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

const help = `fission — temporary compute for your coding agent

Terminal
  fission                         Open the Rust TUI
  tmux                            Open the TUI with managed SSH windows (requires tmux)
  help                            Show this command reference
  skill install [--output DIR]    Install the agent skill (default: ~/.agents/skills/fission)
  guide rental|harnesses|reth      Read a bundled workflow guide
  ui                              Open the TUI (alias)

Machines and budgets
  capabilities
  ssh NAME
  spending [--refresh]
  machines --profile reth-source --region ams [--max-spend AMOUNT --duration DURATION]
    [--cpu N --memory GiB --disk GiB --os linux --arch x86_64 --kind vm]
  budget [--total-spend AMOUNT --approve]
    [--vm-max-spend AMOUNT --profile PROFILE --approve]

Planning and preparation
  plan NAME --recipe linux|foundry|reth|tempo|FILE --duration 2h
    --max-spend 1 --total-spend 2 [--profile runtime|foundry-source|reth-source|
    reth-synced|tempo-source|tempo-node]
    [--os linux --arch x86_64 --kind sandbox|vm --cpu N --memory GiB --disk GiB]
    [--repo https://github.com/OWNER/REPO --ref FULL_COMMIT]
    [--provider compute-mpp --machine PLAN --region REGION --duration 24h]
    Use --budget AMOUNT instead of both spending caps. Add --cheapest --region
    REGION --duration DURATION to select the cheapest compatible quoted VM.
    Below 24h, the plan funds a starter and resizes it into the target.
    After migration, prepare NAME verifies capacity/time and starts bootstrap.
    Source recipes: foundry-source, reth-source, tempo-source require --repo/--ref
    and prepare /workspace/build for a separate bounded build job.
    reth-synced prepares /workspace/ethereum; snapshot import and sync are separate jobs.
  open NAME --plan ID --approve
  prepare NAME
  recipes
  open NAME --recipe linux|reth|FILE --duration 2h --max-spend 1 [--approve]

Jobs
  run NAME JOB --duration 10m -- COMMAND [ARG...]
  jobs NAME
  job NAME JOB [--refresh]
  wait NAME JOB --duration 5m --max-spend 0.01

Observe and collect
  report NAME [JOB] [--log FILE --notes FILE --output DIR]
    Save a timestamped Markdown report and structured record under fission/NAME.
  list [--json]
  status NAME [--refresh] [--json]
  watch [--refresh --max-spend 0.01]
  exec NAME -- COMMAND [ARG...]
  upload NAME LOCAL_FILE /remote/file
  download NAME /remote/file LOCAL_FILE

Finish and recover
  close NAME [--output NEW_DIRECTORY | --discard-output]
  reconcile NAME

Terminal controls
  a                Browse available machines / return to owned machines
  b / [ / ]        Available: all prices / previous or next region
  Enter            Available: open details, then fetch a free 24h quote
  arrows / j / k   Select a machine or scroll receipts
  Enter            Open details, then SSH into a ready VM
  Tab / 1 / 2      Switch tabs
  f / s            Filter machines / change sorting
  j/k / h/l        Move / back and open
  gg / G           First / last row
  Ctrl-u / Ctrl-d  Half page up / down
  ?                Keyboard help
  r / v            Reload local state / verify payment receipts
  p                Check the selected provider (uses its request cap)
  x                Confirm, save declared files, and close the selected machine
  Esc / q          Back / quit the interface; machines retain their leases

Recipes
  linux, foundry, reth, tempo      Shell, tools, and local development chains
  foundry-source, reth-source,
  tempo-source                    Source checkout and /workspace/build
  reth-synced                      Reth/Lighthouse snapshot and node controller
  Use fission recipes and fission capabilities for structured details.

Operation and funding
Planning fetches quotes before purchase. --cheapest compares up to three
compatible offers under the configured ceiling. --budget is the workspace
allocation; network fees are separate. Plans specify the exact Tempo payment
token and amount. AGENTS.md documents the agent workflow,
profile sizing, node readiness, and recovery.

open previews unless --approve is supplied. Creation cap excludes later calls.
Modal exec/status/terminate cost at most ${operationCap} USDC.e per request.
Compute VM management and SSH calls are free after the prepaid rental.
File transfers use multiple requests. watch stays local unless --refresh is set.
Ctrl-C stops watching, not the remote workspace. Deadlines are estimates until
the provider confirms termination. Save work before expiry.

Setup
Node >=22.13, SSH, the existing Tempo CLI login, and network access are required.
Prebuilt releases include the TUI; source installations use npm run setup.
FISSION_HOME selects the state directory; FISSION_TEMPO selects the Tempo binary.
`;

function summary(state) {
  return {
    name: state.name, provider: state.provider, providerWarning: providerWarning(state.provider), kind: state.kind, phase: state.phase,
    remoteId: state.remoteId, recipe: state.recipe.name,
    requestedAt: state.requestedAt, readyAt: state.readyAt,
    deadlineEstimate: state.deadlineEstimate, observedAt: state.observedAt,
    providerExpiresAt: state.providerExpiresAt,
    closedAt: state.closedAt,
    remoteStatus: state.remoteStatus, providerStatus: state.providerStatus, resizePending: state.resizePending, observedResources: state.observedResources, exportedTo: state.exportedTo,
    lease: state.lease, leasePhase: state.leasePhase, guestResources: state.guestResources,
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
    log: { type: "string" }, notes: { type: "string" }, recipe: { type: "string" }, duration: { type: "string" }, "max-spend": { type: "string" }, output: { type: "string" },
  } });
  if (values.help) { console.log(help); return; }
  if (!positionals.length) positionals.push("ui");
  const [command, name, first, second] = positionals;
  if (command === "ui" && values.json) throw new Error("Use fission list --json for machine data.");
  const allowed = {
    skill: ["output"], guide: [], report: ["log", "notes", "output"], capabilities: [], help: [], ui: [], tmux: [], ssh: ["tmux"], spending: ["refresh"], machines: ["profile", "region", "duration", "max-spend", "cpu", "memory", "disk", "os", "arch", "kind"], budget: ["total-spend", "approve", "vm-max-spend", "profile"],
    plan: ["recipe", "duration", "max-spend", "total-spend", "profile", "os", "arch", "kind", "cpu", "memory", "disk", "repo", "ref", "provider", "machine", "region", "budget", "cheapest"],
    open: values.plan ? ["plan", "approve"] : ["recipe", "duration", "max-spend", "approve"],
    prepare: [], recipes: [], list: [], status: ["refresh"], watch: ["refresh", "max-spend"],
    jobs: [], run: ["duration"], job: ["refresh"], wait: ["duration", "max-spend"],
    exec: [], upload: [], download: [], close: ["output", "discard-output"], reconcile: [],
  };
  for (const option of Object.keys(values))
    if (option !== "json" && !(allowed[command] || []).includes(option)) throw new Error(`--${option} is not supported by ${command}; no request submitted.`);
  if (command === "watch" && values["max-spend"] !== undefined && !values.refresh)
    throw new Error("Watch spending cap requires --refresh.");
  const arity = { skill: 2, guide: 2, report: first ? 3 : 2, capabilities: 1, help: 1, ui: 1, tmux: 1, ssh: 2, spending: 1, machines: 1, budget: 1, plan: 2, open: 2, prepare: 2, recipes: 1, list: 1, status: 2, watch: 1, jobs: 2, run: 3, job: 3, wait: 3, exec: 2, upload: 4, download: 4, close: 2, reconcile: 2 };
  if (arity[command] && positionals.length !== arity[command]) throw new Error(`Wrong arguments for ${command}; run fission --help.`);
  if (tail.length && !["exec", "run"].includes(command)) throw new Error("Only exec and run accept a command after --.");
  const emit = (value) => console.log(JSON.stringify(value, null, 2));
  switch (command) {
    case "help": console.log(help); break;
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
      if ((values["total-spend"] !== undefined || values["vm-max-spend"] !== undefined) && !values.approve) throw new Error("Use --approve to record an authorized budget or VM ceiling.");
      if (values.profile && (!profiles[values.profile] || values["vm-max-spend"] === undefined)) throw new Error("Use a known --profile with --vm-max-spend.");
      emit(await budget(values["total-spend"], { vmMaxSpend: values["vm-max-spend"], profile: values.profile })); break;
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
    case "prepare": emit(summary(await prepare(name))); break;
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
