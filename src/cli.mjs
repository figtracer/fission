#!/usr/bin/env node
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { list, load, locked } from "./state.mjs";
import { execute, money } from "./provider.mjs";
import { plan, start, refresh, reconcile, active, upload, download, close, operationCap } from "./workspace.mjs";

import { budget } from "./budget.mjs";
import { providers, profiles, createPlan, openPlan } from "./plans.mjs";
import { runJob, getJob, waitJob, listJobs } from "./jobs.mjs";
import { duration } from "./workspace.mjs";

const help = `loaner — temporary workspaces paid with Tempo

  capabilities
  budget [--total-spend AMOUNT --approve]
  plan NAME --recipe linux|foundry|reth|tempo|FILE --duration 2h
    --max-spend 1 --total-spend 2 [--profile runtime|foundry-source|reth-source|
    reth-synced|tempo-source|tempo-node|windows-source]
    [--os linux|windows --arch x86_64 --kind sandbox|vm --cpu N --memory GiB --disk GiB]
    [--repo https://github.com/OWNER/REPO --ref FULL_COMMIT]
  open NAME --plan ID --approve
  run NAME JOB --duration 10m -- COMMAND [ARG...]
  jobs NAME
  job NAME JOB [--refresh]
  wait NAME JOB --duration 5m --max-spend 0.01
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
    totalCap: state.totalCap, bootstrapJob: state.bootstrapJob, source: state.source, planId: state.id,
  };
}

const jobSummary = (job) => ({
  id: job.id, name: job.name, phase: job.phase, digest: job.digest,
  deadline: job.spec?.deadline, log: job.log, observation: job.observation,
  observedAt: job.observedAt, waitingStopped: job.waitingStopped,
});

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
    plan: { type: "string" }, profile: { type: "string" }, os: { type: "string" }, arch: { type: "string" }, kind: { type: "string" },
    cpu: { type: "string" }, memory: { type: "string" }, disk: { type: "string" }, repo: { type: "string" }, ref: { type: "string" }, "total-spend": { type: "string" },
    recipe: { type: "string" }, duration: { type: "string" }, "max-spend": { type: "string" }, output: { type: "string" },
  } });
  const [command, name, first, second] = positionals;
  if (!command || values.help) { console.log(help); return; }
  const allowed = {
    capabilities: [], budget: ["total-spend", "approve"],
    plan: ["recipe", "duration", "max-spend", "total-spend", "profile", "os", "arch", "kind", "cpu", "memory", "disk", "repo", "ref"],
    open: values.plan ? ["plan", "approve"] : ["recipe", "duration", "max-spend", "approve"],
    recipes: [], list: [], status: ["refresh"], watch: ["refresh", "max-spend"],
    jobs: [], run: ["duration"], job: ["refresh"], wait: ["duration", "max-spend"],
    exec: [], upload: [], download: [], close: ["output", "discard-output"], reconcile: [],
  };
  for (const option of Object.keys(values))
    if (option !== "json" && !(allowed[command] || []).includes(option)) throw new Error(`--${option} is not supported by ${command}; no request submitted.`);
  if (command === "watch" && values["max-spend"] !== undefined && !values.refresh)
    throw new Error("Watch spending cap requires --refresh.");
  const arity = { capabilities: 1, budget: 1, plan: 2, open: 2, recipes: 1, list: 1, status: 2, watch: 1, jobs: 2, run: 3, job: 3, wait: 3, exec: 2, upload: 4, download: 4, close: 2, reconcile: 2 };
  if (arity[command] && positionals.length !== arity[command]) throw new Error(`Wrong arguments for ${command}; run loaner --help.`);
  if (tail.length && !["exec", "run"].includes(command)) throw new Error("Only exec and run accept a command after --.");
  const emit = (value) => console.log(JSON.stringify(value, null, 2));
  switch (command) {
    case "capabilities": emit({ providers, profiles, units: { memory: "GiB", disk: "GiB", cpu: "cores" } }); break;
    case "budget":
      if (values["total-spend"] && !values.approve) throw new Error("Use --approve to record the authorized aggregate budget.");
      emit(await budget(values["total-spend"])); break;
    case "plan": {
      const value = await createPlan(name, values); emit(value);
      if (value.status === "unavailable") process.exitCode = 2;
      break;
    }
    case "jobs": emit((await listJobs(name)).map(jobSummary)); break;
    case "run": emit(jobSummary(await runJob(name, first, tail, duration(values.duration)))); break;
    case "job": emit(jobSummary(await getJob(name, first, values.refresh))); break;
    case "wait": {
      const job = await waitJob(name, first, duration(values.duration), values["max-spend"]); emit(jobSummary(job));
      if (job.phase !== "succeeded") process.exitCode = job.waitingStopped ? 2 : 1;
      break;
    }
    case "recipes":
      emit([{ name: "linux", purpose: "Linux shell and Python workspace" }, { name: "reth", purpose: "Pinned Reth binary with a local development chain" }, { name: "foundry", purpose: "Pinned Foundry executables" }, { name: "tempo", purpose: "Pinned Tempo executable with an isolated development chain" }]);
      break;
    case "open": {
      if (values.plan) {
        if (!values.approve) throw new Error("Saved plans require --approve to open.");
        emit(summary(await openPlan(name, values.plan))); break;
      }
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
      const result = await locked(name, async () => execute(await active(name), tail, operationCap));
      if (values.json) emit(result);
      else { process.stdout.write(result.stdout); process.stderr.write(result.stderr); }
      process.exitCode = result.returncode === 0 ? 0 : 1;
      break;
    }
    case "upload":
      if (!first || !second) throw new Error("Supply local and remote file paths.");
      emit(await locked(name, async () => upload(await active(name), first, second))); break;
    case "download":
      if (!first || !second) throw new Error("Supply remote and local file paths.");
      emit(await locked(name, async () => download(await active(name, false), first, second))); break;
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

main().catch((error) => {
  const args = process.argv.slice(2);
  const options = args.includes("--") ? args.slice(0, args.indexOf("--")) : args;
  if (options.includes("--json") || ["capabilities", "budget", "plan", "run", "job", "wait"].includes(args[0]))
    console.error(JSON.stringify({ error: { code: "LOANER_ERROR", message: error.message } }));
  else console.error(`loaner: ${error.message}`);
  process.exitCode = 1;
});
