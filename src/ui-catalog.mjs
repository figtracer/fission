import { catalog, machineCapabilities } from "./compute.mjs";
import { vmCeiling, units } from "./budget.mjs";
import { quote, providerWarning } from "./provider.mjs";

// Browse the complete supported VM catalog; only an explicit selection asks for a quote.
export async function availableMachines() {
  const ceiling = await vmCeiling("runtime");
  const seen = new Set(), machines = [];
  for (const machine of await catalog()) {
    if (machine.provider !== "vultr" || seen.has(machine.id) ||
        !/^[a-z0-9-]+$/.test(machine.id) || !Array.isArray(machine.locations) ||
        !Number.isFinite(machine.our_daily) || machine.our_daily <= 0) continue;
    let capacity;
    try { capacity = machineCapabilities(machine); } catch { continue; }
    const regions = [...new Set(machine.locations.filter(region => /^[a-z0-9-]+$/.test(region)))].sort();
    if (!regions.length) continue;
    seen.add(machine.id);
    const price = machine.our_daily.toFixed(6);
    machines.push({ id: machine.id, provider: "compute-mpp", providerWarning: Boolean(providerWarning("compute-mpp")),
      cpu: capacity.cpu, memory: capacity.memoryGiB, disk: Math.floor(capacity.diskGiB),
      daily: price, regions, withinCap: ceiling === null || units(price) <= units(ceiling) });
  }
  machines.sort((a, b) => Number(a.daily) - Number(b.daily) || a.id.localeCompare(b.id));
  return { machines, ceiling: ceiling || "unset", fetchedAt: new Date().toISOString() };
}

export async function quoteMachine(input) {
  const { id, region } = JSON.parse(input);
  const current = await availableMachines();
  const machine = current.machines.find(machine => machine.id === id && machine.regions.includes(region));
  if (!machine) throw new Error("Machine or region is no longer listed. Reload Available.");
  const offer = await quote("create", { plan: id, provider: "vultr", region, os_id: 2284, prepaid_hours: 24, label: "fission-quote" }, "compute-mpp");
  return `${id} / ${region}: ${offer.amount} USDC.e for 24h / quoted ${new Date().toISOString()}${current.ceiling !== "unset" && units(offer.amount) > units(current.ceiling) ? " / above VM cap" : ""}`;
}
