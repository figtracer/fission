import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { locked, directory, writeJSON } from "./state.mjs";
import { active, operationCap, sourceRecipes } from "./workspace.mjs";
import { execute } from "./provider.mjs";

export function probes(recipe, scope, maxHeadAge) {
  let checks = recipe.checks?.filter((probe) => probe.scope === scope) || [];
  if (!checks.length && scope === "tools") checks = (recipe.readiness || []).map((argv, i) => ({ name: `tool-${i + 1}`, scope, argv, result: "exit" }));
  if (!checks.length && scope === "build" && Object.hasOwn(sourceRecipes, recipe.name))
    checks = [{ name: "compiled-artifacts", scope, argv: ["python3", "/workspace/.fission/rust-source.py", "verify", ...sourceRecipes[recipe.name]], result: "json" }];
  if (!checks.length && scope === "node" && recipe.name === "reth-synced") {
    if (!Number.isSafeInteger(Number(maxHeadAge)) || Number(maxHeadAge) <= 0) throw new Error("Synced Reth readiness requires an explicit --max-head-age in seconds.");
    checks = [{ name: "snapshot-and-storage", scope, result: "json", argv: ["python3", "-c", `import hashlib,json,pathlib,shutil
root=pathlib.Path('/workspace/ethereum-data'); snapshot=json.loads((root/'snapshot.json').read_text()); manifest=root/'manifest.json'
valid=hashlib.sha256(manifest.read_bytes()).hexdigest()==snapshot['manifestSha256']
free=shutil.disk_usage(root).free; minimum=snapshot['extraDiskGiB']*2**30
checks={'manifest':valid,'fullImport':snapshot.get('selection')=='full' and bool(snapshot.get('completedAt')),'databaseVersion':snapshot.get('storageVersion')==2,'diskAllowance':free>=minimum,'configuration':(root/'execution'/'reth.toml').is_file()}
print(json.dumps({'ready':all(checks.values()),'checks':checks,'snapshotBlock':snapshot['block'],'storageVersion':snapshot['storageVersion'],'freeBytes':free,'requiredFreeBytes':minimum,'importer':snapshot['importer']}))`] }, { name: "execution-consensus-pair", scope,
      argv: ["/workspace/ethereum", "status", "--max-head-age", String(maxHeadAge)], result: "json" }];
  } else if (maxHeadAge !== undefined) throw new Error("--max-head-age applies to the synced Reth node check.");
  if (!checks.length) throw new Error(`Recipe has no ${scope} checks. Define named checks in the recipe.`);
  return checks;
}

export async function check(name, scope, seconds, maxHeadAge) {
  // Keep the guest deadline below SSH’s three-minute transport bound.
  if (seconds > 120) throw new Error("Readiness observations allow at most 2m; use a bounded job for preparation or waiting.");
  return locked(name, async () => {
    const state = await active(name);
    const checks = probes(state.recipe, scope, maxHeadAge);
    const deadline = Math.min(Date.now() / 1000 + seconds, Date.parse(state.providerExpiresAt || state.deadlineEstimate) / 1000);
    if (!Number.isFinite(deadline) || deadline <= Date.now() / 1000) throw new Error("No remaining lease time for readiness.");
    const runner = await readFile(new URL("../harness/readiness.py", import.meta.url), "utf8");
    const id = randomUUID(), path = join(directory(name), "checks", `${id}.json`);
    const record = { id, name, scope, phase: "observation_unknown", recipeSha256: state.recipe.digest,
      runnerSha256: createHash("sha256").update(runner).digest("hex"), requestedAt: new Date().toISOString(), checks, deadline };
    await writeJSON(path, record);
    const result = await execute(state, ["python3", "-c", runner, JSON.stringify({ scope, checks, deadline })], operationCap);
    const observation = JSON.parse(result.stdout);
    if ((result.returncode === 0) !== (observation.ready === true) || observation.schemaVersion !== 1 || observation.scope !== scope || !Array.isArray(observation.checks) || typeof observation.ready !== "boolean")
      throw new Error("Invalid readiness response. Observation remains unresolved.");
    record.phase = "observed";
    record.observation = observation;
    await writeJSON(path, record);
    return { ...observation, id, record: path };
  });
}
