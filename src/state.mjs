import { existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

// Keep existing budgets and unresolved machines attached after the product rename.
const legacyRoot = join(homedir(), ".local/state/loaner");
export const root = resolve(process.env.FISSION_HOME || process.env.LOANER_HOME ||
  (existsSync(legacyRoot) ? legacyRoot : join(homedir(), ".local/state/fission")));

// Read old records without rewriting their plan digest or financial history.
export const providerId = (value) => value === "x402-compute" ? "compute-mpp" : value;

export function directory(name) {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(name || ""))
    throw new Error("Name must begin with a lowercase letter and contain at most 48 letters, digits or hyphens.");
  return join(root, name);
}

export async function writeJSON(path, value) {
  await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + "\n");
    await file.sync();
  } finally { await file.close(); }
  await rename(temp, path);
  const parent = await open(resolve(path, ".."), "r");
  try { await parent.sync(); } finally { await parent.close(); }
}

export async function readJSON(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function load(name) {
  const state = await readJSON(join(directory(name), "state.json"));
  if (!state) throw new Error(`No saved workspace named ${name}.`);
  return { ...state, provider: providerId(state.provider) };
}

export const save = (state) => writeJSON(join(directory(state.name), "state.json"), state);

export async function list() {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const names = await readdir(root, { withFileTypes: true });
  const states = [];
  for (const entry of names) {
    if (!entry.isDirectory() || !/^[a-z][a-z0-9-]{0,47}$/.test(entry.name)) continue;
    const state = await readJSON(join(root, entry.name, "state.json"));
    if (state) states.push({ ...state, provider: providerId(state.provider) });
  }
  return states;
}

export const locked = (name, action) => fileLocked(join(directory(name), "operation.lock"), action);

export class OperationLocked extends Error {
  constructor(path) {
    super(`Operation lock exists: ${path}. Check its PID; after that process exits, remove only the lock and run reconcile. Keep all other state.`);
    this.path = path;
  }
}

export async function fileLocked(path, action, waitMs = 0) {
  const dir = resolve(path, "..");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let file;
  const deadline = Date.now() + waitMs;
  while (!file) {
    try { file = await open(path, "wx", 0o600); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline)
        throw new OperationLocked(path);
      await delay(Math.min(25, deadline - Date.now()));
    }
  }
  await file.writeFile(JSON.stringify({ pid: process.pid }));
  await file.close();
  try { return await action(); } finally { await unlink(path); }
}
