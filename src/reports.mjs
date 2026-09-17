import { mkdir, readFile, copyFile, stat, open, readdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { load, writeJSON, readJSON, root, directory } from "./state.mjs";
import { getJob, listJobs } from "./jobs.mjs";
import { spending } from "./payments.mjs";
import { amount, units } from "./budget.mjs";
import { providerWarning } from "./provider.mjs";
import { digest, fingerprint } from "./experiments.mjs";
import { validateRecipe } from "./workspace.mjs";

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
  const savedPlan = state.id ? await readJSON(join(root, ".plans", `${state.id}.json`)) : null;
  const { digest: recipeSha256, ...definition } = savedPlan?.recipe || state.recipe;
  // Old bootstrap appended its log artifact after hashing; only an exact recipe
  // can become a rerunnable record. Historical reports remain readable.
  const recipeVerified = validateRecipe(definition).digest === recipeSha256;
  const measurements = options.measurements ? JSON.parse(await readFile(resolve(options.measurements), "utf8")) : [];
  if (!Array.isArray(measurements) || measurements.some((item) => !item || typeof item.name !== "string" ||
      !Number.isFinite(item.value) || typeof item.unit !== "string" || !item.unit || typeof item.context !== "string"))
    throw new Error("Measurements must be an array of {name, value, unit, context} observations.");
  const job = id ? await getJob(name, id) : null;
  if (options.log && !job) throw new Error("Select a job when attaching --log FILE.");
  const notes = options.notes ? await readFile(resolve(options.notes), "utf8") : null;
  let checks = [];
  try {
    const folder = join(directory(name), "checks");
    checks = await Promise.all((await readdir(folder)).filter((file) => /^[a-f0-9-]+\.json$/.test(file)).sort().map((file) => readJSON(join(folder, file))));
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  // Free receipt lookup after cleanup; three existing 10s RPC windows at most.
  // Unavailable/missing receipts remain explicitly unknown in the report.
  const payments = await spending(state.task ? { refresh: true, signal: AbortSignal.timeout(30000) } : {});
  const transactions = payments.transactions.filter((transaction) => transaction.workspaces.includes(name));
  const unknown = payments.unknownWorkspaces.includes(name) || !transactions.length ||
    transactions.some((transaction) => transaction.paid === null || transaction.workspaces.length !== 1);
  const generatedAt = new Date().toISOString();
  const startedAt = iso(job?.observation?.startedAt), finishedAt = iso(job?.observation?.finishedAt);
  const value = {
    schemaVersion: 2, generatedAt,
    ...(state.task ? { task: { harness: state.task.harness, mode: state.task.mode, outcome: state.task.outcome,
      timing: state.task.timing, deadline: state.task.deadline, command: state.task.command,
      inputs: state.task.inputs, artifacts: state.task.artifacts, exports: state.task.exports || [], lastError: state.task.lastError || null,
      cache: state.task.cache || null, experiment: state.task.experiment || null, guidance: state.task.guidance || null,
      jobs: (await listJobs(name)).map((job) => ({ id: job.id, phase: job.phase, digest: job.digest, observation: job.observation })) } } : {}),
    harness: { recipeSha256, recipeVerified, runnerSha256: job?.runnerSha256 || null },
    measurements, readiness: [...checks, ...(job?.observation?.readiness ? [job.observation.readiness] : [])],
    workspace: { name, provider: state.provider, providerWarning: providerWarning(state.provider),
      remoteId: state.remoteId, phase: state.phase, requestedAt: state.requestedAt, observedAt: state.observedAt,
      expiresAt: state.providerExpiresAt || state.deadlineEstimate, expiryEstimated: !state.providerExpiresAt,
      closedAt: state.closedAt, preparationAcceptance: state.preparationAcceptance || null, region: state.body?.region, recipe: state.recipe.name, profile: state.profile,
      accessObservations: state.accessObservations || [], initialization: state.initialization || null,
      requirements: state.requirements, resources: { quoted: state.capabilities?.capabilities || state.capabilities || null,
        providerObserved: state.observedResources || null, guestObserved: state.guestResources || null },
      source: state.source || null },
    run: job ? { id, phase: job.phase, startedAt, finishedAt,
      durationSeconds: startedAt && finishedAt && finishedAt >= startedAt ? (Date.parse(finishedAt) - Date.parse(startedAt)) / 1000 : null,
      exitCode: job.observation?.returncode ?? null, error: job.observation?.error ?? null,
      observedAt: job.observedAt, deadline: iso(job.spec?.deadline), digest: job.digest,
      commands: id === state.bootstrapJob || id === state.repairJob ? null : job.spec?.commands,
      readinessChecks: job.observation?.checks ?? null, environment: job.observation?.environment ?? null, remoteLog: job.log } : null,
    spending: { currency: payments.currency, allocation: state.totalCap ?? null, creationQuote: state.creationQuote,
      verifiedOutflow: unknown ? null : amount(transactions.reduce((sum, transaction) => sum + units(transaction.paid), 0n)),
      incomplete: unknown, refreshError: payments.refreshError || null, transactions },
    assessment: notes, log: null,
    cleanup: { phase: state.phase, confirmed: ["terminated", "expired", "not_submitted", "not_purchased"].includes(state.phase), observedAt: state.closedAt || state.observedAt || null },
  };
  const parent = resolve(options.output || "fission", name);
  await mkdir(parent, { recursive: true });
  const destination = join(parent, generatedAt.replaceAll(":", "-") + "-" + (id || "run"));
  await mkdir(destination, { mode: 0o700 });
  const evidence = [];
  for (const item of state.task?.exports || []) {
    if (item.phase !== "collected") continue;
    const actual = await fingerprint(item.local);
    if (actual.sha256 !== item.sha256 || actual.bytes !== item.bytes) throw new Error("Collected evidence changed before reporting.");
    const path = `evidence-${evidence.length}`;
    await copyFile(item.local, join(destination, path));
    evidence.push({ path, remote: item.remote, ...actual });
  }
  if (state.task) value.evidence = evidence;
  if (options.log) {
    const source = resolve(options.log);
    if (!(await stat(source)).isFile()) throw new Error("Attach a regular local log file.");
    const path = join(destination, "output.log");
    await copyFile(source, path);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    value.log = { path: "output.log", bytes: (await stat(path)).size, sha256: hash.digest("hex"), source: "operator-supplied local log" };
  }
  const observedSource = job?.observation?.environment?.source;
  const sourceReproducible = !state.source || observedSource?.clean === true && /^[a-f0-9]{40}$/.test(observedSource.commit);
  const replayable = recipeVerified && sourceReproducible && job && id !== state.bootstrapJob && id !== state.repairJob && job.spec?.commands?.length;
  const rows = [
    ...(state.task ? [["Task", `${state.task.harness} / ${state.task.mode}`], ["Outcome", state.task.outcome], ["Cleanup confirmed", value.cleanup.confirmed]] : []),
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
    "## Environment", "", code({ requirements: value.workspace.requirements, observedResources: value.workspace.resources, source: value.workspace.source, runEnvironment: value.run?.environment }), "",
    "## Commands", "", value.run?.commands ? code(value.run.commands) : "Preparation or workspace-level report; the structured record identifies the recipe and run digest.", "",
    ...(measurements.length ? ["## Measurements", "", code(measurements), ""] : []),
    "## Evidence", "", "- [Structured record](run.json)",
    ...evidence.map((item) => `- [${cell(item.remote)}](${item.path}): ${item.bytes} bytes; SHA-256 \`${item.sha256}\`.`),
    ...(state.task?.exports || []).filter((item) => item.phase !== "collected").map((item) => `- ${cell(item.remote)}: ${cell(item.phase)}; ${cell(item.error)}`),
    ...(replayable ? ["- [Portable experiment](experiment.json): review its commands, then request a fresh plan and budget."] : []),
    ...(value.log ? [`- [Job output](output.log): ${value.log.bytes} bytes; SHA-256 \`${value.log.sha256}\`.`] : []),
    ...transactions.map((transaction) => `- [Payment receipt](${transaction.explorer}): ${transaction.paid ?? "unverified"} USDC.e${transaction.workspaces.length > 1 ? " (shared transaction)" : ""}.`),
    "", "Receipt outflow includes fees in that token. Missing receipts, other assets, and later refunds are not inferred.", "",
    ...(value.workspace.providerWarning ? ["Provider history: recorded failure. Read `fission help rental` for context.", ""] : []),
  ].join("\n");
  await writeJSON(join(destination, "run.json"), value);
  const path = join(destination, "run.md");
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(markdown); await file.sync(); } finally { await file.close(); }
  let experiment;
  if (replayable) {
    const record = { schemaVersion: 1, generatedAt, recipe: definition, recipeSha256,
      runnerSha256: job.runnerSha256 || null, profile: state.profile || "runtime", requirements: state.requirements || { os: "linux", kind: "sandbox" },
      source: state.source ? { ...state.source, commit: observedSource.commit } : null, workload: { commands: job.spec.commands, cwd: job.spec.cwd },
      preparation: "Bootstrap the embedded recipe, then restore or prepare workload inputs explicitly. Remote files and datasets are not embedded.",
      ...(state.task ? { task: savedPlan?.task || null } : {}),
      files: await Promise.all(["run.json", "run.md", ...evidence.map((item) => item.path), ...(value.log ? ["output.log"] : [])].map(async (file) => ({ path: file, ...await fingerprint(join(destination, file)) }))) };
    record.digest = digest(record);
    experiment = join(destination, "experiment.json");
    await writeJSON(experiment, record);
  }
  return { experiment, report: path, record: join(destination, "run.json"), generatedAt, phase: job?.phase || state.phase, machinePhase: state.phase };
}
