#!/usr/bin/env node
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { list, load, locked } from "./state.mjs";
import { execute, providerWarning } from "./provider.mjs";
import { refresh, reconcile, active, upload, download, close, operationCap, prepare, repair, sourceRecipes } from "./workspace.mjs";

import { budget } from "./budget.mjs";
import { providers, profiles, createPlan, openPlan, machineOffers } from "./plans.mjs";
import { harnesses, taskOptions } from "./harnesses.mjs";
import { runTask, runFile, taskStatus, resumeTask, stopTask, supervise } from "./tasks.mjs";
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
    lease: state.lease, leasePhase: state.leasePhase, preparationAcceptance: state.preparationAcceptance,
    accessObservations: state.accessObservations, initialization: state.initialization, guestResources: state.guestResources,
    creationQuote: state.creationQuote, creationCap: state.creationCap,
    totalCap: state.totalCap, bootstrapJob: state.bootstrapJob, repairJob: state.repairJob, source: state.source, planId: state.id,
    ...(state.cacheHost ? { cacheHost: state.cacheHost } : {}),
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
    harness: { type: "string" }, mode: { type: "string" }, chain: { type: "string" }, solver: { type: "string" },
    patch: { type: "string" },
    "work-duration": { type: "string" }, "prepare-duration": { type: "string" }, cwd: { type: "string" },
    input: { type: "string", multiple: true }, artifact: { type: "string", multiple: true },
    snapshot: { type: "string" }, manifest: { type: "string" }, "manifest-url": { type: "string" }, "snapshot-plan": { type: "string" }, "checkpoint-url": { type: "string" }, checkpoint: { type: "string" }, "extra-disk-gib": { type: "string" },
    "l1-execution-url": { type: "string" }, "l1-beacon-url": { type: "string" }, "max-safe-age": { type: "string" }, "max-l1-head-age": { type: "string" }, "max-l1-lag-blocks": { type: "string" }, "max-tip-lag-blocks": { type: "string" },
    resume: { type: "boolean" }, wait: { type: "string" },
    refresh: { type: "boolean" }, "discard-output": { type: "boolean" }, cheapest: { type: "boolean" }, budget: { type: "string" },
    "no-resize": { type: "boolean" },
    plan: { type: "string" }, profile: { type: "string" }, os: { type: "string" }, arch: { type: "string" }, kind: { type: "string" },
    provider: { type: "string" }, machine: { type: "string" }, region: { type: "string" },
    cpu: { type: "string" }, memory: { type: "string" }, disk: { type: "string" }, repo: { type: "string" }, ref: { type: "string" }, "total-spend": { type: "string" }, "vm-max-spend": { type: "string" },
    "raise-to": { type: "string" }, approval: { type: "string" },
    "storage-dir": { type: "string" },
    "max-bytes": { type: "string" }, "cache-workspace": { type: "string" }, "cache-max-bytes": { type: "string" },
    scope: { type: "string" }, "max-head-age": { type: "string" },
    from: { type: "string" }, measurements: { type: "string" },
    log: { type: "string" }, notes: { type: "string" }, recipe: { type: "string" }, duration: { type: "string" }, "max-spend": { type: "string" }, output: { type: "string" },
  } });
  const advanced = positionals[0] === "advanced";
  if (advanced) positionals.shift();
  if (values.help) {
    const [command] = positionals;
    const topic = command === "help" ? positionals.slice(1)
      : positionals.slice(0, ["cache", "dataset", "skill"].includes(command) ? 2 : 1);
    if (!advanced && ["run", "rent"].includes(command) && values.harness) topic.push(values.harness);
    console.log(await help(advanced ? ["advanced", ...topic] : topic)); return;
  }
  if (advanced && !positionals.length) { console.log(await help(["advanced"])); return; }
  if (!positionals.length) positionals.push("ui");
  const [command, name, first, second] = positionals;
  if (command === "ui" && values.json) throw new Error("Use fission status --json for task data.");
  if (!advanced && !["ui", "run", "rent", "ssh", "status", "stop", "help", "budget", "campaign", "install"].includes(command))
    throw new Error(`Use fission advanced ${command} for low-level recovery; fission help shows the managed workflow.`);
  const allowed = {
    install: ["output"], skill: ["output"], guide: [], report: ["log", "notes", "measurements", "output"], capabilities: [], help: [], ui: [], tmux: [], ssh: ["tmux"], spending: ["refresh"], machines: ["profile", "region", "duration", "max-spend", "cpu", "memory", "disk", "os", "arch", "kind"], budget: ["total-spend", "approve", "vm-max-spend", "profile", "raise-to", "approval"],
    plan: ["from", "recipe", "duration", "max-spend", "total-spend", "profile", "os", "arch", "kind", "cpu", "memory", "disk", "repo", "ref", "provider", "machine", "region", "budget", "cheapest"],
    open: ["plan", "approve"], stop: [], supervise: [],
    prepare: ["duration"], repair: ["duration", "approve"], recipes: [], list: [], status: ["refresh"],
    dataset: ["storage-dir", "max-bytes", "duration", "from"], storage: ["storage-dir", "max-bytes"], cache: ["max-bytes", "storage-dir", "cache-workspace"], check: ["scope", "duration", "max-head-age"], jobs: [], run: ["duration", "from"], campaign: ["output"], job: ["refresh"], wait: ["duration", "max-spend"],
    exec: [], upload: [], download: [], close: ["output", "discard-output"], reconcile: [],
  };
  if (!advanced) {
    allowed.run = values.from ? ["from", "budget", "approve"] : [...taskOptions, "approve"];
    allowed.rent = values.from ? ["from", "budget", "approve"] : [...taskOptions.filter((key) => key !== "work-duration"), "approve"];
    allowed.status = ["refresh", "resume", "wait"];
  }
  for (const option of Object.keys(values))
    if (option !== "json" && !(allowed[command] || []).includes(option)) throw new Error(`--${option} is not supported by ${command}; no request submitted.`);
  const arity = { install: 1, skill: 2, guide: name ? 2 : 1, report: first ? 3 : 2, capabilities: name ? 2 : 1, ui: 1, tmux: 1, ssh: 2, spending: 1, machines: 1, budget: 1, plan: 2, open: 2, prepare: 2, repair: 2, recipes: 1, list: 1, status: 2, watch: 1, dataset: name === "inspect" ? 3 : 4, storage: 1, cache: name === "list" ? 2 : name === "restore" ? 4 : 3, check: 2, jobs: 2, run: 3, campaign: 3, job: 3, wait: 3, exec: 2, upload: 4, download: 4, close: 2, reconcile: 2 };
  arity.stop = 2; arity.supervise = 2;
  if (!advanced) { arity.run = 2; arity.rent = 2; arity.status = name ? 2 : 1; }
  if (arity[command] && positionals.length !== arity[command]) throw new Error(`Wrong arguments for ${command}; run fission help ${command}.`);
  if (tail.length && !["exec", "run"].includes(command)) throw new Error("Only exec and run accept a command after --.");
  const emit = (value) => console.log(JSON.stringify(value, null, 2));
  switch (command) {
    case "supervise": await supervise(name); break;
    case "stop": emit(await stopTask(name)); break;
    case "help": console.log(await help(positionals.slice(1))); break;
    case "install":
    case "skill":
      if (command === "skill" && name !== "install") throw new Error("Use fission install.");
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
    case "capabilities": {
      if (name && !Object.hasOwn(harnesses, name)) throw new Error("Unknown harness.");
      emit({ providers, profiles, units: { memory: "GiB", disk: "GiB", cpu: "provider vCPUs; not dedicated physical cores" }, harnesses: name ? { [name]: harnesses[name] } : harnesses });
      break;
    }
    case "budget":
      if (["total-spend", "vm-max-spend", "raise-to"].some((key) => values[key] !== undefined) && !values.approve) throw new Error("Use --approve to record an authorized budget or VM ceiling.");
      if (values.profile && (!profiles[values.profile] || values["vm-max-spend"] === undefined)) throw new Error("Use a known --profile with --vm-max-spend.");
      emit(await budget(values["total-spend"], { vmMaxSpend: values["vm-max-spend"], profile: values.profile, raiseTo: values["raise-to"], approval: values.approval })); break;
    case "campaign": {
      if (name !== "expand" || !first || !values.output) throw new Error("Usage: fission campaign expand CAMPAIGN.json --output MANIFEST.json");
      const { expandCampaign, writeCampaignManifest } = await import("./campaigns.mjs");
      const { manifest, summary } = await expandCampaign(first);
      const output = await writeCampaignManifest(values.output, manifest);
      emit({ ...summary, output, next: `fission run NAME --from ${output} --budget ${summary.campaignBudget}` });
      break;
    }
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
      if (name === "init") {
        if (values["max-bytes"] !== undefined || values["storage-dir"] || values["cache-workspace"])
          throw new Error("cache init accepts only the retained VPS workspace name.");
        emit(await (await import("./cache-host.mjs")).initCacheHost(first));
      } else if (name === "list") {
        if (values["max-bytes"] !== undefined) throw new Error("cache list takes no byte limit.");
        emit(await cache.listCaches(values["storage-dir"], values["cache-workspace"]));
      } else emit(await cache.buildCache(name, first, second, values["max-bytes"], values["storage-dir"],
        { cacheWorkspace: values["cache-workspace"] }));
      break;
    }
    case "check": {
      const result = await (await import("./readiness.mjs")).check(name, values.scope, duration(values.duration), values["max-head-age"]);
      emit(result); if (!result.ready) process.exitCode = 1;
      break;
    }
    case "jobs": emit((await listJobs(name)).map(jobSummary)); break;
    case "rent": {
      const options = { ...values, kind: "rental" };
      const result = values.from ? await runFile(name, options) : await runTask(name, options, []);
      emit(result);
      if (result.status === "unavailable") process.exitCode = 2;
      break;
    }
    case "run": {
      if (!advanced) {
        if (values.from && tail.length) throw new Error("The task file supplies workload argv; do not add a command after --.");
        const result = values.from ? await runFile(name, values) : await runTask(name, values, tail); emit(result);
        if (result.status === "unavailable") process.exitCode = 2;
        break;
      }
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
      emit([{ name: "linux", purpose: "Linux shell and Python workspace" }, { name: "reth", purpose: "Pinned Reth binary with a local development chain" }, { name: "reth-synced", purpose: "Pinned Reth/Lighthouse tools for full Ethereum mainnet snapshot import and sync jobs", profile: "reth-synced" }, { name: "base-synced", purpose: "Pinned unified Base execution/rollup-consensus tool for managed Base mainnet sync", profile: "base-synced" }, { name: "foundry", purpose: "Pinned Foundry executables" }, { name: "tempo", purpose: "Pinned Tempo executable with an isolated development chain" },
        { name: "foundry-symbolic", purpose: "Prebuilt Forge and Z3 for bounded symbolic properties; Linux x86_64, glibc >= 2.39", profile: "foundry-symbolic" },
        ...Object.keys(sourceRecipes).map((name) => ({ name, purpose: "Pinned source checkout, Rust 1.96.1 and build dependencies; run /workspace/build as a separate job", sourceRequired: true, profile: name }))]);
      break;
    case "open": {
      if (!values.plan || !values.approve) throw new Error("Use a saved --plan with --approve; direct-open preparation was consolidated into saved plans.");
      emit(summary(await openPlan(name, values.plan)));
      break;
    }
    case "list": {
      const states = await list();
      values.json ? emit(states.map(summary)) : console.log(table(states));
      break;
    }
    case "status": {
      if (!advanced) {
        if (!name && (values.resume || values.refresh || values.wait)) throw new Error("Select one task for --resume, --refresh or --wait.");
        if (values.resume) await resumeTask(name);
        if (values.refresh) {
          const current = await taskStatus(name);
          if (current.machines) {
            for (const item of current.machines) if (item.phase !== "not_purchased") await refresh(item.name);
          } else await refresh(name);
        }
        const until = Date.now() + (values.wait ? duration(values.wait) * 1000 : 0);
        let result;
        do {
          result = await taskStatus(name);
          if (!values.wait || result.phase === "done" || result.kind === "rental" && result.ready) break;
          await delay(Math.min(1000, Math.max(0, until - Date.now())));
        } while (Date.now() < until);
        emit(result);
        if (values.wait && result.phase !== "done" && !(result.kind === "rental" && result.ready)) process.exitCode = 2;
        else if (values.wait && result.phase === "done" && !["succeeded", "closed"].includes(result.outcome)) process.exitCode = 1;
        break;
      }
      const state = values.refresh ? await refresh(name) : await load(name);
      values.json ? emit(summary(state)) : console.log(table([state]));
      break;
    }
    case "prepare": emit(summary(await prepare(name, values.duration))); break;
    case "repair":
      if (!values.approve) throw new Error("Inspect bootstrap commands and log; use --approve only when repeating the failed step is safe.");
      emit(summary(await repair(name, duration(values.duration)))); break;
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
