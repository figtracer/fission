import { spawn } from "node:child_process";
import { mkdir, open, readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { root, directory, load, save, list, readJSON, locked, fileLocked, recoverLock, processAlive, OperationLocked } from "./state.mjs";
import { createPlan, openPlan } from "./plans.mjs";
import { taskSpec } from "./harnesses.mjs";
import { budget, units } from "./budget.mjs";
import { active, prepare, reconcile, refresh, close, upload, download, terminal, operationCap } from "./workspace.mjs";
import { execute } from "./provider.mjs";
import { launch, listJobs, getJob, jobDone } from "./jobs.mjs";
import { report } from "./reports.mjs";
import { fingerprint } from "./experiments.mjs";

// The plan owns authorization; workspace state owns coordination; jobs own
// execution. This supervisor cannot purchase. Recorded mutations are observed,
// never replayed. Unknown deletion is never treated as confirmed cleanup.
const ownerPath = (name) => join(directory(name), "supervisor.lock");
// Two bounded 60s HTTP management requests: DELETE and its confirmation.
const teardownReserveMs = 120000;
const update = (name, change, waitMs = 0) => locked(name, async () => {
  const state = await load(name);
  await change(state.task, state);
  await save(state);
  return state;
}, waitMs);

export async function runTask(name, options, command) {
  directory(name);
  if (await readJSON(join(directory(name), "state.json"))) throw new Error("Task name already recorded. Use status NAME --resume; run never repeats a purchase.");
  const { definition, disk, task } = await taskSpec(options, command);
  const ledger = await budget();
  if (units(options.budget) > units(ledger.availableToAllocate)) throw new Error("Retained aggregate authorization cannot cover this task. No quote or purchase submitted.");
  const { digest, ...recipe } = definition;
  const plan = await createPlan(name, { recipe, repo: options.repo, ref: options.ref, disk,
    cpu: options.cpu, memory: options.memory, budget: options.budget, duration: options.duration,
    region: options.region, cheapest: true, kind: "vm", os: "linux", arch: "x86_64" }, task);
  if (plan.status === "unavailable") return plan;
  const preview = { name, plan: plan.id, paymentSubmitted: false, harness: task.harness, mode: task.mode,
    machine: plan.machine.id, resources: plan.capabilities, region: options.region, providerWarning: plan.providerWarning,
    quote: plan.creationQuote, allocation: plan.totalCap, currency: "USDC.e", timing: task.timing,
    lease: plan.lease || { prepaidHours: 24 }, context: task.context,
    note: "Prepaid provider credit may outlive the authorized task; the supervisor closes early. No refund assumed. Run with --approve only within existing authorization." };
  if (!options.approve) return preview;
  try { await openPlan(name, plan.id); }
  finally {
    // Even a lost creation response leaves a recoverable task, not permission to buy again.
    const state = await readJSON(join(directory(name), "state.json"));
    if (state?.task) await resumeTask(name);
  }
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

export async function taskStatus(name) {
  if (!name) return Promise.all((await list()).map((state) => taskStatus(state.name)));
  const state = await load(name), task = state.task;
  if (!task) return { name, phase: state.phase, legacy: true, cleanupConfirmed: terminal(state), note: "Retained workspace; use advanced for recovery." };
  const jobs = await listJobs(name), owner = await readJSON(ownerPath(name));
  const record = task.report?.record ? await readJSON(task.report.record) : null;
  return { name, harness: task.harness, mode: task.mode, phase: nextTaskStep(state, jobs), outcome: task.outcome || null,
    supervisor: { pid: owner?.pid || null, alive: Boolean(owner && processAlive(owner.pid)), lastObservedAt: task.observedAt || null },
    deadline: new Date(task.deadline).toISOString(), providerExpiresAt: state.providerExpiresAt || null,
    timing: task.timing, jobs: jobs.map((job) => ({ id: job.id, phase: job.phase, step: job.observation?.step, startedAt: job.observation?.startedAt, finishedAt: job.observation?.finishedAt })),
    cost: record?.spending || { allocation: state.totalCap, creationQuote: state.creationQuote, verifiedOutflow: null, incomplete: true },
    cleanup: { phase: state.phase, confirmed: terminal(state), observedAt: state.closedAt || null },
    report: task.report?.report || null, evidence: task.exports || [], lastError: task.lastError || null };
}

export async function resumeTask(name) {
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

export async function stopTask(name) {
  // A killed owner can leave its operation lock behind. Reclaim only a proven
  // dead PID before recording cancellation; never wait ten minutes on that lock.
  await recoverLock(join(directory(name), "operation.lock"));
  await update(name, (task) => {
    if (!task) throw new Error("Use advanced close for a retained low-level workspace.");
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
