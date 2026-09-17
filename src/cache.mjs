import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { locked, readJSON, root, writeJSON } from "./state.mjs";
import { active, upload, download, duration, operationCap, sourceRecipes } from "./workspace.mjs";
import { execute } from "./provider.mjs";
import { fingerprint } from "./experiments.mjs";
import { storageRoot, storage } from "./storage.mjs";
import { listHostCaches, publishHostCache, stageHostCache } from "./cache-host.mjs";

const identifier = (cacheRoot, id) => {
  if (!/^[a-f0-9]{64}$/.test(id || "")) throw new Error("Use a SHA-256 cache ID from cache list.");
  return join(cacheRoot, id);
};

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function listCaches(path, cacheWorkspace) {
  if (path && cacheWorkspace) throw new Error("Use either --storage-dir or --cache-workspace, not both.");
  if (cacheWorkspace) return (await listHostCaches(cacheWorkspace)).records;
  await storage(path);
  const cacheRoot = join(storageRoot(path), "builds");
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const names = await readdir(cacheRoot);
  const records = await Promise.all(names.filter((name) => /^[a-f0-9]{64}$/.test(name)).sort().map((id) => readJSON(join(identifier(cacheRoot, id), "cache.json"))));
  return records.filter(Boolean);
}

// Inspect candidate metadata before any rental or quote. Local archives are
// hashed immediately; a VPS archive is bounded and hashed before guest use.
// A candidate is not a hit until the guest verifies its complete build identity.
export async function cachePreflight(options, definition) {
  const cacheWorkspace = options["cache-workspace"];
  const maximum = cacheWorkspace ? Number(options["cache-max-bytes"]) : undefined;
  if (cacheWorkspace && (!Number.isSafeInteger(maximum) || maximum <= 0))
    throw new Error("A cache VPS requires a positive integer --cache-max-bytes transfer and expansion limit.");
  const location = cacheWorkspace
    ? await listHostCaches(cacheWorkspace, Date.now() + duration(options.duration) * 1000)
    : await storage();
  const records = cacheWorkspace ? location.records : await listCaches();
  const result = { kind: "release-binaries", checkedBeforeRental: true,
    backend: cacheWorkspace ? { kind: "workspace", name: cacheWorkspace, remoteId: location.remoteId,
      providerExpiresAt: location.providerExpiresAt } : { kind: "directory", directory: location.directory },
    ...(cacheWorkspace ? { maximum } : { directory: location.directory }),
    candidate: null, excluded: [], note: "Exact guest identity must match. No Cargo target/test cache or cross-commit reuse is implied." };
  if (options.mode !== "build" || options.patch) {
    result.note = options.patch ? "Patched source is not eligible for clean binary caches." : "Release binaries cannot accelerate Cargo test compilation; no test cache is claimed.";
    result.inspected = records.length;
    return result;
  }
  const harness = await fingerprint(new URL("../harness/rust-source.py", import.meta.url));
  for (const record of records.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)))) {
    const identity = record.identity;
    if (identity?.commit !== options.ref || JSON.stringify(identity.binaries) !== JSON.stringify(sourceRecipes[definition.name])) continue;
    try {
      if (!identity.clean || !identity.tree || identity.harnessSha256 !== harness.sha256)
        throw new Error("Source identity schema or preparation harness differs");
      if (record.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(record.id || "") || !Number.isSafeInteger(record.bytes) || record.bytes <= 0 ||
          !Number.isSafeInteger(record.uncompressedBytes) || record.uncompressedBytes <= 0)
        throw new Error("Archive digest, size or metadata differs");
      const limit = Math.max(record.bytes, record.uncompressedBytes);
      if (cacheWorkspace && limit > maximum) throw new Error("Archive exceeds --cache-max-bytes");
      if (cacheWorkspace) {
        result.candidate = { id: record.id, bytes: record.bytes, maximum: limit, savedAt: record.savedAt,
          cacheWorkspace, remote: `/workspace/.fission/cache-host-v1/builds/${record.id}/build.tar.gz` };
      } else {
        const path = join(identifier(join(location.directory, "builds"), record.id), "build.tar.gz");
        const actual = await fingerprint(path);
        if (actual.sha256 !== record.id || actual.bytes !== record.bytes) throw new Error("Archive digest or size differs");
        result.candidate = { id: record.id, local: path, bytes: actual.bytes, maximum: limit, savedAt: record.savedAt };
      }
      break;
    } catch (error) { result.excluded.push({ id: record.id, reason: error.message }); }
  }
  return result;
}

export async function stageCacheInput(name, input, options = {}) {
  if (!input.cache?.workspace || !/^[a-f0-9]{64}$/.test(input.sha256 || "")) throw new Error("Invalid VPS cache input descriptor.");
  const path = join(root, ".cache-staging", name, input.sha256, "build.tar.gz");
  try {
    const actual = await fingerprint(path);
    if (actual.sha256 !== input.sha256 || actual.bytes !== input.bytes) throw new Error("Retained staging archive differs.");
    return path;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await stageHostCache(input.cache.workspace, { id: input.sha256, bytes: input.bytes }, path, input.cache.maximum, options);
  return path;
}

async function remoteBuildCache(action, name, id, maximum, cacheWorkspace, options) {
  if (!Number.isSafeInteger(maximum) || maximum <= 0) throw new Error("Set a positive integer --max-bytes for archive and uncompressed artifacts.");
  if (action === "restore") {
    const records = await listCaches(undefined, cacheWorkspace);
    const metadata = records.find((record) => record.id === id);
    if (!metadata || metadata.bytes > maximum || metadata.uncompressedBytes > maximum)
      throw new Error("Cache metadata or byte limit does not match.");
    const folder = join(root, ".cache-staging", "restore", name, randomUUID()), path = join(folder, "build.tar.gz");
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await stageHostCache(cacheWorkspace, metadata, path, maximum, options);
    try {
      return await locked(name, async () => {
        const state = await active(name);
        if (!Object.hasOwn(sourceRecipes, state.recipe.name)) throw new Error("Build caches require a prepared source recipe.");
        const prepared = await execute(state, ["python3", "-c", "import pathlib; print(pathlib.Path('/workspace/source.json').read_text())"], operationCap, undefined, options);
        if (prepared.returncode || canonicalJson(JSON.parse(prepared.stdout).identity) !== canonicalJson(metadata.identity))
          throw new Error("Cache differs from the prepared source environment; no archive uploaded.");
        const remote = `/workspace/.fission/cache-${randomUUID()}.tar.gz`;
        await upload(state, path, remote, options);
        const result = await execute(state, ["python3", "/workspace/.fission/rust-source.py", "cache-restore", remote, String(maximum)], operationCap, undefined, options);
        if (result.returncode !== 0) throw new Error(`Cache restore failed: ${result.stderr.slice(-2000)}`);
        return JSON.parse(result.stdout);
      });
    } finally { await rm(folder, { recursive: true, force: true }); }
  }

  const folder = join(root, ".cache-staging", "save", name, randomUUID()), path = join(folder, "build.tar.gz");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  let record;
  try {
    record = await locked(name, async () => {
      const state = await active(name);
      if (!Object.hasOwn(sourceRecipes, state.recipe.name)) throw new Error("Build caches require a prepared source recipe.");
      const remote = `/workspace/.fission/cache-${randomUUID()}.tar.gz`;
      const result = await execute(state, ["python3", "/workspace/.fission/rust-source.py", "cache-save", remote, String(maximum)], operationCap, undefined, options);
      if (result.returncode !== 0) throw new Error(`Cache save failed: ${result.stderr.slice(-2000)}`);
      const observation = JSON.parse(result.stdout);
      if (!/^[a-f0-9]{64}$/.test(observation.sha256 || "") || !Number.isSafeInteger(observation.bytes) || observation.bytes <= 0 || observation.bytes > maximum ||
          !Number.isSafeInteger(observation.uncompressedBytes) || observation.uncompressedBytes <= 0 || observation.uncompressedBytes > maximum)
        throw new Error("Invalid remote cache size or digest; no download started.");
      await download(state, remote, path, { ...options,
        expected: { size: observation.bytes, sha256: observation.sha256, maximum } });
      return { ...observation, schemaVersion: 1, id: observation.sha256, machine: name,
        savedAt: new Date().toISOString(), archive: "build.tar.gz" };
    });
    const published = await publishHostCache(cacheWorkspace, path, record, options);
    await rm(folder, { recursive: true, force: true });
    return { ...record, cacheWorkspace, publication: published };
  } catch (error) {
    throw new Error(`${error.message} Local VPS-cache staging is retained at ${folder}; no transfer was retried.`);
  }
}

export async function buildCache(action, name, id, limit, storageDirectory, options = {}) {
  if (!["save", "restore"].includes(action)) throw new Error("Use cache save NAME, cache restore NAME ID, or cache list.");
  if (storageDirectory && options.cacheWorkspace) throw new Error("Use either --storage-dir or --cache-workspace, not both.");
  if (options.cacheWorkspace) return remoteBuildCache(action, name, id, Number(limit), options.cacheWorkspace, options);
  const cacheRoot = join(storageRoot(storageDirectory), "builds");
  const local = await storage(storageDirectory);
  // Managed collection leaves room for both the cache and copied report artifacts.
  const maximum = limit === undefined && action === "save" ? Math.floor(local.availableBytes / 2) : Number(limit);
  if (!Number.isSafeInteger(maximum) || maximum <= 0) throw new Error("Set a positive integer --max-bytes for archive and uncompressed artifacts.");
  return locked(name, async () => {
    const state = await active(name);
    if (!Object.hasOwn(sourceRecipes, state.recipe.name)) throw new Error("Build caches require a prepared source recipe.");
    if (action === "save" && !(await storage(storageDirectory, maximum)).fits) throw new Error("Local storage has less free space than the chosen byte limit. Select --storage-dir or a smaller explicit limit.");
    const remote = `/workspace/.fission/cache-${randomUUID()}.tar.gz`;
    const command = ["python3", "/workspace/.fission/rust-source.py", `cache-${action}`, remote];
    if (action === "restore") {
      const folder = identifier(cacheRoot, id), path = join(folder, "build.tar.gz");
      const metadata = await readJSON(join(folder, "cache.json"));
      const actual = await fingerprint(path);
      if (!metadata || metadata.schemaVersion !== 1 || !Number.isSafeInteger(metadata.uncompressedBytes) || metadata.uncompressedBytes <= 0 || !metadata.identity || metadata.id !== id || actual.sha256 !== id || actual.bytes !== metadata.bytes || actual.bytes > maximum || metadata.uncompressedBytes > maximum)
        throw new Error("Cache metadata, digest, or byte limit does not match.");
      const prepared = await execute(state, ["python3", "-c", "import pathlib; print(pathlib.Path('/workspace/source.json').read_text())"], operationCap, undefined, options);
      if (prepared.returncode || canonicalJson(JSON.parse(prepared.stdout).identity) !== canonicalJson(metadata.identity))
        throw new Error("Cache differs from the prepared source environment; no archive uploaded.");
      await upload(state, path, remote, options);
      command.push(id);
    }
    command.push(String(maximum));
    const result = await execute(state, command, operationCap, undefined, options);
    if (result.returncode !== 0) throw new Error(`Cache ${action} failed: ${result.stderr.slice(-2000)}`);
    const observation = JSON.parse(result.stdout);
    if (action === "restore") return observation;
    if (!/^[a-f0-9]{64}$/.test(observation.sha256 || "") || !Number.isSafeInteger(observation.bytes) || observation.bytes <= 0 || observation.bytes > maximum ||
        !Number.isSafeInteger(observation.uncompressedBytes) || observation.uncompressedBytes <= 0 || observation.uncompressedBytes > maximum)
      throw new Error("Invalid remote cache size or digest; no download started.");
    await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
    const staging = join(cacheRoot, `.partial-${randomUUID()}`);
    await mkdir(staging, { mode: 0o700 });
    const path = join(staging, "build.tar.gz");
    await download(state, remote, path, options);
    const actual = await fingerprint(path);
    if (actual.sha256 !== observation.sha256 || actual.bytes !== observation.bytes) throw new Error("Cache changed during transfer; partial files retained.");
    const record = { ...observation, id: actual.sha256, machine: name, savedAt: new Date().toISOString(), archive: "build.tar.gz" };
    await writeJSON(join(staging, "cache.json"), record);
    try { await rename(staging, identifier(cacheRoot, record.id)); }
    catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error; }
    return record;
  });
}
