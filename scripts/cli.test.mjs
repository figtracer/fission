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
  for (const topic of ["rental", "harnesses", "reth", "workloads"]) {
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

test("workload IDs retrieve complete cards; filters preserve the existing capabilities envelope", async () => {
  const all = JSON.parse(run(["capabilities"]).stdout);
  const ids = all.workloads.map(({ id }) => id);
  assert.equal(new Set(ids).size, 13);
  const guideIds = run(["help", "guides"]).stdout.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("workloads/"));
  assert.deepEqual(ids, guideIds);
  const recipes = JSON.parse(run(["recipes"]).stdout).map(({ name }) => name);
  for (const item of all.workloads) {
    assert.ok(["validated", "unvalidated", "unavailable"].includes(item.status));
    for (const id of item.related) assert.ok(ids.includes(id), `${item.id} -> ${id}`);
    const card = run(["help", item.id]).stdout;
    assert.equal((card.match(/^## /gm) || []).length, 1);
    assert.match(card, /\]\(https:\/\//, "Each card must retain its source links");
    if (item.status === "unavailable") {
      assert.equal(item.recipe, null);
      assert.equal(item.profile, null);
      assert.match(card, /Unavailable/);
    } else {
      assert.ok(recipes.includes(item.recipe));
      assert.ok(Object.hasOwn(all.profiles, item.profile));
    }
    if (item.status === "validated") assert.match(item.evidence, /^\d{4}-\d{2}-\d{2}: /);
  }
  for (const [ecosystem, count] of [["foundry", 3], ["reth", 3], ["tempo", 3], ["base", 2], ["bsc", 2]]) {
    const selected = JSON.parse(run(["capabilities", ecosystem]).stdout);
    assert.equal(selected.workloads.length, count);
    assert.ok(selected.workloads.every((item) => item.ecosystem === ecosystem));
    for (const key of ["providers", "profiles", "units"]) assert.deepEqual(selected[key], all[key]);
  }
  assert.match(run(["capabilities", "other"], 1).stderr, /Unknown ecosystem/);
  assert.match(run(["capabilities", "base", "bsc"], 1).stderr, /Wrong arguments/);
  for (const ecosystem of ["base", "bsc"]) {
    const node = all.workloads.find(({ id }) => id === `workloads/${ecosystem}-node`);
    assert.equal(node.status, "unavailable", "Fork support must not imply a full-node recipe");
  }
});

test("symbolic preparation reuses Foundry and rejects incompatible planning before a request", async () => {
  const { recipe } = await import("../src/workspace.mjs");
  const ordinary = await recipe("foundry");
  const symbolic = await recipe("foundry-symbolic");
  assert.deepEqual(symbolic.prepare.slice(0, -1), ordinary.prepare);
  assert.deepEqual(symbolic.readiness, [...ordinary.readiness, ["/workspace/z3", "--version"]]);
  assert.notEqual(symbolic.digest, ordinary.digest);
  assert.deepEqual(symbolic.artifacts, ["/workspace/symbolic-tools.json"]);
  assert.equal(symbolic.afterCheckout, undefined, "Prebuilt tools must not require a source build");
  const profile = JSON.parse(run(["capabilities", "foundry"]).stdout).profiles["foundry-symbolic"];
  assert.deepEqual(profile, { os: "linux", kind: "vm", architecture: "x86_64" });
  for (const [flag, value] of [["profile", "runtime"], ["arch", "aarch64"], ["kind", "sandbox"], ["os", "darwin"]])
    assert.match(run(["plan", "symbolic", "--recipe", "foundry-symbolic", `--${flag}`, value], 1).stderr, /matching profile|conflicts with the profile/);
  assert.match(run(["open", "symbolic", "--recipe", "foundry-symbolic"], 1).stderr, /requires a saved Linux x86_64 VM plan/);
  const guard = spawnSync("python3", ["-c", `
import io, runpy
from unittest.mock import patch
module = runpy.run_path(${JSON.stringify(fileURLToPath(new URL("../harness/foundry-symbolic.py", import.meta.url)))})
for system, machine, libc, message in [('Darwin', 'x86_64', ('glibc', '2.39'), 'requires Linux'), ('Linux', 'aarch64', ('glibc', '2.39'), 'requires Linux'), ('Linux', 'x86_64', ('glibc', '2.38'), 'requires Linux'), ('Linux', 'x86_64', ('glibc', '2.39'), 'digest mismatch')]:
    with patch('platform.system', return_value=system), patch('platform.machine', return_value=machine), patch('platform.libc_ver', return_value=libc), patch('urllib.request.urlopen', return_value=io.BytesIO(b'corrupt archive')) as request:
        try:
            module['main']()
        except RuntimeError as error:
            assert message in str(error), str(error)
        else:
            raise AssertionError('unsafe preparation accepted')
        assert request.call_count == (1 if message == 'digest mismatch' else 0)
`], { encoding: "utf8", timeout: 10000 });
  assert.equal(guard.error, undefined);
  assert.equal(guard.status, 0, guard.stderr);
});
