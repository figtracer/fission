import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { locked, save } from "./state.mjs";
import { active, download, operationCap, upload } from "./workspace.mjs";
import { execute } from "./provider.mjs";

const helper = await readFile(new URL("../harness/cache-host.py", import.meta.url), "utf8");
const cacheRoot = "/workspace/.fission/cache-host-v1";

function requireLease(state, minimumUntil = Date.now()) {
  const expiry = Date.parse(state.providerExpiresAt);
  if (!Number.isFinite(expiry) || expiry <= minimumUntil)
    throw new Error("Cache VPS has insufficient observed lease time. Refresh or choose another initialized host before purchasing work.");
}

async function host(name, minimumUntil = Date.now(), initialized = true) {
  const state = await active(name);
  if (state.task) throw new Error("A managed task cannot become a cache VPS; its supervisor may destroy it.");
  if (state.provider !== "compute-mpp" || state.kind !== "linux-vm" || state.phase !== "ready")
    throw new Error("Cache storage requires a ready retained compute-mpp Linux VM workspace.");
  requireLease(state, minimumUntil);
  if (initialized && (state.cacheHost?.schemaVersion !== 1 || state.cacheHost.remoteId !== state.remoteId))
    throw new Error("Initialize this exact VPS with fission advanced cache init HOST.");
  return state;
}

function parse(result, operation) {
  if (result.returncode !== 0) throw new Error(`Cache VPS ${operation} failed: ${result.stderr.slice(-2000)}`);
  let value;
  try { value = JSON.parse(result.stdout); } catch { throw new Error(`Cache VPS ${operation} returned invalid JSON.`); }
  return value;
}

export async function initCacheHost(name) {
  return locked(name, async () => {
    const state = await host(name, Date.now(), false);
    const value = parse(await execute(state, ["python3", "-c", helper, "init", state.remoteId], operationCap), "initialization");
    if (value.schemaVersion !== 1 || value.kind !== "fission-build-cache" || value.remoteId !== state.remoteId ||
        !Number.isSafeInteger(value.availableBytes) || value.availableBytes < 0)
      throw new Error("Cache VPS initialization acknowledgement is invalid.");
    state.cacheHost = { schemaVersion: 1, remoteId: state.remoteId, root: cacheRoot,
      initializedAt: state.cacheHost?.initializedAt || new Date().toISOString() };
    await save(state);
    return { workspace: name, provider: state.provider, remoteId: state.remoteId,
      providerExpiresAt: state.providerExpiresAt, availableBytes: value.availableBytes, cache: state.cacheHost };
  });
}

export async function listHostCaches(name, minimumUntil = Date.now()) {
  return locked(name, async () => {
    const state = await host(name, minimumUntil);
    const value = parse(await execute(state, ["python3", "-c", helper, "list", state.remoteId], operationCap), "listing");
    if (value.schemaVersion !== 1 || !Array.isArray(value.records) || value.records.length > 1000 ||
        !Number.isSafeInteger(value.availableBytes) || value.availableBytes < 0)
      throw new Error("Cache VPS listing is invalid.");
    return { workspace: name, remoteId: state.remoteId, providerExpiresAt: state.providerExpiresAt,
      availableBytes: value.availableBytes, records: value.records };
  });
}

export async function stageHostCache(name, record, local, maximum, options = {}) {
  return locked(name, async () => {
    const state = await host(name);
    const remote = `${cacheRoot}/builds/${record.id}/build.tar.gz`;
    return download(state, remote, local, { ...options,
      expected: { size: record.bytes, sha256: record.id, maximum } });
  });
}

export async function publishHostCache(name, local, record, options = {}) {
  return locked(name, async () => {
    const state = await host(name);
    const listing = parse(await execute(state, ["python3", "-c", helper, "list", state.remoteId], operationCap, undefined, options), "capacity check");
    if (!Number.isSafeInteger(listing.availableBytes) || listing.availableBytes < record.bytes)
      throw new Error("Cache VPS lacks observed space for this archive; no upload started.");
    const remote = `${cacheRoot}/staging/${randomUUID()}.tar.gz`;
    await upload(state, local, remote, options);
    const published = parse(await execute(state, ["python3", "-c", helper, "publish", state.remoteId, remote,
      JSON.stringify(record)], operationCap, undefined, options), "publication");
    if (published.id !== record.id || published.bytes !== record.bytes || typeof published.alreadyPresent !== "boolean")
      throw new Error("Cache VPS publication acknowledgement is invalid.");
    return { ...published, workspace: name, remoteId: state.remoteId };
  });
}
