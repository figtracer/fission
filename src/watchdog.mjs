import { join } from "node:path";
import { directory, readJSON, writeJSON, save } from "./state.mjs";

export function watchdogURL(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("--watchdog requires the HTTPS origin of your Fission watchdog.");
  return url.origin;
}

export async function checkWatchdog(value) {
  const token = process.env.FISSION_WATCHDOG_TOKEN;
  if (!token || token.length < 32) throw new Error("Set FISSION_WATCHDOG_TOKEN to your watchdog secret (at least 32 characters).");
  const response = await fetch(watchdogURL(value) + "/health", {
    headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Watchdog preflight HTTP ${response.status}; no purchase submitted.`);
  const data = await response.json();
  if (data.service !== "fission-watchdog" || data.version !== 1) throw new Error("Unrecognized watchdog deployment.");
}

async function call(state, method, path = "", body) {
  const auth = await readJSON(join(directory(state.name), "watchdog-auth.json"));
  if (!auth?.token) throw new Error("Missing saved watchdog credential; no direct deletion fallback.");
  const url = watchdogURL(state.task.watchdog.url);
  const response = await fetch(`${url}/rentals/${state.remoteId}${path}`, {
    method, headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error", signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`Watchdog HTTP ${response.status}; registration/deletion remains unresolved.`);
  const value = await response.json();
  if (value.id !== state.remoteId || value.deadline !== state.task.deadline) throw new Error("Watchdog rental identity differs.");
  state.task.watchdog.phase = value.phase;
  state.task.watchdog.observedAt = value.observedAt || null;
  state.task.watchdog.error = value.error || null;
  await save(state);
  return value;
}

// The watchdog receives only the instance management credential, never the
// wallet or SSH key. Once registration is attempted it owns all DELETE dispatches.
export async function registerWatchdog(state) {
  if (state.provider !== "compute-mpp") throw new Error("Watchdog requires a compute VM.");
  const token = process.env.FISSION_WATCHDOG_TOKEN;
  if (!token || token.length < 32) throw new Error("FISSION_WATCHDOG_TOKEN must contain at least 32 characters.");
  const auth = await readJSON(join(directory(state.name), "compute-auth.json"));
  if (!auth?.key) throw new Error("Missing rental management key.");
  await writeJSON(join(directory(state.name), "watchdog-auth.json"), { token });
  state.task.watchdog.phase = "registration_unknown";
  state.task.watchdog.requestedAt = new Date().toISOString();
  await save(state);
  const value = await call(state, "PUT", "", { key: auth.key, deadline: state.task.deadline });
  if (value.phase !== "armed") throw new Error("Watchdog did not confirm the rental deadline.");
}

export async function closeWithWatchdog(state) {
  // Repeating an identical registration is safe: the worker binds one ID and
  // deadline forever. A lost response cannot authorize a second deletion owner.
  if (state.task.watchdog.phase === "registration_unknown") {
    const auth = await readJSON(join(directory(state.name), "compute-auth.json"));
    await call(state, "PUT", "", { key: auth.key, deadline: state.task.deadline });
  }
  const result = await call(state, "POST", "/close");
  return { success: result.phase === "closed", watchdog: result };
}
