import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { root, directory, readJSON, writeJSON, save, fileLocked, recoverLock, list } from "./state.mjs";
import { quote, request } from "./provider.mjs";
import { units, budget } from "./budget.mjs";
import { paymentReference } from "./payments.mjs";

// One-shot executions share the cash ledger, but have no VM lease or cleanup call.
export async function runCodeFile(name, options) {
  const file = resolve(options.from), document = await readJSON(file);
  if (!document || !Object.hasOwn(document, "execution")) return null;
  directory(name);
  if (document.schemaVersion !== 1 || Object.keys(document).some(key => !["schemaVersion", "execution"].includes(key)))
    throw new Error("Code task requires schemaVersion 1 and execution only.");
  const spec = document.execution;
  const allowed = ["provider", "source", "language", "stdin", "expectedOutput", "cpuSeconds", "wallSeconds", "memoryKiB", "output"];
  if (!spec || Array.isArray(spec) || Object.keys(spec).some(key => !allowed.includes(key)) || spec.provider !== "judge0")
    throw new Error("Execution requires provider judge0 and documented fields; see help code.");
  if (typeof spec.source !== "string" || !spec.source || !Number.isSafeInteger(spec.language) || spec.language < 1)
    throw new Error("Execution needs a source file and positive Judge0 language ID.");
  for (const key of ["stdin", "expectedOutput", "output"])
    if (spec[key] !== undefined && typeof spec[key] !== "string") throw new Error(`${key} must be a string.`);
  for (const key of ["cpuSeconds", "wallSeconds", "memoryKiB"])
    if (!Number.isSafeInteger(spec[key]) || spec[key] < 1) throw new Error(`${key} must be an explicit positive integer.`);
  if (spec.cpuSeconds > spec.wallSeconds) throw new Error("cpuSeconds must fit within wallSeconds.");
  if (units(options.budget) <= 0n) throw new Error("A positive budget is required.");
  const bytes = await readFile(resolve(dirname(file), spec.source));
  const body = { source_code: bytes.toString("utf8"), language_id: spec.language, enable_network: false,
    cpu_time_limit: spec.cpuSeconds, wall_time_limit: spec.wallSeconds, memory_limit: spec.memoryKiB,
    ...(spec.stdin !== undefined ? { stdin: spec.stdin } : {}),
    ...(spec.expectedOutput !== undefined ? { expected_output: spec.expectedOutput } : {}) };
  const identity = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const lock = join(root, ".task-create.lock");
  await recoverLock(lock);
  return fileLocked(lock, async () => {
    if ((await list()).some(state => state.name === name || state.task?.experiment?.name === name || state.task?.experiment?.members?.includes(name)))
      throw new Error("Name already recorded. Use status; never repeat a paid execution.");
    const offer = await quote("execute-code", body, "judge0");
    if (units(offer.amount) > units(options.budget)) throw new Error("Execution quote exceeds budget; no payment submitted.");
    const ledger = await budget();
    if (units(options.budget) > units(ledger.availableToAllocate)) throw new Error("Aggregate budget cannot fund this execution.");
    const preview = { name, provider: "judge0", kind: "code-execution", quote: offer.amount,
      budget: options.budget, sourceSha256: createHash("sha256").update(bytes).digest("hex"),
      language: spec.language, limits: { cpuSeconds: spec.cpuSeconds, wallSeconds: spec.wallSeconds, memoryKiB: spec.memoryKiB },
      network: false, cleanup: "not_applicable", note: "One paid execution. Preview transmits source to the provider to obtain terms. No VM or SSH access." };
    if (!options.approve) return { ...preview, status: "preview" };
    const requestedAt = new Date().toISOString(), id = randomUUID();
    const state = { name, provider: "judge0", kind: "code-execution", phase: "execution_unknown", requestedAt,
      totalCap: options.budget, creationQuote: offer.amount, recipe: { name: "code" },
      execution: { ...preview, identity, requestId: id, output: resolve(dirname(file), spec.output || "fission", name, requestedAt.replace(/[:.]/g, "-")) } };
    await save(state);
    try {
      const response = await request(state, "execute-code", body, offer.amount, id);
      const result = response?.data;
      // Accepted, compile errors, wrong answers and runtime errors are completed
      // deliveries. Queued/processing or malformed responses remain unresolved.
      if (response.success !== true || !Number.isInteger(result?.status?.id) || result.status.id < 3)
        throw new Error("Provider did not return a completed code result; preserve the request and do not resubmit.");
      state.execution.result = result;
      state.execution.outcome = result.status.id === 3 ? "succeeded" : "failed";
      state.phase = "terminated"; // Terminal record only: cleanup is explicitly not applicable.
      state.closedAt = new Date().toISOString();
      await save(state);
      await writeCodeReport(state);
    } catch (error) {
      state.execution.error = error.message;
      await save(state);
      throw error;
    }
    return codeStatus(name);
  });
}

async function writeCodeReport(state) {
  const { execution } = state, output = execution.output;
  await mkdir(output, { recursive: true, mode: 0o700 });
  const record = { schemaVersion: 1, name: state.name, provider: state.provider, requestedAt: state.requestedAt,
    finishedAt: state.closedAt, ...execution, cleanup: "not_applicable" };
  delete record.output;
  const meta = await readJSON(join(directory(state.name), "requests", `${execution.requestId}.meta.json`));
  record.payment = { quote: state.creationQuote, receipt: paymentReference(meta), verifiedOutflow: null };
  await writeJSON(join(output, "run.json"), record);
  await writeFile(join(output, "run.md"), `# ${state.name}\n\n${execution.outcome} · Judge0 · ${state.requestedAt}\n\n` +
    `Source SHA-256: ${execution.sourceSha256}\n\nLanguage ID: ${execution.language}\n\n` +
    `Execution: ${execution.result.time ?? "unknown"}s; memory: ${execution.result.memory ?? "unknown"} KiB.\n\n` +
    `Quoted charge: ${state.creationQuote} USDC.e. Transaction fees are separate; on-chain outflow is not verified here.\n\n` +
    `Cleanup: not applicable (one-shot execution). Full output and payment reference: run.json.\n`, { mode: 0o600 });
  execution.report = join(output, "run.md");
  await save(state);
}

export async function codeStatus(name) {
  const state = await readJSON(join(directory(name), "state.json"));
  if (state?.kind !== "code-execution") return null;
  const execution = state.execution;
  // A controller can exit after receiving the result but before saving state.
  // Recover that local evidence only; never issue a new provider request.
  if (state.phase !== "terminated") {
    const responsePath = join(directory(name), "requests", `${execution.requestId}.response.json`);
    let response;
    try { response = await readJSON(responsePath); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    if (response?.success === true && Number.isInteger(response.data?.status?.id) && response.data.status.id >= 3) {
      execution.result = response.data;
      execution.outcome = response.data.status.id === 3 ? "succeeded" : "failed";
      state.phase = "terminated";
      state.closedAt = new Date().toISOString();
      await save(state);
    }
  }
  const done = state.phase === "terminated";
  if (done && !execution.report) await writeCodeReport(state);
  return { name, kind: "code-execution", provider: "judge0", phase: done ? "done" : "unresolved",
    outcome: execution.outcome || null, result: execution.result || null,
    sourceSha256: execution.sourceSha256, cost: { quote: state.creationQuote, allocation: state.totalCap, verifiedOutflow: null },
    cleanup: { phase: "not_applicable", confirmed: true }, report: execution.report || null,
    lastError: execution.error || null, note: "Status/stop/resume never resubmit code or charge again. An unresolved result needs provider reconciliation." };
}
