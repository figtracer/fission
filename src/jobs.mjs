import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { directory, locked, load, save, readJSON, writeJSON, OperationLocked } from "./state.mjs";
import { execute, money } from "./provider.mjs";
import { active, operationCap, terminal } from "./workspace.mjs";

const runner = new URL("../harness/job.py", import.meta.url);
const jobPath = (name, id) => {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(id || "")) throw new Error("Use a lowercase job name, up to 48 characters.");
  return join(directory(name), "jobs", `${id}.json`);
};
const remotePath = (id) => `/workspace/.fission/jobs/${id}`;
export const jobDone = (job) => ["succeeded", "failed", "timed_out", "workspace_terminated"].includes(job.phase);

export async function launch(state, id, commands, seconds, readiness = [], cwd = "/workspace") {
  const file = jobPath(state.name, id);
  if (await readJSON(file)) throw new Error("Job name already recorded. Inspect it; submission will not be repeated.");
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > state.durationSeconds)
    throw new Error("Job duration must be positive and no longer than the workspace lease.");
  for (const command of [...commands, ...readiness])
    if (!Array.isArray(command) || !command.length || command.some((arg) => typeof arg !== "string" || arg.includes("\0")))
      throw new Error("Job commands must be nonempty argv arrays.");
  const deadline = Math.min(Date.now() / 1000 + seconds, Date.parse(state.providerExpiresAt || state.deadlineEstimate) / 1000);
  if (!Number.isFinite(deadline) || deadline <= Date.now() / 1000) throw new Error("Insufficient estimated lease time for a new job.");
  const spec = { id, commands, readiness, cwd, deadline, pollSeconds: 15 };
  const runnerBytes = await readFile(runner);
  const job = { runnerSha256: createHash("sha256").update(runnerBytes).digest("hex"), id, name: state.name, phase: "launch_unknown", requestId: randomUUID(), spec, digest: createHash("sha256").update(JSON.stringify(spec)).digest("hex"), log: `${remotePath(id)}/output.log` };
  await writeJSON(file, job);
  const script = `import sys,json,pathlib,base64,subprocess,os
p=pathlib.Path(sys.argv[1]); p.mkdir(parents=True,exist_ok=False)
os.chmod(p,0o700)
(p/'spec.json').write_text(sys.argv[2])
(p/'runner.py').write_bytes(base64.b64decode(sys.argv[3]))
(p/'status.json').write_text(json.dumps({'id':p.name,'phase':'launch_unknown'}))
log=(p/'supervisor.log').open('ab')
subprocess.Popen(['python3',str(p/'runner.py'),str(p)],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
print(json.dumps({'id':p.name,'phase':'submitted'}))`;
  const result = await execute(state, ["python3", "-c", script, remotePath(id), JSON.stringify(spec), runnerBytes.toString("base64")], operationCap, job.requestId);
  if (result.returncode !== 0) throw new Error(`Job launch unresolved. Inspect job ${id} before doing anything else.`);
  job.phase = "submitted";
  await writeJSON(file, job);
  return job;
}

export const runJob = (name, id, command, seconds) => locked(name, async () => launch(await active(name), id, [command], seconds));


export async function listJobs(name) {
  await load(name);
  const dir = join(directory(name), "jobs");
  let files;
  try { files = await readdir(dir); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return Promise.all(files.filter((file) => /^[a-z][a-z0-9-]{0,47}\.json$/.test(file)).sort().map((file) => readJSON(join(dir, file))));
}

export async function getJob(name, id, refresh = false, options = {}) {
  const action = async () => {
    const file = jobPath(name, id);
    const job = await readJSON(file);
    if (!job) throw new Error("Unknown job.");
    if (!refresh) return job;
    const state = await load(name);
    const updatesPreparation = id === (state.repairJob ?? state.bootstrapJob) && !terminal(state) && !["termination_unknown", "closing"].includes(state.phase);
    if (jobDone(job)) {
      if (updatesPreparation) {
        state.phase = job.phase === "succeeded" ? "ready" : "prepare_failed";
        await save(state);
      }
      return job;
    }
    if (terminal(state)) {
      job.phase = "workspace_terminated";
      await writeJSON(file, job);
      return job;
    }
    const result = await execute(state, ["python3", "-c", "import pathlib,sys; p=pathlib.Path(sys.argv[1]); print(p.read_text() if p.exists() else '{\"phase\":\"launch_unknown\"}')", `${dirname(job.log)}/status.json`], operationCap, undefined, options);
    if (result.returncode) throw new Error("Could not observe remote job. Saved job remains unresolved.");
    const observation = JSON.parse(result.stdout);
    if (!["launch_unknown", "running", "waiting", "failed", "succeeded", "timed_out"].includes(observation.phase)) throw new Error("Invalid remote job status.");
    job.phase = observation.phase;
    job.observation = observation;
    job.observedAt = new Date().toISOString();
    await writeJSON(file, job);
    if (updatesPreparation) {
      state.phase = job.phase === "succeeded" ? "ready" : jobDone(job) ? "prepare_failed" : "preparing";
      if (state.phase === "ready") state.readyAt ??= job.observedAt;
      await save(state);
    }
    return job;
  };
  return refresh ? locked(name, action) : action();
}

export async function waitJob(name, id, seconds, maximum) {
  let remaining = money(maximum);
  const until = Date.now() + seconds * 1000;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    while (Date.now() < until && !controller.signal.aborted) {
      const cached = await getJob(name, id);
      if (jobDone(cached)) return cached;
      if (remaining < money(operationCap)) return { ...cached, waitingStopped: "observation_budget_exhausted" };
      try {
        const job = await getJob(name, id, true, { deadline: until, signal: controller.signal });
        remaining -= money(operationCap);
        if (jobDone(job)) return job;
      } catch (error) {
        // Contention happens before observation starts. Keep the same deadline
        // and budget, and never remove another operation's lock.
        if (!(error instanceof OperationLocked) || error.path !== join(directory(name), "operation.lock")) throw error;
      }
      await delay(Math.min(15000, Math.max(0, until - Date.now())), undefined, { signal: controller.signal });
    }
  } catch (error) { if (error.name !== "AbortError" && !controller.signal.aborted && Date.now() < until) throw error; }
  finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
  return { ...await getJob(name, id), waitingStopped: controller.signal.aborted ? "interrupted" : "observation_deadline" };
}
