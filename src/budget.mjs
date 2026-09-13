import { join } from "node:path";
import { root, readJSON, writeJSON, fileLocked, list } from "./state.mjs";

export function units(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value))
    throw new Error("Use a non-negative USDC.e amount with at most six decimal places.");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0"));
}
export const amount = (value) => `${value / 1000000n}.${String(value % 1000000n).padStart(6, "0")}`;
const path = join(root, ".budget.json");
const lock = (fn) => fileLocked(join(root, ".budget.lock"), fn);
// Two gateway calls remain available for a termination and its confirmation.
const terminationReserve = 200n;
export class BudgetRejected extends Error {}

function summarize(ledger) {
  if (!ledger) throw new Error("Initialize an aggregate budget with budget --total-spend AMOUNT --approve.");
  const allocated = Object.values(ledger.allocations).reduce((sum, item) => sum + units(item), 0n);
  const reserved = Object.values(ledger.requests).reduce((sum, item) => sum + units(item.maximum), 0n);
  return { limit: ledger.limit, allocated: amount(allocated), reserved: amount(reserved), availableToAllocate: amount(units(ledger.limit) - allocated), allocations: ledger.allocations, vmCaps: ledger.vmCaps || {} };
}

export async function budget(limit, { vmMaxSpend, profile } = {}) {
  // Atomic rename makes a read snapshot coherent. Observers must not compete
  // with the fail-fast authorization/reservation lock.
  if (limit === undefined && vmMaxSpend === undefined) return summarize(await readJSON(path));
  return lock(async () => {
    const existing = await readJSON(path);
    if (limit !== undefined) {
      if (units(limit) <= 0n) throw new Error("Budget must be positive.");
      if (existing && units(limit) > units(existing.limit)) throw new Error("An authorization already exists. Preserve it; this command cannot increase or reset it.");
      if (existing && units(limit) < units(existing.limit)) {
        const allocated = Object.values(existing.allocations).reduce((sum, item) => sum + units(item), 0n);
        if (units(limit) < allocated) throw new Error("The new ceiling cannot be below existing workspace allocations.");
        if (Object.values(existing.vmCaps || {}).some((cap) => units(cap) > units(limit)))
          throw new Error("Lower the configured VM ceilings before lowering the aggregate ceiling below them.");
        existing.limit = limit;
        await writeJSON(path, existing);
      }
      if (!existing) {
        if ((await list()).some((state) => !state.totalCap && !["terminated", "expired"].includes(state.phase)))
          throw new Error("Close existing creation-only workspaces before initializing an aggregate budget.");
        await writeJSON(path, { version: 1, limit, allocations: {}, requests: {} });
      }
    }
    const ledger = existing || await readJSON(path);
    if (!ledger) throw new Error("Initialize an aggregate budget with budget --total-spend AMOUNT --approve.");
    if (vmMaxSpend !== undefined) {
      if (units(vmMaxSpend) <= 0n || units(vmMaxSpend) > units(ledger.limit))
        throw new Error("VM ceiling must be positive and within the aggregate authorization.");
      ledger.vmCaps = { ...ledger.vmCaps, [profile || "default"]: vmMaxSpend };
      await writeJSON(path, ledger);
    }
    return summarize(ledger);
  });
}

function ceiling(ledger, profile, requested) {
  const limits = [ledger?.vmCaps?.default, ledger?.vmCaps?.[profile], requested].filter((value) => value !== undefined);
  if (!limits.length) return null;
  return amount(limits.map(units).reduce((a, b) => a < b ? a : b));
}

export async function vmCeiling(profile, requested) {
  return ceiling(await readJSON(path), profile, requested);
}

export async function hasTerminationReservation(state) {
  const ledger = await readJSON(path);
  return !ledger || Object.values(ledger.requests).some((item) => item.name === state.name && item.operation === "terminate");
}

export async function reserve(state, operation, maximum, id) {
  return lock(async () => {
    const ledger = await readJSON(path);
    if (!ledger && !state.totalCap) return; // Existing creation-only workflows remain compatible.
    if (!ledger) throw new BudgetRejected("Initialize the aggregate budget before purchasing a persisted plan.");
    if (operation === "create" && state.kind === "linux-vm") {
      const maximumVM = ceiling(ledger, state.profile);
      if (maximumVM !== null && units(state.totalCap) > units(maximumVM))
        throw new BudgetRejected("Workspace allocation exceeds the configured VM ceiling. Generate a lower-budget plan.");
    }
    if (ledger.requests[id]) throw new Error("Payment already reserved. Reconcile; never resubmit this request.");
    const cap = state.totalCap || ledger.allocations[state.name];
    if (!cap) throw new Error("This legacy workspace has no allocation in the active aggregate budget.");
    if (!ledger.allocations[state.name]) {
      const allocated = Object.values(ledger.allocations).reduce((sum, item) => sum + units(item), 0n);
      if (allocated + units(cap) > units(ledger.limit)) throw new BudgetRejected("Aggregate budget cannot fund this workspace allocation.");
      ledger.allocations[state.name] = cap;
    }
    if (units(cap) !== units(ledger.allocations[state.name])) throw new Error("Workspace budget differs from its durable allocation.");
    const used = Object.values(ledger.requests).filter((item) => item.name === state.name).reduce((sum, item) => sum + units(item.maximum), 0n);
    const closing = Object.values(ledger.requests).some((item) => item.name === state.name && item.operation === "terminate");
    const reserveForClose = operation === "terminate" || (operation === "status" && closing) ? 0n : terminationReserve;
    if (used + units(maximum) + reserveForClose > units(cap)) throw new Error("Workspace budget exhausted; termination reserve is protected.");
    ledger.requests[id] = { name: state.name, operation, maximum, reservedAt: new Date().toISOString() };
    await writeJSON(path, ledger);
  });
}
