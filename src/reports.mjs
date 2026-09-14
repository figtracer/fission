import { mkdir, readFile, copyFile, stat, open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { load, writeJSON } from "./state.mjs";
import { getJob } from "./jobs.mjs";
import { spending } from "./payments.mjs";
import { amount, units } from "./budget.mjs";
import { providerWarning } from "./provider.mjs";

const iso = (seconds) => {
  const value = Number.isFinite(seconds) ? new Date(seconds * 1000) : null;
  return value && Number.isFinite(value.getTime()) ? value.toISOString() : null;
};
const cell = (value) => String(value ?? "Unknown").replace(/[\r\n|]/g, " ").replace(/[<>]/g, (c) => c === "<" ? "&lt;" : "&gt;");
const code = (value) => {
  const text = JSON.stringify(value, null, 2);
  const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1)));
  return `${fence}json\n${text}\n${fence}`;
};

export async function report(name, id, options = {}) {
  const state = await load(name);
  const job = id ? await getJob(name, id) : null;
  if (options.log && !job) throw new Error("Select a job when attaching --log FILE.");
  const notes = options.notes ? await readFile(resolve(options.notes), "utf8") : null;
  const payments = await spending();
  const transactions = payments.transactions.filter((transaction) => transaction.workspaces.includes(name));
  const unknown = payments.unknownWorkspaces.includes(name) || !transactions.length ||
    transactions.some((transaction) => transaction.paid === null || transaction.workspaces.length !== 1);
  const generatedAt = new Date().toISOString();
  const startedAt = iso(job?.observation?.startedAt), finishedAt = iso(job?.observation?.finishedAt);
  const value = {
    schemaVersion: 1, generatedAt,
    workspace: { name, provider: state.provider, providerWarning: providerWarning(state.provider),
      remoteId: state.remoteId, phase: state.phase, requestedAt: state.requestedAt, observedAt: state.observedAt,
      expiresAt: state.providerExpiresAt || state.deadlineEstimate, expiryEstimated: !state.providerExpiresAt,
      closedAt: state.closedAt, region: state.body?.region, recipe: state.recipe.name, profile: state.profile,
      requirements: state.requirements, resources: { quoted: state.capabilities?.capabilities || state.capabilities || null,
        providerObserved: state.observedResources || null, guestObserved: state.guestResources || null },
      source: state.source || null },
    run: job ? { id, phase: job.phase, startedAt, finishedAt,
      durationSeconds: startedAt && finishedAt && finishedAt >= startedAt ? (Date.parse(finishedAt) - Date.parse(startedAt)) / 1000 : null,
      exitCode: job.observation?.returncode ?? null, error: job.observation?.error ?? null,
      observedAt: job.observedAt, deadline: iso(job.spec?.deadline), digest: job.digest,
      commands: id === state.bootstrapJob ? null : job.spec?.commands,
      readinessChecks: job.observation?.checks ?? null, remoteLog: job.log } : null,
    spending: { currency: payments.currency, allocation: state.totalCap ?? null, creationQuote: state.creationQuote,
      verifiedOutflow: unknown ? null : amount(transactions.reduce((sum, transaction) => sum + units(transaction.paid), 0n)),
      incomplete: unknown, transactions },
    assessment: notes, log: null,
  };
  const parent = resolve(options.output || "fission", name);
  await mkdir(parent, { recursive: true });
  const destination = join(parent, generatedAt.replaceAll(":", "-") + "-" + (id || "run"));
  await mkdir(destination, { mode: 0o700 });
  if (options.log) {
    const source = resolve(options.log);
    if (!(await stat(source)).isFile()) throw new Error("Attach a regular local log file.");
    const path = join(destination, "output.log");
    await copyFile(source, path);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    value.log = { path: "output.log", bytes: (await stat(path)).size, sha256: hash.digest("hex"), source: "operator-supplied local log" };
  }
  const rows = [
    ["Generated (UTC)", generatedAt], ["Requested (UTC)", state.requestedAt], ["Machine", name], ["Provider", state.provider],
    ["Recipe", state.recipe.name], ["Run", id || "Workspace"], ["Recorded result", job?.phase || state.phase],
    ["Started (UTC)", startedAt], ["Finished (UTC)", finishedAt], ["Duration (seconds)", value.run?.durationSeconds],
    ["Exit code", value.run?.exitCode], ["Last job observation (UTC)", job?.observedAt],
    ["Machine state", state.phase], ["Closed (UTC)", state.closedAt],
    ["Lease expiry (UTC)", value.workspace.expiresAt], ["Expiry estimated", value.workspace.expiryEstimated],
    ["Workspace allocation (USDC.e)", value.spending.allocation], ["Creation quote (USDC.e)", state.creationQuote],
    ["Verified receipt outflow (USDC.e)", value.spending.verifiedOutflow],
  ];
  const markdown = [
    `# ${cell(name)} / ${cell(id || "workspace")}`, "",
    "## Recorded execution", "", "| Field | Value |", "|---|---|",
    ...rows.map(([key, item]) => `| ${key} | ${cell(item)} |`), "",
    "Recorded process status is evidence for the agent's assessment. Unknown timing, spending, or cleanup stays unknown.", "",
    "## Agent assessment", "", notes || "Assessment pending.", "",
    "## Environment", "", code({ requirements: value.workspace.requirements, observedResources: value.workspace.resources, source: value.workspace.source }), "",
    "## Commands", "", value.run?.commands ? code(value.run.commands) : "Preparation or workspace-level report; the structured record identifies the recipe and run digest.", "",
    "## Evidence", "", "- [Structured record](run.json)",
    ...(value.log ? [`- [Job output](output.log): ${value.log.bytes} bytes; SHA-256 \`${value.log.sha256}\`.`] : []),
    ...transactions.map((transaction) => `- [Payment receipt](${transaction.explorer}): ${transaction.paid ?? "unverified"} USDC.e${transaction.workspaces.length > 1 ? " (shared transaction)" : ""}.`),
    "", "Receipt outflow includes fees in that token. Missing receipts, other assets, and later refunds are not inferred.", "",
    ...(value.workspace.providerWarning ? ["Provider history: recorded failure. Read `fission guide rental` for context.", ""] : []),
  ].join("\n");
  await writeJSON(join(destination, "run.json"), value);
  const path = join(destination, "run.md");
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(markdown); await file.sync(); } finally { await file.close(); }
  return { report: path, record: join(destination, "run.json"), generatedAt, phase: job?.phase || state.phase, machinePhase: state.phase };
}
