import { readFile, stat } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { recipe, duration, sourceRecipes, validateRecipe } from "./workspace.mjs";
import { nodeOptions } from "./node-options.mjs";
import { probes } from "./readiness.mjs";
import { fingerprint } from "./experiments.mjs";

// Shared by CLI validation and multi-machine manifests.
export const taskOptions = ["harness", "mode", "chain", "solver", "budget", "duration", "work-duration", "prepare-duration", "region", "machine", "cpu", "memory", "disk", "no-resize", "repo", "ref", "patch", "cwd", "input", "artifact", "output", "cache-workspace", "cache-max-bytes", "snapshot", "manifest", "manifest-url", "snapshot-plan", "checkpoint-url", "checkpoint", "l1-execution-url", "l1-beacon-url", "max-head-age", "max-safe-age", "max-l1-head-age", "max-l1-lag-blocks", "max-tip-lag-blocks", "extra-disk-gib"];

// Task files also accept an explicit guest recipe, using the same managed runtime.
export const taskFileOptions = [...taskOptions, "recipe", "preparation", "scope", "context", "node"];

// One selection contract; recipes remain the pinned preparation source of truth.
export const harnesses = {
  foundry: { modes: ["tools", "test", "build"], description: "Contract tests, fuzz/invariants, symbolic properties, or test/build Foundry itself." },
  reth: { modes: ["dev", "test", "build", "synced"], description: "Ethereum/Base source work and configurable snapshot-backed nodes." },
  tempo: { modes: ["dev", "tools", "test", "build", "node"], description: "Tempo development/public nodes, Foundry contract model, or client tests/build." },
  linux: { modes: ["tools"], description: "Plain Linux x86 shell/Python fallback." },
};

export async function taskSpec(options, command) {
  const custom = options.recipe !== undefined;
  let definition;
  if (custom) {
    if (!options.recipe || typeof options.recipe !== "object" || Array.isArray(options.recipe))
      throw new Error("Task recipe must be an embedded recipe object.");
    const presetOnly = ["node", "harness", "mode", "chain", "solver", "patch", "cache-workspace", "cache-max-bytes", "snapshot", "manifest", "manifest-url", "snapshot-plan", "checkpoint-url", "checkpoint", "l1-execution-url", "l1-beacon-url", "max-head-age", "max-safe-age", "max-l1-head-age", "max-l1-lag-blocks", "max-tip-lag-blocks", "extra-disk-gib"];
    if (presetOnly.some((key) => options[key] !== undefined))
      throw new Error("Choose a built-in harness or an explicit recipe; put custom configuration in the recipe and preparation commands.");
    definition = await recipe(options.recipe);
    if (!/^[a-z][a-z0-9-]*$/.test(definition.name)) throw new Error("Custom recipe name must use lowercase letters, digits and hyphens.");
    if (definition.afterCheckout?.length && !options.repo) throw new Error("afterCheckout requires repo and ref.");
    for (const key of ["cpu", "memory", "disk"])
      if (!["string", "number"].includes(typeof options[key]) || !Number.isFinite(Number(options[key])) || Number(options[key]) <= 0)
        throw new Error(`Custom tasks require positive ${key} requirements before quoting.`);
    if (!options["prepare-duration"]) throw new Error("Custom tasks require an explicit prepare-duration allowance.");
    if (options.context !== undefined && typeof options.context !== "string") throw new Error("Task context must be text.");
    const scope = options.scope ?? "tools";
    if (typeof scope !== "string" || !/^[a-z][a-z0-9-]*$/.test(scope)) throw new Error("Invalid readiness scope.");
    if (!definition.checks?.some((check) => check.scope === scope) && !(scope === "tools" && definition.readiness?.length))
      throw new Error(`Recipe has no ${scope} checks. Define named checks in the recipe.`);
    probes(definition, scope); // Reject missing readiness before quotes.
  } else if (["scope", "context"].some((key) => options[key] !== undefined)) {
    throw new Error("Custom scope and context require an explicit recipe.");
  }
  const harness = custom ? definition.name : options.harness;
  if (!custom && !Object.hasOwn(harnesses, harness || "")) throw new Error("Choose --harness foundry, reth, tempo, or linux.");
  const mode = custom ? "custom" : options.mode || harnesses[harness].modes[0];
  if (!custom && !harnesses[harness].modes.includes(mode)) throw new Error(`Modes for ${harness}: ${harnesses[harness].modes.join(", ")}.`);
  const source = ["test", "build"].includes(mode);
  if (options.chain !== undefined && harness !== "reth" && !(harness === "tempo" && mode === "node")) throw new Error("--chain applies to Reth or Tempo node mode.");
  const chain = !custom && harness === "reth" ? options.chain || "ethereum" : undefined;
  if (!custom && harness === "reth" && !["ethereum", "base"].includes(chain))
    throw new Error("Bundled Reth supports --chain ethereum or --chain base. Reth-BSC is unavailable as a bundled shortcut; use an explicit task recipe.");
  if (chain === "base" && mode === "dev")
    throw new Error("Base-Reth does not support standalone dev mode; use source test/build or managed synced mode. Standalone dev does not provide Base rollup consensus or L1 infrastructure.");
  if (!Array.isArray(command) || !command.length || typeof command[0] !== "string" || !command[0] || command.some((arg) => typeof arg !== "string" || arg.includes("\0"))) throw new Error("Supply the workload argv after --.");
  if (options.solver && (harness !== "foundry" || mode !== "tools" || options.solver !== "z3")) throw new Error("--solver z3 applies to Foundry tools.");
  if (options.patch && !source) throw new Error("--patch applies to pinned client test/build modes; use --input for other workload files.");
  if (options["cache-workspace"] && (mode !== "build" || options.patch))
    throw new Error("--cache-workspace applies only to clean source build mode.");
  if (options["cache-max-bytes"] !== undefined && !options["cache-workspace"])
    throw new Error("--cache-max-bytes requires --cache-workspace.");
  if (options["cache-workspace"] && (!Number.isSafeInteger(Number(options["cache-max-bytes"])) || Number(options["cache-max-bytes"]) <= 0))
    throw new Error("A cache VPS requires a positive integer --cache-max-bytes transfer and expansion limit.");
  if (source && (!options.repo || !options.ref)) throw new Error("Client tests/builds require public --repo and exact --ref; --patch supplies changed source.");
  if (options.repo || options.ref) {
    if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(options.repo || "") || !/^[a-f0-9]{40}$/.test(options.ref || ""))
      throw new Error("Use a public GitHub --repo and a full 40-character --ref commit.");
  }
  if (options.node !== undefined && !(harness === "reth" && mode === "synced" || harness === "tempo" && mode === "node"))
    throw new Error("node configuration applies to synced Reth/Base or Tempo node mode.");
  const node = nodeOptions(options.node, chain === "base" ? "base" : harness);
  const tempoNode = harness === "tempo" && mode === "node";
  if (tempoNode) {
    node.network ||= options.chain || "dev";
    node.role ||= node.network === "dev" ? "dev" : "rpc";
    node.chainId ||= { dev: 1337, mainnet: 4217, moderato: 42431, testnet: 42431 }[node.network];
    if (!node.chainId) throw new Error("Supply node.chainId for the selected custom Tempo chain.");
    node.maxHeadAge = Number(options["max-head-age"]);
    if (node.role !== "dev") {
      if (!Number.isSafeInteger(node.maxHeadAge) || node.maxHeadAge <= 0 || !options["prepare-duration"])
        throw new Error("Public Tempo nodes require max-head-age and an explicit prepare-duration.");
      for (const key of ["cpu", "memory", "disk"])
        if (!Number.isFinite(Number(options[key])) || Number(options[key]) <= 0) throw new Error(`Choose explicit ${key} resources for this Tempo node.`);
    } else delete node.maxHeadAge;
    if (["validator", "custom"].includes(node.role) && !node.checks?.length)
      throw new Error("Validator/custom roles require additional node.checks for their requested role; RPC freshness alone is insufficient.");
    if (node.role === "validator" && !(node.args || []).some((arg) => arg === "--consensus.signing-key" || arg.startsWith("--consensus.signing-key=")))
      throw new Error("Tempo validator needs its explicit guest signing-key path and provisioned network configuration.");
  }
  if (!tempoNode && chain !== "base" && node.network && node.network !== "mainnet") throw new Error("Use an explicit recipe for a different chain topology; this snapshot pair is mainnet. Ordinary upstream client options remain configurable.");
  if (node.chainId !== undefined && !tempoNode && chain !== "base") throw new Error("Snapshot chain identity comes from the manifest and paired readiness.");
  if (chain === "base" && mode === "synced") {
    node.network ||= "mainnet";
    node.chainId ||= { mainnet: 8453, sepolia: 84532, zeronet: 763360 }[node.network];
    node.l1ChainId ||= { mainnet: 1, sepolia: 11155111 }[node.network];
    node.genesisHash ||= node.network === "mainnet" ? "0xf712aa9241cc24369b143cf6dce85f0902a9731e70d66818a3a5845b296c73dd" : undefined;
    if (!node.chainId || !node.l1ChainId || !node.genesisHash) throw new Error("Resolve Base node.chainId, l1ChainId and genesisHash for this network before quoting.");
  }
  const additionalChecks = node.checks || [];
  validateRecipe({name:"node-checks",prepare:[],artifacts:[],checks:additionalChecks});
  if (additionalChecks.some((check) => check.scope !== "node")) throw new Error("Additional node checks must use scope node.");
  const syncedOptions = ["snapshot", "manifest", "manifest-url", "snapshot-plan", "checkpoint-url", "checkpoint", "l1-execution-url", "l1-beacon-url", "max-head-age", "max-safe-age", "max-l1-head-age", "max-l1-lag-blocks", "max-tip-lag-blocks", "extra-disk-gib"];
  if (mode !== "synced" && syncedOptions.some((key) => options[key] !== undefined && !(tempoNode && key === "max-head-age"))) throw new Error("Snapshot/checkpoint options apply only to reth --mode synced.");
  const snapshot = mode === "synced" ? options.snapshot || "full" : undefined;
  if (snapshot && !["minimal", "full", "archive"].includes(snapshot)) throw new Error("Snapshot selection must be minimal, full or archive.");
  if (snapshot && snapshot !== "full" && !options["prepare-duration"]) throw new Error("Choose an explicit prepare-duration for the selected snapshot; full-node timings do not establish its import duration.");
  const total = duration(options.duration), work = duration(options["work-duration"]);
  // Policy allowances, not measured maxima. Leave transfer variance and bounded
  // SSH/export/DELETE time; never silently purchase a longer authorization.
  const timing = {
    provisioningSeconds: 1800, preparationSeconds: custom ? duration(options["prepare-duration"]) : mode === "synced" ? 14400 : source ? 3600 : 600,
    workSeconds: work, cleanupSeconds: 900, authorizedSeconds: total,
    basis: "30m provisioning allows the observed 13m migration plus guest checks; 15m cleanup allows bounded transfers and confirmation. Planning allowances are not guarantees.",
    evidence: tempoNode || options.node ? { sampleCount: 0, uncertainty: "Configured client/environment; choose time and resources for this setup. Default-client timings do not qualify this configuration." } : snapshot && snapshot !== "full" ? { sampleCount: 0, selection: snapshot, uncertainty: "No measured import/catch-up bound for this selection. Size from its canonical plan and choose a preparation allowance." } : custom ? { sampleCount: 0, uncertainty: "Operator-supplied preparation allowance for this recipe; no measured startup bound. Setup and readiness must finish within the authorized preparation window." } : mode === "synced" && chain === "base" ? {
      date: "2026-09-17", sampleCount: 0, clients: "Base unified node 1.4.0",
      uncertainty: "Fixture/local integration only. Base snapshot download, extraction, indexing, L1 derivation and catch-up have no measured managed-run bound; choose an explicit larger preparation allowance. Live node readiness is unqualified.",
    } : mode === "synced" ? {
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
  if (mode === "synced" && chain === "base" && !options["prepare-duration"])
    throw new Error("Base synced mode requires an explicit --prepare-duration of at least 4h because snapshot import and catch-up are not live-timed.");
  if (options["prepare-duration"]) {
    const requested = duration(options["prepare-duration"]);
    if (requested < timing.preparationSeconds) throw new Error("--prepare-duration may raise, not silently lower, the harness preparation allowance.");
    timing.preparationSeconds = requested;
  }
  timing.requiredSeconds = timing.provisioningSeconds + timing.preparationSeconds + work + timing.cleanupSeconds;
  if (timing.requiredSeconds > total) throw new Error(`Duration too short: ${timing.provisioningSeconds}s provisioning + ${timing.preparationSeconds}s preparation + ${work}s workload + ${timing.cleanupSeconds}s cleanup = ${timing.requiredSeconds}s required; ${total}s authorized. No quote or purchase submitted.`);
  let selected = source ? chain === "base" ? "base-reth-source" : `${harness}-source` : mode === "synced" ? chain === "base" ? "base-synced" : "reth-synced" : tempoNode ? "tempo-node" : harness === "tempo" && mode === "tools" ? "foundry" : harness;
  if (options.solver) selected = "foundry-symbolic";
  definition ||= await recipe(selected);
  if (options.node || tempoNode || chain === "base" && mode === "synced") {
    const {digest, ...configured} = definition;
    configured.prepare = definition.prepare.map((argv) => argv.at(-1) === "install" ? [...argv, "--options", JSON.stringify(node)] : argv);
    if (tempoNode && node.execution) {
      configured.prepare.shift();
      configured.prepare.splice(1, 0, ["python3", "-c", "import sys,pathlib,json; sys.path.insert(0,'/workspace/.fission'); from node_options import install_client; install_client(json.loads(sys.argv[1]),pathlib.Path('/workspace/tempo'))", JSON.stringify(node.execution)]);
    }
    definition = validateRecipe(configured);
  }
  const inputs = [], preparation = options.preparation === undefined ? [] : structuredClone(options.preparation);
  if (!Array.isArray(preparation) || preparation.some((argv) => !Array.isArray(argv) || !argv.length ||
      typeof argv[0] !== "string" || !argv[0] || argv.some((arg) => typeof arg !== "string" || arg.includes("\0"))))
    throw new Error("Preparation must be guest argv arrays, executed after input transfer.");
  if (options.input !== undefined && (!Array.isArray(options.input) || options.input.some((item) => typeof item !== "string")))
    throw new Error("input must be an array of file mappings.");
  for (const mapping of options.input || []) {
    const separator = mapping.indexOf("=");
    const local = resolve(separator < 0 ? mapping : mapping.slice(0, separator));
    const remote = separator < 0 ? "/workspace/" + local.split("/").at(-1) : mapping.slice(separator + 1);
    if (!(await stat(local)).isFile() || !isAbsolute(remote) || remote.includes("\0") || /[\r\n]/.test(remote) || !remote.startsWith("/workspace/"))
      throw new Error("--input accepts a regular local file[=/workspace/path]. Use an explicit source archive or patch, not an implicit directory upload.");
    inputs.push({ local, remote, ...await fingerprint(local) });
  }
  let disk = options.disk, baseReadiness;
  if (mode === "synced") {
    if (!options.manifest || !options["snapshot-plan"]) throw new Error("Synced Reth needs --manifest FILE and its matching --snapshot-plan FILE for sizing before quote; see help reth.");
    const manifest = JSON.parse(await readFile(options.manifest, "utf8"));
    const plan = JSON.parse(await readFile(options["snapshot-plan"], "utf8"));
    const base = new URL(manifest.base_url);
    const extra = Number(options["extra-disk-gib"]), age = Number(options["max-head-age"]);
    const chainId = chain === "base" ? node.chainId : 1;
    if (!Number.isSafeInteger(extra) || extra <= 0 || !Number.isSafeInteger(age) || age <= 0)
      throw new Error("Synced mode needs positive --max-head-age seconds and --extra-disk-gib allowance.");
    if (plan.schemaVersion !== 1 || plan.chainId !== chainId || plan.block !== manifest.block || !Array.isArray(plan.archives) || !plan.archives.length)
      throw new Error("Snapshot plan must match the selected chain manifest block and canonical schema.");
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
    if (chain === "base") {
      const endpoint = (name) => {
        let url;
        try { url = new URL(options[name]); }
        catch { throw new Error(`${name} must be a credential-free HTTPS origin; it is persisted in task state.`); }
        if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash || /[\0\r\n]/.test(options[name] || ""))
          throw new Error(`${name} must be a credential-free HTTPS origin with no path, query, fragment, userinfo or custom port; it is persisted in task state.`);
        return url.href;
      };
      let manifestUrl;
      try { manifestUrl = new URL(options["manifest-url"]); }
      catch { throw new Error("Base synced mode requires the immutable official --manifest-url used to fetch the local manifest."); }
      if (manifest.chain_id !== node.chainId || manifest.storage_version !== 2 || !Number.isSafeInteger(manifest.block) || manifest.block <= 0 ||
          base.protocol !== "https:" || !base.hostname || base.port || base.username || base.password || base.search || base.hash ||
          manifestUrl.protocol !== "https:" || !manifestUrl.hostname || manifestUrl.username || manifestUrl.password || manifestUrl.search || manifestUrl.hash)
        throw new Error("Use a pinned HTTPS Base V2 manifest and matching selected chain identity.");
      const snapshotRoot = base.href.replace(/\/$/, "") + "/";
      if (plan.archives.some((archive) => !archive.url.startsWith(snapshotRoot)))
        throw new Error("Every Base snapshot archive must remain under the pinned manifest directory.");
      const components = Object.values(manifest.components || {});
      const outputs = components.flatMap((component) => [...(component.output_files || []), ...(component.chunk_output_files || []).flat()]);
      if (!components.length || !outputs.length || outputs.some((output) => typeof output.path !== "string" || output.path.startsWith("/") || output.path.split("/").includes("..") ||
          !Number.isSafeInteger(output.size) || output.size < 0 || !/^[a-f0-9]{64}$/.test(output.blake3 || "")))
        throw new Error("Base manifest must contain safe relative output paths, sizes and BLAKE3 checksums.");
      if (options["checkpoint-url"] !== undefined || options.checkpoint !== undefined)
        throw new Error("Ethereum checkpoint options do not apply to Base synced mode.");
      const readiness = {
        maxHeadAge: age, maxSafeAge: Number(options["max-safe-age"]), maxL1HeadAge: Number(options["max-l1-head-age"]),
        maxL1LagBlocks: Number(options["max-l1-lag-blocks"]), maxTipLagBlocks: Number(options["max-tip-lag-blocks"]),
      };
      if (!Number.isSafeInteger(readiness.maxSafeAge) || readiness.maxSafeAge <= 0 || !Number.isSafeInteger(readiness.maxL1HeadAge) || readiness.maxL1HeadAge <= 0 ||
          !Number.isSafeInteger(readiness.maxL1LagBlocks) || readiness.maxL1LagBlocks < 0 || !Number.isSafeInteger(readiness.maxTipLagBlocks) || readiness.maxTipLagBlocks < 0)
        throw new Error("Base synced mode needs positive --max-safe-age/--max-l1-head-age and nonnegative integer L1/tip lag block bounds.");
      const l1Execution = endpoint("l1-execution-url"), l1Beacon = endpoint("l1-beacon-url");
      preparation.push(["/workspace/base-node", "download", "--manifest", manifestFile.remote, "--manifest-url", manifestUrl.href, "--sha256", manifestFile.sha256, "--plan", planFile.remote, "--extra-disk-gib", String(extra), "--selection", snapshot],
        ["/workspace/base-node", "start", "--l1-execution-url", l1Execution, "--l1-beacon-url", l1Beacon, ...Object.entries(readiness).flatMap(([key, value]) => [`--${key.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase())}`, String(value)])]);
      baseReadiness = { selection: snapshot, chainId: node.chainId, l1ChainId: node.l1ChainId, genesisHash: node.genesisHash, ...readiness, l1ExecutionUrl: l1Execution, l1BeaconUrl: l1Beacon };
    } else {
      if (manifest.chain_id !== 1 || manifest.storage_version !== 2 || !String(manifest.reth_version).startsWith((node.execution?.version || "2.5.2") + " ") ||
          base.protocol !== "https:" || base.hostname !== "snapshots-r2.reth.rs" || base.port || base.username || base.password || base.search || base.hash)
        throw new Error("Use an official HTTPS Ethereum mainnet V2 manifest produced by the selected Reth client version.");
      const checkpoint = new URL(options["checkpoint-url"]);
      if (checkpoint.protocol !== "https:" || checkpoint.username || checkpoint.password || checkpoint.search || checkpoint.hash || !/^0x[a-fA-F0-9]{64}:\d+$/.test(options.checkpoint || ""))
        throw new Error("Supply an independently verified HTTPS checkpoint URL and block_root:epoch.");
      if (["manifest-url", "l1-execution-url", "l1-beacon-url", "max-safe-age", "max-l1-head-age", "max-l1-lag-blocks", "max-tip-lag-blocks"].some((key) => options[key] !== undefined))
        throw new Error("Base L1, manifest URL and lag options do not apply to Ethereum synced mode.");
      preparation.push(["/workspace/ethereum", "download", "--manifest", manifestFile.remote, "--sha256", manifestFile.sha256, "--plan", planFile.remote, "--extra-disk-gib", String(extra), "--selection", snapshot],
        ["/workspace/ethereum", "start", "--checkpoint-url", checkpoint.href, "--checkpoint", options.checkpoint, "--max-head-age", String(age)]);
    }
  }
  if (tempoNode) preparation.push(["/workspace/tempo-node", "start"]);
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
  if (!Array.isArray(artifacts) || artifacts.some((path) => typeof path !== "string")) throw new Error("artifact must be an array of paths.");
  if (artifacts.some((path) => !path.startsWith("/workspace/") || /[\0\r\n]/.test(path))) throw new Error("--artifact must name a regular /workspace/file; databases stay remote.");
  const cwd = options.cwd || (options.repo ? "/workspace/source" : "/workspace");
  if (!isAbsolute(cwd) || cwd.includes("\0")) throw new Error("--cwd must be an absolute guest directory.");
  return { definition, disk, task: { harness, mode, ...(chain ? { chain } : {}), command, cwd, inputs, preparation, artifacts, ...(snapshot ? { snapshot } : {}), ...(options.node || tempoNode || baseReadiness ? { node, checks: additionalChecks } : {}),
    scope: custom ? options.scope || "tools" : mode === "test" ? "source" : mode === "build" ? "build" : ["dev", "synced", "node"].includes(mode) ? "node" : "tools",
    maxHeadAge: tempoNode ? undefined : options["max-head-age"], ...(baseReadiness ? { readiness: baseReadiness } : snapshot ? { readiness: { maxHeadAge: Number(options["max-head-age"]), selection: snapshot } } : {}), timing, output: resolve(options.output || "fission"),
    context: tempoNode ? `Managed Tempo ${node.role} on ${node.network}; readiness records chain, sync state and any additional role checks.` : custom ? options.context || definition.description || "Custom managed Linux task." : chain === "base" && mode === "synced" ? `Managed Base ${node.network} execution and rollup consensus using credential-free L1 endpoints; fixture/local validated, live snapshot import and sync unqualified.` :
      chain === "base" ? "Pinned Base-Reth source test/build; this does not run or validate a Base node, rollup consensus, or L1 derivation." :
      harness === "tempo" && mode === "tools" ? "Foundry Tempo execution model; this does not run a Tempo node." : harnesses[harness].description } };
}
