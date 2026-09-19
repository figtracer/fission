// Client configuration expands into the existing recipe and guest controllers.
// Options owned by their process/data/readiness contract cannot be overridden
// through trailing argv. Other client flags remain opaque to Fission.
export function nodeOptions(value = {}, harness) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !["args", "consensusArgs", "execution", "consensus", "network", "chainId", "role", "upstream", "checks", "rpcModules", "retention", "l1ChainId", "genesisHash"].includes(key)))
    throw new Error("Unknown node configuration field; see help harnesses/node-configuration.");
  const reserved = ["--", "-c", "--instance", "--chain", "--network", "--datadir", "--config", "--full", "--minimal", "--archive", "--dev",
    "--http", "--http.addr", "--http.port", "--http.api", "--ipcpath", "--ipcdisable", "--authrpc.addr", "--authrpc.port", "--authrpc.jwtsecret",
    "--execution-endpoint", "--execution-jwt", "--checkpoint-sync-url", "--wss-checkpoint", "--http-address", "--http-port",
    "--rpc.addr", "--rpc.port", "--l1-eth-rpc", "--l1-beacon", "--follow"];
  for (const key of ["args", "consensusArgs"]) {
    const argv = value[key] === undefined ? [] : value[key];
    if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== "string" || arg.includes("\0"))) throw new Error(`node.${key} must be an argv array.`);
    for (const arg of argv) {
      const flag = arg.split("=", 1)[0];
      if (reserved.includes(flag) || flag.startsWith("--prune.") || flag.startsWith("--pruning.") || flag.startsWith("--datadir."))
        throw new Error(`${flag} changes managed node identity, data or observation endpoints. Use snapshot/network/role configuration, or an explicit recipe for a different topology.`);
    }
  }
  for (const key of ["execution", "consensus"]) if (value[key] !== undefined) {
    const asset = value[key];
    if (!asset || Object.keys(asset).some((field) => !["url", "sha256", "executable", "version"].includes(field)) ||
        !/^[a-f0-9]{64}$/.test(asset.sha256 || "") || !/^[A-Za-z0-9._-]+$/.test(asset.executable || "") ||
        typeof asset.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(asset.version))
      throw new Error(`node.${key} requires url, sha256, executable and an exact release version.`);
    const url = new URL(asset.url);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Client assets require a credential-free HTTPS URL and verified SHA-256.");
  }
  if (harness !== "reth" && (value.consensus || value.consensusArgs?.length)) throw new Error("Separate consensus client options apply to the Ethereum Reth pair.");
  if (value.network !== undefined && (typeof value.network !== "string" || !value.network || /[\0\r\n]/.test(value.network))) throw new Error("node.network must name the upstream chain or an uploaded genesis path.");
  if (value.chainId !== undefined && (!Number.isSafeInteger(value.chainId) || value.chainId <= 0)) throw new Error("node.chainId must be a positive integer.");
  if (harness !== "tempo" && (value.role || value.upstream)) throw new Error("node.role and upstream apply to Tempo; Base roles are supplied through client args.");
  if (harness === "tempo" && value.role !== undefined && !["dev", "rpc", "validator", "custom"].includes(value.role)) throw new Error("Tempo role must be dev, rpc, validator or custom.");
  if (value.upstream !== undefined) {
    const url = new URL(value.upstream);
    if (!["wss:", "ws:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Tempo follower upstream must be a credential-free WebSocket URL.");
  }
  if (value.rpcModules !== undefined && (!Array.isArray(value.rpcModules) || value.rpcModules.some((item) => typeof item !== "string" || !/^[a-z][a-z0-9]*$/.test(item))))
    throw new Error("node.rpcModules must be an array of upstream RPC module names.");
  if (value.retention !== undefined && (harness !== "tempo" || !["minimal", "full", "archive"].includes(value.retention)))
    throw new Error("Tempo node.retention accepts minimal/full/archive; snapshot-backed nodes use snapshot selection.");
  if (value.l1ChainId !== undefined && (!Number.isSafeInteger(value.l1ChainId) || value.l1ChainId <= 0)) throw new Error("node.l1ChainId must be positive.");
  if (value.genesisHash !== undefined && !/^0x[a-fA-F0-9]{64}$/.test(value.genesisHash)) throw new Error("node.genesisHash must be a block hash.");
  if (harness !== "base" && (value.l1ChainId || value.genesisHash)) throw new Error("L1/rollup identity fields apply to Base.");
  return { ...value };
}
