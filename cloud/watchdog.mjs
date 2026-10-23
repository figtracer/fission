import { DurableObject } from "cloudflare:workers";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const endpoint = "https://compute.x402layer.cc/compute/instances/";
const terminal = (status) => ["destroyed", "terminated"].includes(status);
// Bound observation retries to the original 15-minute cleanup allowance.
const observationMs = 30000, cleanupMs = 900000;
const publicState = ({ key, ...value }) => value;

export default {
  async fetch(request, env) {
    const expected = env.FISSION_WATCHDOG_TOKEN;
    if (!expected || expected.length < 32) return new Response("Watchdog is not configured", { status: 503 });
    const supplied = request.headers.get("Authorization") || "";
    const hash = async (value) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
    const [a, b] = await Promise.all([hash(supplied), hash(`Bearer ${expected}`)]);
    if (a.reduce((diff, byte, i) => diff | byte ^ b[i], 0)) return new Response("Unauthorized", { status: 401 });
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET" && !url.search) return Response.json({ service: "fission-watchdog", version: 1 });
    const match = /^\/rentals\/([^/]+)(\/close)?$/.exec(url.pathname);
    if (!match || !uuid.test(match[1]) || url.search || !["GET", "PUT", "POST"].includes(request.method) ||
        (request.method === "POST") !== Boolean(match[2])) return new Response("Unsupported operation", { status: 400 });
    return env.RENTALS.getByName(match[1].toLowerCase()).fetch(request);
  },
};

export class Rental extends DurableObject {
  async fetch(request) {
    const id = new URL(request.url).pathname.split("/")[2].toLowerCase();
    if (request.method === "PUT") {
      if (Number(request.headers.get("Content-Length")) > 4096) return new Response("Too large", { status: 413 });
      const text = await request.text();
      if (text.length > 4096) return new Response("Too large", { status: 413 });
      let body;
      try { body = JSON.parse(text); } catch { return new Response("Invalid JSON", { status: 400 }); }
      if (Object.keys(body || {}).some((key) => !["key", "deadline"].includes(key)) ||
          typeof body?.key !== "string" || body.key.length < 16 || body.key.length > 512 || /[\r\n]/.test(body.key) ||
          !Number.isSafeInteger(body.deadline) || body.deadline <= 0) return new Response("Invalid rental", { status: 400 });
      // No provider I/O inside the transaction. Registration is immutable and
      // idempotent, including after a lost acknowledgement or process restart.
      const value = await this.ctx.storage.transaction(async (txn) => {
        const previous = await txn.get("rental");
        if (previous) return previous;
        const rental = { id, key: body.key, deadline: body.deadline, phase: "armed", registeredAt: Date.now() };
        await txn.put("rental", rental);
        await txn.setAlarm(Math.max(Date.now(), body.deadline));
        return rental;
      });
      if (value.deadline !== body.deadline || value.key && value.key !== body.key) return new Response("Rental registration differs", { status: 409 });
      return Response.json(publicState(value));
    }
    const value = await this.ctx.storage.get("rental");
    if (!value) return new Response("Rental not registered", { status: 404 });
    if (request.method === "POST") await this.close();
    return Response.json(publicState(await this.ctx.storage.get("rental")));
  }

  async close() {
    const value = await this.ctx.storage.transaction(async (txn) => {
      const rental = await txn.get("rental");
      if (!rental || rental.phase === "closed") return null;
      rental.closeRequestedAt ??= Date.now();
      rental.phase = rental.deleteAttemptedAt ? "termination_unknown" : "closing";
      await txn.put("rental", rental);
      await txn.setAlarm(Date.now() + observationMs);
      return rental;
    });
    if (!value) return;
    let status, error;
    try {
      const observe = async () => {
        const response = await fetch(endpoint + value.id, { headers: { "X-API-Key": value.key }, redirect: "manual", signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(`Provider status HTTP ${response.status}`);
        const data = await response.json(), order = data.order || data.instance || data;
        if (order.id !== value.id || typeof order.status !== "string") throw new Error("Provider identity mismatch");
        return order.status;
      };
      status = await observe();
      const dispatch = !terminal(status) && await this.ctx.storage.transaction(async (txn) => {
        const current = await txn.get("rental");
        if (current.phase === "closed" || current.deleteAttemptedAt) return false;
        current.deleteAttemptedAt = Date.now();
        current.phase = "termination_unknown";
        await txn.put("rental", current);
        return true;
      });
      // Persist the claim before DELETE. Alarm retries and local stop requests
      // may repeat observations, but never replay an uncertain mutation.
      if (dispatch) {
        const response = await fetch(endpoint + value.id, { method: "DELETE", headers: { "X-API-Key": value.key }, redirect: "manual", signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(`Provider DELETE HTTP ${response.status}`);
        status = await observe();
      }
    } catch (cause) { error = cause.message; }
    await this.ctx.storage.transaction(async (txn) => {
      const current = await txn.get("rental");
      if (current.phase === "closed") return;
      current.observedAt = Date.now();
      current.status = status || null;
      current.error = error || null;
      if (terminal(status)) {
        current.phase = "closed";
        delete current.key;
        await txn.deleteAlarm();
      } else if (Date.now() < current.closeRequestedAt + cleanupMs) {
        await txn.setAlarm(Date.now() + observationMs);
      } else {
        current.error ||= "Cleanup not confirmed; inspect provider state. DELETE will not be repeated.";
        await txn.deleteAlarm();
      }
      await txn.put("rental", current);
    });
  }

  async alarm() {
    const value = await this.ctx.storage.get("rental");
    if (!value || value.phase === "closed") return;
    if (!value.closeRequestedAt && Date.now() < value.deadline) {
      await this.ctx.storage.setAlarm(value.deadline);
      return;
    }
    await this.close();
  }
}
