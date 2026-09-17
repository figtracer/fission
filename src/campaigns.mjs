import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { amount, units } from "./budget.mjs";
import { digest } from "./experiments.mjs";
import { taskOptions, taskSpec } from "./harnesses.mjs";

const maximumSeed = (1n << 256n) - 1n;
const maximumWorkers = 4096;
const maximumManifestBytes = 1024 * 1024;
const placeholders = new Set(["{{seed}}", "{{workerIndex}}", "{{workerCount}}"]);

function campaignError(message) {
  throw new Error(`Campaign ${message}`);
}

function seed(value, field, positive = false) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) campaignError(`${field} must be an unsigned decimal integer.`);
  const parsed = BigInt(value);
  if (parsed > maximumSeed || positive && parsed === 0n) campaignError(`${field} is outside the supported unsigned 256-bit range.`);
  return parsed;
}

function resolveInput(value, base) {
  if (typeof value !== "string") campaignError("template input entries must be strings.");
  const index = value.indexOf("=");
  return resolve(base, index < 0 ? value : value.slice(0, index)) + (index < 0 ? "" : value.slice(index));
}

function resolveTemplate(template, base) {
  if (!template || typeof template !== "object" || Array.isArray(template)) campaignError("template must be an object.");
  if (Object.keys(template).some((key) => !["command", ...taskOptions].includes(key)))
    campaignError("template contains an unsupported field.");
  if (!Array.isArray(template.command) || template.command.some((arg) => typeof arg !== "string"))
    campaignError("template command must be a string argv array.");
  const resolved = { ...template, output: resolve(base, template.output || "fission") };
  for (const field of ["patch", "manifest", "snapshot-plan"]) if (resolved[field]) resolved[field] = resolve(base, resolved[field]);
  if (resolved.input) resolved.input = resolved.input.map((value) => resolveInput(value, base));
  return resolved;
}

function expandCommand(command, values) {
  let hasSeed = false;
  const expanded = command.map((arg) => {
    const matches = arg.match(/{{[^}]+}}/g) || [];
    if (matches.some((match) => !placeholders.has(match)) || matches.length && matches[0] !== arg)
      campaignError("placeholders must be whole argv elements: {{seed}}, {{workerIndex}}, or {{workerCount}}.");
    if (arg === "{{seed}}") hasSeed = true;
    return values[arg] || arg;
  });
  if (!hasSeed) campaignError("template command must include {{seed}}.");
  return expanded;
}

export async function expandCampaign(file) {
  const path = resolve(file);
  let campaign;
  try { campaign = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { campaignError(`file is not valid JSON: ${error.message}`); }
  if (!campaign || campaign.schemaVersion !== 1 || campaign.kind !== "campaign" ||
      Object.keys(campaign).some((key) => !["schemaVersion", "kind", "workers", "baseSeed", "seedStride", "budget", "template"].includes(key)))
    campaignError("file requires schemaVersion 1, kind \"campaign\", workers, baseSeed, seedStride, budget, and template only.");
  if (!Number.isSafeInteger(campaign.workers) || campaign.workers <= 0 || campaign.workers > maximumWorkers)
    campaignError(`workers must be a positive safe integer no greater than ${maximumWorkers}.`);
  const baseSeed = seed(campaign.baseSeed, "baseSeed"), stride = seed(campaign.seedStride, "seedStride", true);
  const template = resolveTemplate(campaign.template, dirname(path));
  const workerBudget = units(template.budget), campaignBudget = units(campaign.budget);
  const allocation = workerBudget * BigInt(campaign.workers);
  if (allocation > campaignBudget) campaignError("combined worker allocations exceed campaign budget.");
  const machines = [];
  const workers = [];
  for (let index = 0; index < campaign.workers; index++) {
    const workerSeed = baseSeed + BigInt(index) * stride;
    if (workerSeed > maximumSeed) campaignError("seed sequence overflows the unsigned 256-bit range.");
    const command = expandCommand(template.command, {
      "{{seed}}": workerSeed.toString(), "{{workerIndex}}": String(index), "{{workerCount}}": String(campaign.workers),
    });
    const settings = { ...template };
    delete settings.command;
    await taskSpec(settings, command);
    machines.push({ name: `worker-${index}`, ...settings, command });
    workers.push({ name: `worker-${index}`, index, seed: workerSeed.toString() });
  }
  const manifest = { schemaVersion: 1, machines };
  const bytes = Buffer.byteLength(JSON.stringify(manifest, null, 2) + "\n");
  if (bytes > maximumManifestBytes) campaignError(`expanded manifest exceeds the ${maximumManifestBytes}-byte safety limit.`);
  return { manifest, summary: { source: path, workers, campaignBudget: amount(campaignBudget), combinedAllocation: amount(allocation), manifestSha256: digest(manifest), bytes } };
}

export async function writeCampaignManifest(output, manifest) {
  const path = resolve(output);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let file;
  try { file = await open(path, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") campaignError("output already exists; inspect it or choose a new path.");
    throw error;
  }
  try {
    await file.writeFile(JSON.stringify(manifest, null, 2) + "\n");
    await file.sync();
  } finally { await file.close(); }
  return path;
}
