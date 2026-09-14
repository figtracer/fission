import { mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { locked, readJSON, writeJSON } from "./state.mjs";
import { active, upload, download, operationCap, sourceRecipes } from "./workspace.mjs";
import { execute } from "./provider.mjs";
import { fingerprint } from "./experiments.mjs";
import { storageRoot, storage } from "./storage.mjs";

const identifier = (cacheRoot, id) => {
  if (!/^[a-f0-9]{64}$/.test(id || "")) throw new Error("Use a SHA-256 cache ID from cache list.");
  return join(cacheRoot, id);
};
export async function listCaches(path) {
  await storage(path);
  const cacheRoot = join(storageRoot(path), "builds");
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const names = await readdir(cacheRoot);
  const records = await Promise.all(names.filter((name) => /^[a-f0-9]{64}$/.test(name)).sort().map((id) => readJSON(join(identifier(cacheRoot, id), "cache.json"))));
  return records.filter(Boolean);
}

export async function buildCache(action, name, id, limit, storageDirectory) {
  const cacheRoot = join(storageRoot(storageDirectory), "builds");
  if (!["save", "restore"].includes(action)) throw new Error("Use cache save NAME, cache restore NAME ID, or cache list.");
  await storage(storageDirectory);
  const maximum = Number(limit);
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
      const prepared = await execute(state, ["python3", "-c", "import pathlib; print(pathlib.Path('/workspace/source.json').read_text())"], operationCap);
      if (prepared.returncode || JSON.stringify(JSON.parse(prepared.stdout).identity) !== JSON.stringify(metadata.identity))
        throw new Error("Cache differs from the prepared source environment; no archive uploaded.");
      await upload(state, path, remote);
      command.push(id);
    }
    command.push(String(maximum));
    const result = await execute(state, command, operationCap);
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
    await download(state, remote, path);
    const actual = await fingerprint(path);
    if (actual.sha256 !== observation.sha256 || actual.bytes !== observation.bytes) throw new Error("Cache changed during transfer; partial files retained.");
    const record = { ...observation, id: actual.sha256, machine: name, savedAt: new Date().toISOString(), archive: "build.tar.gz" };
    await writeJSON(join(staging, "cache.json"), record);
    try { await rename(staging, identifier(cacheRoot, record.id)); }
    catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error; }
    return record;
  });
}
