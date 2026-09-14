import { join, basename } from "node:path";
import { mkdir, readFile, access } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { root, directory, readJSON, writeJSON, providerId } from "./state.mjs";
import { recipe, duration, start, sourceRecipes } from "./workspace.mjs";
import { quote, money, runProcess, paymentTerms, providerWarning } from "./provider.mjs";
import { catalog, machineCapabilities } from "./compute.mjs";
import { amount, vmCeiling } from "./budget.mjs";

export const providers = [{
  id: "modal-tempo", available: true,
  capabilities: { os: "linux", kind: "sandbox", architecture: null, cpu: null, memoryGiB: null, diskGiB: null, p2p: false, customImage: false, expiry: true },
  evidence: "https://modal.mpp.tempo.xyz",
  limitations: "Gateway exposes timeout only; no resource reservation, architecture selection, P2P ports, or image selection. Runtime recipes are opportunistic.",
}, {
  id: "compute-mpp", available: true,
  limitations: "Vultr Linux x86_64 VMs selected from the live catalog. Shorter target leases use a prepaid starter upgrade with capacity and time gates. Catalog capacity and P2P require guest verification; node readiness is a separate workload. Early deletion does not imply a refund.",
  payment: "MPP tempo.charge",
}, {
  id: "smol-orthogonal", available: false,
  reason: "Lifecycle API returned expired_key on 2026-09-13. No purchase until authenticated lifecycle operations work.",
  evidence: "https://www.orthogonal.com/blog/smolmachines-microvms-for-ai-agents",
}, {
  id: "agentvm", available: false,
  reason: "Published MPP profile has unselectable capacity (up to 160 GB), Linux only, and no verified capability-authenticated immediate teardown.",
  evidence: "https://mpp.agentvm.sh/compute/sessions",
}].map((provider) => ({ ...provider, warning: providerWarning(provider.id) }));

// Planning floors, not performance guarantees; stricter issue-specific requirements
// may be supplied. Full-node figures require rechecking snapshot expansion/growth.
export const profiles = {
  runtime: { os: "linux", kind: "sandbox" },
  "foundry-source": { os: "linux", architecture: "x86_64", cpu: 4, memoryGiB: 16, diskGiB: 100 },
  "reth-source": { os: "linux", architecture: "x86_64", cpu: 8, memoryGiB: 32, diskGiB: 200 },
  "reth-synced": { os: "linux", kind: "vm", architecture: "x86_64", cpu: 8, memoryGiB: 32, diskGiB: 2048, p2p: true },
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
      requirements[field] = Math.max(requirements[field] || 0, value);
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
const hourlyRate = (machine) => {
  if (!Number.isFinite(machine.our_hourly) || machine.our_hourly <= 0) throw new Error("Missing hourly compute rate.");
  return money(String(machine.our_hourly));
};
const catalogPrice = (machine) => {
  if (typeof machine.our_daily !== "number" || !Number.isFinite(machine.our_daily) || machine.our_daily <= 0)
    throw new Error("Missing daily catalog price.");
  return money(String(machine.our_daily));
};

function rentalFor(machine, machines, seconds, region) {
  if (seconds === 86400) return { estimate: catalogPrice(machine) };
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

export async function machineOffers(options) {
  const { profile, requirements } = requirementsFor({ kind: "vm", ...options });
  const cap = await vmCeiling(profile, options["max-spend"]);
  if (cap === null || money(cap) <= 0n) throw new Error("Set a VM ceiling with budget --vm-max-spend AMOUNT --approve, or pass machines --max-spend AMOUNT for discovery.");
  if (!/^[a-z0-9-]+$/.test(options.region || "")) throw new Error("Select --region, such as ams. Compare offers in the same region.");
  const seconds = duration(options.duration || "24h");
  const machines = await catalog();
  const candidates = [], seen = new Set();
  let compatible = 0, omitted = 0, unsupportedLease = 0;
  for (const machine of machines) {
    if (machine.provider !== "vultr" || !Array.isArray(machine.locations) || !machine.locations.includes(options.region) || seen.has(machine.id)) continue;
    seen.add(machine.id);
    let capabilities, rental;
    try { capabilities = machineCapabilities(machine); rental = rentalFor(machine, machines, seconds, options.region); }
    catch { omitted++; continue; }
    if (Object.entries(requirements).some(([key, value]) => capabilities[key] == null ||
      (typeof value === "number" ? capabilities[key] < value : capabilities[key] !== value))) continue;
    compatible++;
    if (!rental) { unsupportedLease++; continue; }
    if (rental.estimate > money(cap)) continue;
    candidates.push({ machine, capabilities, ...rental });
  }
  candidates.sort((a, b) => a.estimate < b.estimate ? -1 : a.estimate > b.estimate ? 1 : a.machine.id.localeCompare(b.machine.id));
  const offers = [];
  let quoteFailures = 0, changedBeyondCap = 0;
  for (const { machine, capabilities, estimate, lease } of candidates.slice(0, shortlistSize)) {
    let offer, quoted;
    try {
      offer = await quote("create", { plan: lease?.starter.id || machine.id, provider: "vultr", region: options.region, os_id: 2284, prepaid_hours: lease?.prepaidHours || 24, label: "fission-quote" }, "compute-mpp");
      quoted = quotedLease(lease, offer.amount);
    }
    catch { quoteFailures++; continue; }
    if (money(offer.amount) > money(cap)) { changedBeyondCap++; continue; }
    offers.push({ provider: "compute-mpp", providerWarning: providerWarning("compute-mpp"), machine: machine.id, region: options.region, capabilities,
      creationQuote: offer.amount, catalogEstimate: amount(estimate), catalogCachedAt: machine.cached_at,
      quotedAt: new Date().toISOString(), leaseHours: lease ? null : 24, requestedHours: seconds / 3600, lease: quoted });
  }
  offers.sort((a, b) => money(a.creationQuote) < money(b.creationQuote) ? -1 : money(a.creationQuote) > money(b.creationQuote) ? 1 : a.machine.localeCompare(b.machine));
  const prices = offers.map((offer) => money(offer.creationQuote));
  return { status: offers.length ? "quoted" : "unavailable", profile, requirements, ceiling: cap, currency: "USDC.e",
    region: options.region, leaseHours: seconds === 86400 ? 24 : null, requestedHours: seconds / 3600, paymentSubmitted: false,
    offers, average: prices.length ? { amount: amount((prices.reduce((a, b) => a + b, 0n) + BigInt(prices.length) - 1n) / BigInt(prices.length)),
      minimum: amount(prices[0]), maximum: amount(prices.at(-1)), sampleCount: prices.length, providerCount: 1,
      basis: "Live quotes from up to three cheapest compatible catalog plans within the ceiling, in this region for the requested target duration. Not a market average or spending authorization. Creation only; fees and extra services are excluded." } : null,
    excluded: { overCeiling: compatible - unsupportedLease - candidates.length + changedBeyondCap, unsupportedLease, incompleteCatalog: omitted, quoteFailures },
    note: offers.length ? "Capacity and inventory are provider catalog claims; plan and open re-quote before payment. Leave allocation room for lifecycle operations." : "No verified quote within the ceiling. Requirements and budget were preserved." };
}

export async function createPlan(name, options) {
  directory(name);
  const previous = await readJSON(join(directory(name), "state.json"));
  if (previous && previous.phase !== "not_submitted") throw new Error("Workspace name already recorded.");
  options = { ...options, provider: providerId(options.provider) };
  if (options.from) options = await (await import("./experiments.mjs")).planOptions(options);
  const definition = await recipe(options.recipe || "linux");
  const recipeName = definition.name;
  if (recipeName === "reth-synced") {
    if (options.profile && options.profile !== "reth-synced") throw new Error("The synced-node recipe requires its matching profile.");
    options.profile = "reth-synced";
  }
  if (Object.hasOwn(sourceRecipes, recipeName)) {
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
  let selection;
  if (options.cheapest) {
    if (options.budget === undefined) throw new Error("Use --cheapest with a whole-workspace --budget.");
    if (options.machine || (options.provider && options.provider !== "compute-mpp") || (options.kind && options.kind !== "vm"))
      throw new Error("--cheapest selects a compute VM; do not combine it with --machine or an incompatible provider/kind.");
    if (!options.duration) throw new Error("--cheapest requires an explicit --duration.");
    const cap = await vmCeiling(options.profile || "runtime");
    if (cap !== null && money(options.budget) > money(cap)) throw new Error("Workspace allocation exceeds the configured VM ceiling.");
    const discovery = await machineOffers(options);
    if (!discovery.offers.length) return discovery;
    const selected = discovery.offers[0];
    options.provider = selected.provider;
    options.machine = selected.machine;
    selection = { strategy: "cheapest", scope: discovery.average.basis, sampleCount: discovery.offers.length,
      average: discovery.average.amount, selectedQuote: selected.creationQuote, quotedAt: selected.quotedAt };
  }
  const provider = options.provider || "modal-tempo";
  const { profile, requirements } = requirementsFor({ ...(provider === "compute-mpp" ? { kind: "vm" } : {}), ...options });
  if (!["modal-tempo", "compute-mpp"].includes(provider)) throw new Error("Unknown provider.");
  let machine, capabilities, rental;
  if (provider === "compute-mpp") {
    const machines = await catalog();
    machine = machines.find((item) => item.id === options.machine && item.provider === "vultr");
    if (!machine || !machine.locations.includes(options.region)) throw new Error("Choose a Vultr --machine and --region from the live compute catalog.");
    capabilities = machineCapabilities(machine);
    const unmet = Object.entries(requirements).filter(([key, value]) => capabilities[key] == null ||
      (typeof value === "number" ? capabilities[key] < value : capabilities[key] !== value)).map(([key, value]) => `${key}=${value}`);
    if (unmet.length) return { status: "unavailable", requirements, unmet, machine: machine.id, paymentSubmitted: false };
    const seconds = duration(options.duration);
    rental = rentalFor(machine, machines, seconds, options.region);
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
    if (rental.estimate > money(creationCap)) return { status: "unavailable", reason: "Catalog estimate exceeds the creation cap; no quote or payment submitted.", requirements, paymentSubmitted: false };
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
      prepaid_hours: rental.lease?.prepaidHours || 24, ssh_public_key: (await readFile(key + ".pub", "utf8")).trim() };
  }
  const offer = await quote("create", body, provider);
  if (money(offer.amount) > money(creationCap)) throw new Error("Creation quote exceeds its cap.");
  if (selection && money(offer.amount) > money(selection.selectedQuote)) throw new Error("Quote increased after selection. No purchase submitted; request a fresh plan.");
  if (options.budget !== undefined) creationCap = offer.amount;
  const lease = quotedLease(rental?.lease, offer.amount);
  const value = { version: 1, status: "planned", id: randomUUID(), name, project: basename(process.cwd()), profile, requirements, provider, providerWarning: providerWarning(provider), kind: machine ? "linux-vm" : "linux-sandbox", capabilities: capabilities || providers[0], machine, lease, durationSeconds: timeout, creationQuote: offer.amount, creationCap, totalCap, source, recipe: definition, body, selection, createdAt: new Date().toISOString() };
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
  if (value.provider === "compute-mpp") {
    const cap = await vmCeiling(value.profile);
    if (cap !== null && money(value.totalCap) > money(cap)) throw new Error("Saved allocation exceeds the current VM ceiling. Generate a lower-budget plan.");
    const machines = await catalog();
    const current = machines.find((item) => item.id === value.machine.id && item.provider === "vultr");
    if (!current || !current.locations.includes(value.body.region) || JSON.stringify(machineCapabilities(current)) !== JSON.stringify(value.capabilities))
      throw new Error("Compute plan capacity changed. Generate a fresh plan.");
    if (value.lease) {
      const starter = machines.find((item) => item.id === value.body.plan && item.provider === "vultr");
      if (!starter || !starter.locations.includes(value.body.region) || JSON.stringify(machineCapabilities(starter)) !== JSON.stringify(value.lease.starterCapabilities) ||
          hourlyRate(starter) !== money(value.lease.starterHourlyRate) || hourlyRate(current) !== money(value.lease.targetHourlyRate))
        throw new Error("Starter capacity or conversion rates changed. Generate a fresh plan.");
    }
    if ((await readFile(join(directory(name), "id_ed25519.pub"), "utf8")).trim() !== value.body.ssh_public_key)
      throw new Error("Workspace SSH public key changed after planning.");
  } else if (!match(value.requirements).some((item) => item.provider === value.provider && !item.unmet.length))
    throw new Error("Provider no longer satisfies the saved requirements.");
  const offer = await quote("create", value.body, value.provider);
  if (money(offer.amount) > money(value.creationCap)) throw new Error("Current quote exceeds the approved creation cap.");
  quotedLease(value.lease, offer.amount);
  return start(name, { ...value, creationQuote: offer.amount, asyncPreparation: true });
}
