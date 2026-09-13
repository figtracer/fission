import { readFile, open, rename, mkdir, unlink } from "node:fs/promises";
import { join, resolve, basename, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { directory, load, save, readJSON, locked } from "./state.mjs";
import { quote, request, recoverCreate, execute, money } from "./provider.mjs";

// Published gateway price for exec, status, and terminate; reject a higher charge.
export const operationCap = "0.0001";
const recipeDirectory = fileURLToPath(new URL("../recipes/", import.meta.url));
export const terminal = (state) => ["terminated", "expired"].includes(state.phase);

export async function recipe(input = "linux") {
  const file = ["linux", "reth"].includes(input) ? join(recipeDirectory, `${input}.json`) : resolve(input);
  const value = JSON.parse(await readFile(file, "utf8"));
  if (typeof value.name !== "string" || !Array.isArray(value.prepare) || !Array.isArray(value.artifacts))
    throw new Error("Recipe requires name, prepare argv arrays, and artifact paths.");
  if (Object.keys(value).some((key) => !["name", "description", "prepare", "artifacts"].includes(key)))
    throw new Error("Unknown recipe field. Recipes cannot change payment or runtime settings.");
  for (const args of value.prepare)
    if (!Array.isArray(args) || !args.length || args.some((arg) => typeof arg !== "string" || arg.includes("\0")))
      throw new Error("Each preparation command must be an argv array.");
  const names = new Set();
  for (const path of value.artifacts) {
    remotePath(path);
    if (names.has(basename(path))) throw new Error("Artifact basenames must be unique.");
    names.add(basename(path));
  }
  return { ...value, digest: createHash("sha256").update(JSON.stringify(value)).digest("hex") };
}

export function duration(text) {
  const match = /^(\d+)(s|m|h)$/.exec(text || "");
  if (!match) throw new Error("Specify a duration, such as 15m or 2h.");
  const seconds = Number(match[1]) * { s: 1, m: 60, h: 3600 }[match[2]];
  if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 86400)
    throw new Error("Duration must be between 60 seconds and 24 hours.");
  return seconds;
}

export async function plan(name, options) {
  directory(name);
  if (await readJSON(join(directory(name), "state.json")))
    throw new Error("That name already has saved state. Reconcile it or choose a different name for a new task.");
  const definition = await recipe(options.recipe);
  const timeout = duration(options.duration);
  const maximum = options["max-spend"];
  if (money(maximum) <= 0n) throw new Error("Set a positive --max-spend for creation.");
  const body = { timeout };
  const offer = await quote("create", body);
  if (money(offer.amount) > money(maximum)) throw new Error(`Quote ${offer.amount} exceeds --max-spend ${maximum}.`);
  return { name, provider: "modal-tempo", kind: "linux-sandbox", durationSeconds: timeout, creationQuote: offer.amount, creationCap: maximum, operationCap, recipe: definition, body };
}

export async function start(name, prepared) {
  return locked(name, async () => {
    if (await readJSON(join(directory(name), "state.json")))
      throw new Error("That name already has saved state. Reconcile it or choose a different name for a new task.");
    const state = { ...prepared, phase: "provisioning_unknown", createRequest: randomUUID(), requestedAt: new Date().toISOString(), remoteId: null };
    await save(state);
    const response = await request(state, "create", state.body, state.creationCap, state.createRequest);
    if (!/^sb-[A-Za-z0-9]+$/.test(response.sandbox_id || "")) throw new Error("Creation response has no valid sandbox ID. Reconcile before another purchase.");
    state.remoteId = response.sandbox_id;
    state.receivedAt = new Date().toISOString();
    // Gateway exposes no server creation timestamp. Show an estimated deadline,
    // never treat a local countdown as confirmation of remote termination.
    state.deadlineEstimate = new Date(Date.parse(state.requestedAt) + state.durationSeconds * 1000).toISOString();
    state.phase = "preparing";
    await save(state);
    try {
      for (const command of state.recipe.prepare) {
        const result = await execute(state, command, operationCap);
        if (result.returncode !== 0) throw new Error(`Preparation exited ${result.returncode}: ${result.stderr.slice(-1000)}`);
      }
      state.phase = "ready";
      state.readyAt = new Date().toISOString();
      await save(state);
    } catch (error) {
      state.preparationError = error.message;
      state.phase = "prepare_failed";
      await save(state);
      try { await terminate(state); } catch { /* State retains unresolved cleanup. */ }
      throw new Error(`Preparation failed: ${error.message}. Cleanup state: ${state.phase}.`);
    }
    return state;
  });
}

async function refreshState(state) {
  if (!state.remoteId) throw new Error("No remote ID yet. Run reconcile to recover the saved create response.");
  const response = await request(state, "status", { sandbox_id: state.remoteId }, operationCap);
  if (!["running", "terminated"].includes(response.status)) throw new Error(`Unexpected status ${response.status}; inspect the saved response.`);
  state.observedAt = new Date().toISOString();
  state.remoteStatus = response.status;
  state.returncode = response.returncode;
  if (response.status === "terminated") {
    state.phase = "terminated";
    state.closedAt ??= state.observedAt;
  }
  await save(state);
  return state;
}

export const refresh = (name) => locked(name, async () => refreshState(await load(name)));

export async function reconcile(name) {
  return locked(name, async () => {
    const state = await load(name);
    if (!state.remoteId) {
      state.remoteId = await recoverCreate(state);
      if (!state.remoteId)
        throw new Error(`No recoverable response for request ${state.createRequest}. Do not create again. Preserve ${directory(name)} for provider/payment reconciliation.`);
      state.phase = "preparation_pending";
      state.deadlineEstimate = new Date(Date.parse(state.requestedAt) + state.durationSeconds * 1000).toISOString();
      await save(state);
    }
    // Reconciliation observes only; it never repeats preparation or payment.
    return refreshState(state);
  });
}

async function terminate(state) {
  state.phase = "termination_unknown";
  await save(state);
  const response = await request(state, "terminate", { sandbox_id: state.remoteId }, operationCap);
  if (response.status !== "terminated") throw new Error("Provider did not confirm termination. Run status before retrying.");
  state.phase = "terminated";
  state.remoteStatus = "terminated";
  state.observedAt = new Date().toISOString();
  state.closedAt ??= state.observedAt;
  await save(state);
  return state;
}

function remotePath(path) {
  if (typeof path !== "string" || !isAbsolute(path) || /[\0\r\n]/.test(path) || basename(path) === "." || basename(path) === "..")
    throw new Error("Use an absolute remote file path.");
  return path;
}

export async function active(name) {
  const state = await load(name);
  if (!state.remoteId || terminal(state) || ["termination_unknown", "closing"].includes(state.phase))
    throw new Error(`Workspace is ${state.phase}; inspect status before executing work.`);
  if (Date.now() >= Date.parse(state.deadlineEstimate))
    throw new Error("Estimated deadline has passed. Inspect status; the workspace may already be gone.");
  return state;
}

export async function upload(state, local, remote) {
  remotePath(remote);
  const bytes = await readFile(resolve(local));
  // The payment gateway rejected 48 KiB request chunks. Keep payloads small
  // enough for its payment-challenge headers as well as the JSON body.
  const chunkBytes = 4 * 1024;
  const temp = remote + ".loaner-" + randomUUID();
  const script = "import sys,base64,pathlib; p=pathlib.Path(sys.argv[1]); p.parent.mkdir(parents=True,exist_ok=True); f=p.open(sys.argv[2]); f.write(base64.b64decode(sys.argv[3])); f.close()";
  for (let offset = 0; offset < Math.max(bytes.length, 1); offset += chunkBytes) {
    const result = await execute(state, ["python3", "-c", script, temp, offset ? "ab" : "xb", bytes.subarray(offset, offset + chunkBytes).toString("base64")], operationCap);
    if (result.returncode) throw new Error("Upload interrupted; remote staging file retained. No command was retried.");
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  const finish = await execute(state, ["python3", "-c", "import sys,hashlib,os; p=sys.argv[1]; assert hashlib.sha256(open(p,'rb').read()).hexdigest()==sys.argv[3]; os.link(p,sys.argv[2]); os.unlink(p)", temp, remote, digest], operationCap);
  if (finish.returncode) throw new Error("Upload verification or publication failed. Destination must not exist.");
  return { remote, bytes: bytes.length, sha256: digest };
}

export async function download(state, remote, local) {
  remotePath(remote);
  const destination = resolve(local);
  await mkdir(resolve(destination, ".."), { recursive: true });
  const target = await open(destination, "wx", 0o600);
  const script = "import sys,json,hashlib,base64; f=open(sys.argv[1],'rb'); b=f.read(); i=int(sys.argv[2]); print(json.dumps({'size':len(b),'sha256':hashlib.sha256(b).hexdigest(),'data':base64.b64encode(b[i:i+49152]).decode()}))";
  let expected, offset = 0;
  const hash = createHash("sha256");
  try {
    do {
      const result = await execute(state, ["python3", "-c", script, remote, String(offset)], operationCap);
      if (result.returncode) throw new Error("Remote file could not be read.");
      const part = JSON.parse(result.stdout);
      if (!Number.isSafeInteger(part.size) || part.size < 0 || !/^[a-f0-9]{64}$/.test(part.sha256)) throw new Error("Invalid file manifest.");
      expected ??= part;
      if (expected.sha256 !== part.sha256 || expected.size !== part.size) throw new Error("File changed during export. Quiesce the writer and try a new output path.");
      const bytes = Buffer.from(part.data, "base64");
      if (bytes.length !== Math.min(49152, expected.size - offset)) throw new Error("Incomplete file chunk.");
      await target.write(bytes);
      hash.update(bytes);
      offset += bytes.length;
    } while (offset < expected.size);
    if (hash.digest("hex") !== expected.sha256) throw new Error("Export digest mismatch.");
    await target.sync();
    return { local: destination, remote, bytes: offset, sha256: expected.sha256 };
  } catch (error) {
    throw new Error(`${error.message} Partial output retained at ${destination}; machine remains open until its original deadline.`);
  } finally { await target.close(); }
}

export async function close(name, options) {
  return locked(name, async () => {
    const state = await load(name);
    if (terminal(state)) return state;
    if (!state.remoteId) throw new Error("Run reconcile before closing an unresolved creation.");
    if (state.phase === "termination_unknown") {
      await refreshState(state);
      if (terminal(state)) return state;
    }
    if (!options["discard-output"] && state.recipe.artifacts.length && !options.output)
      throw new Error("Choose --output DIR to save declared files, or --discard-output to delete without saving.");
    if (options.output && !state.exportedTo) {
      const output = resolve(options.output);
      const staging = `${output}.partial-${randomUUID()}`;
      await mkdir(staging, { recursive: false, mode: 0o700 });
      for (const path of state.recipe.artifacts) await download(state, path, join(staging, basename(path)));
      // Require a fresh destination; do not merge with or overwrite existing work.
      const reserved = await open(`${output}.loaner-reservation`, "wx", 0o600);
      await reserved.close();
      try {
        await mkdir(output, { recursive: false });
        await rename(staging, output);
      } catch (error) { throw new Error(`Export retained at ${staging}: ${error.message}`); }
      finally { await unlink(`${output}.loaner-reservation`); }
      state.exportedTo = output;
      await save(state);
    }
    return terminate(state);
  });
}
