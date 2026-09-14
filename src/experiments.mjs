import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { validateRecipe } from "./workspace.mjs";

export const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function fingerprint(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { bytes: (await stat(path)).size, sha256: hash.digest("hex") };
}

export async function readExperiment(path) {
  const file = resolve(path);
  const value = JSON.parse(await readFile(file, "utf8"));
  const { digest: expected, ...record } = value;
  if (value.schemaVersion !== 1 || digest(record) !== expected) throw new Error("Unsupported or changed experiment record.");
  if (!value.recipe || validateRecipe(value.recipe).digest !== value.recipeSha256)
    throw new Error("Experiment recipe digest mismatch.");
  if (!Array.isArray(value.files) || !Array.isArray(value.workload?.commands) || !value.workload.commands.length ||
      value.workload.commands.some((argv) => !Array.isArray(argv) || !argv.length || argv.some((arg) => typeof arg !== "string" || arg.includes("\0"))) ||
      typeof value.workload.cwd !== "string" || !value.workload.cwd.startsWith("/") || value.workload.cwd.includes("\0"))
    throw new Error("Experiment needs an explicit workload and working directory.");
  for (const entry of value.files) {
    if (!entry || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(entry.path) || entry.path === "experiment.json")
      throw new Error("Invalid experiment attachment path.");
    const actual = await fingerprint(join(dirname(file), entry.path));
    if (actual.sha256 !== entry.sha256 || actual.bytes !== entry.bytes) throw new Error(`Changed experiment attachment: ${entry.path}`);
  }
  return value;
}

export async function planOptions(options) {
  const record = await readExperiment(options.from);
  for (const field of ["recipe", "profile", "repo", "ref", "os", "arch", "kind", "cpu", "memory", "disk"])
    if (options[field] !== undefined) throw new Error(`--from supplies ${field}; use a new explicit plan to change the experiment.`);
  const requirements = record.requirements;
  if (!requirements || typeof requirements !== "object") throw new Error("Missing experiment requirements.");
  const mapped = { os: "os", architecture: "arch", kind: "kind", cpu: "cpu", memoryGiB: "memory", diskGiB: "disk" };
  const result = { ...options, recipe: record.recipe, profile: record.profile };
  for (const [key, value] of Object.entries(requirements)) {
    if (mapped[key]) result[mapped[key]] = String(value);
    else if (key !== "p2p" || record.profile !== "reth-synced" && record.profile !== "tempo-node")
      throw new Error(`Unsupported recorded requirement: ${key}`);
  }
  if (record.source) { result.repo = record.source.url; result.ref = record.source.commit; }
  return result;
}
