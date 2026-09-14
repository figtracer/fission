#!/usr/bin/env node
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { list, load, locked } from "./state.mjs";
import { execute, money, providerWarning } from "./provider.mjs";
import { plan, start, refresh, reconcile, active, upload, download, close, operationCap, prepare } from "./workspace.mjs";

import { budget } from "./budget.mjs";
import { providers, profiles, createPlan, openPlan, machineOffers } from "./plans.mjs";
import { runJob, getJob, waitJob, listJobs } from "./jobs.mjs";
import { duration } from "./workspace.mjs";
import { help } from "./help.mjs";

function summary(state) {
  return {
    name: state.name, provider: state.provider, providerWarning: providerWarning(state.provider), kind: state.kind, phase: state.phase,
    remoteId: state.remoteId, recipe: state.recipe.name,
    requestedAt: state.requestedAt, readyAt: state.readyAt,
    deadlineEstimate: state.deadlineEstimate, observedAt: state.observedAt,
    providerExpiresAt: state.providerExpiresAt,
    closedAt: state.closedAt,
    remoteStatus: state.remoteStatus, providerStatus: state.providerStatus, resizePending: state.resizePending, observedResources: state.observedResources, exportedTo: state.exportedTo,
    lease: state.lease, leasePhase: state.leasePhase, preparationAcceptance: state.preparationAcceptance, guestResources: state.guestResources,
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
  const rows = [["NAME", "STATE", "ELAPSED", "LEFT", "LAST CHECK"]];
  for (const state of states) {
    const done = ["terminated", "expired"].includes(state.phase);
    const left = Date.parse(state.providerExpiresAt || state.deadlineEstimate) - now;
    const end = done ? Date.parse(state.closedAt || state.observedAt) : now;
    rows.push([state.name, !done && state.resizePending ? "resizing" : state.phase, time(end - Date.parse(state.requestedAt)), done ? "closed" : left <= 0 ? "confirm expiry" : time(left) + (state.providerExpiresAt ? "" : " (est.)"), state.observedAt ? time(now - Date.parse(state.observedAt)) + " ago" : "not checked"]);
  }
  if (rows.length === 1) return "No saved workspaces. Run fission help to get started.";
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => safeText(row[i]).length)));
  const warnings = [...new Set(states.map((state) => providerWarning(state.provider)).filter(Boolean))];
  return [...rows.map((row) => row.map((cell, i) => safeText(cell).padEnd(widths[i])).join("  ")),
    ...warnings.map((warning) => `⚠ Provider history: ${warning}`)].join("\n");
}

async function main() {
  const raw = process.argv.slice(2);
  const separator = raw.indexOf("--");
  const tail = separator < 0 ? [] : raw.slice(separator + 1);
  const { values, positionals } = parseArgs({ args: separator < 0 ? raw : raw.slice(0, separator), allowPositionals: true, options: {
    help: { type: "boolean", short: "h" }, json: { type: "boolean" }, approve: { type: "boolean" }, tmux: { type: "boolean" },
    refresh: { type: "boolean" }, "discard-output": { type: "boolean" }, cheapest: { type: "boolean" }, budget: { type: "string" },
    plan: { type: "string" }, profile: { type: "string" }, os: { type: "string" }, arch: { type: "string" }, kind: { type: "string" },
    provider: { type: "string" }, machine: { type: "string" }, region: { type: "string" },
    cpu: { type: "string" }, memory: { type: "string" }, disk: { type: "string" }, repo: { type: "string" }, ref: { type: "string" }, "total-spend": { type: "string" }, "vm-max-spend": { type: "string" },
    "raise-to": { type: "string" }, approval: { type: "string" },
    "storage-dir": { type: "string" },
    "max-bytes": { type: "string" },
    scope: { type: "string" }, "max-head-age": { type: "string" },
    from: { type: "string" }, measurements: { type: "string" },
    log: { type: "string" }, notes: { type: "string" }, recipe: { type: "string" }, duration: { type: "string" }, "max-spend": { type: "string" }, output: { type: "string" },
  } });
  if (values.help) {
    const [command] = positionals;
    const topic = command === "help" ? positionals.slice(1)
      : positionals.slice(0, ["cache", "dataset", "skill"].includes(command) ? 2 : 1);
    console.log(await help(topic)); return;
  }
  if (!positionals.length) positionals.push("ui");
  const [command, name, first, second] = positionals;
  if (command === "ui" && values.json) throw new Error("Use fission list --json for machine data.");
  const allowed = {
    skill: ["output"], guide: [], report: ["log", "notes", "measurements", "output"], capabilities: [], help: [], ui: [], tmux: [], ssh: ["tmux"], spending: ["refresh"], machines: ["profile", "region", "duration", "max-spend", "cpu", "memory", "disk", "os", "arch", "kind"], budget: ["total-spend", "approve", "vm-max-spend", "profile", "raise-to", "approval"],
    plan: ["from", "recipe", "duration", "max-spend", "total-spend", "profile", "os", "arch", "kind", "cpu", "memory", "disk", "repo", "ref", "provider", "machine", "region", "budget", "cheapest"],
    open: values.plan ? ["plan", "approve"] : ["recipe", "duration", "max-spend", "approve"],
    prepare: ["duration"], recipes: [], list: [], status: ["refresh"], watch: ["refresh", "max-spend"],
    dataset: ["storage-dir", "max-bytes", "duration", "from"], storage: ["storage-dir", "max-bytes"], cache: ["max-bytes", "storage-dir"], check: ["scope", "duration", "max-head-age"], jobs: [], run: ["duration", "from"], job: ["refresh"], wait: ["duration", "max-spend"],
    exec: [], upload: [], download: [], close: ["output", "discard-output"], reconcile: [],
  };
  for (const option of Object.keys(values))
    if (option !== "json" && !(allowed[command] || []).includes(option)) throw new Error(`--${option} is not supported by ${command}; no request submitted.`);
  if (command === "watch" && values["max-spend"] !== undefined && !values.refresh)
    throw new Error("Watch spending cap requires --refresh.");
  const arity = { skill: 2, guide: name ? 2 : 1, report: first ? 3 : 2, capabilities: 1, ui: 1, tmux: 1, ssh: 2, spending: 1, machines: 1, budget: 1, plan: 2, open: 2, prepare: 2, recipes: 1, list: 1, status: 2, watch: 1, dataset: name === "inspect" ? 3 : 4, storage: 1, cache: name === "list" ? 2 : name === "restore" ? 4 : 3, check: 2, jobs: 2, run: 3, job: 3, wait: 3, exec: 2, upload: 4, download: 4, close: 2, reconcile: 2 };
  if (arity[command] && positionals.length !== arity[command]) throw new Error(`Wrong arguments for ${command}; run fission help ${command}.`);
  if (tail.length && !["exec", "run"].includes(command)) throw new Error("Only exec and run accept a command after --.");
  const emit = (value) => console.log(JSON.stringify(value, null, 2));
  switch (command) {
    case "help": console.log(await help(positionals.slice(1))); break;
    case "skill":
      if (name !== "install") throw new Error("Use fission skill install.");
      emit(await (await import("./onboarding.mjs")).installSkill(values.output)); break;
    case "guide": console.log(await (await import("./onboarding.mjs")).guide(name)); break;
    case "report": emit(await (await import("./reports.mjs")).report(name, first, values)); break;
    case "ui": await (await import("./ui.mjs")).ui(); break;
    case "tmux": await (await import("./tmux.mjs")).openTmux(); break;
    case "ssh":
      if (values.tmux) await (await import("./tmux.mjs")).selectMachine(name);
      else process.exitCode = await (await import("./compute.mjs")).connect(name);
      break;
    case "spending": emit(await (await import("./payments.mjs")).spending({ refresh: values.refresh })); break;
    case "machines": {
      const value = await machineOffers(values); emit(value);
      if (value.status === "unavailable") process.exitCode = 2;
      break;
    }
    case "capabilities": emit({ providers, profiles, units: { memory: "GiB", disk: "GiB", cpu: "provider vCPUs; not dedicated physical cores" } }); break;
    case "budget":
      if (["total-spend", "vm-max-spend", "raise-to"].some((key) => values[key] !== undefined) && !values.approve) throw new Error("Use --approve to record an authorized budget or VM ceiling.");
      if (values.profile && (!profiles[values.profile] || values["vm-max-spend"] === undefined)) throw new Error("Use a known --profile with --vm-max-spend.");
      emit(await budget(values["total-spend"], { vmMaxSpend: values["vm-max-spend"], profile: values.profile, raiseTo: values["raise-to"], approval: values.approval })); break;
    case "plan": {
      const value = await createPlan(name, values); emit(value);
      if (value.status === "unavailable") process.exitCode = 2;
      break;
    }
    case "dataset": {
      const valid = { inspect: ["storage-dir", "max-bytes"], save: ["storage-dir", "max-bytes", "duration"], collect: ["storage-dir", "max-bytes"], restore: ["max-bytes", "duration", "from"] }[name];
      if (!valid || Object.keys(values).some((option) => option !== "json" && !valid.includes(option))) throw new Error("Invalid dataset operation options; run fission help dataset.");
      emit(await (await import("./datasets.mjs")).dataset(name, first, second, values, ["save", "restore"].includes(name) ? duration(values.duration) : undefined));
      break;
    }
    case "storage": emit(await (await import("./storage.mjs")).storage(values["storage-dir"], Number(values["max-bytes"] || 0))); break;
    case "cache": {
      const cache = await import("./cache.mjs");
      if (name === "list") {
        if (values["max-bytes"] !== undefined) throw new Error("cache list takes no byte limit.");
        emit(await cache.listCaches(values["storage-dir"]));
      } else emit(await cache.buildCache(name, first, second, values["max-bytes"], values["storage-dir"]));
      break;
    }
    case "check": {
      const result = await (await import("./readiness.mjs")).check(name, values.scope, duration(values.duration), values["max-head-age"]);
      emit(result); if (!result.ready) process.exitCode = 1;
      break;
    }
    case "jobs": emit((await listJobs(name)).map(jobSummary)); break;
    case "run": {
      if (values.from) {
        if (tail.length) throw new Error("Use --from or a command, not both.");
        const record = await (await import("./experiments.mjs")).readExperiment(values.from);
        const { launch } = await import("./jobs.mjs");
        emit(jobSummary(await locked(name, async () => {
          const state = await active(name);
          if (state.recipe.digest !== record.recipeSha256 || JSON.stringify(state.source || null) !== JSON.stringify(record.source))
            throw new Error("Machine recipe/source differs from the experiment. Plan a compatible rental first.");
          return launch(state, first, record.workload.commands, duration(values.duration), [], record.workload.cwd);
        })));
      } else emit(jobSummary(await runJob(name, first, tail, duration(values.duration))));
      break;
    }
    case "job": emit(jobSummary(await getJob(name, first, values.refresh))); break;
    case "wait": {
      const job = await waitJob(name, first, duration(values.duration), values["max-spend"]); emit(jobSummary(job));
      if (job.phase !== "succeeded") process.exitCode = job.waitingStopped ? 2 : 1;
      break;
    }
    case "recipes":
      emit([{ name: "linux", purpose: "Linux shell and Python workspace" }, { name: "reth", purpose: "Pinned Reth binary with a local development chain" }, { name: "reth-synced", purpose: "Pinned Reth/Lighthouse tools for full mainnet snapshot import and sync jobs", profile: "reth-synced" }, { name: "foundry", purpose: "Pinned Foundry executables" }, { name: "tempo", purpose: "Pinned Tempo executable with an isolated development chain" },
        ...["foundry", "reth", "tempo"].map((tool) => ({ name: `${tool}-source`, purpose: "Pinned source checkout, Rust 1.96.1 and build dependencies; run /workspace/build as a separate job", sourceRequired: true, profile: `${tool}-source` }))]);
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
    case "prepare": emit(summary(await prepare(name, values.duration))); break;
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
    default: throw new Error(`Unknown command ${command}. Run fission --help.`);
  }
}

main().catch((error) => {
  const args = process.argv.slice(2);
  const options = args.includes("--") ? args.slice(0, args.indexOf("--")) : args;
  if (options.includes("--json") || ["capabilities", "budget", "plan", "run", "job", "wait"].includes(args[0]))
    console.error(JSON.stringify({ error: { code: "FISSION_ERROR", message: error.message } }));
  else console.error(`fission: ${error.message}`);
  process.exitCode = 1;
});
