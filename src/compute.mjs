import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { directory, readJSON, writeJSON, save } from "./state.mjs";
import { reserve } from "./budget.mjs";
import { runProcess, validRemoteId, money, recordProviderFailure } from "./provider.mjs";

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

async function management(state, method, options = {}, body) {
  if (!validRemoteId(state, state.remoteId)) throw new Error("Invalid compute order ID.");
  const auth = await readJSON(credentials(state));
  if (!auth?.key) throw new Error("Missing saved compute management credential.");
  const timeout = AbortSignal.timeout(Math.max(1, Math.min(60000, (options.deadline || Infinity) - Date.now())));
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetch(endpoint + "instances/" + state.remoteId + (body ? "/resize" : ""), {
    method, headers: { "X-API-Key": auth.key, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal, redirect: "error",
  });
  // A 404 is not proof of destruction: it can mean lost authorization or routing.
  if (!response.ok) {
    await recordProviderFailure(state.provider);
    throw new Error(`Compute ${method} HTTP ${response.status}; outcome requires observation.`);
  }
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
    let state = await active(name, false);
    if (state.provider !== "compute-mpp") throw new Error("This provider has no SSH access. Use run/exec for its sandbox.");
    await refresh(name, { signal });
    state = await active(name);
    signal.throwIfAborted();
    return await new Promise((resolve, reject) => {
      // Bound dead interactive connections to two missed 15-second probes so
      // their tmux windows close even when the provider drops packets silently.
      const child = spawn("ssh", [...sshArguments(state), "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", "-tt", `root@${state.sshHost}`], { stdio: "inherit" });
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
  if (!["exec", "status", "terminate", "resize"].includes(operation)) throw new Error("Unsupported compute operation.");
  if (operation === "resize" && (!state.lease || state.resizeRequest !== id || body.plan !== state.machine.id || body.confirm_disk_resize !== true))
    throw new Error("Resize requires the recorded target and disk-growth approval from a saved plan.");
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
    const response = await management(state, operation === "resize" ? "POST" : operation === "terminate" ? "DELETE" : "GET", options, operation === "resize" ? body : undefined);
    await writeJSON(join(directory(state.name), "requests", `${id}.response.json`), response);
    if (operation === "resize") {
      if (response.success !== true || response.instance_id !== state.remoteId || response.to_plan !== state.machine.id || !Number.isFinite(Date.parse(response.new_expires_at)))
        throw new Error("Resize outcome unresolved. Observe the same instance; do not repeat the request.");
      state.providerExpiresAt = new Date(Math.min(Date.parse(state.providerExpiresAt), Date.parse(response.new_expires_at))).toISOString();
      state.leasePhase = "resizing";
      state.resizePending = true;
      await save(state);
      result = { status: "resizing" };
    } else if (operation === "terminate") {
      if (response.success !== true) throw new Error("Deletion acknowledgement unrecognized; inspect status.");
      result = { status: "terminated" }; // workspace lifecycle still requires a subsequent GET.
    } else {
      const order = response.order || response.instance || response;
      if (!order || order.id !== state.remoteId) throw new Error("Unrecognized compute instance response.");
      if (usableIP(order.ip_address)) state.sshHost = order.ip_address;
      const pending = order.metadata?.resize_pending;
      state.observedMachine = order.vultr_plan;
      state.observedServerStatus = order.vultr_server_status;
      state.resizePending = Boolean(pending) || Boolean(state.lease && state.resizeRequest &&
        (order.vultr_plan !== state.machine.id || order.vultr_server_status !== "ok"));
      const expiries = [order.expires_at, pending?.new_expires_at, state.resizePending ? state.providerExpiresAt : undefined].filter((value) => Number.isFinite(Date.parse(value)));
      if (expiries.length) state.providerExpiresAt = expiries.sort((a, b) => Date.parse(a) - Date.parse(b))[0];
      state.providerStatus = order.status;
      if ([order.vultr_vcpu_count, order.vultr_ram, order.vultr_disk].every((value) => Number.isFinite(value) && value > 0))
        state.observedResources = { cpu: order.vultr_vcpu_count, memoryGiB: order.vultr_ram / 1024, diskGiB: order.vultr_disk * 1e9 / 2 ** 30 };
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

// A short rental buys a starter once and converts its credit in place. prepare
// resumes observations after migration; neither purchase nor resize is replayed.
export async function prepareLease(state) {
  await computeRequest(state, "status", {}, randomUUID());
  if (["destroyed", "terminated"].includes(state.providerStatus)) throw new Error("The provider terminated this lease. Observe status.");
  if (!state.resizeRequest) {
    if (state.observedMachine !== state.body.plan || state.resizePending)
      throw new Error("Starter state differs from the saved plan. Inspect before resizing.");
    await prepareAccess(state);
    const machines = await catalog();
    const target = machines.find((item) => item.provider === "vultr" && item.id === state.machine.id);
    const starter = machines.find((item) => item.provider === "vultr" && item.id === state.body.plan);
    if (!target || !starter || !target.locations.includes(state.body.region) || !starter.locations.includes(state.body.region) ||
        money(String(target.our_hourly)) !== money(state.lease.targetHourlyRate) || money(String(starter.our_hourly)) !== money(state.lease.starterHourlyRate) ||
        JSON.stringify(machineCapabilities(target)) !== JSON.stringify(state.capabilities) || JSON.stringify(machineCapabilities(starter)) !== JSON.stringify(state.lease.starterCapabilities))
      throw new Error("Resize capacity or rates changed after purchase. Inspect or close the starter.");
    const remaining = Date.parse(state.providerExpiresAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("Starter expiry is unavailable or elapsed.");
    const converted = Number(BigInt(Math.floor(remaining)) * money(state.lease.starterHourlyRate) / money(state.lease.targetHourlyRate));
    if (converted < state.durationSeconds * 1000) throw new Error("Remaining credit cannot cover the requested target lease. Close or inspect the starter.");
    state.resizeRequest = randomUUID();
    state.leasePhase = "resize_unknown";
    state.resizePending = true;
    // Persist the shorter bound before dispatch, including when the reply is lost.
    state.providerExpiresAt = new Date(Date.now() + Math.min(remaining, converted)).toISOString();
    await save(state);
    await computeRequest(state, "resize", { plan: state.machine.id, confirm_disk_resize: true }, state.resizeRequest);
    return false;
  }
  if (state.resizePending || state.observedMachine !== state.machine.id || !["active", "running"].includes(state.providerStatus)) return false;
  for (const key of ["cpu", "memoryGiB", "diskGiB"])
    if (!Number.isFinite(state.observedResources?.[key]) || state.observedResources[key] < state.capabilities[key])
      throw new Error("Provider has not confirmed the planned target capacity.");
  if (Date.parse(state.providerExpiresAt) - Date.now() < state.durationSeconds * 1000)
    throw new Error("Migration left less than the requested target lease. Inspect or close this machine.");
  await prepareAccess(state);
  const probe = "import json,os,platform; s=os.statvfs('/'); m=int(next(x.split()[1] for x in open('/proc/meminfo') if x.startswith('MemTotal:')))*1024; print(json.dumps({'architecture':platform.machine(),'cpu':os.cpu_count(),'memoryBytes':m,'diskBytes':s.f_blocks*s.f_frsize,'freeBytes':s.f_bavail*s.f_frsize}))";
  const result = await computeRequest(state, "exec", { command: ["python3", "-c", probe] }, randomUUID());
  if (result.returncode !== 0) throw new Error("Guest capacity observation failed.");
  const guest = JSON.parse(result.stdout), required = state.requirements;
  if (guest.architecture !== "x86_64" || ![guest.cpu, guest.memoryBytes, guest.diskBytes, guest.freeBytes].every((value) => Number.isSafeInteger(value) && value > 0) ||
      guest.cpu < state.capabilities.cpu || guest.diskBytes < (required.diskGiB || 0) * 2 ** 30 ||
      // Provider RAM is nominal GiB; usable pages exclude firmware/kernel reserve.
      Math.ceil(guest.memoryBytes / 2 ** 30) < (required.memoryGiB || 1))
    throw new Error("Guest capacity does not satisfy the workload. Inspect or close the machine.");
  if (Date.parse(state.providerExpiresAt) - Date.now() < state.durationSeconds * 1000)
    throw new Error("Insufficient target lease remains for preparation and work.");
  state.guestResources = { ...guest, observedAt: new Date().toISOString() };
  state.leasePhase = "verified";
  await save(state);
  return true;
}
