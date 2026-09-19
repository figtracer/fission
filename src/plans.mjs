import { join, basename } from "node:path";
import { mkdir, readFile, access } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { root, directory, readJSON, writeJSON, providerId } from "./state.mjs";
import { recipe, duration, start, sourceRecipes } from "./workspace.mjs";
import { quote, money, runProcess, paymentTerms, providerWarning } from "./provider.mjs";
import { catalog, machineCapabilities } from "./compute.mjs";
import { amount, vmCeiling } from "./budget.mjs";

export const providers = [{
  id: "modal-tempo", available: true, gateway: "Tempo", operator: "Modal",
  price: "Dynamic creation + $0.0001 per lifecycle call", payment: "MPP tempo.charge",
  capabilities: { os: "linux", kind: "sandbox", architecture: null, cpu: null, memoryGiB: null, diskGiB: null, p2p: false, customImage: false, expiry: true },
  evidence: "https://modal.mpp.tempo.xyz",
  limitations: "Gateway exposes timeout only; no resource reservation, architecture selection, P2P ports, or image selection. Runtime recipes are opportunistic.",
}, {
  id: "compute-mpp", available: true, gateway: "x402layer", operator: "Vultr",
  price: "Live per-plan VM prices; quote before purchase",
  limitations: "Vultr Linux x86_64 VMs selected from the live catalog. Shorter target leases use a prepaid starter upgrade with capacity and time gates. Catalog capacity and P2P require guest verification; node readiness is a separate workload. Early deletion does not imply a refund.",
  payment: "MPP tempo.charge",
}, {
  id: "smol-orthogonal", available: false, gateway: "Orthogonal", operator: "Smol",
  reason: "Lifecycle API returned expired_key on 2026-09-13. No purchase until authenticated lifecycle operations work.",
  evidence: "https://www.orthogonal.com/blog/smolmachines-microvms-for-ai-agents",
}, {
  id: "agentvm", available: false, gateway: "AgentVM", operator: "Hetzner",
  reason: "Published MPP profile has unselectable capacity (up to 160 GB), Linux only, and no verified capability-authenticated immediate teardown.",
  evidence: "https://mpp.agentvm.sh/compute/sessions",
}, {
  id: "vps-phoneagent", available: false, gateway: "Mercator / PhoneAgent", operator: "Unspecified",
  price: "From $12.99 / month (published Sep 15, 2026)", payment: "x402 Base USDC; listed by Mercator",
  reason: "September 15, 2026: Mercator rent quotes failed invalid_challenge (HTTP 402, non-retryable). Hourly sandboxes are documented unavailable. No documented immediate destroy.",
  evidence: "https://vps.phoneagent.xyz/llms.txt",
}, {
  id: "agentmetal", available: false, gateway: "AgentMetal", operator: "Unspecified",
  price: "From $1.20 / day (catalog Sep 15, 2026)", payment: "x402 Base USDC",
  reason: "September 15, 2026: early destroy requires an account bearer key; no configured signing/authentication path or verified x86 lifecycle. Not found in Mercator discovery.",
  evidence: "https://agentmetal.dev/auth.md",
}, {
  id: "palmyr", available: false, gateway: "Palmyr", operator: "Hetzner", payment: "x402 Base USDC or Solana USDC",
  reason: "September 15, 2026: monthly Hetzner x86 VPS plans exist, but Mercator lists only SSH-key registration, not provision/status/destroy. Lifecycle requires the original payer identity; no configured direct signing path.",
  evidence: "https://palmyr.ai/compute/plans",
}, {
  id: "vaaya", available: false, gateway: "Mercator / Vaaya", operator: "Modal",
  payment: "Tempo to Mercator; x402 Base USDC downstream",
  price: "$0.05 / 300s creation + $0.01 / exec (quote Sep 15, 2026)",
  reason: "Create and exec quotes succeed. Mercator rejects status and terminate as not cataloged. Sandbox only; resource guarantees and complete lifecycle unverified. No purchase enabled.",
  evidence: "https://vaaya.ai/tools/modal/sandbox-create",
}, {
  id: "blockrun", available: false, gateway: "Mercator / BlockRun", operator: "Modal",
  payment: "Tempo to Mercator; x402 Base USDC downstream",
  price: "$0.011 / 300s creation + $0.002 / lifecycle call (402 Sep 15, 2026)",
  reason: "Direct payment challenges respond promptly, but Mercator rejects create with invalid_challenge and exec/status/terminate as not cataloged. Sandbox, not an SSH VM; no purchase enabled.",
  evidence: "https://blockrun.ai/services/modal",
}, {
  id: "openvps", available: false, gateway: "OpenVPS", operator: "Self-hosted Firecracker",
  payment: "MPP Tempo or x402 (published, not live verified)",
  reason: "Independent Linux VM implementation with SSH/status/delete. Published deployment openvps.sh refused HTTPS connections on Sep 15, 2026. Live terms, capacity and lifecycle unverified.",
  evidence: "https://github.com/kartojal/openvps",
}, {
  id: "payweave-sandbox", available: false, gateway: "PayWeave", operator: "Unspecified",
  payment: "MPP Tempo USDC.e or x402",
  price: "$0.01 / execution, at most 60s (published Sep 15, 2026)",
  reason: "Single-use command execution only. No persistent machine, SSH, resource guarantees or separate status/terminate routes. Not compatible with managed harness preparation and artifact transfers.",
  evidence: "https://sandbox.payweave.services/skill.md",
}].map((provider) => ({ ...provider, warning: providerWarning(provider.id) }));

// Planning floors, not performance guarantees; stricter issue-specific requirements
// may be supplied. Full-node figures require rechecking snapshot expansion/growth.
export const profiles = {
  runtime: { os: "linux", kind: "sandbox" },
  "foundry-symbolic": { os: "linux", kind: "vm", architecture: "x86_64" },
  "foundry-source": { os: "linux", architecture: "x86_64", cpu: 4, memoryGiB: 16, diskGiB: 100 },
  "reth-source": { os: "linux", architecture: "x86_64", cpu: 8, memoryGiB: 32, diskGiB: 200 },
  "base-reth-source": { os: "linux", architecture: "x86_64", cpu: 8, memoryGiB: 32, diskGiB: 200 },
  "reth-synced": { os: "linux", kind: "vm", architecture: "x86_64", cpu: 8, memoryGiB: 32, diskGiB: 2048, p2p: true },
  "base-synced": { os: "linux", kind: "vm", architecture: "x86_64", cpu: 16, memoryGiB: 64, diskGiB: 2048, p2p: true },
  "tempo-source": { os: "linux", architecture: "x86_64", cpu: 8, memoryGiB: 32, diskGiB: 200 },
  "tempo-node": { os: "linux", kind: "vm", architecture: "x86_64", cpu: 16, memoryGiB: 32, diskGiB: 1024, p2p: true },
};

export function match(requirements) {
  return providers.map((provider) => {
    if (!provider.available) return { provider: provider.id, unmet: [provider.reason] };
    if (!provider.capabilities) return { provider: provider.id, unmet: ["Select a compatible machine from machines with --provider compute-mpp."] };
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

export function requirementsFor(options) {
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
      // Node capacities are planning defaults. Snapshot plans own actual disk
      // sizing; explicit hardware requests may replace these estimates.
      requirements[field] = ["reth-synced", "base-synced", "tempo-node"].includes(profile) ? value : Math.max(requirements[field] || 0, value);
    }
  }
  return { profile, requirements };
}

// A short, fixed-size sample keeps discovery useful without quoting an entire
// catalog. It is the cheapest compatible shortlist, never a market-wide average.
const shortlistSize = 3;
// Existing minimum allocation room for one launch and two shutdown calls.
// This is an accounting floor, not an estimate of all lifecycle costs.
const minimumHeadroom = 300n;
// Observed large migration took 13 minutes; allow another 17 for provisioning
// and guest verification. Actual remaining time is gated again before bootstrap.
const preparationAllowanceSeconds = 30 * 60;
const resizeFamily = (id) => /^vc2-/.test(id) ? "vc2" : /^voc-m-.*-amd$/.test(id) ? "voc-m-amd" : null;
const resizePolicyMessage = "Public-alpha automatic resize is limited to targets up to 4 vCPU and 8 GiB RAM; use --no-resize for explicit direct provisioning.";
const resizePolicyReason = (machine) => machine.vcpu_count > 4 || machine.ram > 8 * 1024
  ? resizePolicyMessage : null;
const hourlyRate = (machine) => {
  if (!Number.isFinite(machine.our_hourly) || machine.our_hourly <= 0) throw new Error("Missing hourly compute rate.");
  return money(String(machine.our_hourly));
};
const catalogPrice = (machine) => {
  if (typeof machine.our_daily !== "number" || !Number.isFinite(machine.our_daily) || machine.our_daily <= 0)
    throw new Error("Missing daily catalog price.");
  return money(String(machine.our_daily));
};

function rentalFor(machine, machines, seconds, region, noResize = false) {
  if (seconds >= 86400 || noResize) {
    const days = Math.ceil(seconds / 86400);
    return { estimate: catalogPrice(machine) * BigInt(days), prepaidHours: days * 24 };
  }
  if (resizePolicyReason(machine)) return null;
  const family = resizeFamily(machine.id);
  if (!family) return null;
  const targetRate = hourlyRate(machine), candidates = [];
  for (const starter of machines) {
    if (starter.provider !== "vultr" || starter.id === machine.id || resizeFamily(starter.id) !== family || !starter.locations?.includes(region)) continue;
    let capabilities, rate;
    try { capabilities = machineCapabilities(starter); rate = hourlyRate(starter); } catch { continue; }
    if (rate >= targetRate || starter.vcpu_count > machine.vcpu_count || starter.ram > machine.ram || starter.disk > machine.disk) continue;
    const needed = targetRate * BigInt(seconds + preparationAllowanceSeconds);
    const dayCredit = catalogPrice(starter) * 3600n;
    const prepaidHours = Number((needed + dayCredit - 1n) / dayCredit) * 24;
    if (!Number.isSafeInteger(prepaidHours) || prepaidHours < 24) continue;
    candidates.push({ estimate: catalogPrice(starter) * BigInt(prepaidHours / 24), lease: {
      strategy: "prepaid-resize", starter: { id: starter.id }, starterCapabilities: capabilities, prepaidHours,
      starterHourlyRate: amount(rate), targetHourlyRate: amount(targetRate),
      requestedSeconds: seconds, preparationAllowanceSeconds,
    } });
  }
  candidates.sort((a, b) => a.estimate < b.estimate ? -1 : a.estimate > b.estimate ? 1 : a.lease.starter.id.localeCompare(b.lease.starter.id));
  return candidates[0] || null;
}

function quotedLease(lease, quotedAmount) {
  if (!lease) return undefined;
  const estimatedSeconds = Number(money(quotedAmount) * 3600n / money(lease.targetHourlyRate));
  if (estimatedSeconds < lease.requestedSeconds + lease.preparationAllowanceSeconds)
    throw new Error("Quoted starter credit does not cover the requested target lease and preparation allowance.");
  return { ...lease, estimatedSeconds,
    note: "Credit converts to a shorter target lease. Migration consumes time; actual hardware and remaining lease are checked before bootstrap." };
}

export async function machineOffers(options, machines) {
  const { profile, requirements } = requirementsFor({ kind: "vm", ...options });
  const cap = await vmCeiling(profile, options["max-spend"]);
  if (cap === null || money(cap) <= 0n) throw new Error("Set a VM ceiling with budget --vm-max-spend AMOUNT --approve, or pass machines --max-spend AMOUNT for discovery.");
  if (!/^[a-z0-9-]+$/.test(options.region || "")) throw new Error("Select --region, such as ams. Compare offers in the same region.");
  const seconds = duration(options.duration || "24h");
  machines ??= await catalog();
  const candidates = [], seen = new Set();
  let compatible = 0, omitted = 0, unsupportedLease = 0, resizePolicy = 0;
  for (const machine of machines) {
    if (machine.provider !== "vultr" || !Array.isArray(machine.locations) || !machine.locations.includes(options.region) || seen.has(machine.id)) continue;
    seen.add(machine.id);
    let capabilities;
    try { capabilities = machineCapabilities(machine); }
    catch { omitted++; continue; }
    if (Object.entries(requirements).some(([key, value]) => capabilities[key] == null ||
      (typeof value === "number" ? capabilities[key] < value : capabilities[key] !== value))) continue;
    compatible++;
    if (seconds < 86400 && !options["no-resize"] && resizePolicyReason(machine)) { resizePolicy++; continue; }
    let rental;
    try { rental = rentalFor(machine, machines, seconds, options.region, options["no-resize"]); }
    catch { compatible--; omitted++; continue; }
    if (!rental) { unsupportedLease++; continue; }
    if (rental.estimate > money(cap)) continue;
    candidates.push({ machine, capabilities, ...rental });
  }
  candidates.sort((a, b) => a.estimate < b.estimate ? -1 : a.estimate > b.estimate ? 1 : a.machine.id.localeCompare(b.machine.id));
  const offers = [];
  const quoteErrors = [];
  let changedBeyondCap = 0;
  for (const { machine, capabilities, estimate, lease, prepaidHours } of candidates.slice(0, shortlistSize)) {
    let offer, quoted;
    try {
      offer = await quote("create", { plan: lease?.starter.id || machine.id, provider: "vultr", region: options.region, os_id: 2284, prepaid_hours: lease?.prepaidHours || prepaidHours, label: "fission-quote" }, "compute-mpp");
      quoted = quotedLease(lease, offer.amount);
    }
    catch (error) { quoteErrors.push({ provider: "compute-mpp", machine: machine.id, reason: error.message }); continue; }
    if (money(offer.amount) > money(cap)) { changedBeyondCap++; continue; }
    offers.push({ provider: "compute-mpp", providerWarning: providerWarning("compute-mpp"), machine: machine.id, region: options.region, capabilities,
      creationQuote: offer.amount, catalogEstimate: amount(estimate), catalogCachedAt: machine.cached_at,
      quotedAt: new Date().toISOString(), leaseHours: lease ? null : prepaidHours, requestedHours: seconds / 3600, lease: quoted });
  }
  offers.sort((a, b) => money(a.creationQuote) < money(b.creationQuote) ? -1 : money(a.creationQuote) > money(b.creationQuote) ? 1 : a.machine.localeCompare(b.machine));
  const prices = offers.map((offer) => money(offer.creationQuote));
  return { status: offers.length ? "quoted" : "unavailable", profile, requirements, ceiling: cap, currency: "USDC.e",
    region: options.region, leaseHours: seconds >= 86400 ? Math.ceil(seconds / 86400) * 24 : null, requestedHours: seconds / 3600, paymentSubmitted: false,
    reason: !offers.length && compatible === resizePolicy && resizePolicy > 0 ? resizePolicyMessage : undefined,
    offers, average: prices.length ? { amount: amount((prices.reduce((a, b) => a + b, 0n) + BigInt(prices.length) - 1n) / BigInt(prices.length)),
      minimum: amount(prices[0]), maximum: amount(prices.at(-1)), sampleCount: prices.length, providerCount: 1,
      basis: "Live quotes from up to three cheapest compatible catalog plans within the ceiling, in this region for the requested target duration. Not a market average or spending authorization. Creation only; fees and extra services are excluded." } : null,
    quoteErrors,
    excluded: { overCeiling: compatible - resizePolicy - unsupportedLease - candidates.length + changedBeyondCap, resizePolicy, unsupportedLease, incompleteCatalog: omitted, quoteFailures: quoteErrors.length },
    note: offers.length ? "Capacity and inventory are provider catalog claims; plan and open re-quote before payment. Leave allocation room for lifecycle operations." : "No verified quote within the ceiling. Requirements and budget were preserved." };
}

export async function createPlan(name, options, task) {
  directory(name);
  const previous = await readJSON(join(directory(name), "state.json"));
  if (previous && previous.phase !== "not_submitted") throw new Error("Workspace name already recorded.");
  options = { ...options, provider: providerId(options.provider) };
  if (options.from) options = await (await import("./experiments.mjs")).planOptions(options);
  const definition = await recipe(options.recipe || "linux");
  const recipeName = definition.name;
  if (task?.mode !== "custom" && ["reth-synced", "base-synced", "foundry-symbolic"].includes(recipeName)) {
    if (options.profile && options.profile !== recipeName) throw new Error(`The ${recipeName} recipe requires its matching profile.`);
    options.profile = recipeName;
  }
  if (task?.mode !== "custom" && Object.hasOwn(sourceRecipes, recipeName)) {
    if (options.profile && options.profile !== recipeName) throw new Error("A source recipe requires its matching source profile; use hardware flags to raise its requirements.");
    if (!options.repo || !options.ref) throw new Error("Source recipes require a public --repo and exact --ref commit.");
    options.profile = recipeName;
  }
  if (options.budget !== undefined) {
    if (options["max-spend"] !== undefined || options["total-spend"] !== undefined)
      throw new Error("Use --budget alone, or separate --max-spend and --total-spend caps.");
    if (money(options.budget) <= minimumHeadroom) throw new Error("Budget must leave room for creation and 0.0003 in lifecycle allocation.");
    options["total-spend"] = options.budget;
    options["max-spend"] = amount(money(options.budget) - minimumHeadroom);
  }
  let selection, machines, alternatives = [];
  if (options.cheapest) {
    if (options.budget === undefined) throw new Error("Use --cheapest with a whole-workspace --budget.");
    if (options.machine || (options.provider && options.provider !== "compute-mpp") || (options.kind && options.kind !== "vm"))
      throw new Error("--cheapest selects a compute VM; do not combine it with --machine or an incompatible provider/kind.");
    if (!options.duration) throw new Error("--cheapest requires an explicit --duration.");
    const cap = await vmCeiling(options.profile || "runtime");
    if (cap !== null && money(options.budget) > money(cap)) throw new Error("Workspace allocation exceeds the configured VM ceiling.");
    machines = await catalog();
    const discovery = await machineOffers(options, machines);
    if (!discovery.offers.length) return discovery;
    const selected = discovery.offers[0];
    options.provider = selected.provider;
    options.machine = selected.machine;
    selection = { strategy: "cheapest", scope: discovery.average.basis, sampleCount: discovery.offers.length,
      average: discovery.average.amount, selectedQuote: selected.creationQuote, quotedAt: selected.quotedAt,
      baseline: selected.creationQuote, providerCount: discovery.average.providerCount, quoteErrors: discovery.quoteErrors };
    // Prefer the closest-priced compatible offers without inventing a second
    // budget. Discovery already preserves the task cap and lifecycle headroom.
    alternatives = discovery.offers.slice(1);
  }
  const provider = options.provider || "modal-tempo";
  const { profile, requirements } = requirementsFor({ ...(provider === "compute-mpp" ? { kind: "vm" } : {}), ...options });
  if (!["modal-tempo", "compute-mpp"].includes(provider)) throw new Error("Unknown provider.");
  let machine, capabilities, rental;
  if (provider === "compute-mpp") {
    machines ??= await catalog();
    machine = machines.find((item) => item.id === options.machine && item.provider === "vultr");
    if (!machine || !machine.locations.includes(options.region)) throw new Error("Choose a Vultr --machine and --region from the live compute catalog.");
    capabilities = machineCapabilities(machine);
    const unmet = Object.entries(requirements).filter(([key, value]) => capabilities[key] == null ||
      (typeof value === "number" ? capabilities[key] < value : capabilities[key] !== value)).map(([key, value]) => `${key}=${value}`);
    if (unmet.length) return { status: "unavailable", requirements, unmet, machine: machine.id, paymentSubmitted: false };
    const seconds = duration(options.duration);
    const policyReason = seconds < 86400 && !options["no-resize"] ? resizePolicyReason(machine) : null;
    if (policyReason) return { status: "unavailable", reason: policyReason, requirements, paymentSubmitted: false };
    rental = rentalFor(machine, machines, seconds, options.region, options["no-resize"]);
    if (!rental) return { status: "unavailable", reason: "No supported starter resize for this target duration and machine.", requirements, paymentSubmitted: false };
  } else {
    if (options.machine || options.region) throw new Error("Machine and region require --provider compute-mpp.");
    const matches = match(requirements);
    if (!matches.some((item) => item.provider === provider && item.unmet.length === 0)) return { version: 1, status: "unavailable", name, profile, requirements, candidates: matches, paymentSubmitted: false };
  }
  if (definition.artifacts.some((path) => basename(path) === "output.log")) throw new Error("output.log is reserved for the bootstrap artifact; use another artifact basename.");
  const timeout = duration(options.duration);
  const totalCap = options["total-spend"];
  let creationCap = options["max-spend"];
  if (money(creationCap) <= 0n || money(totalCap) < money(creationCap) + minimumHeadroom)
    throw new Error("Set --total-spend above the creation cap, leaving at least a launch and two shutdown calls (0.0003).");
  if (machine) {
    const cap = await vmCeiling(profile);
    if (cap !== null && money(totalCap) > money(cap)) throw new Error("Workspace allocation exceeds the configured VM ceiling.");
    if (!selection && rental.estimate > money(creationCap)) return { status: "unavailable", reason: "Catalog estimate exceeds the creation cap; no quote or payment submitted.", requirements, paymentSubmitted: false };
  }
  let source;
  if (options.repo || options.ref) {
    if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(options.repo || "") || !/^[a-f0-9]{40}$/.test(options.ref || ""))
      throw new Error("Source requires a public GitHub --repo URL and exact 40-character --ref commit. Upload private work explicitly.");
    source = { url: options.repo, commit: options.ref };
  }
  if (definition.afterCheckout?.length && !source) throw new Error("afterCheckout requires a public --repo and exact --ref commit.");
  let body = { timeout };
  if (machine) {
    await mkdir(directory(name), { recursive: true, mode: 0o700 });
    const key = join(directory(name), "id_ed25519");
    try { await access(key); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const result = await runProcess("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "fission", "-f", key]);
      if (result.code !== 0) throw new Error("Could not create workspace SSH key.");
    }
    body = { plan: rental.lease?.starter.id || machine.id, provider: "vultr", region: options.region, os_id: 2284, label: name,
      prepaid_hours: rental.lease?.prepaidHours || rental.prepaidHours, ssh_public_key: (await readFile(key + ".pub", "utf8")).trim() };
  }
  const candidates = [{ machine, capabilities, body, lease: rental?.lease }, ...alternatives.map((item) => {
    const target = machines.find((entry) => entry.id === item.machine && entry.provider === "vultr");
    const rental = rentalFor(target, machines, timeout, options.region, options["no-resize"]);
    return { machine: target, capabilities: item.capabilities, lease: item.lease,
      body: { ...body, plan: rental.lease?.starter.id || target.id, prepaid_hours: rental.lease?.prepaidHours || rental.prepaidHours } };
  })];
  let chosen, offer;
  const skipped = [];
  for (const candidate of candidates) {
    try {
      const current = await quote("create", candidate.body, provider);
      if (money(current.amount) > money(creationCap)) throw new Error("Creation quote exceeds its cap.");
      candidate.lease = quotedLease(candidate.lease, current.amount);
      chosen = candidate; offer = current; break;
    } catch (error) {
      if (!selection) throw error;
      skipped.push({ machine: candidate.machine.id, reason: error.message });
    }
  }
  if (!chosen) return { status: "unavailable", name, requirements, paymentSubmitted: false,
    reason: "No quoted candidate within the task's creation cap. No purchase submitted.", selection: { ...selection, skipped } };
  ({ machine, capabilities, body } = chosen);
  const lease = chosen.lease;
  if (selection) selection = { ...selection, selectedQuote: offer.amount, skipped,
    alternates: candidates.filter((item) => item !== chosen) };
  else if (options.budget !== undefined) creationCap = offer.amount;
  const value = { version: 1, status: "planned", id: randomUUID(), name, project: basename(process.cwd()), profile, requirements, provider, providerWarning: providerWarning(provider), kind: machine ? "linux-vm" : "linux-sandbox", capabilities: capabilities || providers[0], machine, lease, durationSeconds: timeout, creationQuote: offer.amount, creationCap, totalCap, source, recipe: definition, body, selection, createdAt: new Date().toISOString() };
  if (task) value.task = task;
  value.digest = digest(value);
  await writeJSON(planFile(value.id), value);
  return { ...value, paymentSubmitted: false, open: ["fission", "open", name, "--plan", value.id, "--approve"],
    funding: { ...paymentTerms, creationAmount: offer.amount, workspaceAllocation: totalCap,
      remainingAllocation: amount(money(totalCap) - money(creationCap)), feesIncluded: false, balance: null, shortfall: null } };
}

export async function openPlan(name, id) {
  const value = await readJSON(planFile(id));
  if (!value || value.name !== name) throw new Error("Saved plan does not match workspace name.");
  const { digest: expected, ...contents } = value;
  if (digest(contents) !== expected) throw new Error("Plan changed after creation. Generate a fresh plan.");
  value.provider = providerId(value.provider);
  let machines;
  if (value.provider === "compute-mpp") {
    const cap = await vmCeiling(value.profile);
    if (cap !== null && money(value.totalCap) > money(cap)) throw new Error("Saved allocation exceeds the current VM ceiling. Generate a lower-budget plan.");
    machines = await catalog();
    if ((await readFile(join(directory(name), "id_ed25519.pub"), "utf8")).trim() !== value.body.ssh_public_key)
      throw new Error("Workspace SSH public key changed after planning.");
  } else if (!match(value.requirements).some((item) => item.provider === value.provider && !item.unmet.length))
    throw new Error("Provider no longer satisfies the saved requirements.");
  const candidates = [{ machine: value.machine, capabilities: value.capabilities, body: value.body, lease: value.lease }, ...(value.selection?.alternates || [])];
  let chosen, offer;
  const skipped = [];
  for (const candidate of candidates) {
    try {
      if (machines) validateCandidate(machines, candidate);
      const current = await quote("create", candidate.body, value.provider);
      if (money(current.amount) > money(value.creationCap)) throw new Error("Current quote exceeds the approved creation cap.");
      candidate.lease = quotedLease(candidate.lease, current.amount);
      chosen = candidate; offer = current; break;
    } catch (error) {
      if (!value.selection?.alternates) throw error;
      skipped.push({ machine: candidate.machine.id, reason: error.message });
    }
  }
  if (!chosen) throw new Error(`No approved candidate validated before payment: ${skipped.map((item) => `${item.machine}: ${item.reason}`).join("; ")}. No purchase submitted.`);
  // This is deliberately outside the fallback loop. Once a creation intent
  // exists, observe its outcome; never buy another machine after an error.
  return start(name, { ...value, ...chosen, creationQuote: offer.amount, asyncPreparation: true,
    selection: value.selection ? { ...value.selection, chosen: chosen.machine.id, openSkipped: skipped } : undefined });
}

function validateCandidate(machines, candidate) {
  const current = machines.find((item) => item.id === candidate.machine.id && item.provider === "vultr");
  if (!current || !current.locations.includes(candidate.body.region) || JSON.stringify(machineCapabilities(current)) !== JSON.stringify(candidate.capabilities))
    throw new Error("Compute plan capacity changed. Generate a fresh plan.");
  if (candidate.lease) {
    const policyReason = resizePolicyReason(current);
    if (policyReason) throw new Error(policyReason);
    const starter = machines.find((item) => item.id === candidate.body.plan && item.provider === "vultr");
    if (!starter || !starter.locations.includes(candidate.body.region) || JSON.stringify(machineCapabilities(starter)) !== JSON.stringify(candidate.lease.starterCapabilities) ||
        hourlyRate(starter) !== money(candidate.lease.starterHourlyRate) || hourlyRate(current) !== money(candidate.lease.targetHourlyRate))
      throw new Error("Starter capacity or conversion rates changed. Generate a fresh plan.");
  }
}
