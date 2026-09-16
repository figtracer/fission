import { open, readFile } from "node:fs/promises";
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
const guestCapacityProbe = await readFile(new URL("../harness/guest-capacity.py", import.meta.url), "utf8");

class DispatchNotStarted extends Error {
  constructor(message) {
    super(message);
    this.notDispatched = true;
  }
}

function requireDispatchWindow(deadline, operation) {
  if (deadline !== undefined && Date.now() >= deadline)
    throw new DispatchNotStarted(`${operation} deadline ${new Date(deadline).toISOString()} passed; no request dispatched.`);
}

export async function catalog(options = {}) {
  // The default endpoint omits dedicated and GPU classes. Read every documented
  // category before comparing offers; an incomplete catalog fails discovery.
  const started = Date.now();
  const categories = await Promise.allSettled(["vps", "vhp", "vdc", "vcg"].map(async (type) => {
    requireDispatchWindow(options.deadline, "Catalog");
    const timeoutMs = Math.max(1, Math.min(60000, (options.deadline || Infinity) - Date.now()));
    try {
      const response = await fetch(endpoint + "plans?type=" + type, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const value = await response.json();
      if (!Array.isArray(value.plans)) throw new Error("invalid plans response");
      return value.plans;
    } catch (error) {
      throw new Error(`${type}: ${error.name === "TimeoutError" ? `timed out after ${timeoutMs}ms` : error.message}`);
    }
  }));
  const failed = categories.filter((item) => item.status === "rejected");
  if (failed.length) throw new Error(`compute-mpp catalog at ${endpoint}plans incomplete after ${Date.now() - started}ms (${failed.map((item) => item.reason.message).join("; ")}). All current VM offers share this gateway.`);
  return categories.flatMap((item) => item.value);
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
  requireDispatchWindow(options.deadline, body ? "Resize" : method === "DELETE" ? "Termination" : "Status");
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
    "-o", `HostKeyAlias=fission-${state.remoteId.toLowerCase()}`,
    "-i", join(directory(state.name), "id_ed25519")];
}

async function ensureHostKeyAlias(state) {
  const path = join(directory(state.name), "known_hosts");
  let text;
  try { text = await readFile(path, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  const alias = `fission-${state.remoteId.toLowerCase()}`;
  const entries = text.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).map((line) => {
    const [hosts, type, key] = line.split(/\s+/);
    return { hosts: hosts?.split(",") || [], type, key };
  });
  if (entries.some((entry) => entry.hosts.includes(alias))) return;
  if (!entries.length) return;
  const legacyHosts = new Set([state.sshHost, `[${state.sshHost}]:22`]);
  const keys = [...new Set(entries.filter((entry) => entry.hosts.some((host) => legacyHosts.has(host)) && entry.type && entry.key)
    .map((entry) => `${entry.type} ${entry.key}`))];
  if (keys.length !== 1)
    throw new Error("Existing SSH host trust cannot be mapped unambiguously to this compute order; explicit recovery is required.");
  const file = await open(path, "a", 0o600);
  try {
    await file.writeFile(`${text.endsWith("\n") ? "" : "\n"}${alias} ${keys[0]}\n`);
    await file.sync();
  } finally { await file.close(); }
}

export async function connect(name, options = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("SSH requires an interactive terminal.");
  const { active } = await import("./workspace.mjs");
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  let ownsInput = false;
  const interrupt = () => { if (!ownsInput) controller.abort(); };
  const terminate = () => controller.abort();
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
  try {
    const state = await active(name);
    if (state.provider !== "compute-mpp") throw new Error("This provider has no SSH access. Use run/exec for its sandbox.");
    // Bootstrap already verified this host. Interactive SSH must not contend
    // with running jobs for the local mutation lock or wait on provider HTTP.
    if (!Number.isFinite(Date.parse(state.providerExpiresAt)) || Date.parse(state.providerExpiresAt) <= Date.now())
      throw new Error("Confirm the current lease with status --refresh before opening SSH.");
    await ensureHostKeyAlias(state);
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
  try {
    await ensureHostKeyAlias(state);
    requireDispatchWindow(options.deadline, "SSH");
  } catch (error) {
    error.notDispatched = true;
    throw error;
  }
  const quote = (arg) => "'" + arg.replaceAll("'", "'\"'\"'") + "'";
  const result = await runProcess("ssh", [...sshArguments(state), `root@${state.sshHost}`,
    command.map(quote).join(" ")], { inputFd: options.inputFd, outputFd: options.outputFd, signal: options.signal, timeoutMs: Math.max(1, Math.min(180000, (options.deadline || Infinity) - Date.now())) });
  if (result.code === null || result.code === 255) {
    const error = new Error("SSH outcome unresolved. Inspect the existing job before executing it again.");
    error.observation = {
      code: result.code,
      signal: result.signal || null,
      interruption: result.interruption || null,
      stderr: result.stderr.trim().slice(-512),
    };
    throw error;
  }
  return { returncode: result.code, stdout: result.stdout, stderr: result.stderr };
}

async function recordAccess(state, observation) {
  state.accessObservations = [...(state.accessObservations || []), {
    at: new Date().toISOString(),
    ...observation,
  }].slice(-24);
  await save(state);
}

const healthyInitialization = (value) => value?.status === "done" && value.extended_status === "done" &&
  Array.isArray(value.errors) && value.errors.length === 0 && value.recoverable_errors &&
  typeof value.recoverable_errors === "object" && !Array.isArray(value.recoverable_errors) &&
  Object.keys(value.recoverable_errors).length === 0;

function initializationResult(result) {
  let value;
  try { value = JSON.parse(result.stdout); } catch { /* Preserve malformed output below. */ }
  return { returncode: result.returncode, stdout: result.stdout, stderr: result.stderr, value: value || null,
    observedAt: new Date().toISOString() };
}

async function rejectInitialization(state, stage, message) {
  state.initialization[stage].error = message;
  if (state.task) state.phase = "prepare_failed";
  await save(state);
  throw new Error(message);
}

export async function verifyInitialization(state, stage, options = {}) {
  if (!["starter", "target", "direct"].includes(stage)) throw new Error("Unknown initialization stage.");
  const bootResult = await computeRequest(state, "exec", { command: ["python3", "-c",
    "import json,time;print(json.dumps({'bootId':open('/proc/sys/kernel/random/boot_id').read().strip(),'guestTime':time.time()}))"] }, randomUUID(), options);
  let boot;
  try { boot = JSON.parse(bootResult.stdout); } catch { /* Reject below. */ }
  if (bootResult.returncode !== 0 || !/^[a-f0-9-]{36}$/.test(boot?.bootId || "") || !Number.isFinite(boot?.guestTime))
    throw new Error("Guest boot identity observation failed.");
  const version = await computeRequest(state, "exec", { command: ["cloud-init", "--version"] }, randomUUID(), options);
  const initial = initializationResult(await computeRequest(state, "exec", {
    command: ["cloud-init", "status", "--format=json"],
  }, randomUUID(), options));
  state.initialization ??= {};
  const previous = state.initialization[stage];
  state.initialization[stage] = previous?.bootId === boot.bootId ? {
    ...previous, latest: initial, version: { returncode: version.returncode, stdout: version.stdout, stderr: version.stderr },
    observedAt: new Date().toISOString(), guestTime: boot.guestTime,
  } : {
    bootId: boot.bootId, guestTime: boot.guestTime, observedAt: new Date().toISOString(),
    version: { returncode: version.returncode, stdout: version.stdout, stderr: version.stderr }, initial, latest: initial,
  };
  await save(state);
  if (version.returncode !== 0) return rejectInitialization(state, stage, "cloud-init is unavailable; resize and bootstrap were not authorized.");

  let final = initial;
  if (!healthyInitialization(initial.value)) {
    const running = initial.returncode === 0 && initial.value?.status === "running" && initial.value?.extended_status === "running" &&
      Array.isArray(initial.value.errors) && initial.value.errors.length === 0 &&
      initial.value.recoverable_errors && typeof initial.value.recoverable_errors === "object" &&
      !Array.isArray(initial.value.recoverable_errors) && Object.keys(initial.value.recoverable_errors).length === 0;
    if (!running) return rejectInitialization(state, stage, "cloud-init reported an unhealthy, disabled, or unreadable terminal state.");
    const seconds = Math.min(60, Math.max(1, Math.floor(((options.deadline || Date.now() + 60000) - Date.now()) / 1000) - 1));
    final = initializationResult(await computeRequest(state, "exec", { command: ["timeout", "--signal=TERM", "--kill-after=5s",
      `${seconds}s`, "cloud-init", "status", "--wait", "--format=json"] }, randomUUID(), options));
    state.initialization[stage].latest = final;
    if (final.returncode === 124) {
      await save(state);
      throw new Error("cloud-init is still running; resize and bootstrap remain pending within the original cutoff.");
    }
  }
  state.initialization[stage].final = final;
  await save(state);
  if (final.returncode !== 0 || !healthyInitialization(final.value))
    return rejectInitialization(state, stage, "cloud-init did not reach a healthy completed state.");
  const sync = await computeRequest(state, "exec", { command: ["sync"] }, randomUUID(), options);
  state.initialization[stage].sync = { returncode: sync.returncode, stdout: sync.stdout, stderr: sync.stderr,
    observedAt: new Date().toISOString() };
  await save(state);
  if (sync.returncode !== 0) return rejectInitialization(state, stage, "Guest filesystem flush failed before resize or bootstrap.");
}

export async function computeRequest(state, operation, body, id, options = {}) {
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
    try { result = await ssh(state, body.command, options); }
    catch (error) {
      await writeJSON(path, { ...intent, state: error.notDispatched ? "not_dispatched" : "unknown",
        finishedAt: new Date().toISOString(), error: error.message, observation: error.observation });
      throw error;
    }
    await writeJSON(join(directory(state.name), "requests", `${id}.response.json`), result);
  }
  else {
    let response;
    try { response = await management(state, operation === "resize" ? "POST" : operation === "terminate" ? "DELETE" : "GET", options, operation === "resize" ? body : undefined); }
    catch (error) {
      await writeJSON(path, { ...intent, state: error.notDispatched ? "not_dispatched" : "unknown",
        finishedAt: new Date().toISOString(), error: error.message });
      throw error;
    }
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
      if (["destroyed", "terminated"].includes(order.status)) state.resizePending = false;
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

export async function prepareAccess(state, options = {}) {
  const key = join(directory(state.name), "id_ed25519");
  // Keys are created once while planning and never copied to the guest.
  await readFile(key);
  const until = Math.min(Date.now() + 300000, options.deadline || Infinity);
  while (Date.now() < until) {
    let response;
    try { response = await management(state, "GET", { deadline: until }); }
    catch (error) {
      await recordAccess(state, { stage: options.stage || "direct", kind: "provider", result: "unavailable", error: error.message });
      throw error;
    }
    const order = response.order || response.instance || response;
    if (!order || order.id !== state.remoteId) throw new Error("Unrecognized compute status while waiting for SSH.");
    if (["destroyed", "terminated", "failed", "expired"].includes(order.status)) throw new Error(`Compute provisioning is ${order.status}.`);
    const provider = {
      stage: options.stage || "direct",
      kind: "provider",
      order: order.id,
      status: order.status || null,
      ip: usableIP(order.ip_address) ? order.ip_address : null,
      machine: order.vultr_plan || null,
      serverStatus: order.vultr_server_status || null,
      resizePending: Boolean(order.metadata?.resize_pending),
    };
    if (usableIP(order.ip_address)) {
      state.sshHost = order.ip_address;
      await recordAccess(state, provider);
      try {
        if ((await ssh(state, ["true"], { deadline: until })).returncode === 0) {
          await recordAccess(state, { ...provider, kind: "ssh", result: "ready" });
          return;
        }
      } catch (error) {
        await recordAccess(state, { ...provider, kind: "ssh", result: "unavailable", ...error.observation });
      }
    } else {
      await recordAccess(state, provider);
    }
    await delay(Math.min(5000, Math.max(1, until - Date.now())));
  }
  throw new Error(`SSH readiness timed out at ${new Date(until).toISOString()}. Reconcile the existing instance; do not purchase again.`);
}

// A short rental buys a starter once and converts its credit in place. prepare
// resumes observations after migration; neither purchase nor resize is replayed.
export async function prepareLease(state, options = {}) {
  if (!state.resizeRequest && options.deadline !== undefined && Date.now() >= options.deadline)
    throw new Error(`Preparation cutoff ${new Date(options.deadline).toISOString()} passed; no resize submitted.`);
  await computeRequest(state, "status", {}, randomUUID(), options);
  if (["destroyed", "terminated"].includes(state.providerStatus)) throw new Error("The provider terminated this lease. Observe status.");
  if (!state.resizeRequest) {
    if (state.observedMachine !== state.body.plan || state.resizePending)
      throw new Error("Starter state differs from the saved plan. Inspect before resizing.");
    await prepareAccess(state, { ...options, stage: "starter" });
    await verifyInitialization(state, "starter", options);
    const machines = await catalog(options);
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
    if (options.deadline !== undefined && Date.now() >= options.deadline)
      throw new Error(`Preparation cutoff ${new Date(options.deadline).toISOString()} passed after starter stabilization; no resize submitted.`);
    state.resizeRequest = randomUUID();
    state.leasePhase = "resize_unknown";
    state.resizePending = true;
    // Persist the shorter bound before dispatch, including when the reply is lost.
    state.providerExpiresAt = new Date(Date.now() + Math.min(remaining, converted)).toISOString();
    await save(state);
    await computeRequest(state, "resize", { plan: state.machine.id, confirm_disk_resize: true }, state.resizeRequest, options);
    return false;
  }
  if (state.resizePending || state.observedMachine !== state.machine.id || !["active", "running"].includes(state.providerStatus)) return false;
  const minimumRemaining = state.task
    ? Math.max(60, Math.ceil((state.task.deadline - Date.now()) / 1000))
    : state.preparationAcceptance?.minimumSeconds ?? state.durationSeconds;
  if (!Number.isSafeInteger(minimumRemaining) || minimumRemaining < 60 || minimumRemaining > state.durationSeconds)
    throw new Error("Invalid accepted remaining-time minimum.");
  for (const key of ["cpu", "memoryGiB", "diskGiB"])
    if (!Number.isFinite(state.observedResources?.[key]) || state.observedResources[key] < state.capabilities[key])
      throw new Error("Provider has not confirmed the planned target capacity.");
  if (Date.parse(state.providerExpiresAt) - Date.now() < minimumRemaining * 1000)
    throw new Error("Migration left less than the requested target lease. Inspect or close this machine.");
  await prepareAccess(state, { ...options, stage: "target" });
  await verifyInitialization(state, "target", options);
  await verifyGuest(state, options);
  if (Date.parse(state.providerExpiresAt) - Date.now() < minimumRemaining * 1000)
    throw new Error("Insufficient target lease remains for preparation and work.");
  state.leasePhase = "verified";
  await save(state);
  return true;
}

export async function verifyGuest(state, options = {}) {
  const result = await computeRequest(state, "exec", { command: ["python3", "-c", guestCapacityProbe] }, randomUUID(), options);
  if (result.returncode !== 0) throw new Error("Guest capacity observation failed.");
  const guest = JSON.parse(result.stdout), required = state.requirements;
  state.guestResources = { ...guest, observedAt: new Date().toISOString(), verified: false };
  await save(state);
  if (guest.architecture !== "x86_64" || typeof guest.rootDevice !== "string" ||
      ![guest.cpu, guest.memoryBytes, guest.filesystemBytes, guest.freeBytes, guest.rootDiskBytes].every((value) => Number.isSafeInteger(value) && value > 0) ||
      guest.cpu < state.capabilities.cpu || guest.rootDiskBytes < state.machine.disk * 1e9 ||
      guest.filesystemBytes < (required.diskGiB || 0) * 2 ** 30 ||
      // Provider RAM is nominal GiB; usable pages exclude firmware/kernel reserve.
      Math.ceil(guest.memoryBytes / 2 ** 30) < state.capabilities.memoryGiB) {
    state.guestResources.verificationError = "Guest has not converged to the selected machine capacity.";
    await save(state);
    throw new Error("Guest has not converged to the selected machine capacity. Inspect or close the machine.");
  }
  state.guestResources.verified = true;
  await save(state);
}
