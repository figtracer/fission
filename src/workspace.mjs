import { readFile, open, rename, mkdir, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve, basename, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { directory, load, save, readJSON, locked, providerId } from "./state.mjs";
import { quote, request, recoverCreate, execute, money, validRemoteId } from "./provider.mjs";
import { hasTerminationReservation, BudgetRejected } from "./budget.mjs";

// Published gateway price for exec, status, and terminate; reject a higher charge.
export const operationCap = "0.0001";
const recipeDirectory = fileURLToPath(new URL("../recipes/", import.meta.url));
export const terminal = (state) => ["terminated", "expired"].includes(state.phase);
export const sourceRecipes = {
  "foundry-source": ["forge", "cast", "anvil", "chisel"],
  "reth-source": ["reth"],
  "tempo-source": ["tempo"],
};

export async function recipe(input = "linux") {
  let value;
  if (typeof input === "object" && input !== null) value = input;
  else if (input === "foundry-symbolic") {
    const { digest, ...foundry } = await recipe("foundry");
    value = { ...foundry, name: input, description: "Prebuilt Foundry 1.8.1 and Z3 5.1.0 for bounded symbolic tests; Linux x86_64, glibc >= 2.39. No source build.",
      prepare: [...foundry.prepare, ["python3", "-c", await readFile(new URL("../harness/foundry-symbolic.py", import.meta.url), "utf8")]],
      readiness: [...foundry.readiness, ["/workspace/z3", "--version"]],
      artifacts: ["/workspace/symbolic-tools.json"] };
  } else if (input === "reth-synced") {
    const files = {};
    for (const name of ["ethereum-node.py", "ethereum-ready.py"])
      files[name] = await readFile(new URL(`../harness/${name}`, import.meta.url), "utf8");
    value = { name: input, description: "Prepare pinned Reth/Lighthouse tools and permit their P2P ports through UFW. Bootstrap does not import data or start nodes.",
      prepare: [["python3", "-c", "import pathlib,json,sys; p=pathlib.Path('/workspace/.fission'); p.mkdir(parents=True,exist_ok=True); [(p/name).write_text(text) for name,text in json.loads(sys.argv[1]).items()]", JSON.stringify(files)],
        ["python3", "/workspace/.fission/ethereum-node.py", "install"],
        ...["30303/tcp", "30303/udp", "9000/tcp", "9000/udp", "9001/udp"].map((port) => ["ufw", "allow", port]),
        ["ufw", "status", "verbose"]],
      readiness: [["/workspace/.fission/clients/reth-2.5.2", "--version"], ["/workspace/.fission/clients/lighthouse-8.2.2", "--version"]],
      artifacts: ["/workspace/ethereum-tools.json"] };
  } else {
    const file = ["linux", "reth", "foundry", "tempo"].includes(input) ? join(recipeDirectory, `${input}.json`) : resolve(input);
    const binaries = Object.hasOwn(sourceRecipes, input) ? sourceRecipes[input] : null;
    value = binaries ? {
      name: input, description: "Prepare Rust 1.96.1 and the exact source checkout. Run /workspace/build as a separate job; no node is started.", prepare: [],
      afterCheckout: [["python3", "-c", "import pathlib,subprocess,sys; p=pathlib.Path('/workspace/.fission/rust-source.py'); p.parent.mkdir(exist_ok=True); p.write_text(sys.argv[1]); subprocess.run(['python3',str(p),'prepare',*sys.argv[2:]],check=True)", await readFile(new URL("../harness/rust-source.py", import.meta.url), "utf8"), ...binaries]],
      readiness: [["/workspace/cargo", "--version"], ["/workspace/rustc", "--version"]], artifacts: ["/workspace/source.json"],
    } : JSON.parse(await readFile(file, "utf8"));
  }
  return validateRecipe(value);
}

export function validateRecipe(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Recipe must be an object.");
  if (typeof value.name !== "string" || !Array.isArray(value.prepare) || !Array.isArray(value.artifacts))
    throw new Error("Recipe requires name, prepare argv arrays, and artifact paths.");
  if (Object.keys(value).some((key) => !["schemaVersion", "name", "description", "prepare", "artifacts", "readiness", "afterCheckout", "checks"].includes(key)))
    throw new Error("Unknown recipe field. Recipes cannot change payment or runtime settings.");
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1) throw new Error("Unsupported recipe schemaVersion.");
  if (value.checks !== undefined) {
    if (!Array.isArray(value.checks)) throw new Error("checks must be named scoped probes.");
    const names = new Set();
    for (const check of value.checks) {
      if (!check || Object.keys(check).some((key) => !["name", "scope", "argv", "result"].includes(key)) ||
          !/^[a-z][a-z0-9-]*$/.test(check.name || "") || !/^[a-z][a-z0-9-]*$/.test(check.scope || "") ||
          !["exit", "json"].includes(check.result) || names.has(check.name)) throw new Error("Invalid or duplicate readiness check.");
      names.add(check.name);
    }
  }
  if (value.readiness !== undefined && !Array.isArray(value.readiness)) throw new Error("Readiness must be argv arrays.");
  if (value.afterCheckout !== undefined && !Array.isArray(value.afterCheckout)) throw new Error("afterCheckout must be argv arrays.");
  for (const args of [...value.prepare, ...(value.afterCheckout || []), ...(value.readiness || []), ...(value.checks || []).map((check) => check.argv)])
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
  if (options.recipe === "reth-synced") throw new Error("The synced-node recipe requires capability matching through a saved plan.");
  if (options.recipe === "foundry-symbolic") throw new Error("The symbolic recipe requires a saved Linux x86_64 VM plan.");
  directory(name);
  if (await readJSON(join(directory(name), "state.json")))
    throw new Error("That name already has saved state. Reconcile it or choose a different name for a new task.");
  const definition = await recipe(options.recipe);
  if (definition.afterCheckout?.length) throw new Error("Source recipes require a saved plan with --repo and --ref.");
  const timeout = duration(options.duration);
  const maximum = options["max-spend"];
  if (money(maximum) <= 0n) throw new Error("Set a positive --max-spend for creation.");
  const body = { timeout };
  const offer = await quote("create", body);
  if (money(offer.amount) > money(maximum)) throw new Error(`Quote ${offer.amount} exceeds --max-spend ${maximum}.`);
  return { name, project: basename(process.cwd()), provider: "modal-tempo", kind: "linux-sandbox", durationSeconds: timeout, creationQuote: offer.amount, creationCap: maximum, operationCap, recipe: definition, body };
}

export async function start(name, prepared) {
  prepared = { ...prepared, provider: providerId(prepared.provider) };
  return locked(name, async () => {
    const previous = await readJSON(join(directory(name), "state.json"));
    if (previous && previous.phase !== "not_submitted")
      throw new Error("That name already has saved state. Reconcile it or choose a different name for a new task.");
    const state = { ...prepared, phase: "provisioning_unknown", createRequest: randomUUID(), requestedAt: new Date().toISOString(), remoteId: null };
    await save(state);
    let response;
    try { response = await request(state, "create", state.body, state.creationCap, state.createRequest); }
    catch (error) {
      if (error instanceof BudgetRejected) {
        state.phase = "not_submitted";
        state.preparationError = error.message;
        await save(state);
      }
      throw error;
    }
    if (!validRemoteId(state, response.sandbox_id)) throw new Error("Creation response has no valid machine ID. Reconcile before another purchase.");
    state.remoteId = response.sandbox_id;
    state.receivedAt = new Date().toISOString();
    // Gateway exposes no server creation timestamp. Show an estimated deadline,
    // never treat a local countdown as confirmation of remote termination.
    state.deadlineEstimate = new Date(Date.parse(state.requestedAt) + state.durationSeconds * 1000).toISOString();
    state.phase = "preparing";
    await save(state);
    if (state.asyncPreparation) return prepareState(state);

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

async function prepareState(state) {
  if (!state.asyncPreparation || !state.remoteId || !["preparing", "preparation_pending"].includes(state.phase))
    throw new Error("This workspace is not awaiting preparation.");
  if (state.bootstrapJob) throw new Error("Bootstrap already recorded. Observe its existing job; do not launch it again.");
  if (state.provider === "compute-mpp") {
    const compute = await import("./compute.mjs");
    if (state.lease) {
      if (!await compute.prepareLease(state)) return state;
    } else await compute.prepareAccess(state);
  }
  const { launch } = await import("./jobs.mjs");
  const commands = [...state.recipe.prepare];
  if (state.source) commands.unshift(["python3", "-c", "import shutil,subprocess; subprocess.run(['apt-get','update'],check=True) if not shutil.which('git') else None; subprocess.run(['apt-get','install','-y','git','ca-certificates'],check=True) if not shutil.which('git') else None"]);
  if (state.source) commands.push(["python3", "-c", "import subprocess,pathlib,sys,json; p=pathlib.Path('/workspace/source'); p.mkdir(); subprocess.run(['git','init',str(p)],check=True); subprocess.run(['git','-C',str(p),'fetch','--depth','1',sys.argv[1],sys.argv[2]],check=True); subprocess.run(['git','-C',str(p),'checkout','--detach','FETCH_HEAD'],check=True); actual=subprocess.check_output(['git','-C',str(p),'rev-parse','HEAD'],text=True).strip(); assert actual==sys.argv[2]; subprocess.run(['git','-C',str(p),'submodule','update','--init','--recursive'],check=True); print(json.dumps({'commit':actual,'submodules':subprocess.check_output(['git','-C',str(p),'submodule','status','--recursive'],text=True)}))", state.source.url, state.source.commit]);
  commands.push(...(state.recipe.afterCheckout || []));
  // The job identity is persisted before launch. An ambiguous result is observed,
  // never automatically replayed or mistaken for failed preparation.
  state.bootstrapJob = "bootstrap";
  state.recipe = { ...state.recipe, artifacts: [...new Set([...state.recipe.artifacts, "/workspace/.fission/jobs/bootstrap/output.log"])] };
  await save(state);
  await launch(state, "bootstrap", commands, state.durationSeconds, state.recipe.readiness || []);
  return state;
}

export const prepare = (name, remaining) => locked(name, async () => {
  const state = await load(name);
  if (remaining !== undefined) {
    const minimumSeconds = duration(remaining);
    if (!state.lease || !state.resizeRequest || state.bootstrapJob || !["preparing", "preparation_pending"].includes(state.phase) || minimumSeconds > state.durationSeconds)
      throw new Error("An explicit shorter minimum applies only to an already-resized lease awaiting bootstrap.");
    state.preparationAcceptance = { minimumSeconds, originalMinimumSeconds: state.durationSeconds, acceptedAt: new Date().toISOString(), providerExpiresAt: state.providerExpiresAt };
    await save(state);
  }
  return prepareState(state);
});

async function refreshState(state, options) {
  if (!state.remoteId) throw new Error("No remote ID yet. Run reconcile to recover the saved create response.");
  const response = await request(state, "status", { sandbox_id: state.remoteId }, operationCap, undefined, options);
  if (!["running", "terminated"].includes(response.status)) throw new Error(`Unexpected status ${response.status}; inspect the saved response.`);
  state.observedAt = new Date().toISOString();
  state.remoteStatus = response.status;
  state.returncode = response.returncode;
  if (response.status === "terminated") {
    state.phase = "terminated";
    state.closedAt ??= state.observedAt;
  } else if (terminal(state)) {
    // A termination acknowledgement can precede the provider's actual exit.
    state.phase = "termination_unknown";
    delete state.closedAt;
  }
  await save(state);
  return state;
}

export const refresh = (name, options) => locked(name, async () => refreshState(await load(name), options));

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
  try {
    const response = await request(state, "terminate", { sandbox_id: state.remoteId }, operationCap);
    if (response.status !== "terminated") throw new Error("Provider did not acknowledge termination.");
  } catch (error) {
    // A live VM DELETE timed out after destruction. Observe once, never replay
    // the mutation merely because its acknowledgement was lost.
    try { await refreshState(state); } catch { /* Keep the unresolved record. */ }
    if (terminal(state)) return state;
    throw new Error(`Termination is unconfirmed: ${error.message}. Run status --refresh before another close.`);
  }
  state.remoteStatus = "termination_acknowledged";
  await save(state);
  // The gateway can acknowledge before the process has actually exited.
  return refreshState(state);
}

function remotePath(path) {
  if (typeof path !== "string" || !isAbsolute(path) || /[\0\r\n]/.test(path) || basename(path) === "." || basename(path) === "..")
    throw new Error("Use an absolute remote file path.");
  return path;
}

export async function active(name, requireReady = true) {
  const state = await load(name);
  if (!state.remoteId || terminal(state) || ["termination_unknown", "closing"].includes(state.phase))
    throw new Error(`Workspace is ${state.phase}; inspect status before executing work.`);
  if (requireReady && state.resizePending)
    throw new Error("Provider resize is pending. Observe with status --refresh before submitting work.");
  if (requireReady && (state.asyncPreparation || state.bootstrapJob) && state.phase !== "ready")
    throw new Error("Bootstrap is not ready. Inspect its job before submitting work.");
  // The local deadline is informational; only the provider knows actual expiry.
  return state;
}

async function fingerprint(file) {
  const info = await file.stat();
  if (!info.isFile() || !Number.isSafeInteger(info.size)) throw new Error("Transfer requires a regular file of a supported size.");
  const hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
  for (let offset = 0; offset < info.size;) {
    // Explicit positions leave the descriptor at its start for the SSH child.
    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, info.size - offset), offset);
    if (!bytesRead) throw new Error("File changed while calculating its digest.");
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return { size: info.size, sha256: hash.digest("hex") };
}

export async function upload(state, local, remote) {
  remotePath(remote);
  if (providerId(state.provider) === "compute-mpp") {
    const source = await open(resolve(local), constants.O_RDONLY | constants.O_NONBLOCK);
    const staging = remote + ".fission-" + randomUUID();
    try {
      const expected = await fingerprint(source);
      const script = await readFile(new URL("../harness/transfer.py", import.meta.url), "utf8");
      const result = await execute(state, ["python3", "-c", script, "receive", staging, remote, String(expected.size), expected.sha256], operationCap, undefined, { inputFd: source.fd });
      if (result.returncode) throw new Error("Upload verification or publication failed; destination must not exist.");
      const received = JSON.parse(result.stdout);
      if (received.size !== expected.size || received.sha256 !== expected.sha256) throw new Error("Unrecognized upload acknowledgement.");
      return { remote, bytes: expected.size, sha256: expected.sha256 };
    } catch (error) {
      throw new Error(`${error.message} Inspect destination ${remote} and staging ${staging}; no transfer was retried.`);
    } finally { await source.close(); }
  }
  const bytes = await readFile(resolve(local));
  // The paid gateway rejected larger chunks because its payment-challenge
  // headers also carry request data.
  const chunkBytes = 4 * 1024;
  const temp = remote + ".fission-" + randomUUID();
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
  const target = await open(destination, "wx+", 0o600);
  const script = "import sys,json,hashlib,base64; f=open(sys.argv[1],'rb'); b=f.read(); i=int(sys.argv[2]); print(json.dumps({'size':len(b),'sha256':hashlib.sha256(b).hexdigest(),'data':base64.b64encode(b[i:i+49152]).decode()}))";
  let expected, offset = 0;
  const hash = createHash("sha256");
  try {
    if (providerId(state.provider) === "compute-mpp") {
      const script = await readFile(new URL("../harness/transfer.py", import.meta.url), "utf8");
      const metadata = await execute(state, ["python3", "-c", script, "metadata", remote], operationCap);
      if (metadata.returncode) throw new Error("Remote file could not be read.");
      expected = JSON.parse(metadata.stdout);
      if (!Number.isSafeInteger(expected.size) || expected.size < 0 || !/^[a-f0-9]{64}$/.test(expected.sha256)) throw new Error("Invalid file manifest.");
      const result = await execute(state, ["python3", "-c", script, "send", remote, String(expected.size), expected.sha256], operationCap, undefined, { outputFd: target.fd });
      if (result.returncode) throw new Error("Export interrupted or file changed.");
      const actual = await fingerprint(target);
      if (actual.size !== expected.size || actual.sha256 !== expected.sha256) throw new Error("Export digest mismatch.");
      await target.sync();
      return { local: destination, remote, bytes: actual.size, sha256: actual.sha256 };
    }
    do {
      const result = await execute(state, ["python3", "-c", script, remote, String(offset)], operationCap);
      if (result.returncode) throw new Error("Remote file could not be read.");
      const part = JSON.parse(result.stdout);
      if (!Number.isSafeInteger(part.size) || part.size < 0 || !/^[a-f0-9]{64}$/.test(part.sha256)) throw new Error("Invalid file manifest.");
      expected ??= part;
      if (expected.sha256 !== part.sha256 || expected.size !== part.size) throw new Error("File changed during export. Quiesce the writer and try a new output path.");
      const bytes = Buffer.from(part.data, "base64");
      if (bytes.length !== Math.min(49152, expected.size - offset)) throw new Error("Incomplete file chunk.");
      await target.writeFile(bytes);
      hash.update(bytes);
      offset += bytes.length;
    } while (offset < expected.size);
    if (hash.digest("hex") !== expected.sha256) throw new Error("Export digest mismatch.");
    await target.sync();
    return { local: destination, remote, bytes: offset, sha256: expected.sha256 };
  } catch (error) {
    throw new Error(`${error.message} Partial output retained at ${destination}; inspect provider status. No termination was requested by this export.`);
  } finally { await target.close(); }
}

export async function close(name, options) {
  return locked(name, async () => {
    const state = await load(name);
    if (terminal(state)) return state;
    if (!state.remoteId) throw new Error("Run reconcile before closing an unresolved creation.");
    if (state.phase === "termination_unknown" && await hasTerminationReservation(state)) {
      await refreshState(state);
      if (terminal(state)) return state;
    }
    if (!options["discard-output"] && state.recipe.artifacts.length && !options.output)
      throw new Error("Choose --output DIR to save declared files, or --discard-output to delete without saving.");
    if (options.output) {
      const output = resolve(options.output);
      const staging = `${output}.partial-${randomUUID()}`;
      await mkdir(staging, { recursive: false, mode: 0o700 });
      for (const path of state.recipe.artifacts) await download(state, path, join(staging, basename(path)));
      // Require a fresh destination; do not merge with or overwrite existing work.
      const reserved = await open(`${output}.fission-reservation`, "wx", 0o600);
      await reserved.close();
      try {
        await mkdir(output, { recursive: false });
        await rename(staging, output);
      } catch (error) { throw new Error(`Export retained at ${staging}: ${error.message}`); }
      finally { await unlink(`${output}.fission-reservation`); }
      state.exportedTo = output;
      await save(state);
    }
    return terminate(state);
  });
}
