import { emitKeypressEvents } from "node:readline";
import { join } from "node:path";
import { root, list } from "./state.mjs";
import { spending } from "./payments.mjs";
import { close, refresh, operationCap } from "./workspace.mjs";
import { connect } from "./compute.mjs";
import { units, amount } from "./budget.mjs";

const finished = (state) => ["terminated", "expired", "not_submitted"].includes(state.phase);
const filters = ["all", "active", "past"];
const sorts = ["recent", "name", "paid", "expiry"];
// Provider strings and job metadata must never become terminal escape sequences.
const safe = (value) => String(value ?? "-").replace(/[^\x20-\x7e\u00b7\u2191\u2193\u2013\u2026]/g, "?");
const clip = (value, width) => {
  const text = safe(value);
  return text.length <= width ? text : text.slice(0, Math.max(0, width - 1)) + "…";
};
const money = (value) => {
  if (value == null) return "unknown";
  const [whole, fraction = ""] = String(value).split(".");
  return whole + "." + fraction.replace(/0+$/, "").padEnd(2, "0");
};
const date = (value) => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "unknown";
const remaining = (state, now) => {
  if (finished(state)) return state.phase === "not_submitted" ? "not rented" : "closed";
  const seconds = Math.floor((Date.parse(state.providerExpiresAt || state.deadlineEstimate) - now) / 1000);
  if (!Number.isFinite(seconds)) return "unknown";
  if (seconds <= 0) return "check expiry";
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}m` + (state.providerExpiresAt ? "" : " ~");
};

function paidFor(state, report) {
  if (report.unknownWorkspaces?.includes(state.name)) return null;
  const transactions = report.transactions.filter((item) => item.workspaces.includes(state.name));
  if (!transactions.length || transactions.some((item) => item.paid === null || item.workspaces.length !== 1)) return null;
  return amount(transactions.reduce((sum, item) => sum + units(item.paid), 0n));
}

export function machineRows(data, view) {
  return data.states.filter((state) => view.filter === "all" || (view.filter === "past") === finished(state)).sort((a, b) => {
    if (view.sort === "name") return a.name.localeCompare(b.name);
    if (view.sort === "paid") {
      const paidA = paidFor(a, data.report), paidB = paidFor(b, data.report);
      const delta = (paidB === null ? -1n : units(paidB)) - (paidA === null ? -1n : units(paidA));
      return delta > 0n ? 1 : delta < 0n ? -1 : a.name.localeCompare(b.name);
    }
    if (view.sort === "expiry") return (finished(a) ? Infinity : Date.parse(a.providerExpiresAt || a.deadlineEstimate) || Infinity) -
      (finished(b) ? Infinity : Date.parse(b.providerExpiresAt || b.deadlineEstimate) || Infinity) || a.name.localeCompare(b.name);
    return String(b.requestedAt || "").localeCompare(String(a.requestedAt || "")) || a.name.localeCompare(b.name);
  });
}

export function renderUI(data, view, columns = 100, rows = 30, now = Date.now(), color = true) {
  const width = Math.max(1, columns - 4), lines = [];
  const tint = (text, code) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const add = (text = "", style) => lines.push("  " + (style ? tint(clip(text, width), style) : clip(text, width)));
  if (columns < 56 || rows < 16) return ["fission", "Enlarge the terminal to at least 56 x 16.", "q quit"].slice(0, rows).map((line) => clip(line, Math.max(1, columns - 1)));
  const report = data.report, activeCount = data.states.filter((state) => !finished(state)).length;
  add(); add("fission", "38;5;108");
  add(`${activeCount} active  /  ${data.states.length} recorded`, "2");
  add(`paid ${money(report.paid)} ${report.currency}${report.pendingVerification || report.unresolvedRequests || report.unreadableRecords ? " + unknown" : ""}    allocated ${money(report.budget?.allocated)} / ${money(report.budget?.limit)}`);
  add();
  const machines = machineRows(data, view), index = Math.max(0, Math.min(view.index, machines.length - 1)), selected = machines[index];
  if (!view.detail) {
    add(`${view.filter} machines    sort: ${view.sort}`, "2");
    const nameWidth = columns >= 100 ? 24 : columns >= 75 ? 20 : 16;
    const stateWidth = columns >= 100 ? 23 : columns >= 75 ? 20 : 15;
    const tableRow = (name, phase, left, paid) => `${clip(name, nameWidth).padEnd(nameWidth)} ${clip(phase, stateWidth).padEnd(stateWidth)} ${left.padEnd(12)}${columns >= 75 ? " " + paid.padStart(9) : ""}`;
    add("  " + tableRow("name", "state", "time left", "paid"), "2");
    const count = Math.max(1, rows - 12), offset = Math.floor(index / count) * count;
    for (const [i, state] of machines.slice(offset, offset + count).entries()) {
      const row = tableRow(state.name, state.phase, remaining(state, now), money(paidFor(state, report)));
      add((offset + i === index ? "> " : "  ") + row, offset + i === index ? "7" : undefined);
    }
    if (!machines.length) add(view.filter === "active" ? "No active machines." : "No machines here yet.");
    if (machines.length > count) add(`${index + 1} / ${machines.length}`, "2");
  } else if (selected) {
    add(selected.name, "38;5;108");
    add(`${selected.phase}  ·  ${remaining(selected, now)}  ·  ${selected.provider}`);
    const capacity = selected.capabilities;
    if (capacity?.cpu) add(`${capacity.cpu} vCPU  /  ${capacity.memoryGiB} GiB RAM  /  ${Math.floor(capacity.diskGiB)} GiB disk`, "2");
    else add("capacity: unreserved sandbox", "2");
    add(`started ${date(selected.requestedAt)}`);
    add(`${finished(selected) ? "closed " + date(selected.closedAt) : "expires " + date(selected.providerExpiresAt || selected.deadlineEstimate)}`);
    add(`paid ${money(paidFor(selected, report))}  /  workspace cap ${money(selected.totalCap)}  /  quote ${money(selected.creationQuote)}`);
    add(); add("transactions", "2");
    const transactions = report.transactions.filter((item) => item.workspaces.includes(selected.name));
    const count = Math.max(1, rows - 19);
    for (const item of transactions.slice(view.offset, view.offset + count))
      add(`${money(item.paid).padEnd(10)} ${safe(item.operation).padEnd(10)} ${item.hash}`);
    if (!transactions.length) add("No recorded payment receipts.");
    else add(`${Math.min(view.offset + 1, transactions.length)}–${Math.min(view.offset + count, transactions.length)} of ${transactions.length}  ·  full references: fission spending`, "2");
    if (selected.exportedTo) add(`saved ${selected.exportedTo}`, "2");
  }
  while (lines.length < rows - 4) add();
  // Keep messages and controls visible even when the terminal is short.
  lines.splice(rows - 4);
  add(view.message || "cached view · v verifies payments · network fees included in paid", "2");
  add(view.confirm ? `Close ${view.confirm}? y save declared files and close · n cancel` :
    view.detail ? "enter SSH · p check machine · x close · esc back · q quit" : "↑↓ select · enter details · tab filter · s sort · q quit", "2");
  add(view.detail ? "↑↓ scroll receipts · r reload · v verify payments" : "r reload · v verify payments · ~ estimated expiry", "2");
  return lines.slice(0, rows);
}

export async function ui() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("The TUI needs an interactive terminal. Agents can use list --json and spending.");
  const input = process.stdin, output = process.stdout;
  const view = { filter: "all", sort: "recent", index: 0, detail: false, offset: 0, message: "" };
  let data = { states: await list(), report: await spending() }, stopped = false, busy = false, paused = false, loading = false;
  let lastFrame;
  let controller = new AbortController();
  const previousRaw = input.isRaw;
  const paint = () => {
    if (paused || stopped) return;
    const frame = "\x1b[H" + renderUI(data, view, output.columns, output.rows, Date.now(), !process.env.NO_COLOR)
      .map((line) => line + "\x1b[K").join("\r\n") + "\x1b[J";
    if (frame !== lastFrame) output.write(frame);
    lastFrame = frame;
  };
  const reload = async () => {
    if (loading || stopped || paused) return;
    loading = true;
    try {
      const selected = machineRows(data, view)[view.index]?.name;
      data = { states: await list(), report: await spending() };
      const rows = machineRows(data, view), found = rows.findIndex((item) => item.name === selected);
      view.index = found >= 0 ? found : Math.max(0, Math.min(view.index, rows.length - 1));
      paint();
    } catch (error) { view.message = error.message; paint(); }
    finally { loading = false; }
  };
  const enter = () => { lastFrame = null; output.write("\x1b[?1049h\x1b[?25l"); input.setRawMode(true); input.resume(); paint(); };
  const leave = () => { input.setRawMode(previousRaw || false); input.pause(); output.write("\x1b[0m\x1b[?25h\x1b[?1049l"); };
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const stop = () => { controller.abort(); stopped = true; if (!busy) finish(); };
  const settled = () => { busy = false; if (stopped) finish(); };
  const keypress = async (text, key = {}) => {
    if (paused || stopped) return;
    if (key.name === "q" || key.ctrl && key.name === "c") { if (!busy) stop(); else { controller.abort(); view.message = "Finishing the current operation; q quits when it returns."; paint(); } return; }
    if (busy) return;
    const machines = machineRows(data, view), selected = machines[view.index];
    if (view.confirm) {
      const name = view.confirm;
      view.confirm = null;
      if (key.name === "y") {
        busy = true; view.message = `Saving and closing ${name}…`; paint();
        try {
          const target = join(root, "exports", `${name}-${Date.now()}`);
          // close requires its parent to exist; state writer owns private paths.
          const { mkdir } = await import("node:fs/promises");
          await mkdir(join(root, "exports"), { recursive: true, mode: 0o700 });
          const result = await close(name, { output: target });
          view.message = `${name}: ${result.phase}. ${result.exportedTo ? "Saved declared output to " + result.exportedTo : "No output was exported."}`;
        } catch (error) { view.message = error.message; }
        finally { settled(); await reload(); }
      }
      paint(); return;
    }
    view.message = "";
    if (key.name === "up" || key.name === "k") view.detail ? view.offset = Math.max(0, view.offset - 1) : view.index = Math.max(0, view.index - 1);
    else if (key.name === "down" || key.name === "j") {
      if (view.detail) view.offset = Math.min(Math.max(0, data.report.transactions.filter((item) => item.workspaces.includes(selected?.name)).length - 1), view.offset + 1);
      else view.index = Math.min(Math.max(0, machines.length - 1), view.index + 1);
    } else if (key.name === "tab") { view.filter = filters[(filters.indexOf(view.filter) + 1) % filters.length]; view.index = 0; view.detail = false; }
    else if (key.name === "s" && !view.detail) { view.sort = sorts[(sorts.indexOf(view.sort) + 1) % sorts.length]; view.index = 0; }
    else if (key.name === "escape" || key.name === "backspace") { view.detail = false; view.offset = 0; }
    else if (key.name === "r") await reload();
    else if (key.name === "v") {
      controller = new AbortController();
      busy = true; view.message = "Verifying recorded transactions on Tempo…"; paint();
      try {
        data.report = await spending({ refresh: true, signal: controller.signal });
        const index = machineRows(data, view).findIndex((item) => item.name === selected?.name);
        if (index >= 0) view.index = index;
        view.message = data.report.refreshError || "Payment amounts verified; missing receipts remain unknown.";
      }
      catch (error) { view.message = error.message; }
      finally { settled(); }
    } else if (key.name === "p" && view.detail && selected && !finished(selected)) {
      busy = true; view.message = `Checking ${selected.name} (at most ${selected.provider === "x402-compute" ? "0" : operationCap} USDC.e)…`; paint();
      controller = new AbortController();
      try { await refresh(selected.name, { signal: controller.signal }); view.message = "Provider status updated."; }
      catch (error) { view.message = error.message; }
      finally { settled(); await reload(); }
    } else if (key.name === "x" && view.detail && selected && !finished(selected)) view.confirm = selected.name;
    else if (key.name === "return" && selected) {
      if (!view.detail) { view.detail = true; view.offset = 0; }
      else if (selected.provider !== "x402-compute" || selected.phase !== "ready") view.message = finished(selected) ? "This machine is closed." : "SSH is available on ready full VMs; use run/exec for sandboxes.";
      else {
        controller = new AbortController();
        busy = true; paused = true; leave();
        try { view.message = `SSH exited ${await connect(selected.name, { signal: controller.signal })}.`; }
        catch (error) { view.message = error.message; }
        finally { paused = false; settled(); if (!stopped) { enter(); await reload(); } }
      }
    }
    paint();
  };
  const onKey = (text, key) => { keypress(text, key).catch((error) => { view.message = error.message; busy = false; paint(); }); };
  const interrupt = () => { if (!paused) stop(); };
  emitKeypressEvents(input);
  input.on("keypress", onKey); output.on("resize", paint);
  process.on("SIGINT", interrupt); process.on("SIGTERM", stop);
  const ticker = setInterval(paint, 1000), refreshTimer = setInterval(() => { if (!busy) void reload(); }, 5000);
  try { enter(); await done; }
  finally {
    clearInterval(ticker); clearInterval(refreshTimer);
    input.off("keypress", onKey); output.off("resize", paint);
    process.off("SIGINT", interrupt); process.off("SIGTERM", stop);
    leave();
  }
}
