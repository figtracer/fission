import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, beforeEach, test } from "node:test";

const home = await mkdtemp(join(tmpdir(), "fission-budget-test-"));
const file = join(home, ".budget.json");
const original = {
  version: 1, limit: "7.50", allocations: { closed: "2.10", unknown: "4.75" },
  requests: { ambiguous: { name: "unknown", operation: "create", maximum: "4.50" } },
  vmCaps: { default: "5", "reth-source": "4" },
  authorizationAmendments: [{ id: "earlier", previousLimit: "5", limit: "7.50" }],
};
beforeEach(() => writeFile(file, JSON.stringify(original)));
after(() => rm(home, { recursive: true, force: true }));

function run(args, status = 0) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../src/cli.mjs", import.meta.url)), "budget", ...args], {
    env: { ...process.env, FISSION_HOME: home, FISSION_TEMPO: join(home, "no-tempo") }, encoding: "utf8", timeout: 10000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, status, result.stderr);
  assert.equal(status === 0 ? result.stderr : result.stdout, "");
  return JSON.parse(status === 0 ? result.stdout : result.stderr);
}

test("a new authorized ceiling appends evidence and preserves closed and unknown liabilities", async () => {
  const summary = run(["--raise-to", "8.25", "--approval", "Gustavo authorized another 0.75 for the fixture", "--approve"]);
  const saved = JSON.parse(await readFile(file, "utf8"));
  const { allocations, requests, vmCaps } = original;
  assert.deepEqual({ ...saved, limit: original.limit, authorizationAmendments: original.authorizationAmendments }, original);
  assert.equal(summary.limit, "8.25");
  assert.equal(summary.allocated, "6.850000");
  assert.equal(summary.availableToAllocate, "1.400000");
  assert.equal(summary.reserved, "4.500000");
  assert.equal(saved.authorizationAmendments.length, 2);
  assert.deepEqual(saved.authorizationAmendments[0], original.authorizationAmendments[0]);
  const amendment = saved.authorizationAmendments[1];
  assert.equal(amendment.previousLimit, "7.50");
  assert.equal(amendment.limit, "8.25");
  assert.equal(amendment.approvedIncrease, "0.750000");
  assert.match(amendment.userResponse, /authorized another 0.75/);
  assert.ok(Number.isFinite(Date.parse(amendment.recordedAt)));
  assert.equal(amendment.preservedHistorySha256, createHash("sha256").update(JSON.stringify({ allocations, requests, vmCaps })).digest("hex"));
  assert.deepEqual(run([]).authorizationAmendments, saved.authorizationAmendments);
  const beforeReplay = await readFile(file, "utf8");
  run(["--raise-to", "8.25", "--approval", amendment.userResponse, "--approve"], 1);
  assert.equal(await readFile(file, "utf8"), beforeReplay);
});

test("missing authorization, invalid ceilings and mixed mutations leave the ledger byte-identical", async () => {
  const before = await readFile(file, "utf8");
  for (const args of [
    ["--raise-to", "8", "--approval", "approved"],
    ["--raise-to", "8", "--approve"],
    ["--raise-to", "8", "--approval", "   ", "--approve"],
    ["--raise-to", "7.5", "--approval", "approved", "--approve"],
    ["--raise-to", "7.49", "--approval", "approved", "--approve"],
    ["--raise-to", "NaN", "--approval", "approved", "--approve"],
    ["--raise-to", "8", "--approval", "approved", "--approve", "--total-spend", "9"],
    ["--raise-to", "8", "--approval", "approved", "--approve", "--vm-max-spend", "6"],
    ["--total-spend", "8", "--approve"],
    ["--approval", "approved", "--approve"],
  ]) {
    assert.equal(run(args, 1).error.code, "FISSION_ERROR");
    assert.equal(await readFile(file, "utf8"), before, args.join(" "));
  }
  await rm(file);
  assert.match(run(["--raise-to", "8", "--approval", "approved", "--approve"], 1).error.message, /Initialize/);
  await assert.rejects(readFile(file), { code: "ENOENT" });
});
