import { readFile, mkdir, rename } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { locked, writeJSON } from "./state.mjs";
import { active, upload, download, operationCap } from "./workspace.mjs";
import { launch, getJob } from "./jobs.mjs";
import { execute } from "./provider.mjs";
import { storageRoot, storage } from "./storage.mjs";
import { digest, fingerprint } from "./experiments.mjs";

const remote = (id) => {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(id || "")) throw new Error("Use a lowercase dataset job name, up to 48 characters.");
  return `/workspace/.fission/datasets/${id}`;
};
const validate = (value, maximum) => {
  if (value.schemaVersion !== 1 || value.kind !== "reth-execution" || value.chainId !== 1 || value.storageVersion !== 2 ||
      !/^[a-f0-9]{64}$/.test(value.writerSha256 || "") || !/^[a-f0-9]{64}$/.test(value.manifestSha256 || "") ||
      !Number.isSafeInteger(value.fileBytes) || value.fileBytes <= 0 || value.fileBytes > maximum ||
      !Number.isSafeInteger(value.archiveBytes) || value.archiveBytes <= 0 || value.archiveBytes > maximum ||
      !Number.isSafeInteger(value.fileCount) || value.fileCount <= 0 || !Array.isArray(value.parts) || !value.parts.length ||
      value.parts.some((part, index) => part.path !== `part-${String(index).padStart(6, "0")}` || !Number.isSafeInteger(part.bytes) || part.bytes <= 0 || part.bytes > 64 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(part.sha256)) ||
      value.parts.reduce((sum, part) => sum + part.bytes, 0) !== value.archiveBytes)
    throw new Error("Invalid or oversized dataset manifest.");
  return value;
};

export async function dataset(action, name, id, options, seconds) {
  const maximum = Number(options["max-bytes"]);
  if (!Number.isSafeInteger(maximum) || maximum <= 0) throw new Error("Set a positive --max-bytes for the dataset archive and extracted data.");
  if (action !== "restore") await storage(options["storage-dir"]);
  const helper = await readFile(new URL("../harness/dataset.py", import.meta.url), "utf8");
  return locked(name, async () => {
    const state = await active(name);
    if (state.provider !== "compute-mpp" || state.recipe.name !== "reth-synced") throw new Error("Dataset preservation requires a prepared Reth VM.");
    if (action === "save") {
      if (!(await storage(options["storage-dir"], maximum)).fits) throw new Error("Insufficient local storage for the chosen limit. Select a larger drive with --storage-dir.");
      return launch(state, id, [["python3", "-c", helper, "save", remote(id), String(maximum)]], seconds);
    }
    if (action === "inspect") {
      const result = await execute(state, ["python3", "-c", helper, "inspect", remote("inspect"), String(maximum)], operationCap);
      if (result.returncode) throw new Error(result.stderr.slice(-2000));
      const observation = JSON.parse(result.stdout);
      return { ...observation, storage: await storage(options["storage-dir"], observation.fileBytes),
        maximumBytes: maximum, fitsLimit: observation.fileBytes <= maximum, note: "Archive headers and temporary guest staging require additional space. Stop the node pair before saving." };
    }
    if (action === "collect") {
      const job = await getJob(name, id);
      if (job.phase !== "succeeded" || job.spec.commands?.[0]?.[3] !== "save" || job.spec.commands[0][4] !== remote(id))
        throw new Error("Observe the dataset save job to successful completion before collecting.");
      const response = await execute(state, ["python3", "-c", "import pathlib,sys; print(pathlib.Path(sys.argv[1]).read_text())", remote(id) + "/manifest.json"], operationCap);
      if (response.returncode) throw new Error("Dataset manifest unavailable.");
      const manifest = validate(JSON.parse(response.stdout), maximum), key = digest(manifest);
      const folder = join(storageRoot(options["storage-dir"]), "datasets", key);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      let remaining = manifest.archiveBytes;
      const missing = [];
      for (const part of manifest.parts) {
        const path = join(folder, part.path);
        try {
          const actual = await fingerprint(path);
          if (actual.bytes !== part.bytes || actual.sha256 !== part.sha256) throw new Error(`Saved chunk changed: ${path}`);
          remaining -= part.bytes;
        } catch (error) { if (error.code !== "ENOENT") throw error; missing.push(part); }
      }
      if (!(await storage(folder, remaining)).fits) throw new Error("Insufficient local space for the remaining dataset chunks.");
      await writeJSON(join(folder, "pending.json"), { name, job: id, manifest });
      for (const part of missing) {
        const path = join(folder, part.path), staging = path + ".partial-" + randomUUID();
        const result = await download(state, remote(id) + "/" + part.path, staging);
        if (result.bytes !== part.bytes || result.sha256 !== part.sha256) throw new Error("Dataset chunk changed during collection; partial files retained.");
        await rename(staging, path);
      }
      await writeJSON(join(folder, "manifest.json"), { ...manifest, digest: key });
      return { saved: true, id: key, manifest: join(folder, "manifest.json"), bytes: manifest.archiveBytes, custody: "local" };
    }
    if (action === "restore") {
      if (!options.from) throw new Error("Use --from PATH/manifest.json for dataset restore.");
      const file = resolve(options.from), folder = dirname(file);
      const { digest: expected, ...contents } = JSON.parse(await readFile(file, "utf8"));
      if (digest(contents) !== expected) throw new Error("Dataset manifest changed after collection.");
      const manifest = validate(contents, maximum);
      if (await getJob(name, id).catch((error) => { if (error.message === "Unknown job.") return null; throw error; }))
        throw new Error("Restore job already exists. Observe it instead of uploading again.");
      for (const part of manifest.parts) {
        const actual = await fingerprint(join(folder, part.path));
        if (actual.bytes !== part.bytes || actual.sha256 !== part.sha256) throw new Error(`Changed dataset chunk: ${part.path}`);
      }
      // Read-only remote observations make chunk upload resumable. A present,
      // different chunk is preserved for inspection instead of overwritten.
      for (const part of [{ path: "manifest.json", ...await fingerprint(file) }, ...manifest.parts]) {
        const destination = remote(id) + "/" + part.path;
        const probe = await execute(state, ["python3", "-c", "import hashlib,json,pathlib,sys; p=pathlib.Path(sys.argv[1]); print(json.dumps(None if not p.exists() else {'bytes':p.stat().st_size,'sha256':hashlib.file_digest(p.open('rb'),'sha256').hexdigest()}))", destination], operationCap);
        if (probe.returncode) throw new Error("Could not inspect restore staging.");
        const existing = JSON.parse(probe.stdout);
        if (existing) {
          if (existing.bytes !== part.bytes || existing.sha256 !== part.sha256) throw new Error("Different restore data already staged; preserve it.");
        } else await upload(state, part.path === "manifest.json" ? file : join(folder, part.path), destination);
        if (part.path === "manifest.json") {
          const preflight = await execute(state, ["python3", "-c", helper, "restore-inspect", remote(id), String(maximum)], operationCap);
          if (preflight.returncode) throw new Error(`Dataset restore preflight failed: ${preflight.stderr.slice(-2000)}`);
        }
      }
      return launch(state, id, [["python3", "-c", helper, "restore", remote(id), String(maximum)]], seconds);
    }
    throw new Error("Use dataset inspect, save, collect, or restore.");
  });
}
