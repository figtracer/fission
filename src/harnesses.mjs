import { readFile, stat } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { recipe, duration, sourceRecipes } from "./workspace.mjs";
import { fingerprint } from "./experiments.mjs";

// Shared by CLI validation and multi-machine manifests.
export const taskOptions = ["harness", "mode", "chain", "solver", "budget", "duration", "work-duration", "prepare-duration", "region", "cpu", "memory", "disk", "repo", "ref", "patch", "cwd", "input", "artifact", "output", "manifest", "snapshot-plan", "checkpoint-url", "checkpoint", "max-head-age", "extra-disk-gib"];

// One selection contract; recipes remain the pinned preparation source of truth.
export const harnesses = {
  foundry: { modes: ["tools", "test", "build"], description: "Contract tests, fuzz/invariants, symbolic properties, or test/build Foundry itself." },
  reth: { modes: ["dev", "test", "build", "synced"], description: "Private development chain, client tests/build, or Ethereum mainnet with Lighthouse. Base/BSC clients are not implemented." },
  tempo: { modes: ["dev", "tools", "test", "build"], description: "Private Tempo chain, Foundry's Tempo contract model, or client tests/build." },
  linux: { modes: ["tools"], description: "Plain Linux x86 shell/Python fallback." },
};

export async function taskSpec(options, command) {
  const harness = options.harness;
  if (!Object.hasOwn(harnesses, harness || "")) throw new Error("Choose --harness foundry, reth, tempo, or linux.");
  const mode = options.mode || harnesses[harness].modes[0];
  if (!harnesses[harness].modes.includes(mode)) throw new Error(`Modes for ${harness}: ${harnesses[harness].modes.join(", ")}.`);
  const source = ["test", "build"].includes(mode);
  if (options.chain !== undefined && (harness !== "reth" || options.chain !== "ethereum"))
    throw new Error("Only Reth's ethereum variant is implemented; Base-Reth and Reth-BSC are unavailable.");
  if (!command.length || command.some((arg) => !arg || arg.includes("\0"))) throw new Error("Supply the workload argv after --.");
  if (options.solver && (harness !== "foundry" || mode !== "tools" || options.solver !== "z3")) throw new Error("--solver z3 applies to Foundry tools.");
  if (options.patch && !source) throw new Error("--patch applies to pinned client test/build modes; use --input for other workload files.");
  if (source && (!options.repo || !options.ref)) throw new Error("Client tests/builds require public --repo and exact --ref; --patch supplies changed source.");
  if (options.repo || options.ref) {
    if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(options.repo || "") || !/^[a-f0-9]{40}$/.test(options.ref || ""))
      throw new Error("Use a public GitHub --repo and a full 40-character --ref commit.");
  }
  const syncedOptions = ["manifest", "snapshot-plan", "checkpoint-url", "checkpoint", "max-head-age", "extra-disk-gib"];
  if (mode !== "synced" && syncedOptions.some((key) => options[key] !== undefined)) throw new Error("Snapshot/checkpoint options apply only to reth --mode synced.");
  const total = duration(options.duration), work = duration(options["work-duration"]);
  // Policy allowances, not measured maxima. Leave transfer variance and bounded
  // SSH/export/DELETE time; never silently purchase a longer authorization.
  const timing = {
    provisioningSeconds: 1800, preparationSeconds: mode === "synced" ? 14400 : source ? 3600 : 600,
    workSeconds: work, cleanupSeconds: 900, authorizedSeconds: total,
    basis: "30m provisioning allows the observed 13m migration plus guest checks; 15m cleanup allows bounded transfers and confirmation. Planning allowances are not guarantees.",
    evidence: mode === "synced" ? {
      date: "2026-09-14", sampleCount: 1, name: "reth-ready-proof", machine: "Amsterdam, 16 vCPU, 128 GiB RAM, 3.2 TB nominal disk",
      clients: "Reth 2.5.2, Lighthouse 8.2.2", manifestSha256: "3f4f00bec3ca8fcc2360dec9f2832d4193072b4beec16becd6a1316dcd3d3af2",
      snapshotBlock: 25962390, downloadBytes: 726194576598, outputBytes: 962683657146,
      importSeconds: 3543.768, indexSeconds: 2427.639, importStartToReadySeconds: 9660.188, rentalToReadySeconds: 13173.091,
      readyAt: "2026-09-14T12:39:52.836046Z", uncertainty: "Includes diagnostics/migration; network throughput unmeasured. Unknown on smaller machines or newer snapshots; one live sample, not a universal bound.",
    } : source ? {
      date: "2026-09-14", sampleCount: mode === "build" && harness === "foundry" ? 1 : 0,
      ...(mode === "build" && harness === "foundry" ? { name: "cache-build-proof", buildSeconds: 667.354 } : {}),
      uncertainty: "1h conservative source preparation allowance, not a measured bound. Test mode installs the toolchain/dependencies without compiling: test compilation consumes WORK. Build mode may reuse verified binaries; otherwise it compiles during preparation.",
    } : { date: "2026-09-15", sampleCount: 1, name: "native-fee-proof", bootstrapSeconds: 10.105,
      machine: "Amsterdam, 1 vCPU, 2 GiB nominal, Linux x86_64/glibc 2.39", clients: "Forge/Cast 1.8.1, Tempo 1.14.0",
      uncertainty: "Combined prebuilt preparation sample, not a per-client prediction. 10m allows download variance; no guaranteed network throughput." },
  };
  if (options["prepare-duration"]) {
    const requested = duration(options["prepare-duration"]);
    if (requested < timing.preparationSeconds) throw new Error("--prepare-duration may raise, not silently lower, the harness preparation allowance.");
    timing.preparationSeconds = requested;
  }
  timing.requiredSeconds = timing.provisioningSeconds + timing.preparationSeconds + work + timing.cleanupSeconds;
  if (timing.requiredSeconds > total) throw new Error(`Duration too short: ${timing.provisioningSeconds}s provisioning + ${timing.preparationSeconds}s preparation + ${work}s workload + ${timing.cleanupSeconds}s cleanup = ${timing.requiredSeconds}s required; ${total}s authorized. No quote or purchase submitted.`);
  let selected = source ? `${harness}-source` : mode === "synced" ? "reth-synced" : harness === "tempo" && mode === "tools" ? "foundry" : harness;
  if (options.solver) selected = "foundry-symbolic";
  const definition = await recipe(selected), inputs = [], preparation = [];
  for (const mapping of options.input || []) {
    const separator = mapping.indexOf("=");
    const local = resolve(separator < 0 ? mapping : mapping.slice(0, separator));
    const remote = separator < 0 ? "/workspace/" + local.split("/").at(-1) : mapping.slice(separator + 1);
    if (!(await stat(local)).isFile() || !isAbsolute(remote) || remote.includes("\0") || /[\r\n]/.test(remote) || !remote.startsWith("/workspace/"))
      throw new Error("--input accepts a regular local file[=/workspace/path]. Use an explicit source archive or patch, not an implicit directory upload.");
    inputs.push({ local, remote, ...await fingerprint(local) });
  }
  let disk = options.disk;
  if (mode === "synced") {
    if (!options.manifest || !options["snapshot-plan"]) throw new Error("Synced Reth needs --manifest FILE and its pinned full --snapshot-plan FILE for sizing before quote; see help reth.");
    const manifest = JSON.parse(await readFile(options.manifest, "utf8"));
    const plan = JSON.parse(await readFile(options["snapshot-plan"], "utf8"));
    const base = new URL(manifest.base_url);
    if (manifest.chain_id !== 1 || manifest.storage_version !== 2 || !String(manifest.reth_version).startsWith("2.5.2 ") ||
        base.protocol !== "https:" || base.hostname !== "snapshots-r2.reth.rs" || base.port || base.username || base.password || base.search || base.hash)
      throw new Error("Use an official HTTPS Ethereum mainnet V2 manifest produced by Reth 2.5.2.");
    const extra = Number(options["extra-disk-gib"]), age = Number(options["max-head-age"]);
    const checkpoint = new URL(options["checkpoint-url"]);
    if (checkpoint.protocol !== "https:" || checkpoint.username || checkpoint.password || checkpoint.search || checkpoint.hash ||
        !/^0x[a-fA-F0-9]{64}:\d+$/.test(options.checkpoint || "") || !Number.isSafeInteger(extra) || extra <= 0 || !Number.isSafeInteger(age) || age <= 0)
      throw new Error("Supply an independently verified HTTPS checkpoint URL/root:epoch, positive --max-head-age seconds and --extra-disk-gib allowance.");
    if (plan.schemaVersion !== 1 || plan.chainId !== 1 || plan.block !== manifest.block || !Array.isArray(plan.archives) || !plan.archives.length)
      throw new Error("Snapshot plan must match the Ethereum manifest block and canonical schema.");
    if (new Set(plan.archives.map((item) => item.url)).size !== plan.archives.length ||
        plan.archives.some((item) => typeof item.url !== "string" || !item.url.startsWith(base.href.replace(/\/$/, "") + "/")))
      throw new Error("Snapshot archives must be unique and remain under the manifest base URL.");
    for (const [totalKey, entry] of [["totalDownloadSize", "downloadSize"], ["totalOutputSize", "outputSize"]]) {
      if (!Number.isSafeInteger(plan[totalKey]) || plan[totalKey] <= 0 || plan.archives.some((item) => !Number.isSafeInteger(item[entry]) || item[entry] < 0) ||
          plan.archives.reduce((sum, item) => sum + item[entry], 0) !== plan[totalKey]) throw new Error("Incomplete snapshot plan sizes.");
    }
    const manifestFile = { local: resolve(options.manifest), remote: "/workspace/snapshot-manifest.json", ...await fingerprint(options.manifest) };
    const planFile = { local: resolve(options["snapshot-plan"]), remote: "/workspace/snapshot-plan.json", ...await fingerprint(options["snapshot-plan"]) };
    inputs.push(manifestFile, planFile);
    disk = String(Math.max(Number(disk || 0), Math.ceil((plan.totalDownloadSize + plan.totalOutputSize) / 2 ** 30) + extra));
    preparation.push(["/workspace/ethereum", "download", "--manifest", manifestFile.remote, "--sha256", manifestFile.sha256, "--plan", planFile.remote, "--extra-disk-gib", String(extra)],
      ["/workspace/ethereum", "start", "--checkpoint-url", checkpoint.href, "--checkpoint", options.checkpoint, "--max-head-age", String(age)]);
  }
  if (source) {
    if (options.patch) {
      const patch = { local: resolve(options.patch), remote: "/workspace/source.patch", ...await fingerprint(options.patch) };
      if (!patch.bytes) throw new Error("Patch must be nonempty (git diff --binary HEAD).");
      inputs.push(patch);
      preparation.push(["python3", "/workspace/.fission/rust-source.py", "apply", patch.remote, patch.sha256]);
    }
    if (mode === "build") preparation.push(["python3", "/workspace/.fission/rust-source.py", "ensure-build", ...sourceRecipes[selected]]);
  }
  if (new Set(inputs.map((input) => input.remote)).size !== inputs.length) throw new Error("Input destinations must be unique.");
  const artifacts = options.artifact || [];
  if (artifacts.some((path) => !path.startsWith("/workspace/") || /[\0\r\n]/.test(path))) throw new Error("--artifact must name a regular /workspace/file; databases stay remote.");
  const cwd = options.cwd || (options.repo ? "/workspace/source" : "/workspace");
  if (!isAbsolute(cwd) || cwd.includes("\0")) throw new Error("--cwd must be an absolute guest directory.");
  return { definition, disk, task: { harness, mode, command, cwd, inputs, preparation, artifacts,
    scope: mode === "test" ? "source" : mode === "build" ? "build" : ["dev", "synced"].includes(mode) ? "node" : "tools",
    maxHeadAge: options["max-head-age"], timing, output: resolve(options.output || "fission"),
    context: harness === "tempo" && mode === "tools" ? "Foundry Tempo execution model; this does not run a Tempo node." : harnesses[harness].description } };
}
