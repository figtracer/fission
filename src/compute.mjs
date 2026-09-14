import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { directory, readJSON, writeJSON, save } from "./state.mjs";
import { reserve } from "./budget.mjs";
import { runProcess, validRemoteId } from "./provider.mjs";

const endpoint = "https://compute.x402layer.cc/compute/";
const usableIP = (value) => isIP(value || "") && !["0.0.0.0", "::", "127.0.0.1", "::1"].includes(value);
const credentials = (state) => join(directory(state.name), "compute-auth.json");

export async function catalog() {
  // The default endpoint omits dedicated and GPU classes. Read every documented
  // category before comparing offers; an incomplete catalog fails discovery.
  const categories = await Promise.all(["vps", "vhp", "vdc", "vcg"].map(async (type) => {
    const response = await fetch(endpoint + "plans?type=" + type, { signal: AbortSignal.timeout(60000), redirect: "error" });
    if (!response.ok) throw new Error(`Compute ${type} catalog HTTP ${response.status}.`);
    const value = await response.json();
    if (!Array.isArray(value.plans)) throw new Error(`Invalid compute ${type} catalog.`);
    return value.plans;
  }));
  return categories.flat();
}

export function machineCapabilities(machine) {
  if (![machine.vcpu_count, machine.ram, machine.disk].every((value) => Number.isFinite(value) && value > 0) || machine.disk_count !== 1)
    throw new Error("Compute catalog has unsupported or incomplete resource quantities.");
  // The catalog labels disk as GB. Convert conservatively to GiB; never equate
  // a decimal 2 TB disk with a 2 TiB requirement. CPU counts are provider vCPUs.
  return { os: "linux", kind: "vm", architecture: "x86_64", cpu: machine.vcpu_count,
    memoryGiB: machine.ram / 1024, diskGiB: machine.disk * 1e9 / 2 ** 30,
    p2p: true, customImage: false, expiry: true };
}

export async function adopt(state, response) {
  const order = response.order;
  if (!order || !validRemoteId(state, order.id)) throw new Error("Invalid compute order. Preserve the creation response; do not repurchase.");
  if (response.management_api_key) {
    if (typeof response.management_api_key !== "string" || !/^x402c_[A-Za-z0-9_-]+$/.test(response.management_api_key))
      throw new Error("Invalid management credential. Preserve the creation response.");
    await writeJSON(credentials(state), { key: response.management_api_key });
  } else if (!await readJSON(credentials(state))) throw new Error("Creation returned no management credential. Preserve the response for recovery.");
  if (usableIP(order.ip_address)) state.sshHost = order.ip_address;
  if (Number.isFinite(Date.parse(order.expires_at))) state.providerExpiresAt = order.expires_at;
  return order.id;
}

async function management(state, method, options = {}) {
  if (!validRemoteId(state, state.remoteId)) throw new Error("Invalid compute order ID.");
  const auth = await readJSON(credentials(state));
  if (!auth?.key) throw new Error("Missing saved compute management credential.");
  const timeout = AbortSignal.timeout(Math.max(1, Math.min(60000, (options.deadline || Infinity) - Date.now())));
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetch(endpoint + "instances/" + state.remoteId, {
    method, headers: { "X-API-Key": auth.key }, signal, redirect: "error",
  });
  // A 404 is not proof of destruction: it can mean lost authorization or routing.
  if (!response.ok) throw new Error(`Compute ${method} HTTP ${response.status}; outcome requires observation.`);
  return response.json();
}

function sshArguments(state) {
  if (!usableIP(state.sshHost)) throw new Error("Compute instance has no observed IP yet.");
  return ["-F", "/dev/null", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
    "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new", "-o", "ForwardAgent=no",
    "-o", "ClearAllForwardings=yes", "-o", `UserKnownHostsFile=${join(directory(state.name), "known_hosts")}`,
    "-i", join(directory(state.name), "id_ed25519")];
}

export async function connect(name, options = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("SSH requires an interactive terminal.");
  const { active, refresh } = await import("./workspace.mjs");
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  let ownsInput = false;
  const interrupt = () => { if (!ownsInput) controller.abort(); };
  const terminate = () => controller.abort();
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
  try {
    let state = await active(name);
    if (state.provider !== "compute-mpp") throw new Error("This provider has no SSH access. Use run/exec for its sandbox.");
    await refresh(name, { signal });
    state = await active(name);
    signal.throwIfAborted();
    return await new Promise((resolve, reject) => {
      const child = spawn("ssh", [...sshArguments(state), "-tt", `root@${state.sshHost}`], { stdio: "inherit" });
      let failure, timer;
      const stop = () => {
        child.kill("SIGTERM");
        // Bound shutdown of the owned local SSH process, even if it ignores TERM.
        timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      };
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      child.once("spawn", () => { ownsInput = true; });
      child.once("error", (error) => { failure = error; });
      child.once("close", (code) => {
        clearTimeout(timer); signal.removeEventListener("abort", stop);
        if (failure) reject(failure); else resolve(code ?? 1);
      });
    });
  } finally {
    process.off("SIGINT", interrupt); process.off("SIGTERM", terminate);
  }
}

async function ssh(state, command, options = {}) {
  const quote = (arg) => "'" + arg.replaceAll("'", "'\"'\"'") + "'";
  const result = await runProcess("ssh", [...sshArguments(state), `root@${state.sshHost}`,
    command.map(quote).join(" ")], { inputFd: options.inputFd, outputFd: options.outputFd, signal: options.signal, timeoutMs: Math.max(1, Math.min(180000, (options.deadline || Infinity) - Date.now())) });
  if (result.code === null || result.code === 255) throw new Error("SSH outcome unresolved. Inspect the existing job before executing it again.");
  return { returncode: result.code, stdout: result.stdout, stderr: result.stderr };
}

export async function computeRequest(state, operation, body, id, options) {
  if (!["exec", "status", "terminate"].includes(operation)) throw new Error("Unsupported compute operation.");
  const path = join(directory(state.name), "requests", `${id}.json`);
  if (await readJSON(path)) throw new Error("Request already recorded; reconcile it.");
  await reserve(state, operation, "0", id);
  const intent = { id, operation, body, maximum: "0", state: "submitting", submittedAt: new Date().toISOString() };
  await writeJSON(path, intent);
  let result;
  if (operation === "exec") {
    result = await ssh(state, body.command, options);
    await writeJSON(join(directory(state.name), "requests", `${id}.response.json`), result);
  }
  else {
    const response = await management(state, operation === "terminate" ? "DELETE" : "GET", options);
    await writeJSON(join(directory(state.name), "requests", `${id}.response.json`), response);
    if (operation === "terminate") {
      if (response.success !== true) throw new Error("Deletion acknowledgement unrecognized; inspect status.");
      result = { status: "terminated" }; // workspace lifecycle still requires a subsequent GET.
    } else {
      const order = response.order || response.instance || response;
      if (!order || order.id !== state.remoteId) throw new Error("Unrecognized compute instance response.");
      if (usableIP(order.ip_address)) state.sshHost = order.ip_address;
      if (Number.isFinite(Date.parse(order.expires_at))) state.providerExpiresAt = order.expires_at;
      state.providerStatus = order.status;
      await save(state);
      if (["destroyed", "terminated"].includes(order.status)) result = { status: "terminated" };
      else if (["active", "pending", "provisioning", "running"].includes(order.status)) result = { status: "running" };
      else throw new Error(`Compute instance is ${order.status}; termination is not confirmed.`);
    }
  }
  await writeJSON(path, { ...intent, state: "received", finishedAt: new Date().toISOString() });
  return result;
}

export async function prepareAccess(state) {
  const key = join(directory(state.name), "id_ed25519");
  // Keys are created once while planning and never copied to the guest.
  await readFile(key);
  const until = Date.now() + 300000;
  while (Date.now() < until) {
    const response = await management(state, "GET", { deadline: until });
    const order = response.order || response.instance || response;
    if (!order || order.id !== state.remoteId) throw new Error("Unrecognized compute status while waiting for SSH.");
    if (["destroyed", "terminated", "failed", "expired"].includes(order.status)) throw new Error(`Compute provisioning is ${order.status}.`);
    if (usableIP(order.ip_address)) {
      state.sshHost = order.ip_address;
      await save(state);
      try { if ((await ssh(state, ["true"], { deadline: until })).returncode === 0) return; }
      catch { /* Only the read-only SSH readiness probe is retried. */ }
    }
    await delay(Math.min(5000, Math.max(1, until - Date.now())));
  }
  throw new Error("SSH readiness timed out. Reconcile the existing instance; do not purchase again.");
}
