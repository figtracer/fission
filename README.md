# Fission

Run a bounded build or test on a suitable temporary Linux machine, within an explicit budget.

[Harnesses](docs/harnesses.md) · [Workload guidance](docs/workloads.md) · [Rental safety](docs/rental.md) · [Synced Ethereum](docs/reth.md) · [Installation](docs/install.md)

Fission takes a task, source or inputs, workload argv, budget, and authorized duration. It quotes compatible MPP compute, prepares and checks the environment, runs the workload, collects hash-verified evidence, writes a local report, and requests confirmed cleanup. The coding agent stays local; no LLM runs on the guest.

Fission is an early independent tool, not an official Tempo, Foundry, or Reth service. Previewing can request live quotes but pays nothing. An approved run can spend the stated USDC.e allocation, and early deletion does not imply a refund.

## Choose a harness

| Harness | Use it for | Modes |
| --- | --- | --- |
| Foundry | Forge/Cast tests, fuzzing, invariants, bounded symbolic work, changed Foundry source | `tools`, `test`, `build` |
| Reth | Isolated development-chain work, selected source tests, release builds, paired Ethereum sync | `dev`, `test`, `build`, `synced` |
| Tempo | Isolated node transactions, Foundry's Tempo contract model, source tests and builds | `dev`, `tools`, `test`, `build` |
| Linux | Ordinary Linux x86_64 work that does not fit an ecosystem harness | `tools` |

Start with `fission help run HARNESS`. For a specific question, `fission help index WORDS` searches a small revision-pinned capability index and points to the canonical guide. It is reviewed manually, not an automatically refreshed copy of upstream source.

## One managed run

The normal flow is preview, approve, observe, and inspect the result:

```sh
# 1. Preview. This quotes and checks policy, but submits no payment.
fission run check-a --harness foundry --budget AMOUNT --duration 2h \
  --work-duration 10m --region ams --input ./check.sh \
  --artifact /workspace/result.json -- bash /workspace/check.sh

# 2. Review the machine, quote, allocation, timing basis, and uncertainty.
# Then repeat the identical command with --approve inside existing authorization.
fission run check-a --harness foundry --budget AMOUNT --duration 2h \
  --work-duration 10m --region ams --input ./check.sh \
  --artifact /workspace/result.json --approve -- bash /workspace/check.sh

# 3. Observe the durable owner. Waiting locally does not extend the task.
fission status check-a --wait 10m

# 4. Cancel early when the partial result is no longer useful.
fission stop check-a
fission status check-a --wait 10m
```

`status` returns outcome, jobs, observed cost, evidence paths and hashes, report path, and cleanup state. After local sleep, reboot, or owner interruption, `fission status NAME --resume` resumes observation of the same recorded purchase and submission; it never buys a replacement. Keep using status until cleanup is confirmed—timeout, provider `404`, or guest shutdown alone is not proof of destruction.

Automatic selection retains compatible alternatives from the quoted shortlist, cheapest first. Before payment, a failed quote or changed capacity can select another retained machine within the task creation cap, preserving lifecycle headroom, resources, region and duration. There is no percentage premium limit. The preview exposes alternatives and failures; an uncertain purchase never triggers a second rental. Current VM offers still share one gateway, so this does not yet protect against a gateway-wide outage.

Use `--machine ID` when a reproducible comparison or qualification run requires one exact catalog machine. Exact selection has no alternative-machine fallback.

During public alpha, automatic starter resizing supports targets up to 4 vCPU and 8 GiB RAM. Larger short tasks require `--no-resize`, which provisions the selected machine directly for at least one prepaid day while preserving the shorter task deadline.

Bare `fission` opens the Rust task dashboard. Click a task to inspect it. Inside `fission advanced tmux`, **SSH terminal** opens a small popup while the dashboard keeps refreshing; a plain dashboard uses fullscreen SSH and resumes refresh after the shell exits. Stopping requires a second confirmation: provider cleanup may lose guest files that were not collected, but local task/experiment folders, collected evidence and reports, and caches already saved by successful builds remain. Other experiment machines keep running.

Tasks appear in outcome order: **Succeeded**, **Active**, **Unsuccessful**, then dimmed **Unresolved**. Experiments stay together under their combined outcome; success with unconfirmed cleanup stays unresolved. **Closed history** is collapsed under all records. `[advanced]` identifies old unfinished workspaces without a task supervisor; normal runs need no “managed” label. List order is presentation, not spending or cleanup authority.

Press `q` twice consecutively to quit the dashboard, not the task. The first press shows a confirmation cue; another key or an actionable mouse event cancels it. Ready and finished transitions emit a dashboard-local bell and visible cue, not an external notification.

In **Available**, `b` cycles between within-budget VM offers, all VM prices, and **Gateways**. Only usable gateways appear; details show the compute operator, pricing units and supported scope. The view is read-only and remains available when live VM discovery fails. Sandbox-per-call prices are not comparable to VM-per-day prices. Unavailable candidates stay in [gateway qualification](docs/rental.md#gateway-qualification), not the dashboard.

`run`, `status`, `stop`, `help`, and `budget` are the normal interface. Manual lifecycle, jobs, transfers, storage, cache, dataset, SSH, and recovery commands are intentionally secondary under `fission advanced`.

## Test or build source

Use a public GitHub repository and an exact 40-character commit. `test` prepares the checkout, Rust toolchain, and native dependencies, then runs your argv in `/workspace/source`; it does **not** compile release binaries first. Selected Cargo dependency and test compilation consumes the requested work time.

```sh
fission run reth-network-tests --harness reth --mode test \
  --repo https://github.com/paradigmxyz/reth \
  --ref FULL_40_CHARACTER_SHA --budget AMOUNT --duration 3h \
  --work-duration 1h --region ams -- \
  /workspace/cargo test --locked -p reth-network --lib transactions::fetcher::tests
```

Use `--patch ./change.patch` to apply one `git diff --binary HEAD` before testing or building. Use `build` only when the result requires release binaries. Build mode checks existing release-binary caches before quoting, verifies exact source/toolchain/CPU/native-package identity on the guest, and falls back to a cold build on a legitimate mismatch. Caches can live locally, on mounted storage, or on an explicitly initialized retained Fission VPS; see [harness storage](docs/harnesses.md#vps-backed-build-cache). They are not Cargo target or incremental caches and do not accelerate source-test compilation.

## Multiple machines

Explicit paired or comparative work uses one manifest. Each role is still an ordinary managed task with its own budget, supervisor, evidence, report, and cleanup:

```json
{
  "schemaVersion": 1,
  "machines": [
    {
      "name": "tests",
      "harness": "reth",
      "mode": "test",
      "repo": "https://github.com/paradigmxyz/reth",
      "ref": "FULL_40_CHARACTER_SHA",
      "budget": "1.25",
      "duration": "3h",
      "work-duration": "1h",
      "region": "ams",
      "command": ["/workspace/cargo", "test", "--locked", "-p", "reth-network", "--lib"]
    },
    {
      "name": "build",
      "harness": "reth",
      "mode": "build",
      "repo": "https://github.com/paradigmxyz/reth",
      "ref": "FULL_40_CHARACTER_SHA",
      "budget": "1.25",
      "duration": "3h",
      "work-duration": "10m",
      "prepare-duration": "90m",
      "region": "ams",
      "command": ["/workspace/reth", "--version"]
    }
  ]
}
```

```sh
fission run reth-pair --from ./reth-pair.json --budget 2.50
fission run reth-pair --from ./reth-pair.json --budget 2.50 --approve
fission status reth-pair --wait 10m
fission stop reth-pair
```

Preview validates every role, quotes every machine, and checks the summed allocation before any purchase. Approval accepts the listed set, but purchases are sequential rather than atomic. A stop arriving during creation waits for the approved prepaid purchase sequence to settle, then cancels every purchased member. Missing roles remain `not_purchased`; Fission never buys an automatic replacement. The manifest does not implicitly wire networks, synchronize clocks, share databases, or make benchmark conditions comparable.

## Command guide

| Command | Purpose |
| --- | --- |
| `fission` | Open the local Rust dashboard |
| `fission run NAME … -- CMD` | Preview or approve one managed task |
| `fission status [NAME]` | Read progress, outcome, evidence, cost, and cleanup |
| `fission status NAME --resume` | Restore a missing local supervisor without replaying remote effects |
| `fission stop NAME` | Record cancellation, collect available evidence, and clean up |
| `fission budget` | Inspect retained authorization and allocations |
| `fission help run HARNESS` | Read scoped syntax and ecosystem behavior |
| `fission help index WORDS` | Search revision-pinned capability guidance |
| `fission advanced COMMAND` | Explicit low-level recovery and retained-data operations |

All normal command output is JSON. Flags before `--` configure Fission; everything after `--` is workload argv and is passed without shell reinterpretation. `FISSION_HOME` selects the durable local state, ledger, receipts, and default cache. Never point a new run at a disposable state directory to bypass retained allocations or unresolved requests.

Read [harness selection and source/cache behavior](docs/harnesses.md), [rental and recovery safety](docs/rental.md), and the [synced Ethereum guide](docs/reth.md) before those workflows.

## Installation and development

Releases are paused. Install from a reviewed local source checkout using Node.js 22.13 or newer, Rust for the native dashboard, and SSH:

```sh
npm install
npm run setup
fission help
```

Development tests use an external fixture directory so funded state, credentials, and experiment evidence do not enter the repository:

```sh
FISSION_TEST_DIR=/absolute/path/to/verification npm test
CARGO_NET_OFFLINE=true npm run build
```

See [installation](docs/install.md) for the current source-first workflow. Do not publish, tag, or bump the package while the release pause remains in effect.
