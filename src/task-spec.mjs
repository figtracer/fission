import { stat, lstat } from "node:fs/promises";
import { resolve, isAbsolute, basename } from "node:path";
import { recipe, duration, validateRecipe } from "./workspace.mjs";
import { validateRecipient } from "./encryption.mjs";
import { fingerprint } from "./experiments.mjs";

// The same generic contract serves CLI commands, task files and machine groups.
export const taskOptions = ["budget", "duration", "work-duration", "prepare-duration", "region", "machine", "cpu", "memory", "disk", "no-resize", "repo", "ref", "cwd", "input", "secret", "encrypt-to", "artifact", "output"];
export const taskFileOptions = [...taskOptions, "recipe", "preparation", "checks", "context", "kind"];

export async function taskSpec(options, command) {
  if (Object.keys(options).some((key) => ![...taskFileOptions, "approve", "json"].includes(key)))
    throw new Error("Unsupported task option. Supply your setup and commands; use fission help run.");
  if (options.kind !== undefined && !["run", "rental"].includes(options.kind)) throw new Error("Task kind must be run or rental.");
  const rental = options.kind === "rental";
  if (rental && options["work-duration"] !== undefined) throw new Error("Rentals use --duration for their full lifetime; work-duration applies to run.");
  if (rental) {
    if (!Array.isArray(command) || command.length) throw new Error("Rentals hand over access; use run to execute a workload.");
  } else if (!Array.isArray(command) || !command.length || !command[0] || command.some((arg) => typeof arg !== "string" || arg.includes("\0")))
    throw new Error("Supply the workload argv after --.");
  if (options.recipe !== undefined && (!options.recipe || typeof options.recipe !== "object" || Array.isArray(options.recipe)))
    throw new Error("Task recipe must be an embedded setup object.");
  const definition = await recipe(options.recipe || { name: "machine", prepare: [], artifacts: [] });
  if (definition.afterCheckout?.length && !options.repo) throw new Error("afterCheckout requires repo and ref.");
  if (options.context !== undefined && typeof options.context !== "string") throw new Error("Task context must be text.");
  if (options.repo || options.ref) {
    if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(options.repo || "") || !/^[a-f0-9]{40}$/.test(options.ref || ""))
      throw new Error("The checkout shortcut requires a public GitHub --repo and full --ref commit. Use your own preparation commands or uploaded source for other repositories.");
  }
  for (const key of ["cpu", "memory", "disk"])
    if (options[key] !== undefined && (!["string", "number"].includes(typeof options[key]) || !Number.isFinite(Number(options[key])) || Number(options[key]) <= 0))
      throw new Error(`${key} must be a positive resource requirement.`);
  const total = duration(options.duration), work = rental ? 0 : duration(options["work-duration"]);
  const timing = {
    provisioningSeconds: 1800, preparationSeconds: duration(options["prepare-duration"] || "10m"),
    workSeconds: work, cleanupSeconds: 900, authorizedSeconds: total,
    basis: "30m provisioning and 15m cleanup preserve existing lifecycle allowances. Preparation is user-configurable; these are planning allowances, not guarantees.",
    evidence: { sampleCount: 0, uncertainty: "User-supplied workflow; no application setup or runtime estimate is inferred." },
  };
  timing.requiredSeconds = timing.provisioningSeconds + timing.preparationSeconds + work + timing.cleanupSeconds;
  if (timing.requiredSeconds > total || rental && timing.requiredSeconds === total)
    throw new Error(`Duration too short: ${timing.requiredSeconds}s required; ${total}s authorized. No quote or purchase submitted.`);
  const inputs = [], preparation = options.preparation === undefined ? [] : structuredClone(options.preparation);
  if (!Array.isArray(preparation) || preparation.some((argv) => !Array.isArray(argv) || !argv.length ||
      typeof argv[0] !== "string" || !argv[0] || argv.some((arg) => typeof arg !== "string" || arg.includes("\0"))))
    throw new Error("Preparation must be guest argv arrays, executed after input transfer.");
  if (options.input !== undefined && (!Array.isArray(options.input) || options.input.some((item) => typeof item !== "string")))
    throw new Error("input must be an array of file mappings.");
  for (const mapping of options.input || []) {
    const separator = mapping.indexOf("=");
    const local = resolve(separator < 0 ? mapping : mapping.slice(0, separator));
    const remote = separator < 0 ? "/workspace/" + local.split("/").at(-1) : mapping.slice(separator + 1);
    if (!(await stat(local)).isFile() || !isAbsolute(remote) || remote.includes("\0") || /[\r\n]/.test(remote) || !remote.startsWith("/workspace/"))
      throw new Error("--input accepts a regular local file[=/workspace/path]. Use an explicit source archive or patch, not an implicit directory upload.");
    if (resolve(remote) === "/workspace/.fission/secrets" || resolve(remote).startsWith("/workspace/.fission/secrets/")) throw new Error("Use --secret for the reserved secret directory.");
    inputs.push({ local, remote, ...await fingerprint(local) });
  }
  if (options.secret !== undefined && (!Array.isArray(options.secret) || options.secret.some((item) => typeof item !== "string")))
    throw new Error("secret must be an array of FILE[=NAME] references, never inline values.");
  for (const mapping of options.secret || []) {
    const separator = mapping.indexOf("=");
    const local = resolve(separator < 0 ? mapping : mapping.slice(0, separator));
    const name = separator < 0 ? basename(local) : mapping.slice(separator + 1);
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || [".", ".."].includes(name) || !(await lstat(local)).isFile())
      throw new Error("--secret requires a regular local file and a simple name; symlinks are not accepted.");
    inputs.push({ local, remote: `/workspace/.fission/secrets/${name}`, secret: true });
  }
  if (options["encrypt-to"] !== undefined) await validateRecipient(options["encrypt-to"]);
  if (new Set(inputs.map((input) => input.remote)).size !== inputs.length) throw new Error("Input destinations must be unique.");
  const artifacts = options.artifact || [];
  if (!Array.isArray(artifacts) || artifacts.some((path) => typeof path !== "string")) throw new Error("artifact must be an array of paths.");
  if (artifacts.some((path) => !path.startsWith("/workspace/") || /[\0\r\n]/.test(path))) throw new Error("--artifact must name a regular /workspace/file; databases stay remote.");
  if (artifacts.some((path) => resolve(path) === "/workspace/.fission/secrets" || resolve(path).startsWith("/workspace/.fission/secrets/")))
    throw new Error("Declared secret files cannot be selected as artifacts.");
  const cwd = options.cwd || (options.repo ? "/workspace/source" : "/workspace");
  if (!isAbsolute(cwd) || cwd.includes("\0")) throw new Error("--cwd must be an absolute guest directory.");
  const checks = [...(definition.checks || []), ...(definition.readiness || []).map((argv, i) => ({ name: `check-${i + 1}`, scope: "tools", argv, result: "exit" }))];
  if (options.checks !== undefined && !Array.isArray(options.checks)) throw new Error("checks must be an array.");
  checks.push(...(options.checks || []));
  const resolved = validateRecipe({ name: "checks", prepare: [], artifacts: [], checks });
  return { definition, disk: options.disk, task: { schemaVersion: 2, ...(rental ? { kind: "rental" } : {}),
    command, cwd, inputs, preparation, artifacts, ...(options["encrypt-to"] ? { encryptTo: options["encrypt-to"] } : {}), scope: "tools", probes: resolved.checks,
    timing, output: resolve(options.output || "fission"), context: options.context || "User-supplied Linux workflow." } };
}
