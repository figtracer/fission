#!/usr/bin/env node
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { list, load } from "./state.mjs";
import { execute, money } from "./provider.mjs";
import { plan, start, refresh, reconcile, active, upload, download, close, operationCap } from "./workspace.mjs";

const help = `loaner — temporary workspaces paid with Tempo

  recipes
  open NAME --recipe linux|reth|FILE --duration 2h --max-spend 1 [--approve]
  list [--json]
  status NAME [--refresh] [--json]
  watch [--refresh --max-spend 0.01]
  exec NAME -- COMMAND [ARG...]
  upload NAME LOCAL_FILE /remote/file
  download NAME /remote/file LOCAL_FILE
  close NAME [--output NEW_DIRECTORY | --discard-output]
  reconcile NAME

open previews unless --approve is supplied. Creation cap excludes later calls.
exec/status/terminate cost at most ${operationCap} USDC.e per request.
File transfers use multiple requests. watch stays local unless --refresh is set.
Ctrl-C stops watching, not the remote workspace. Deadlines are estimates until
the provider confirms termination. Save work before expiry.

Node >=22.13, the existing Tempo CLI login, and network access are required.
LOANER_HOME selects the state directory; LOANER_TEMPO selects the Tempo binary.
`;

function summary(state) {
  return {
    name: state.name, provider: state.provider, kind: state.kind, phase: state.phase,
    remoteId: state.remoteId, recipe: state.recipe.name,
    requestedAt: state.requestedAt, readyAt: state.readyAt,
    deadlineEstimate: state.deadlineEstimate, observedAt: state.observedAt,
    closedAt: state.closedAt,
    remoteStatus: state.remoteStatus, exportedTo: state.exportedTo,
    creationQuote: state.creationQuote, creationCap: state.creationCap,
  };
}

const safeText = (value) => String(value ?? "—").replace(/[\x00-\x1f\x7f-\x9f]/g, "?");
function time(ms) {
  if (!Number.isFinite(ms)) return "—";
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function table(states) {
  const now = Date.now();
  const rows = [["NAME", "STATE", "ELAPSED", "LEFT (EST.)", "LAST CHECK"]];
  for (const state of states) {
    const done = ["terminated", "expired"].includes(state.phase);
    const left = Date.parse(state.deadlineEstimate) - now;
    const end = done ? Date.parse(state.closedAt || state.observedAt) : now;
    rows.push([state.name, state.phase, time(end - Date.parse(state.requestedAt)), done ? "closed" : left <= 0 ? "confirm expiry" : time(left), state.observedAt ? time(now - Date.parse(state.observedAt)) + " ago" : "not checked"]);
  }
  if (rows.length === 1) return "No saved workspaces. Use loaner open --help.";
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => safeText(row[i]).length)));
  return rows.map((row) => row.map((cell, i) => safeText(cell).padEnd(widths[i])).join("  ")).join("\n");
}

async function main() {
  const raw = process.argv.slice(2);
  const separator = raw.indexOf("--");
  const tail = separator < 0 ? [] : raw.slice(separator + 1);
  const { values, positionals } = parseArgs({ args: separator < 0 ? raw : raw.slice(0, separator), allowPositionals: true, options: {
    help: { type: "boolean", short: "h" }, json: { type: "boolean" }, approve: { type: "boolean" },
    refresh: { type: "boolean" }, "discard-output": { type: "boolean" },
    recipe: { type: "string" }, duration: { type: "string" }, "max-spend": { type: "string" }, output: { type: "string" },
  } });
  const [command, name, first, second] = positionals;
  if (!command || values.help) { console.log(help); return; }
  const emit = (value) => console.log(JSON.stringify(value, null, 2));
  switch (command) {
    case "recipes":
      emit([{ name: "linux", purpose: "Linux shell and Python workspace" }, { name: "reth", purpose: "Pinned Reth binary with a local development chain" }]);
      break;
    case "open": {
      const prepared = await plan(name, values);
      if (!values.approve) { emit({ ...prepared, note: "Preview only. Preparation argv executes remotely. Add --approve to purchase." }); break; }
      emit(summary(await start(name, prepared)));
      break;
    }
    case "list": {
      const states = await list();
      values.json ? emit(states.map(summary)) : console.log(table(states));
      break;
    }
    case "status": {
      const state = values.refresh ? await refresh(name) : await load(name);
      values.json ? emit(summary(state)) : console.log(table([state]));
      break;
    }
    case "reconcile": emit(summary(await reconcile(name))); break;
    case "exec": {
      const result = await execute(await active(name), tail, operationCap);
      if (values.json) emit(result);
      else { process.stdout.write(result.stdout); process.stderr.write(result.stderr); }
      process.exitCode = result.returncode === 0 ? 0 : 1;
      break;
    }
    case "upload":
      if (!first || !second) throw new Error("Supply local and remote file paths.");
      emit(await upload(await active(name), first, second)); break;
    case "download":
      if (!first || !second) throw new Error("Supply remote and local file paths.");
      emit(await download(await active(name), first, second)); break;
    case "close":
      if (values.output && values["discard-output"]) throw new Error("Choose --output or --discard-output, not both.");
      emit(summary(await close(name, values))); break;
    case "watch": {
      let budget = values.refresh ? money(values["max-spend"]) : 0n;
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      let nextRefresh = 0, warning = "";
      try {
        do {
          let states = await list();
          if (values.refresh && Date.now() >= nextRefresh) {
            for (const state of states.filter((s) => s.remoteId && s.phase !== "terminated")) {
              if (budget < money(operationCap)) { warning = "Refresh budget exhausted; showing cached observations."; break; }
              // Reserve the full cap even if the response is lost or the call fails.
              budget -= money(operationCap);
              try { await refresh(state.name); } catch (error) { warning = error.message; }
            }
            nextRefresh = Date.now() + 30000;
            states = await list();
          }
          if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H");
          console.log(table(states));
          console.log("\nCtrl-C exits this view. Workspaces keep their provider expiry.");
          if (warning) console.log(safeText(warning));
          if (!process.stdout.isTTY) break;
          await delay(1000, undefined, { signal: controller.signal });
        } while (!controller.signal.aborted);
      } catch (error) { if (error.name !== "AbortError") throw error; }
      finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
      break;
    }
    default: throw new Error(`Unknown command ${command}. Run loaner --help.`);
  }
}

main().catch((error) => { console.error(`loaner: ${error.message}`); process.exitCode = 1; });
