// Private TUI adapter: financial calculations and mutations stay in the CLI backend.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { root, list } from "./state.mjs";
import { spending } from "./payments.mjs";
import { close, refresh, operationCap } from "./workspace.mjs";
import { units, amount } from "./budget.mjs";
import { providerWarning } from "./provider.mjs";
import { storage } from "./storage.mjs";
import { availableMachines, quoteMachine } from "./ui-catalog.mjs";

const money = (value) => {
  if (value == null) return "unknown";
  const [whole, fraction = ""] = String(value).split(".");
  return whole + "." + fraction.replace(/0+$/, "").padEnd(2, "0");
};
const date = (value) => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "unknown";

async function main() {
  const [action, name] = process.argv.slice(2);
  let message = "";
  let available = action === "snapshot" ? await availableMachines({ cached: true }) : undefined;
  if (action === "close") {
    await mkdir(join(root, "exports"), { recursive: true, mode: 0o700 });
    const result = await close(name, { output: join(root, "exports", `${name}-${Date.now()}`) });
    message = `${name}: ${result.phase}${result.exportedTo ? ". Saved " + result.exportedTo : ""}`;
  } else if (action === "refresh") {
    await refresh(name);
    message = "Provider status updated.";
  } else if (action === "catalog") available = await availableMachines();
  else if (action === "quote") message = await quoteMachine(name);
  else if (!["snapshot", "verify"].includes(action)) throw new Error("Unknown TUI operation.");
  const states = await list(), report = await spending({ refresh: action === "verify" });
  if (action === "verify") message = report.refreshError || "Payment receipts checked; missing amounts remain unknown.";
  const machines = states.map((state) => {
    const transactions = report.transactions.filter((item) => item.workspaces.includes(state.name));
    const paid = report.unknownWorkspaces?.includes(state.name) || !transactions.length ||
      transactions.some((item) => item.paid === null || item.workspaces.length !== 1) ? null :
      transactions.reduce((sum, item) => sum + units(item.paid), 0n);
    const capacity = state.observedResources || (state.lease ? state.lease.starterCapabilities : state.capabilities);
    const finished = ["terminated", "expired", "not_submitted"].includes(state.phase);
    const unresolved = state.phase.endsWith("_unknown");
    return {
      name: state.name, project: state.project || state.source?.url?.split("/").at(-1)?.replace(/\.git$/, "") || state.recipe.name.replace(/-(source|synced|node)$/, ""),
      phase: !finished && state.resizePending ? "resizing" : state.phase, provider: state.provider, providerWarning: Boolean(providerWarning(state.provider)), finished,
      active: !finished && !unresolved && Boolean(state.remoteId), unresolved,
      ssh: state.provider === "compute-mpp" && state.phase === "ready" && !state.resizePending,
      requested: state.requestedAt || "", expiry: Math.floor(Date.parse(state.providerExpiresAt || state.deadlineEstimate) / 1000) || null,
      estimated: !state.providerExpiresAt, paid: money(paid === null ? null : amount(paid)), paidUnits: paid?.toString() ?? null,
      capacity: capacity?.cpu ? `${capacity.cpu} vCPU / ${capacity.memoryGiB} GiB RAM / ${Math.floor(capacity.diskGiB)} GiB disk` : "unreserved sandbox",
      started: date(state.requestedAt), ended: date(finished ? state.closedAt : state.providerExpiresAt || state.deadlineEstimate),
      cap: money(state.totalCap), quote: money(state.creationQuote), exported: state.exportedTo || "",
      checkCap: state.provider === "compute-mpp" ? "0" : operationCap,
      transactions: transactions.map((item) => ({ paid: money(item.paid), operation: item.operation || "unknown", hash: item.hash })),
    };
  });
  console.log(JSON.stringify({ machines, message, available, storage: await storage().catch((error) => ({ directory: error.message, availableBytes: null })),
    spending: `paid ${money(report.paid)} ${report.currency}${report.pendingVerification || report.unresolvedRequests || report.unreadableRecords ? " + unknown" : ""}    allocated ${money(report.budget?.allocated)} / ${money(report.budget?.limit)}`,
  }));
}
// Closing the TUI closes this pipe and cancels its read-only catalog worker.
const background = process.env.FISSION_UI_BACKGROUND === "1" && process.argv[2] === "catalog";
if (background) {
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; })
  .finally(() => { if (background) process.stdin.destroy(); });
