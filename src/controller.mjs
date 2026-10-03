import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { root, readJSON, writeJSON, hostIdentity, assertControllerHost, fileLocked, recoverLock, ownerAlive, controllerRunning } from "./state.mjs";
import { resumeTask, nextTaskStep } from "./tasks.mjs";
import { listJobs } from "./jobs.mjs";
import { runProcess } from "./provider.mjs";

// Supervisors already poll their guests every 15s. This loop only discovers
// tasks whose owner exited; it never purchases or polls a provider itself.
const intervalMs = 15000;
const lock = join(root, ".controller.lock");
const statusFile = join(root, ".controller-status.json");

async function bind() {
  const identity = await hostIdentity();
  await mkdir(root, { recursive: true, mode: 0o700 });
  await recoverLock(join(root, ".controller-bind.lock"));
  await fileLocked(join(root, ".controller-bind.lock"), async () => {
    if (!await readJSON(join(root, ".controller.json")))
      await writeJSON(join(root, ".controller.json"), { schemaVersion: 1, host: identity.host, root });
    await assertControllerHost();
  });
}

export async function controllerStatus() {
  await assertControllerHost();
  const binding = await readJSON(join(root, ".controller.json"));
  const owner = await readJSON(lock);
  const status = await readJSON(statusFile);
  return { installed: Boolean(binding), running: await controllerRunning(),
    home: root, pid: owner?.pid || null, ...status };
}

export async function runController() {
  await bind();
  await recoverLock(lock);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try {
    await fileLocked(lock, async () => {
      // A task that exits without an owner gets one restart per controller run.
      // Ambiguous creation/deletion always needs explicit human/agent recovery.
      const attempted = new Set();
      while (!abort.signal.aborted) {
        const tasks = [];
        for (const entry of await readdir(root, { withFileTypes: true })) {
          if (abort.signal.aborted) break;
          if (!entry.isDirectory() || !/^[a-z][a-z0-9-]{0,47}$/.test(entry.name)) continue;
          const name = entry.name;
          try {
            const state = await readJSON(join(root, name, "state.json"));
            if (!state?.task || state.provider !== "compute-mpp") continue;
            if (state.name !== name) throw new Error("Task name differs from its state directory; inspect the record before recovery.");
            const step = nextTaskStep(state, await listJobs(name));
            if (step === "done") continue;
            const owner = await readJSON(join(root, name, "supervisor.lock"));
            if (owner && await ownerAlive(owner)) { tasks.push({ name, state: "running" }); continue; }
            const requested = state.task.controllerResumeRequestedAt && state.task.controllerResumeRequestedAt !== state.task.controllerResumeHandledAt;
            if (["reconcile", "confirm"].includes(step) && !requested) {
              tasks.push({ name, state: "needs_attention", reason: "Creation or deletion is unresolved; use status NAME --resume." });
            } else if (attempted.has(name) && !requested) {
              tasks.push({ name, state: "needs_attention", reason: "Supervisor exited after recovery; inspect task status." });
            } else {
              attempted.add(name);
              await resumeTask(name, { controller: true });
              tasks.push({ name, state: "resumed" });
            }
          } catch (error) { tasks.push({ name, state: "needs_attention", reason: error.message }); }
        }
        await writeJSON(statusFile, { observedAt: new Date().toISOString(), tasks });
        try { await delay(intervalMs, undefined, { signal: abort.signal }); }
        catch (error) { if (error.name !== "AbortError") throw error; }
      }
    });
  } finally { process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); }
}

export async function installController() {
  await hostIdentity();
  await assertControllerHost();
  const user = await runProcess("id", ["-un"]);
  if (user.code !== 0 || !user.stdout.trim()) throw new Error("Cannot determine the systemd user.");
  // Without lingering a user service stops at logout and never becomes always-on.
  const linger = await runProcess("loginctl", ["show-user", user.stdout.trim(), "--property=Linger", "--value"]);
  if (linger.code !== 0 || linger.stdout.trim() !== "yes")
    throw new Error(`Enable the user service across logout first: sudo loginctl enable-linger ${user.stdout.trim()}`);
  const quote = (text) => '"' + text.replace(/%/g, "%%").replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
  const pathValue = process.env.PATH || "/usr/local/bin:/usr/bin:/bin";
  if (/[$]/.test(process.execPath + cli)) throw new Error("Controller executable paths cannot contain dollar signs (systemd expansion).");
  for (const value of [root, process.execPath, cli, homedir(), pathValue])
    if (/[\r\n\0]/.test(value)) throw new Error("Controller paths cannot contain control characters.");
  const unit = `[Unit]\nDescription=Fission controller\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=${quote(process.execPath)} ${quote(cli)} controller run\nEnvironment=${quote(`FISSION_HOME=${root}`)}\nEnvironment=${quote(`PATH=${pathValue}`)}\nUMask=0077\nRestart=on-failure\nRestartSec=15\nKillMode=control-group\nTimeoutStopSec=30\n\n[Install]\nWantedBy=default.target\n`;
  const directory = join(homedir(), ".config/systemd/user");
  const path = join(directory, "fission-controller.service");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const existing = await readFile(path, "utf8");
    if (!existing.startsWith("[Unit]\nDescription=Fission controller\n")) throw new Error("Existing service is not owned by Fission; preserve it.");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await bind();
  await writeFile(path, unit, { mode: 0o600 });
  for (const args of [["--user", "daemon-reload"], ["--user", "enable", "fission-controller.service"], ["--user", "restart", "fission-controller.service"]]) {
    const result = await runProcess("systemctl", args);
    if (result.code !== 0) throw new Error(`Service setup failed. Inspect systemctl --user status fission-controller: ${result.stderr}`);
  }
  return { service: path, home: root, note: "Use fission controller status and journalctl --user -u fission-controller. Run Fission commands on this host over SSH." };
}
