import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { directory, readJSON, writeJSON, save } from "./state.mjs";
import { request } from "./provider.mjs";

const origin = "https://mpp.browserbase.com";
const uuid = /^session_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const credentials = (name) => join(directory(name), "browser.json");
export const browserClosed = (browser) => !browser || !browser.createRequest || browser.phase === "closed" || browser.phase === "not_purchased";
export const browserStatus = (browser) => browser ? { provider: "browserbase", phase: browser.phase,
  sessionId: browser.sessionId || null, expiresAt: browser.expiresAt || null, quote: browser.quote, requestedMinutes: browser.body.estimatedMinutes,
  cleanupConfirmed: browserClosed(browser), observedAt: browser.observedAt || null, error: browser.error || null } : null;

async function adopt(state) {
  const browser = state.task.browser;
  const response = await readJSON(join(directory(state.name), "requests", `${browser.createRequest}.response.json`)).catch(() => null);
  const id = response?.sessionId || response?.id;
  if (!uuid.test(id || "")) throw new Error("Browser creation is unresolved. Preserve its receipt; no replacement is purchased.");
  browser.sessionId = id;
  await save(state);
  const url = new URL(response.connectUrl);
  if (url.protocol !== "wss:" || !url.hostname.endsWith(".browserbase.com") || url.username || url.password)
    throw new Error("Browser returned an unrecognized CDP address; cleanup retains the session ID.");
  await writeJSON(credentials(state.name), { connectUrl: url.href });
  browser.expiresAt = response.expiresAt;
  browser.phase = "ready";
  browser.observedAt = new Date().toISOString();
  await save(state);
}

// Called only during the explicit approved purchase, while holding the workspace lock.
export async function createBrowser(state) {
  const browser = state.task.browser;
  if (browser.createRequest) throw new Error("Browser purchase already recorded; do not pay again.");
  browser.createRequest = randomUUID();
  browser.phase = "creation_unknown";
  await save(state);
  try {
    await request(state, "browser-create", browser.body, browser.quote, browser.createRequest,
      { deadline: state.task.deadline - state.task.timing.cleanupSeconds * 1000 });
    await adopt(state);
  } catch (error) {
    browser.error = error.message;
    state.task.outcome = "preparation_failed";
    await save(state);
    throw error;
  }
}

export async function browserEnvironment(state) {
  const browser = state.task.browser;
  if (browser.phase !== "ready") throw new Error("Browser is not ready; no workflow dispatched.");
  const auth = await readJSON(credentials(state.name));
  if (!auth?.connectUrl) throw new Error("Missing saved browser connection.");
  return { FISSION_BROWSER_URL: auth.connectUrl };
}

// Free management calls do not use the wallet. Their IDs and outcomes remain
// beside the paid creation intent. A missing session or elapsed TTL is not proof
// of termination; only a recognized provider terminal status confirms cleanup.
export async function closeBrowser(state) {
  const browser = state.task?.browser;
  if (browserClosed(browser)) return;
  const dir = join(directory(state.name), "requests");
  try {
    if (!browser.sessionId) {
      if (!await readJSON(join(dir, `${browser.createRequest}.json`))) {
        browser.phase = "not_purchased";
        await save(state);
        return;
      }
      await adopt(state);
    }
    if (!uuid.test(browser.sessionId)) throw new Error("Invalid saved browser identity.");
    if (!browser.closeRequest) {
      browser.closeRequest = randomUUID();
      browser.phase = "termination_unknown";
      await save(state);
      await writeJSON(join(dir, `${browser.closeRequest}.json`), { operation: "browser-terminate", state: "submitting", maximum: "0" });
      const response = await fetch(`${origin}/browser/session/${browser.sessionId}`, { method: "DELETE", redirect: "error", signal: AbortSignal.timeout(30000) });
      await writeJSON(join(dir, `${browser.closeRequest}.response.json`), { httpStatus: response.status, body: await response.text() });
      if (!response.ok) throw new Error(`Browser DELETE HTTP ${response.status}; observe this session before recovery.`);
    }
    const response = await fetch(`${origin}/browser/session/${browser.sessionId}/status`, { redirect: "error", signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Browser status HTTP ${response.status}; cleanup remains unconfirmed.`);
    const result = await response.json();
    if (result.sessionId !== browser.sessionId) throw new Error("Browser status identity differs; cleanup remains unconfirmed.");
    await writeJSON(join(dir, `${randomUUID()}.browser-status.json`), result);
    browser.observedAt = new Date().toISOString();
    if (result.status === "ended") {
      browser.phase = "closed";
      delete browser.error;
      // Regenerate an earlier unresolved report after confirmed cleanup.
      delete state.task.report;
    } else browser.error = "Browser termination has not been confirmed; resume observes the same session.";
  } catch (error) { browser.error = error.message; }
  await save(state);
}
