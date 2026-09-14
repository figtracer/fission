import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const home = await mkdtemp(join(tmpdir(), "fission-repair-test-"));
process.env.FISSION_HOME = home;
process.env.FISSION_TEMPO = "/usr/bin/false";
const { save, load, readJSON, writeJSON, directory } = await import("../src/state.mjs");
const { repair, active, validateRecipe } = await import("../src/workspace.mjs");
const { getJob } = await import("../src/jobs.mjs");
const { report } = await import("../src/reports.mjs");
after(() => rm(home, { recursive: true, force: true }));

test("repair preserves failed bootstrap, records one bounded suffix, and owns readiness", async () => {
  const name = "example";
  const path = join(directory(name), "jobs", "bootstrap.json");
  const definition = validateRecipe({ name: "fixture", prepare: [["first"], ["second"], ["third"]], readiness: [["probe"]], artifacts: [] });
  const original = { name, provider: "modal-tempo", remoteId: "sb-fixture", phase: "prepare_failed", bootstrapJob: "bootstrap",
    recipe: definition, durationSeconds: 600, deadlineEstimate: new Date(Date.now() + 900000).toISOString() };
  const bootstrap = { id: "bootstrap", name, phase: "failed", observation: { step: 1, returncode: 7 },
    spec: { commands: definition.prepare, readiness: definition.readiness, cwd: "/workspace" } };
  await save(original);
  await writeJSON(path, bootstrap);
  const before = await readFile(path, "utf8");
  // A false transport simulates a lost submission response without network access.
  await assert.rejects(repair(name, 60), /Provider outcome is unresolved/);
  const job = await getJob(name, "repair");
  assert.equal(job.phase, "launch_unknown");
  assert.deepEqual(job.spec.commands, [["second"], ["third"]]);
  assert.deepEqual(job.spec.readiness, [["probe"]]);
  assert.equal(job.spec.cwd, "/workspace");
  assert.ok(job.spec.deadline <= Date.now() / 1000 + 60);
  assert.equal((await load(name)).repairJob, "repair");
  await assert.rejects(active(name), /Bootstrap is not ready/);
  await assert.rejects(repair(name, 60), /Repair already recorded/);
  await getJob(name, "bootstrap", true);
  assert.equal((await load(name)).phase, "preparing");
  assert.equal(await readFile(path, "utf8"), before);
  // Exercise terminal observations on the new owner, including close precedence.
  for (const [phase, expected] of [["failed", "prepare_failed"], ["succeeded", "ready"]]) {
    await writeJSON(join(directory(name), "jobs", "repair.json"), { ...job, phase });
    await getJob(name, "repair", true);
    assert.equal((await load(name)).phase, expected);
  }
  await getJob(name, "bootstrap", true);
  assert.equal((await active(name)).phase, "ready");
  const repaired = await load(name);
  await save({ ...repaired, phase: "terminated" });
  await getJob(name, "repair", true);
  assert.equal((await load(name)).phase, "terminated");
  const output = await report(name, "repair", { output: join(home, "reports") });
  assert.equal(output.experiment, undefined);
  assert.equal((await readJSON(output.record)).run.commands, null);

  for (const observation of [
    { ...bootstrap, phase: "launch_unknown" }, { ...bootstrap, phase: "timed_out" },
    { ...bootstrap, observation: { step: 1, error: "supervisor error" } },
    { ...bootstrap, observation: { step: 3, returncode: 1 } },
    { ...bootstrap, observation: { step: -1, returncode: 1 } },
    { ...bootstrap, observation: { step: 1, returncode: 0 } },
  ]) {
    await save(original);
    await writeJSON(path, observation);
    await assert.rejects(repair(name, 60), /observed bootstrap command failure/);
    assert.equal((await load(name)).repairJob, undefined);
  }
  await writeJSON(path, bootstrap);
  for (const state of [{ ...original, resizePending: true }, { ...original, phase: "preparing" }, { ...original, phase: "termination_unknown" }]) {
    await save(state);
    await assert.rejects(repair(name, 60), /requires a completed failed bootstrap|inspect status/);
  }
  await save(original);
  await assert.rejects(repair(name, 601), /duration must fit/);
  assert.equal((await load(name)).repairJob, undefined);

  const cli = new URL("../src/cli.mjs", import.meta.url);
  const run = (args) => spawnSync(process.execPath, [cli.pathname, ...args], { encoding: "utf8", timeout: 10000 });
  const help = run(["help", "repair"]);
  assert.equal(help.status, 0);
  assert.equal(run(["repair", "--help"]).stdout, help.stdout);
  assert.match(help.stdout, /--duration DURATION --approve/);
  const denied = run(["repair", name, "--duration", "1m"]);
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /use --approve only/);
});
