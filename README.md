# Fission

Run a bounded build or test on a suitable temporary Linux machine, within an explicit budget.

Fission takes a task, source or inputs, workload argv, budget, and authorized duration. It quotes compatible MPP compute, prepares and checks the environment, runs the workload, collects hash-verified evidence, writes a local report, and requests confirmed cleanup. The coding agent stays local; no LLM runs on the guest.

Fission is an early independent tool, not an official Tempo, Foundry, or Reth service. A preview can request live quotes but pays nothing. An approved run can spend its stated USDC.e allocation.

## Choose a harness

| Harness | Use it for | Modes |
| --- | --- | --- |
| Foundry | Forge/Cast tests, fuzzing, invariants, bounded symbolic work, changed Foundry source | `tools`, `test`, `build` |
| Reth | Ethereum development/source/sync work, plus Base source and managed mainnet sync | `dev`, `test`, `build`, `synced` |
| Tempo | Isolated node transactions, Foundry's Tempo contract model, source tests and builds | `dev`, `tools`, `test`, `build` |
| Linux | Ordinary Linux x86_64 work that does not fit an ecosystem harness | `tools` |

Start with `fission help run HARNESS`. Use `fission help index WORDS` to find revision-pinned workload guidance.

## One managed run

The normal flow is preview, approve, observe, and inspect the result:

```sh
# 1. Preview. This quotes and checks policy, but submits no payment.
fission run check-a --harness foundry --budget AMOUNT --duration 2h \
  --work-duration 10m --region ams --input ./check.sh \
  --artifact /workspace/result.json -- bash /workspace/check.sh

# 2. Review the preview, then repeat it unchanged with --approve.
fission run check-a --harness foundry --budget AMOUNT --duration 2h \
  --work-duration 10m --region ams --input ./check.sh \
  --artifact /workspace/result.json --approve -- bash /workspace/check.sh

# 3. Observe the durable owner. Waiting locally does not extend the task.
fission status check-a --wait 10m

# 4. Cancel early when the partial result is no longer useful.
fission stop check-a
fission status check-a --wait 10m
```

`status` reports progress, outcome, cost, evidence, and cleanup. After a local interruption, `fission status NAME --resume` resumes the same recorded task without buying or submitting it again. Continue until provider cleanup is confirmed.

Bare `fission` opens the local dashboard. The normal CLI is `run`, `status`, `stop`, `budget`, and `help`; manual lifecycle, transfer, storage, cache, dataset, SSH, and recovery operations live under `fission advanced`.

## Test or build source

Use a public GitHub repository and an exact 40-character commit. `test` prepares source and runs the selected Cargo tests; `build` produces release binaries.

```sh
fission run reth-network-tests --harness reth --mode test \
  --repo https://github.com/paradigmxyz/reth \
  --ref FULL_40_CHARACTER_SHA --budget AMOUNT --duration 3h \
  --work-duration 1h --region ams -- \
  /workspace/cargo test --locked -p reth-network --lib transactions::fetcher::tests
```

Use `--patch ./change.patch` to apply one `git diff --binary HEAD` before testing or building. Clean release builds can use exact-identity caches stored locally, on mounted storage, or on an explicitly retained cache VPS. See [source tests, builds, and caches](docs/harnesses.md#source-tests-and-builds).

### Base Reth

Use `--chain base` with `test` or `build` for pinned [Base](https://github.com/base/base) source. Base `synced` preview validates an official content-pinned full snapshot plan, computes the multi-terabyte disk requirement, and requires credential-free Ethereum L1 execution and beacon origins. An approved run manages Base execution and rollup consensus together using the signed pinned unified binary and gates work on coherent, advancing unsafe and derived-safe state.

Base source and synced contracts are fixture/local validated; a paid full snapshot restore and catch-up has not been run. Resource adequacy, restore duration, live sync, bridge finality, and production readiness are therefore unqualified. Base development mode and BSC are not supported. See [Synced Ethereum and Base](docs/reth.md#base-mainnet).

## Multiple machines

Explicit paired or comparative work uses one JSON manifest. Each role remains an ordinary managed task with its own budget, supervisor, evidence, report, and cleanup:

```sh
fission run reth-pair --from ./reth-pair.json --budget 2.50
fission run reth-pair --from ./reth-pair.json --budget 2.50 --approve
fission status reth-pair --wait 10m
fission stop reth-pair
```

The complete schema and partial-purchase behavior are in [Multiple machines](docs/harnesses.md#multiple-machines).

## Documentation

- `fission help` is the command reference.
- [Harnesses](docs/harnesses.md) covers modes, source runs, caching, evidence, and multi-machine manifests.
- [Workload guidance](docs/workloads.md) explains the revision-pinned taxonomy.
- [Rental safety](docs/rental.md) covers authorization, lifecycle, and recovery.
- [Synced Ethereum and Base](docs/reth.md) covers snapshot inputs, dependencies, and readiness.
- [Installation](docs/install.md) covers the current source-first setup.

## Installation

Releases are paused. Install from a reviewed local source checkout using Node.js 22.13 or newer, Rust for the native dashboard, and SSH:

```sh
npm install
npm run setup
fission help
```

See [installation](docs/install.md) for requirements and the current release status.
