import { spawn } from "node:child_process";
import { mkdir, open, readFile } from "node:fs/promises";
import { join, basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { root, directory, load, save, list, readJSON, locked, fileLocked, recoverLock, processAlive, OperationLocked } from "./state.mjs";
import { createPlan, openPlan } from "./plans.mjs";
import { taskSpec, taskOptions } from "./harnesses.mjs";
import { budget, units, amount } from "./budget.mjs";
import { active, prepare, reconcile, refresh, close, upload, download, terminal, operationCap } from "./workspace.mjs";
import { execute } from "./provider.mjs";
import { launch, listJobs, getJob, jobDone } from "./jobs.mjs";
import { report } from "./reports.mjs";
import { fingerprint } from "./experiments.mjs";
import { cachePreflight, buildCache } from "./cache.mjs";
import { guidance } from "./onboarding.mjs";

// The plan owns authorization; workspace state owns coordination; jobs own
// execution. This supervisor cannot purchase. Recorded mutations are observed,
// never replayed. Unknown deletion is never treated as confirmed cleanup.
const ownerPath = (name) => join(directory(name), "supervisor.lock");
// Two bounded 60s HTTP management requests: DELETE and its confirmation.
const teardownReserveMs = 120000;
const creationLock = join(root, ".task-create.lock");
const update = (name, change, waitMs = 0) => locked(name, async () => {
  const state = await load(name);
  await change(state.task, state);
  await save(state);
  return state;
}, waitMs);

async function creationLocked(action, waitMs = 0) {
  const deadline = Date.now() + waitMs;
  while (true) {
    await recoverLock(creationLock);
    try { return await fileLocked(creationLock, action, Math.min(1000, Math.max(0, deadline - Date.now()))); }
    catch (error) {
      if (!(error instanceof OperationLocked) || Date.now() >= deadline) throw error;
    }
  }
}

const sameMembers = (left, right) => Array.isArray(left) && Array.isArray(right) &&
  left.length === right.length && left.every((item, index) => item === right[index]);
const matchesExperiment = (task, expected) => task?.experiment?.name === expected.name &&
  sameMembers(task.experiment.members, expected.members);

async function reservations() {
  const names = new Set();
  for (const state of await list()) {
    const experiment = state.task?.experiment;
    if (!experiment) continue;
    names.add(experiment.name);
    for (const member of experiment.members || []) names.add(member);
  }
  return names;
}

async function experimentStatus(name) {
  const declarations = (await list()).filter((state) => state.task?.experiment?.name === name);
  if (!declarations.length) throw new Error(`No saved task or experiment named ${name}.`);
  const members = declarations[0].task.experiment.members;
  if (!Array.isArray(members) || !members.length || new Set(members).size !== members.length ||
      declarations.some((state) => !members.includes(state.name) || !sameMembers(state.task.experiment.members, members)))
    throw new Error(`Experiment ${name} has inconsistent member records; refusing group operation.`);
  const expected = { name, members };
  const machines = [];
  for (const child of members) {
    const state = await readJSON(join(directory(child), "state.json"));
    if (!state) machines.push({ name: child, phase: "not_purchased", outcome: "not_purchased", cleanup: { confirmed: true } });
    else if (!matchesExperiment(state.task, expected))
      throw new Error(`Experiment member ${child} is occupied by unrelated state; refusing group operation.`);
    else machines.push(await taskStatus(child, expected));
  }
  return { name, machines, phase: machines.every((item) => ["done", "not_purchased"].includes(item.phase)) ? "done" : "running",
    outcome: machines.every((item) => item.outcome === "succeeded") ? "succeeded" : "incomplete",
    cleanup: { confirmed: machines.every((item) => item.cleanup.confirmed) } };
}

async function planTask(name, options, command, experiment) {
  directory(name);
  if (await readJSON(join(directory(name), "state.json"))) throw new Error("Task name already recorded. Use status NAME --resume; run never repeats a purchase.");
  if ((await reservations()).has(name)) throw new Error("Name is reserved by a recorded experiment; choose another task or experiment name.");
  const { definition, disk, task } = await taskSpec(options, command);
  const ledger = await budget();
  if (units(options.budget) > units(ledger.availableToAllocate)) throw new Error("Retained aggregate authorization cannot cover this task. No quote or purchase submitted.");
  if (experiment) task.experiment = experiment;
  task.guidance = await guidance("", { ...options, mode: task.mode });
  if (["test", "build"].includes(task.mode)) {
    task.cache = await cachePreflight({ ...options, mode: task.mode }, definition);
    const candidate = task.cache.candidate;
    if (candidate) {
      const remote = "/workspace/.fission/build-cache.tar.gz";
      if (task.inputs.some((input) => input.remote === remote)) throw new Error("Input conflicts with the selected build cache.");
      task.inputs.push({ local: candidate.local, remote, bytes: candidate.bytes, sha256: candidate.id });
      task.preparation.unshift(["python3", "/workspace/.fission/rust-source.py", "cache-reuse", remote, candidate.id, String(candidate.maximum)]);
      task.artifacts.push("/workspace/cache-result.json");
    }
  }
  const { digest, ...recipe } = definition;
  const plan = await createPlan(name, { recipe, repo: options.repo, ref: options.ref, disk,
    cpu: options.cpu, memory: options.memory, budget: options.budget, duration: options.duration,
    region: options.region, cheapest: true, kind: "vm", os: "linux", arch: "x86_64" }, task);
  if (plan.status === "unavailable") return { ...plan, name, cache: task.cache || null, guidance: task.guidance };
  const preview = { name, plan: plan.id, paymentSubmitted: false, harness: task.harness, mode: task.mode,
    machine: plan.machine.id, resources: plan.capabilities, region: options.region, providerWarning: plan.providerWarning,
    quote: plan.creationQuote, allocation: plan.totalCap, currency: "USDC.e", timing: task.timing,
    lease: plan.lease || { prepaidHours: plan.body.prepaid_hours }, context: task.context,
    fallback: { baseline: plan.selection.baseline, creationCap: plan.creationCap,
      providerCount: plan.selection.providerCount, quoteErrors: plan.selection.quoteErrors, skipped: plan.selection.skipped,
      alternates: plan.selection.alternates.map((item) => ({ provider: plan.provider, machine: item.machine.id, resources: item.capabilities })),
      note: "Pre-payment alternatives only, cheapest compatible first within the task's creation cap. Resources, region, duration and lifecycle headroom are preserved. All listed machines currently share one gateway; this is not independent-provider failover. No replacement after a purchase intent." },
    cache: task.cache || null, guidance: task.guidance, experiment: task.experiment || null,
    note: "Prepaid provider credit may outlive the authorized task; the supervisor closes early. No refund assumed. Run with --approve only within existing authorization." };
  return preview;
}

async function openTask(name, plan) {
  try { await openPlan(name, plan); }
  finally {
    // Even a lost creation response leaves a recoverable task, not permission to buy again.
    const state = await readJSON(join(directory(name), "state.json"));
    if (state?.task) await resumeTask(name);
  }
  return taskStatus(name);
}

export async function runTask(name, options, command) {
  return creationLocked(async () => {
    const preview = await planTask(name, options, command);
    if (!options.approve || preview.status === "unavailable") return preview;
    return openTask(name, preview.plan);
  });
}

// A multi-machine experiment is a set of ordinary tasks, not a second runtime.
// Every task keeps its own durable purchase/job/cleanup markers and shared ledger.
export async function runMachines(name, options) {
  // Serialize namespace checks with single-task creation too: a task cannot hide
  // an experiment, and concurrent manifests cannot disagree about its members.
  return creationLocked(() => createMachines(name, options));
}

async function createMachines(name, options) {
  directory(name);
  const file = resolve(options.from), spec = await readJSON(file);
  if (spec?.schemaVersion !== 1 || Object.keys(spec).some((key) => !["schemaVersion", "machines"].includes(key)) || !Array.isArray(spec.machines) || !spec.machines.length)
    throw new Error("Experiment file requires schemaVersion 1 and a nonempty machines array; see help run.");
  if ((await list()).some((state) => state.name === name || state.task?.experiment?.name === name))
    throw new Error("Experiment already recorded. Use status/stop on its tasks; never repeat a group purchase.");
  const machines = [];
  for (const entry of spec.machines) {
    if (!entry || Object.keys(entry).some((key) => !["name", "command", ...taskOptions].includes(key)) || !Array.isArray(entry.command))
      throw new Error("Each machine needs a role name, command argv, and run options; unknown fields reject.");
    directory(entry.name);
    const child = `${name}-${entry.name}`;
    directory(child);
    if (machines.some((item) => item.name === child) || await readJSON(join(directory(child), "state.json")))
      throw new Error("Machine names must be unique and unused.");
    const { name: role, command, ...settings } = entry;
    for (const field of ["patch", "manifest", "snapshot-plan", "output"]) if (settings[field]) settings[field] = resolve(dirname(file), settings[field]);
    if (settings.input) settings.input = settings.input.map((mapping) => {
      const i = mapping.indexOf("=");
      return resolve(dirname(file), i < 0 ? mapping : mapping.slice(0, i)) + (i < 0 ? "" : mapping.slice(i));
    });
    await taskSpec(settings, command); // Validate every role before the first quote.
    machines.push({ name: child, role, settings, command });
  }
  const reserved = await reservations();
  if (reserved.has(name) || machines.some((machine) => reserved.has(machine.name)))
    throw new Error("Experiment or machine name is reserved by a recorded experiment. No quote or purchase submitted.");
  const allocation = machines.reduce((sum, item) => sum + units(item.settings.budget), 0n);
  if (allocation > units(options.budget) || allocation > units((await budget()).availableToAllocate))
    throw new Error("Combined machine allocations exceed the experiment budget or retained authorization. No quote or purchase submitted.");
  const previews = [];
  const members = machines.map((item) => item.name);
  for (const machine of machines) previews.push(await planTask(machine.name, machine.settings, machine.command, { name, role: machine.role, members }));
  const unavailable = previews.some((item) => item.status === "unavailable");
  const preview = { name, status: unavailable ? "unavailable" : "planned", paymentSubmitted: false, machineCount: previews.length,
    budget: options.budget, combinedAllocation: amount(allocation), currency: "USDC.e", machines: previews,
    combinedCreationQuote: unavailable ? null : amount(previews.reduce((sum, item) => sum + units(item.quote), 0n)),
    note: "--approve accepts all listed machines. Purchases are sequential, not atomic; work runs independently. A later purchase failure leaves earlier tasks supervised. No replacements; status/stop accepts the experiment name. Compare actual machine/traffic conditions before performance claims." };
  if (!options.approve || unavailable) return preview;
  for (const machine of previews) await openTask(machine.name, machine.plan);
  return taskStatus(name);
}

export function nextTaskStep(state, jobs, now = Date.now()) {
  const task = state.task;
  if (!task) return "legacy";
  if (terminal(state) || state.phase === "not_submitted") return task.report ? "done" : "report";
  if (!state.remoteId) return "reconcile";
  if (state.phase === "termination_unknown") return "confirm";
  const cutoff = Math.min(task.deadline, Date.parse(state.providerExpiresAt || state.deadlineEstimate)) - task.timing.cleanupSeconds * 1000;
  if (task.outcome || task.stopRequestedAt || now >= cutoff) return "finish";
  if (state.phase === "prepare_failed") return "finish";
  const prepDeadline = Date.parse(state.requestedAt) + (task.timing.provisioningSeconds + task.timing.preparationSeconds) * 1000;
  if (!jobs.some((job) => job.id === "work") && now >= prepDeadline) return "finish";
  if (!state.bootstrapJob) return "prepare";
  const bootstrap = jobs.find((job) => job.id === (state.repairJob || state.bootstrapJob));
  if (!bootstrap || !jobDone(bootstrap) || bootstrap.phase === "succeeded" && state.phase !== "ready") return "bootstrap";
  if (bootstrap.phase !== "succeeded") return "finish";
  if (task.inputs.some((input) => !input.uploadedAt)) return "upload";
  const preparation = jobs.find((job) => job.id === "preparation");
  if (task.preparation.length && !preparation) return "launch-preparation";
  if (preparation && !jobDone(preparation)) return "preparation";
  if (preparation && preparation.phase !== "succeeded") return "finish";
  const work = jobs.find((job) => job.id === "work");
  if (!work) return "launch-work";
  return jobDone(work) ? "finish" : "work";
}

export async function taskStatus(name, expectedExperiment) {
  if (!name) return Promise.all((await list()).map((state) => taskStatus(state.name)));
  if (!await readJSON(join(directory(name), "state.json"))) return experimentStatus(name);
  const state = await load(name), task = state.task;
  if (expectedExperiment && !matchesExperiment(task, expectedExperiment))
    throw new Error(`Experiment member ${name} changed identity; refusing group operation.`);
  if (!task) return { name, phase: state.phase, legacy: true, cleanupConfirmed: terminal(state), note: "Retained workspace; use advanced for recovery." };
  const jobs = await listJobs(name), owner = await readJSON(ownerPath(name));
  const record = task.report?.record ? await readJSON(task.report.record) : null;
  return { name, harness: task.harness, mode: task.mode, phase: nextTaskStep(state, jobs), outcome: task.outcome || null,
    supervisor: { pid: owner?.pid || null, alive: Boolean(owner && processAlive(owner.pid)), lastObservedAt: task.observedAt || null },
    deadline: new Date(task.deadline).toISOString(), providerExpiresAt: state.providerExpiresAt || null,
    timing: task.timing, jobs: jobs.map((job) => ({ id: job.id, phase: job.phase, step: job.observation?.step, startedAt: job.observation?.startedAt, finishedAt: job.observation?.finishedAt })),
    cost: record?.spending || { allocation: state.totalCap, creationQuote: state.creationQuote, verifiedOutflow: null, incomplete: true },
    cleanup: { phase: state.phase, confirmed: terminal(state) || state.phase === "not_submitted", observedAt: state.closedAt || null },
    report: task.report?.report || null, evidence: task.exports || [], cache: task.cache || null, experiment: task.experiment || null, lastError: task.lastError || null };
}

export async function resumeTask(name) {
  if (!await readJSON(join(directory(name), "state.json"))) {
    const status = await taskStatus(name);
    return Promise.all(status.machines.filter((item) => item.phase !== "not_purchased").map((item) => resumeTask(item.name)));
  }
  const state = await load(name);
  if (!state.task) throw new Error("This is a retained low-level workspace, not a managed task. Use advanced reconcile.");
  // PID ownership lives only in locks, never in a second task/financial registry.
  for (const path of [ownerPath(name), join(directory(name), "operation.lock"), join(root, ".budget.lock")]) await recoverLock(path);
  const owner = await readJSON(ownerPath(name));
  if (owner) return { name, supervisor: owner.pid, note: "Existing owner retained; no duplicate supervisor started." };
  const log = await open(join(directory(name), "supervisor.log"), "a", 0o600);
  try {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./cli.mjs", import.meta.url)), "advanced", "supervise", name], {
      detached: true, stdio: ["ignore", log.fd, log.fd], env: { ...process.env, FISSION_HOME: root },
    });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    return { name, supervisor: child.pid };
  } finally { await log.close(); }
}

export async function stopTask(name, expectedExperiment) {
  if (!await readJSON(join(directory(name), "state.json"))) {
    // Creation is sequential and prepaid. A stop arriving mid-create waits for
    // that approved purchase set to finish, snapshots its final members, then
    // releases the global lock before waiting on any child operation lock.
    const status = await creationLocked(() => experimentStatus(name), 600000);
    const expected = { name, members: status.machines.map((item) => item.name) };
    for (const item of status.machines) if (item.phase !== "not_purchased") await stopTask(item.name, expected);
    return taskStatus(name);
  }
  // A killed owner can leave its operation lock behind. Reclaim only a proven
  // dead PID before recording cancellation; never wait ten minutes on that lock.
  await recoverLock(join(directory(name), "operation.lock"));
  await update(name, (task) => {
    if (!task) throw new Error("Use advanced close for a retained low-level workspace.");
    if (expectedExperiment && !matchesExperiment(task, expectedExperiment))
      throw new Error(`Experiment member ${name} changed identity; refusing cancellation.`);
    task.stopRequestedAt ??= new Date().toISOString();
  }, 600000); // Let an in-flight bounded preparation/transfer release its lock.
  await resumeTask(name);
  return taskStatus(name);
}

async function finish(name, jobs) {
  let state = await update(name, (task, state) => {
    task.outcome ??= task.stopRequestedAt ? "cancelled" : jobs.find((job) => job.id === "work" && jobDone(job))?.phase ||
      (state.phase === "prepare_failed" || jobs.some((job) => jobDone(job) && job.phase !== "succeeded") ? "preparation_failed" : "deadline_exceeded");
    task.exports ??= [];
  });
  const ending = Math.min(state.task.deadline, Date.parse(state.providerExpiresAt || state.deadlineEstimate));
  const transfer = { deadline: ending - teardownReserveMs };
  const running = jobs.filter((job) => !jobDone(job));
  // Cancellation is an idempotent file marker consumed by the existing supervisor;
  // no PID guessing or replay of user commands. Failure cannot block VM teardown.
  if (running.length && !state.task.cancelAttemptedAt && Date.now() < transfer.deadline) {
    state = await update(name, (task) => { task.cancelAttemptedAt = new Date().toISOString(); });
    try {
      await locked(name, async () => execute(await active(name, false), ["python3", "-c", "import pathlib,sys; [(pathlib.Path(p).parent.mkdir(parents=True,exist_ok=True),pathlib.Path(p).touch()) for p in sys.argv[1:]]", ...running.map((job) => `/workspace/.fission/jobs/${job.id}/cancel`)], operationCap, undefined, transfer));
      await delay(1500);
      for (const job of running) await getJob(name, job.id, true, transfer);
    } catch (error) { await update(name, (task) => { task.lastError = `Cancellation observation: ${error.message}`; }); }
  }
  state = await update(name, (task) => {
    for (const item of task.exports) if (item.phase === "collecting") Object.assign(item, { phase: "partial", error: "Collection interrupted; partial file retained." });
  });
  const files = [...new Set([...state.recipe.artifacts, ...state.task.artifacts,
    ...jobs.flatMap((job) => [job.log, `/workspace/.fission/jobs/${job.id}/status.json`]),
    ...(state.task.mode === "build" ? ["/workspace/build.json"] : []),
    ...(state.task.mode === "synced" ? ["/workspace/ethereum-data/snapshot.json", "/workspace/ethereum-data/current.json"] : [])])];
  const destination = join(directory(name), "evidence");
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const remote of files) {
    if (state.task.exports.some((item) => item.remote === remote)) continue;
    // Export timeout shares one cutoff; teardown retains its full request allowance.
    if (Date.now() >= transfer.deadline) {
      const error = `Evidence cutoff ${new Date(transfer.deadline).toISOString()} passed before transfer; not attempted.`;
      state = await update(name, (task) => {
        for (const skipped of files) if (!task.exports.some((item) => item.remote === skipped))
          task.exports.push({ remote: skipped, phase: "not_collected", error });
      });
      break;
    }
    const local = join(destination, `${state.task.exports.length}-${basename(remote)}`);
    state = await update(name, (task) => { task.exports.push({ remote, local, phase: "collecting" }); });
    try {
      const result = await locked(name, async () => download(await active(name, false), remote, local, transfer));
      state = await update(name, (task) => { Object.assign(task.exports.find((item) => item.remote === remote), result, { phase: "collected" }); });
    } catch (error) {
      state = await update(name, (task) => { Object.assign(task.exports.find((item) => item.remote === remote), { phase: "partial", error: error.message }); });
    }
  }
  if (state.task.mode === "build" && state.task.cache && !state.task.cache.save) {
    const eligible = state.task.outcome === "succeeded" && !state.task.inputs.some((input) => input.remote === "/workspace/source.patch") && Date.now() < transfer.deadline;
    state = await update(name, (task) => { task.cache.save = { phase: eligible ? "attempted" : "skipped", reason: eligible ? "Save once after evidence, within cleanup cutoff" : "Requires successful clean build and remaining collection time" }; });
    if (eligible) {
      try {
        const record = await buildCache("save", name, undefined, undefined, state.task.cache.directory, transfer);
        await update(name, (task) => { task.cache.save = { phase: "saved", id: record.id, bytes: record.bytes, directory: task.cache.directory }; });
      } catch (error) { await update(name, (task) => { task.cache.save = { phase: "unresolved", reason: error.message }; }); }
    }
  } else if (state.task.cache?.save?.phase === "attempted") {
    await update(name, (task) => { task.cache.save = { phase: "unresolved", reason: "Owner interrupted during cache save; not replayed" }; });
  }
  await close(name, { "discard-output": true });
}

export async function supervise(name) {
  return fileLocked(ownerPath(name), async () => {
    while (true) {
      let state = await load(name);
      if (!state.task || state.provider !== "compute-mpp") throw new Error("Managed compute VM task required; paid sandbox polling is not supported.");
      const jobs = await listJobs(name), step = nextTaskStep(state, jobs);
      if (step === "done") return;
      try {
        if (step === "reconcile") {
          try {
            await reconcile(name);
            await update(name, (task) => { delete task.report; });
          }
          catch (error) {
            await update(name, (task) => { task.lastError = error.message; });
            // Cannot destroy without an ID. Preserve evidence and explicitly require
            // resume after reconciliation; never buy a replacement automatically.
            const result = await report(name, null, { output: state.task.output });
            await update(name, (task) => { task.report = result; });
            return;
          }
        } else if (step === "confirm") {
          try { state = await refresh(name); }
          catch (error) { state = await update(name, (task) => { task.lastError = error.message; }); }
          if (!terminal(state)) {
            // One follow-up observation did not confirm destruction. Return
            // evidence and stop polling; explicit resume observes this same ID.
            const result = await report(name, null, { output: state.task.output });
            await update(name, (task) => {
              task.report = result;
              task.lastError = "Cleanup remains unconfirmed. Use status NAME --resume to observe the recorded deletion; do not repurchase or repeat DELETE.";
              task.observedAt = new Date().toISOString();
            });
            return;
          }
          // Preserve the earlier unresolved report on disk, but generate a new
          // final report after this observation actually confirms cleanup.
          await update(name, (task) => {
            delete task.report;
            if (task.lastError?.startsWith("Cleanup remains unconfirmed.")) delete task.lastError;
          });
        } else if (step === "prepare") await prepare(name);
        else if (["bootstrap", "preparation", "work"].includes(step)) await getJob(name, step === "bootstrap" ? state.repairJob || state.bootstrapJob : step, true);
        else if (step === "upload") {
          await update(name, async (task, state) => {
            const transfer = { deadline: Math.min(task.deadline - task.timing.cleanupSeconds * 1000,
              Date.parse(state.requestedAt) + (task.timing.provisioningSeconds + task.timing.preparationSeconds) * 1000) };
            const input = task.inputs.find((item) => !item.uploadedAt);
            const actual = await fingerprint(input.local);
            if (actual.sha256 !== input.sha256 || actual.bytes !== input.bytes) {
              task.outcome = "preparation_failed";
              task.lastError = "Input changed after quote; refusing upload.";
              return;
            }
            if (input.attemptedAt) {
              const script = await readFile(new URL("../harness/transfer.py", import.meta.url), "utf8");
              const result = await execute(state, ["python3", "-c", script, "metadata", input.remote], operationCap, undefined, transfer);
              const observed = result.returncode === 0 ? JSON.parse(result.stdout) : null;
              if (observed?.sha256 !== input.sha256 || observed?.size !== input.bytes) {
                task.outcome = "preparation_failed";
                task.lastError = "Input upload unresolved; no repeated transfer.";
                return;
              }
            } else {
              input.attemptedAt = new Date().toISOString();
              await save(state);
              await upload(state, input.local, input.remote, transfer);
            }
            input.uploadedAt = new Date().toISOString();
          });
        } else if (step.startsWith("launch-")) {
          const id = step.slice(7);
          await update(name, async (task, state) => {
            if (state.phase !== "ready" || state.resizePending || task.stopRequestedAt) throw new Error("Task no longer ready for launch.");
            const remaining = Math.floor((Math.min(task.deadline, Date.parse(state.providerExpiresAt || state.deadlineEstimate)) - Date.now()) / 1000) - task.timing.cleanupSeconds;
            const seconds = id === "work" ? task.timing.workSeconds : Math.min(task.timing.preparationSeconds,
              Math.floor((Date.parse(state.requestedAt) + (task.timing.provisioningSeconds + task.timing.preparationSeconds) * 1000 - Date.now()) / 1000));
            if (seconds <= 0 || remaining < seconds) throw new Error("Insufficient authorized time for the full step and cleanup; no launch.");
            await launch(state, id, id === "work" ? [task.command] : task.preparation, seconds, [], id === "work" ? task.cwd : "/workspace");
          });
        } else if (step === "finish") await finish(name, jobs);
        else if (step === "report") {
          state = await update(name, (task, state) => { task.outcome ??= state.phase === "not_submitted" ? "not_purchased" : "interrupted"; });
          const work = jobs.find((job) => job.id === "work") || jobs.at(-1);
          const log = state.task.exports?.find((item) => item.remote === work?.log && item.phase === "collected")?.local;
          const result = await report(name, work?.id, { output: state.task.output, log });
          await update(name, (task) => { task.report = result; });
        }
        await update(name, (task) => { task.observedAt = new Date().toISOString(); });
      } catch (error) {
        if (!(error instanceof OperationLocked)) await update(name, async (task) => {
          task.lastError = `${step}: ${error.message}`;
          // Transport observations may recover; failed dispatches already have
          // their durable marker and will be observed on the following iteration.
          if (step.startsWith("launch-") && !(await listJobs(name)).some((job) => job.id === step.slice(7)))
            task.outcome = "preparation_failed";
        });
      }
      // Free compute management/SSH only. Never run paid sandbox polling here.
      await delay(["launch-work", "launch-preparation", "upload"].includes(step) ? 1000 : 15000);
    }
  });
}
