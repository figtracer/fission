import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const temporary = await mkdtemp(join(tmpdir(), "fission-cli-test-"));
const home = join(temporary, "state");
const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
after(() => rm(temporary, { recursive: true, force: true }));

function run(args, status = 0) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, FISSION_HOME: home, FISSION_TEMPO: join(temporary, "no-tempo"), FISSION_STORAGE_DIR: temporary },
    encoding: "utf8", timeout: 10000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, status, `${args.join(" ")}: ${result.stderr}`);
  if (status === 0) assert.equal(result.stderr, "");
  else assert.equal(result.stdout, "");
  return result;
}

test("root, command, and subcommand help resolve before required arguments or actions", async () => {
  const root = run(["help"]).stdout;
  assert.match(root, /Usage: fission +Open the Rust TUI/);
  assert.equal(run(["--help"]).stdout, root);
  assert.equal(run(["-h"]).stdout, root);
  const commands = ["help", "ui", "tmux", "skill", "guide", "capabilities", "recipes", "machines", "budget", "spending", "plan", "open", "prepare", "run", "jobs", "job", "wait", "check", "list", "status", "watch", "ssh", "exec", "upload", "download", "report", "storage", "cache", "dataset", "close", "reconcile"];
  const subcommands = ["skill install", "cache list", "cache save", "cache restore", "dataset inspect", "dataset save", "dataset collect", "dataset restore"];
  for (const command of [...commands, ...subcommands]) {
    const parts = command.split(" ");
    const output = run(["help", ...parts]).stdout;
    assert.ok(output.startsWith(`fission ${command} — `), command);
    assert.match(output, /\nUsage: fission(?: |\n)/);
    // `help --help` is the root index, while `help help` describes its syntax.
    assert.equal(run([...parts, "--help"]).stdout, command === "help" ? root : output);
    assert.equal(run([...parts, "-h"]).stdout, command === "help" ? root : output);
  }
  for (const [args, topic] of [
    [["open", "example", "--recipe", "linux", "--duration", "1h", "--max-spend", "1", "--approve"], ["open"]],
    [["plan", "example", "--budget", "1", "--cheapest"], ["plan"]],
    [["dataset", "save", "example", "save0", "--duration", "1h"], ["dataset", "save"]],
    [["close", "example", "--discard-output"], ["close"]],
    [["status", "example", "--refresh", "--json"], ["status"]],
    [["skill", "install", "--output", join(temporary, "skill")], ["skill", "install"]],
  ]) assert.equal(run([...args, "--help"]).stdout, run(["help", ...topic]).stdout);
  assert.deepEqual(await readdir(temporary), [], "Help must not create state, locks, or installed files");
});

test("guides keep complete text and the compatibility entry point", async () => {
  const index = run(["help", "guides"]).stdout;
  assert.equal(index, run(["guide"]).stdout);
  for (const topic of ["rental", "harnesses", "reth"]) {
    const source = await readFile(new URL(`../docs/${topic}.md`, import.meta.url), "utf8");
    assert.equal(run(["help", topic]).stdout, source + "\n");
    assert.equal(run(["guide", topic]).stdout, source + "\n");
  }
  const sections = index.split("\n").filter((line) => line.startsWith("  ")).map((line) => line.trim());
  assert.ok(sections.includes("harnesses/readiness"));
  for (const section of sections) assert.equal(run(["help", section]).stdout, run(["guide", section]).stdout);
  const readiness = run(["help", "harnesses/readiness"]).stdout;
  assert.match(readiness, /"result": "exit"/);
  assert.match(readiness, /backend retains payment, lease, and lifecycle ownership\./);
  assert.doesNotMatch(readiness, /## Reuse compiled artifacts/);
});

test("invalid help selectors fail rather than hiding typos behind the index", () => {
  for (const args of [
    ["help", "absent"], ["help", "plan", "extra"], ["help", "rental/nope"],
    ["help", "harnesses/"], ["help", "harnesses/readiness/extra"],
    ["help", "../package.json"], ["help", "constructor"],
    ["absent", "--help"], ["cache", "absent", "--help"], ["dataset", "absent", "-h"],
  ]) assert.match(run(args, 1).stderr, /Unknown help topic|Unknown guide section|Use fission guide/);
  const error = JSON.parse(run(["help", "absent", "--json"], 1).stderr);
  assert.equal(error.error.code, "FISSION_ERROR");
  assert.match(run(["plan"], 1).stderr, /run fission help plan/);
});

test("only help before the argv separator is local; bare fission still selects the TUI", () => {
  for (const args of [["exec", "missing"], ["run", "missing", "run0", "--duration", "1m"]]) {
    assert.equal(run([...args, "--help", "--", "program", "--help"]).stdout, run(["help", args[0]]).stdout);
    assert.match(run([...args, "--", "program", "--help"], 1).stderr, /No saved workspace named missing/);
  }
  const bare = run([], 1);
  assert.match(bare.stderr, /Open fission in an interactive terminal/);
  assert.equal(run(["ui"], 1).stderr, bare.stderr);
  assert.match(JSON.parse(run(["--json"], 1).stderr).error.message, /Use fission list --json/);
});

test("saved machine, job and budget JSON remain usable without requests", async () => {
  await mkdir(join(home, "example", "jobs"), { recursive: true });
  const state = { name: "example", provider: "compute-mpp", phase: "terminated", recipe: { name: "linux" }, remoteId: "fixture-vm", closedAt: "2026-09-14T12:42:33Z" };
  const job = { id: "run0", name: "example", phase: "succeeded", log: "/workspace/log", observation: { returncode: 0 } };
  const ledger = { version: 1, limit: "7", allocations: { example: "2.50" }, requests: {}, vmCaps: { default: "3" } };
  await writeFile(join(home, "example", "state.json"), JSON.stringify(state));
  await writeFile(join(home, "example", "jobs", "run0.json"), JSON.stringify(job));
  await writeFile(join(home, ".budget.json"), JSON.stringify(ledger));
  const listed = JSON.parse(run(["list", "--json"]).stdout);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].remoteId, "fixture-vm");
  assert.equal(listed[0].phase, "terminated");
  assert.deepEqual(JSON.parse(run(["status", "example", "--json"]).stdout), listed[0]);
  assert.deepEqual(JSON.parse(run(["jobs", "example"]).stdout), [job]);
  assert.deepEqual(JSON.parse(run(["job", "example", "run0"]).stdout), job);
  assert.deepEqual(JSON.parse(run(["wait", "example", "run0", "--duration", "1m", "--max-spend", "0"]).stdout), job);
  const budget = JSON.parse(run(["budget"]).stdout);
  assert.equal(budget.allocated, "2.500000");
  assert.equal(budget.availableToAllocate, "4.500000");
  assert.deepEqual(JSON.parse(await readFile(join(home, ".budget.json"), "utf8")), ledger);
});
