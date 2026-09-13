import { join, basename } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { root, directory, readJSON, writeJSON } from "./state.mjs";
import { recipe, duration, start } from "./workspace.mjs";
import { quote, money } from "./provider.mjs";

export const providers = [{
  id: "modal-tempo", available: true,
  capabilities: { os: "linux", kind: "sandbox", architecture: null, cpu: null, memoryGiB: null, diskGiB: null, p2p: false, customImage: false, expiry: true },
  evidence: "https://modal.mpp.tempo.xyz",
  limitations: "Gateway exposes timeout only; no resource reservation, architecture selection, P2P ports, or image selection. Runtime recipes are opportunistic.",
}, {
  id: "smol-orthogonal", available: false,
  reason: "Lifecycle API returned expired_key on 2026-09-13. No purchase until authenticated lifecycle operations work.",
  evidence: "https://www.orthogonal.com/blog/smolmachines-microvms-for-ai-agents",
}, {
  id: "agentvm", available: false,
  reason: "Published MPP profile has unselectable capacity (up to 160 GB), Linux only, and no verified capability-authenticated immediate teardown.",
  evidence: "https://mpp.agentvm.sh/compute/sessions",
}];

// Planning floors, not performance guarantees; stricter issue-specific requirements
// may be supplied. Full-node figures require rechecking snapshot expansion/growth.
export const profiles = {
  runtime: { os: "linux", kind: "sandbox" },
  "foundry-source": { os: "linux", architecture: "x86_64", cpu: 4, memoryGiB: 16, diskGiB: 100 },
  "reth-source": { os: "linux", architecture: "x86_64", cpu: 8, memoryGiB: 32, diskGiB: 200 },
  "reth-synced": { os: "linux", kind: "vm", architecture: "x86_64", cpu: 8, memoryGiB: 32, diskGiB: 2048, p2p: true },
  "tempo-source": { os: "linux", architecture: "x86_64", cpu: 8, memoryGiB: 32, diskGiB: 200 },
  "tempo-node": { os: "linux", kind: "vm", architecture: "x86_64", cpu: 16, memoryGiB: 32, diskGiB: 1024, p2p: true },
  "windows-source": { os: "windows", kind: "vm", architecture: "x86_64", cpu: 4, memoryGiB: 16, diskGiB: 150 },
};

export function match(requirements) {
  return providers.map((provider) => {
    if (!provider.available) return { provider: provider.id, unmet: [provider.reason] };
    const unmet = Object.entries(requirements).filter(([key, value]) => {
      const supplied = provider.capabilities[key];
      return supplied == null || (typeof value === "number" ? supplied < value : supplied !== value);
    }).map(([key, value]) => `${key}=${value} is not guaranteed`);
    return { provider: provider.id, unmet };
  });
}

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const planFile = (id) => {
  if (!/^[a-f0-9-]{36}$/.test(id || "")) throw new Error("Use a saved plan ID.");
  return join(root, ".plans", `${id}.json`);
};

export async function createPlan(name, options) {
  directory(name);
  if (await readJSON(join(directory(name), "state.json"))) throw new Error("Workspace name already recorded.");
  const profile = options.profile || "runtime";
  if (!profiles[profile]) throw new Error("Unknown profile. Run capabilities.");
  const requirements = { ...profiles[profile] };
  for (const [option, field] of [["os", "os"], ["arch", "architecture"], ["kind", "kind"]])
    if (options[option]) {
      if (profile !== "runtime" && requirements[field] && requirements[field] !== options[option]) throw new Error(`--${option} conflicts with the profile. Choose a matching profile.`);
      requirements[field] = options[option];
    }
  for (const [option, field] of [["cpu", "cpu"], ["memory", "memoryGiB"], ["disk", "diskGiB"]]) {
    if (options[option] !== undefined) {
      const value = Number(options[option]);
      if (!Number.isFinite(value) || value <= 0) throw new Error(`--${option} must be positive.`);
      requirements[field] = Math.max(requirements[field] || 0, value);
    }
  }
  const matches = match(requirements);
  if (!matches.some((item) => item.unmet.length === 0)) return { version: 1, status: "unavailable", name, profile, requirements, candidates: matches, paymentSubmitted: false };
  const definition = await recipe(options.recipe || "linux");
  if (definition.artifacts.some((path) => basename(path) === "output.log")) throw new Error("output.log is reserved for the bootstrap artifact; use another artifact basename.");
  const timeout = duration(options.duration);
  const totalCap = options["total-spend"], creationCap = options["max-spend"];
  if (money(creationCap) <= 0n || money(totalCap) < money(creationCap) + 300n)
    throw new Error("Set --total-spend above the creation cap, leaving at least a launch and two shutdown calls (0.0003).");
  let source;
  if (options.repo || options.ref) {
    if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(options.repo || "") || !/^[a-f0-9]{40}$/.test(options.ref || ""))
      throw new Error("Source requires a public GitHub --repo URL and exact 40-character --ref commit. Upload private work explicitly.");
    source = { url: options.repo, commit: options.ref };
  }
  const offer = await quote("create", { timeout });
  if (money(offer.amount) > money(creationCap)) throw new Error("Creation quote exceeds its cap.");
  const value = { version: 1, status: "planned", id: randomUUID(), name, profile, requirements, provider: "modal-tempo", kind: "linux-sandbox", capabilities: providers[0], durationSeconds: timeout, creationQuote: offer.amount, creationCap, totalCap, source, recipe: definition, body: { timeout }, createdAt: new Date().toISOString() };
  value.digest = digest(value);
  await writeJSON(planFile(value.id), value);
  return value;
}

export async function openPlan(name, id) {
  const value = await readJSON(planFile(id));
  if (!value || value.name !== name) throw new Error("Saved plan does not match workspace name.");
  const { digest: expected, ...contents } = value;
  if (digest(contents) !== expected) throw new Error("Plan changed after creation. Generate a fresh plan.");
  if (!match(value.requirements).some((item) => item.provider === value.provider && !item.unmet.length))
    throw new Error("Provider no longer satisfies the saved requirements.");
  const offer = await quote("create", value.body);
  if (money(offer.amount) > money(value.creationCap)) throw new Error("Current quote exceeds the approved creation cap.");
  return start(name, { ...value, creationQuote: offer.amount, asyncPreparation: true });
}
