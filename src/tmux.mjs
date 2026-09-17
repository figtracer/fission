import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";
import { root, list, load, fileLocked } from "./state.mjs";
import { storageRoot } from "./storage.mjs";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const session = `fission-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`;
const tmux = async (...args) => (await execute("tmux", args)).stdout.trim();
const ready = state => state.provider === "compute-mpp" && state.phase === "ready" && state.remoteId && !state.resizePending;

async function ownsSession() {
  const target = session;
  const marker = await tmux("show-option", "-qv", "-t", target, "@fission-home");
  if (marker === root) return true;
  if (marker) return false;
  // Sessions created by older Fission versions predate the ownership marker.
  // Migrate only when their isolated tmux environment proves the same resolved
  // state directory and deterministic session identity.
  let home, identity;
  try {
    home = await tmux("show-environment", "-t", target, "FISSION_HOME");
    identity = await tmux("show-environment", "-t", target, "FISSION_TMUX_SESSION");
  } catch { return false; }
  if (home !== `FISSION_HOME=${root}` || identity !== `FISSION_TMUX_SESSION=${session}`) return false;
  await tmux("set-option", "-t", session, "@fission-home", root);
  return true;
}

async function window(name, select = false) {
  return fileLocked(join(root, ".tmux-window.lock"), async () => {
    const state = await load(name);
    if (!ready(state)) throw new Error("SSH opens when the full VM is ready.");
    const windows = await tmux("list-windows", "-t", session, "-F", "#{window_id} #{@fission-machine}");
    let id = windows.split("\n").map(line => line.split(" ")).find(([, machine]) => machine === name)?.[0];
    if (!id) {
      id = await tmux("new-window", "-d", "-P", "-F", "#{window_id}", "-t", session, "-n", name,
        process.execPath, cli, "advanced", "ssh", name);
      await tmux("set-option", "-w", "-t", id, "@fission-machine", name);
      await tmux("set-option", "-w", "-t", id, "remain-on-exit", "off");
    }
    if (select) await tmux("select-window", "-t", id);
    return id;
  });
}

export async function selectMachine(name) {
  if (process.env.FISSION_TMUX_SESSION !== session) throw new Error("Start fission tmux to use managed SSH windows.");
  await window(name, true);
}

export async function popupMachine(name) {
  const state = await load(name);
  if (!ready(state)) throw new Error("SSH opens when the full VM is ready.");
  if (process.env.FISSION_TMUX_SESSION !== session || !process.env.TMUX_PANE)
    throw new Error("Open the popup from this Fission tmux dashboard.");
  if (!await ownsSession())
    throw new Error("The tmux session belongs to a different Fission state directory.");
  const pane = process.env.TMUX_PANE;
  if (await tmux("display-message", "-p", "-t", pane, "#{session_name}") !== session)
    throw new Error("The dashboard pane is no longer in its owned Fission session.");
  const clients = (await tmux("list-clients", "-t", `=${session}`, "-F", "#{client_name}\t#{pane_id}"))
    .split("\n").filter(Boolean).map(line => line.split("\t"))
    .filter(([, visiblePane]) => visiblePane === pane);
  if (clients.length !== 1)
    throw new Error("Show this dashboard in exactly one tmux client before opening its popup.");
  try {
    await tmux("display-popup", "-E", "-w", "80%", "-h", "70%", "-T", name, "-t", pane,
      "-e", `FISSION_HOME=${root}`, "-e", `FISSION_STORAGE_DIR=${storageRoot()}`,
      process.execPath, cli, "advanced", "ssh", name);
  } catch (error) {
    const detail = error.stderr?.trim().split("\n").at(-1);
    throw new Error(detail ? `Could not open SSH popup: ${detail}` : "Could not open SSH popup.");
  }
}

export async function openTmux() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Open fission tmux in an interactive terminal.");
  try { await tmux("-V"); } catch { throw new Error("Install tmux, then run fission tmux."); }
  let exists = false;
  try { await tmux("has-session", "-t", `=${session}`); exists = true; } catch { /* First launch. */ }
  if (exists) {
    if (!await ownsSession())
      throw new Error("A different tmux session uses this name; preserve it.");
  } else {
    await tmux("new-session", "-d", "-s", session, "-n", "machines", "-e", `FISSION_HOME=${root}`,
      "-e", `FISSION_STORAGE_DIR=${storageRoot()}`,
      "-e", `FISSION_TMUX_SESSION=${session}`, "-e", `FISSION_TEMPO=${process.env.FISSION_TEMPO || join(homedir(), ".tempo/bin/tempo")}`,
      process.execPath, fileURLToPath(import.meta.url), "serve");
    await tmux("set-option", "-t", session, "@fission-home", root);
    await tmux("set-option", "-t", session, "mouse", "on");
  }
  if (process.env.TMUX) { await tmux("switch-client", "-t", session); return; }
  const child = spawn("tmux", ["attach-session", "-t", session], { stdio: "inherit" });
  process.exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); });
}

async function serve() {
  const child = spawn(process.execPath, [cli], { stdio: "inherit" });
  const seen = new Set();
  let running = true;
  const ended = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => { running = false; resolve(code ?? 1); }); });
  const stop = () => child.kill("SIGTERM");
  process.on("SIGTERM", stop); process.on("SIGHUP", stop);
  try {
    while (running) {
      try {
        const states = await list();
        const windows = await tmux("list-windows", "-t", session, "-F", "#{window_id} #{@fission-machine}");
        for (const line of windows.split("\n")) {
          const [id, name] = line.split(" ");
          if (name && states.some(state => state.name === name && ["terminated", "expired", "not_submitted"].includes(state.phase)))
            await tmux("kill-window", "-t", id);
        }
        for (const state of states.filter(ready)) {
          if (seen.has(state.name)) continue;
          seen.add(state.name); // A disconnected shell is reopened explicitly, never in a retry loop.
          await window(state.name);
        }
      } catch { /* Keep the dashboard usable; the next local snapshot can reconcile windows. */ }
      // Match the TUI's local refresh cadence; this loop never polls paid providers.
      await Promise.race([ended, new Promise(resolve => { const timer = setTimeout(resolve, 5000); timer.unref(); })]);
    }
    return await ended;
  } finally {
    process.off("SIGTERM", stop); process.off("SIGHUP", stop);
    try {
      for (const line of (await tmux("list-windows", "-t", session, "-F", "#{window_id} #{@fission-machine}")).split("\n")) {
        const [id, name] = line.split(" ");
        if (name) await tmux("kill-window", "-t", id);
      }
    } catch { /* The owning session may already have exited. */ }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const action = process.argv[2];
  const operation = action === "serve" ? serve().then(code => { process.exitCode = code; }) :
    action === "popup" && process.argv.length === 4 ? popupMachine(process.argv[3]).then(() => console.log('{"status":0}')) :
      Promise.reject(new Error("Unknown tmux operation."));
  operation.catch(error => { console.error(error.message); process.exitCode = 1; });
}
