import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { root, directory, readJSON, writeJSON, providerId } from "./state.mjs";
import { units, reserve } from "./budget.mjs";

const endpoint = "https://modal.mpp.tempo.xyz/sandbox/";
const tempo = process.env.FISSION_TEMPO || process.env.LOANER_TEMPO || join(homedir(), ".tempo/bin/tempo");

export const money = units;
export const paymentTerms = { chainId: 4217, token: "0x20c000000000000000000000b9537d11c60e8b50", currency: "USDC.e" };
const paymentOptions = ["--payment-intent", "charge", "--payment-token", paymentTerms.token, "--network", "tempo"];

// Recorded incidents apply to providers; machine state remains independent.
const providerIncidents = new Set(["compute-mpp", "smol-orthogonal"]);
const failureFile = (provider) => join(root, ".provider-failures", encodeURIComponent(providerId(provider)) + ".json");
export const providerWarning = (provider) => providerIncidents.has(providerId(provider)) || existsSync(failureFile(provider))
  ? "Recorded provider failure; see docs/rental.md#provider-history."
  : null;

export async function recordProviderFailure(provider) {
  const path = failureFile(provider);
  if (!existsSync(path)) await writeJSON(path, { provider: providerId(provider), recordedAt: new Date().toISOString() });
}

function provisioningRecovery(response) {
  return typeof response?.error === "string" && response.details?.cleanup === "destroyed" &&
    response.details.cleanup_error === null && Number.isFinite(response.details.credited) && response.details.credited > 0
    ? " Provider reports automatic destruction and account credit; credit access and payment recovery remain unverified."
    : "";
}

export function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = "", interruption;
    if (options.signal?.aborted) return resolve({ code: null, stdout, stderr, interruption: "interrupted" });
    const grouped = process.platform !== "win32";
    const child = spawn(command, args, { stdio: [options.inputFd ?? "ignore", options.outputFd ?? "pipe", "pipe"], detached: grouped });
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
    child.stdout?.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", (error) => { cleanup(); reject(error); });
    child.on("close", (code, signal) => { cleanup(); resolve({ code, signal, stdout, stderr, interruption }); });
  });
}

export async function quote(operation, body, provider = "modal-tempo") {
  provider = providerId(provider);
  const url = provider === "compute-mpp" ? "https://compute.x402layer.cc/compute/provision" : endpoint + operation;
  const result = await runProcess(tempo, ["request", ...paymentOptions, "--dry-run", "--retries", "0", "-m", "60", "-X", "POST", "--json", JSON.stringify(body), url]);
  if (result.code !== 0) throw new Error(`Quote unavailable: ${result.stderr.trim() || result.stdout.trim()}`);
  let offer;
  try { offer = JSON.parse(result.stdout); } catch { throw new Error("Provider returned an unreadable quote."); }
  if (offer.payment_required !== true || offer.intent !== "charge" || offer.method !== "tempo" ||
      offer.chain_id !== paymentTerms.chainId || offer.token?.toLowerCase() !== paymentTerms.token)
    throw new Error("Provider changed its payment terms. No payment submitted.");
  money(offer.amount);
  return offer;
}

export async function request(state, operation, body, maximum, id = randomUUID(), options = {}) {
  state.provider = providerId(state.provider);
  if ((options.inputFd !== undefined || options.outputFd !== undefined) && (state.provider !== "compute-mpp" || operation !== "exec"))
    throw new Error("File streams require the VM SSH transport.");
  if (state.provider === "compute-mpp" && operation !== "create")
    return (await import("./compute.mjs")).computeRequest(state, operation, body, id, options);
  const dir = join(directory(state.name), "requests");
  const intent = join(dir, `${id}.json`);
  const responsePath = join(dir, `${id}.response.json`);
  const metaPath = join(dir, `${id}.meta.json`);
  if (await readJSON(intent)) throw new Error(`Request ${id} already exists. Reconcile it; do not pay again.`);
  if (operation === "create" && providerWarning(state.provider))
    console.error(`⚠ Provider history: ${providerWarning(state.provider)}`);
  await reserve(state, operation, maximum, id);
  await writeJSON(intent, { id, operation, body, maximum, submittedAt: new Date().toISOString(), state: "submitting" });
  for (const path of [responsePath, metaPath]) {
    const file = await open(path, "wx", 0o600); await file.close();
  }
  const url = state.provider === "compute-mpp" ? "https://compute.x402layer.cc/compute/provision" : endpoint + operation;
  const result = await runProcess(tempo, ["request", ...paymentOptions, "--max-spend", maximum, "--retries", "0", "-m", "180", "-X", "POST", "--json", JSON.stringify(body), "-o", responsePath, "--write-meta", metaPath, url], { signal: options.signal, timeoutMs: Math.max(1, Math.min(180000, (options.deadline || Infinity) - Date.now())) });
  const responseText = await readFile(responsePath, "utf8");
  let response;
  try { response = JSON.parse(responseText); } catch { /* Preserve the raw response for recovery. */ }
  await writeJSON(intent, { id, operation, body, maximum, state: result.code === 0 ? "received" : "unknown", exitCode: result.code, interruption: result.interruption, finishedAt: new Date().toISOString() });
  if (result.code !== 0 || !response) {
    await writeJSON(join(dir, `${id}.error.json`), { code: result.code, stderr: result.stderr, stdout: result.stdout });
    if (!result.interruption) await recordProviderFailure(state.provider);
    const recovery = state.provider === "compute-mpp" && operation === "create" ? provisioningRecovery(response) : "";
    throw new Error(`Provider outcome is unresolved for ${operation} (${id}).${recovery} Saved response: ${responsePath}. Do not repeat the payment.`);
  }
  if (response.error || response.detail) {
    await recordProviderFailure(state.provider);
    throw new Error(`Provider rejected ${operation}; inspect ${responsePath}.`);
  }
  if (state.provider === "compute-mpp") {
    const { adopt } = await import("./compute.mjs");
    return { sandbox_id: await adopt(state, response) };
  }
  return response;
}

export async function recoverCreate(state) {
  const path = join(directory(state.name), "requests", `${state.createRequest}.response.json`);
  let response;
  try { response = await readJSON(path); } catch { return null; }
  if (providerId(state.provider) === "compute-mpp" && response) {
    const recovery = provisioningRecovery(response);
    if (recovery) throw new Error(`Creation remains unresolved.${recovery} Saved response: ${path}. Do not repeat the payment.`);
    return (await import("./compute.mjs")).adopt(state, response);
  }
  return response && /^sb-[A-Za-z0-9]+$/.test(response.sandbox_id || "") ? response.sandbox_id : null;
}

export const validRemoteId = (state, id) => providerId(state.provider) === "compute-mpp"
  ? /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id || "")
  : /^sb-[A-Za-z0-9]+$/.test(id || "");

export async function execute(state, command, maximum, id, options) {
  if (!Array.isArray(command) || !command.length || command.some((arg) => typeof arg !== "string" || arg.includes("\0")))
    throw new Error("Supply a command and its arguments after --.");
  const result = await request(state, "exec", { sandbox_id: state.remoteId, command }, maximum, id, options);
  if (!Number.isInteger(result.returncode) || typeof result.stdout !== "string" || typeof result.stderr !== "string")
    throw new Error("Unrecognized command result; inspect the saved response before retrying.");
  return result;
}
