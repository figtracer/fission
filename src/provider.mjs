import { spawn } from "node:child_process";
import { readFile, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { directory, readJSON, writeJSON } from "./state.mjs";
import { units, reserve } from "./budget.mjs";

const endpoint = "https://modal.mpp.tempo.xyz/sandbox/";
const tempo = process.env.FISSION_TEMPO || process.env.LOANER_TEMPO || join(homedir(), ".tempo/bin/tempo");

export const money = units;

export function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = "", interruption;
    if (options.signal?.aborted) return resolve({ code: null, stdout, stderr, interruption: "interrupted" });
    const grouped = process.platform !== "win32";
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], detached: grouped });
    const stop = (reason) => {
      interruption = reason;
      if (!child.pid) return;
      try {
        // Stop the local request process group before releasing its operation lock.
        // A payment may already have escaped; the request remains unresolved.
        if (grouped) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch (error) { if (error.code !== "ESRCH") reject(error); }
    };
    const abort = () => stop("interrupted");
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => stop("observation_deadline"), options.timeoutMs);
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); };
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", (error) => { cleanup(); reject(error); });
    child.on("close", (code, signal) => { cleanup(); resolve({ code, signal, stdout, stderr, interruption }); });
  });
}

export async function quote(operation, body) {
  const result = await runProcess(tempo, ["request", "--dry-run", "--retries", "0", "-m", "60", "-X", "POST", "--json", JSON.stringify(body), endpoint + operation]);
  if (result.code !== 0) throw new Error(`Quote unavailable: ${result.stderr.trim() || result.stdout.trim()}`);
  let offer;
  try { offer = JSON.parse(result.stdout); } catch { throw new Error("Provider returned an unreadable quote."); }
  if (offer.payment_required !== true || offer.intent !== "charge" || offer.method !== "tempo" ||
      offer.chain_id !== 4217 || offer.token?.toLowerCase() !== "0x20c000000000000000000000b9537d11c60e8b50")
    throw new Error("Provider changed its payment terms. No payment submitted.");
  money(offer.amount);
  return offer;
}

export async function request(state, operation, body, maximum, id = randomUUID(), options = {}) {
  const dir = join(directory(state.name), "requests");
  const intent = join(dir, `${id}.json`);
  const responsePath = join(dir, `${id}.response.json`);
  const metaPath = join(dir, `${id}.meta.json`);
  if (await readJSON(intent)) throw new Error(`Request ${id} already exists. Reconcile it; do not pay again.`);
  await reserve(state, operation, maximum, id);
  await writeJSON(intent, { id, operation, body, maximum, submittedAt: new Date().toISOString(), state: "submitting" });
  for (const path of [responsePath, metaPath]) {
    const file = await open(path, "wx", 0o600); await file.close();
  }
  const result = await runProcess(tempo, ["request", "--max-spend", maximum, "--retries", "0", "-m", "180", "-X", "POST", "--json", JSON.stringify(body), "-o", responsePath, "--write-meta", metaPath, endpoint + operation], { signal: options.signal, timeoutMs: Math.max(1, Math.min(180000, (options.deadline || Infinity) - Date.now())) });
  const responseText = await readFile(responsePath, "utf8");
  let response;
  try { response = JSON.parse(responseText); } catch { /* Preserve the raw response for recovery. */ }
  await writeJSON(intent, { id, operation, body, maximum, state: result.code === 0 ? "received" : "unknown", exitCode: result.code, interruption: result.interruption, finishedAt: new Date().toISOString() });
  if (result.code !== 0 || !response) {
    await writeJSON(join(dir, `${id}.error.json`), { code: result.code, stderr: result.stderr, stdout: result.stdout });
    throw new Error(`Provider outcome is unresolved for ${operation} (${id}). Saved response: ${responsePath}. Do not repeat the payment.`);
  }
  if (response.error || response.detail) throw new Error(`Provider rejected ${operation}; inspect ${responsePath}.`);
  return response;
}

export async function recoverCreate(state) {
  const path = join(directory(state.name), "requests", `${state.createRequest}.response.json`);
  let response;
  try { response = await readJSON(path); } catch { return null; }
  return response && /^sb-[A-Za-z0-9]+$/.test(response.sandbox_id || "") ? response.sandbox_id : null;
}

export async function execute(state, command, maximum, id, options) {
  if (!Array.isArray(command) || !command.length || command.some((arg) => typeof arg !== "string" || arg.includes("\0")))
    throw new Error("Supply a command and its arguments after --.");
  const result = await request(state, "exec", { sandbox_id: state.remoteId, command }, maximum, id, options);
  if (!Number.isInteger(result.returncode) || typeof result.stdout !== "string" || typeof result.stderr !== "string")
    throw new Error("Unrecognized command result; inspect the saved response before retrying.");
  return result;
}
