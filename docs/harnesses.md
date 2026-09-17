# Harnesses

Every harness uses the same managed contract:

```sh
fission run NAME --harness HARNESS --mode MODE --budget AMOUNT \
  --duration TOTAL --work-duration WORK --region REGION [OPTIONS] -- ARGV
```

Without `--approve`, this is a non-paying preview. The approved run prepares and checks the selected environment, runs argv without shell reinterpretation, exports declared evidence, reports, and cleans up. Defaults are the first listed mode: Foundry `tools`, Reth `dev`, Tempo `dev`, and Linux `tools`.

TOTAL must cover 30m provisioning + preparation (10m prebuilt, 1h source, or 4h synced) + WORK + 15m cleanup. These allowances are estimates, not guarantees; the preview carries dated evidence and uncertainty. `--prepare-duration` can raise, never lower, preparation time. Multi-day durations are allowed when the provider quotes a sufficient lease and the user authorizes its cost and duration.

## Foundry

Modes: `tools` for pinned Forge/Cast contract work; `test` for testing changed Foundry crates; `build` when release binaries are needed. **Foundry-only option:** `--solver z3` adds the pinned solver to tools mode. It is absent from generic run help and rejected for other harnesses. A symbolic `pass` is bounded by reported assumptions/model; accept a violation only with replay-confirmed counterexample; timeout, unsupported behavior, all-revert paths, solver errors, and zero meaningful exploration are incomplete.

For fuzz/invariant work, preserve test names, seed, run/depth counts, reverts/discards, selector metrics, config, compiler, and logs. No failure found is not proof, and a campaign with no successful handler calls is vacuous. For forks, pin endpoint block/hash and execution model; RPC state is trusted input. Foundry's Ethereum simulation does not implement BSC consensus/native precompiles, and a Base fork does not validate sequencing, derivation, bridge finality, or consensus.

## Source tests and builds

Use `test` for Cargo tests or benchmarks in Foundry, Ethereum/Base Reth or Tempo. It prepares the pinned checkout, toolchain and native dependencies, then executes your command directly: **no release build before tests**. Cargo's selected dependency/test compilation consumes WORK time. Assert a nonzero number of intended tests passed; Cargo can exit successfully when a filter matches nothing.

Test a changed revision with a public GitHub repository and exact commit:

```sh
fission run forge-change --harness foundry --mode test --repo https://github.com/OWNER/REPO \
  --ref FULL_40_CHARACTER_SHA --patch ./change.patch --budget AMOUNT \
  --duration 3h --work-duration 1h --region ams -- /workspace/cargo test --locked -p PACKAGE TEST
```

Generate the patch with `git diff --binary HEAD`, including lockfile changes (new files must be tracked or intent-to-add). The patch must be nonempty and is applied once before testing/building. Test readiness checks the prepared source identity, including the patch. Build readiness additionally verifies compiled binaries. The workload runs in `/workspace/source` by default. Neither preparation nor compilation establishes runtime correctness.

Source runs inspect the selected local, mounted, or VPS-backed cache before quoting. Build mode can restore a hash-verified release-binary archive and skip compilation only when source tree, lockfile, submodules, toolchain, CPU flags, OS, native packages and harness identity match exactly on the guest. A candidate is not yet a hit. Incompatibility records a miss and falls back to a cold build; corrupt archives fail preparation. Clean successful builds save a cache after normal evidence, if capacity and the cleanup cutoff permit. Interrupted saves are not replayed. Patched builds are not reusable caches.

Storage defaults to `$FISSION_HOME/.cache/builds`; set `FISSION_STORAGE_DIR` to an existing local or mounted directory before running. Local files outlive the rental but are not cloud backups. Only trust your own cache directory: hashes establish integrity, not authenticity. These caches contain release binaries and provenance, **not Cargo target directories**; they do not accelerate test compilation or arbitrary revisions. The preview never claims that they do. Cross-rental hit rate depends on exact environmental compatibility; cache transfers are not assumed faster than builds.

### VPS-backed build cache

A separately rented Fission VPS can retain exact release-binary caches without keeping the persistent copy on the controller. Provision it through the existing advanced plan/open lifecycle, wait for its Linux bootstrap to become ready, then initialize its fixed cache namespace:

```sh
fission advanced plan build-cache --recipe linux --cheapest --kind vm \
  --region REGION --disk DISK_GIB --duration 7d --budget AMOUNT
fission advanced open build-cache --plan PLAN_ID --approve
fission advanced wait build-cache bootstrap --duration 10m --max-spend AMOUNT
fission advanced cache init build-cache
fission advanced cache list --cache-workspace build-cache
```

Use it only for a clean source build, with an explicit compressed-and-expanded transfer bound:

```sh
fission run BUILD_NAME --harness reth --mode build \
  --repo https://github.com/paradigmxyz/reth --ref FULL_40_CHARACTER_SHA \
  --cache-workspace build-cache --cache-max-bytes BYTES \
  --budget AMOUNT --duration TOTAL --work-duration WORK --region REGION -- COMMAND
```

Preview verifies the selected host identity, reachability, metadata, and observed lease coverage before buying the workload. A matching archive is staged temporarily through the controller, hash-checked before guest use, and removed after upload; successful clean builds publish back through bounded staging. Host failure never buys a replacement or silently falls back to persistent local custody. Cache-save failure is separate from workload success and cannot delay workload cleanup.

The cache exists only until that VPS is closed, expires, or loses its disk. There is no automatic renewal, replication, snapshot, migration, encryption-at-rest guarantee, cloud-backup claim, or zero-local-disk transfer path. Hashes establish integrity, not trust in a compromised host. Review `cache list` before closing; a designated cache host requires explicit `fission advanced close build-cache --discard-output`, which destroys the remote cache with the VPS.

Submodule worktrees must stay clean: provenance records their commits, not uncommitted dependency files. A parent-repository patch cannot carry those files. Commit dependency changes and pin their gitlinks rather than silently testing an unidentified dependency tree.

## Reth

Modes: `dev` for the isolated pinned Ethereum development chain, `test` for selected source tests/benchmarks without a node build, `build` for release-profile binaries, and `synced` for a managed mainnet node. Omitted `--chain` means `ethereum` and preserves all four modes. `--chain base` supports `test`, `build`, and `synced`; Base `dev` and Reth-BSC are unavailable.

Base source mode uses a pinned public checkout such as the authoritative `https://github.com/base/base` repository. Public forks are accepted when explicitly pinned. It installs the shared Rust 1.96.1 source environment and Base's native dependencies. Build mode runs locked Cargo release compilation for the `base-reth-node` binary; this is Fission's ordinary `release` profile, not Base's published max-performance profile. The inherited 8 vCPU, 32 GiB RAM and 200 GiB disk floors are planning defaults, not measured Base requirements; current short public-alpha runs require `--no-resize` at that size.

For example, a source test can execute `/workspace/cargo test --locked -p base-execution-cli --lib tests::parse_dev -- --exact`, then confirm that one intended test ran. This checks Base's CLI/dev-chain parser in source; it does not start or validate a Base node. A build can invoke any bounded workload after Fission has produced and verified `/workspace/base-reth-node`.

Base `dev` remains unavailable. A standalone execution client in development mode does not provide Base rollup consensus, L1 derivation or bridge/finality behavior. Base `synced` uses the signed, pinned unified Base binary to manage execution and rollup consensus together, restores a content-pinned full snapshot, verifies the operator's Ethereum execution/beacon dependencies, and gates work on coherent advancing unsafe and derived-safe state. Do not label Base source tests, compilation, a standalone dev process or a Base fork simulation as Base node or consensus validation.

Transaction-fetcher/gossip unit and local-peer integration tests need no Ethereum snapshot. Synced public-peer performance is a different experiment: prepare comparable baseline/candidate nodes, wait for paired readiness and peer warm-up, and retain raw metrics. A two-machine manifest does not automatically supply peer wiring, compatible databases or statistical comparability.

For Ethereum dev, record client version, genesis hash, chain ID, transactions/receipts, nonces and before/after state. Both bundled dev chains use chain ID 1337, so chain ID alone is insufficient. Reth dev mines on transactions; an idle head need not advance. Compilation proves neither sync nor consensus.

Ethereum synced mode requires the canonical manifest and full planner JSON, a separately verified recent checkpoint root/epoch and HTTPS URL, explicit head-age bound, and extra disk allowance. Base synced mode instead requires a pinned Base manifest URL/local file, its canonical full plan, credential-free operator L1 endpoints and explicit unsafe/safe/L1 freshness and lag bounds. Read [reth.md](reth.md); the managed run performs import, startup, readiness and cleanup.

## Tempo

Modes: `dev` for an isolated Tempo node, `tools` for Foundry's Tempo contract model, `test` for changed source tests/benchmarks, and `build` for release binaries. Tools mode is simulation, not a Tempo node or transaction-envelope/consensus test.

For dev transactions, inspect TIP-20 balances and the receipt's actual fee token/payer; `eth_getBalance` in the pinned development client is a compatibility placeholder. Require the intended raw/receipt transaction type, inclusion, nonce lane, state deltas, and fee-transfer evidence. An estimation error is not an included revert. Keep development keys isolated and out of persisted argv. A development chainspec may expose behavior absent from public networks.

For contract-model tests, pin `network = "tempo"` and the intended `tempo:...` hardfork in `foundry.toml`, inspect resolved config, and include negative controls: successful empty returndata can be an empty account, not implemented behavior.

## Linux

Use `--harness linux` only for ordinary Linux x86_64 shell/Python work outside the three ecosystems. It provides tools readiness, not a blockchain node. Request a shell explicitly in argv when shell syntax is needed.

## Inputs and outputs

`--input LOCAL[=/workspace/PATH]` uploads one regular file and is repeatable; directories are never implicit. The input is fingerprinted at preview and must not change before upload. `--artifact /workspace/FILE` collects a regular file and is repeatable; databases are not artifacts. `--cwd` must be an absolute guest directory. Keep secrets out of all persisted material.

Work success and evidence completeness are distinct: inspect every export's `collected`, `partial` or `not_collected` phase. Cleanup remains mandatory even when export fails. Collected files are size/SHA-256 verified locally and copied into the report directory.

Manual cache and Reth dataset operations remain advanced recovery. Inspect compatibility, local or cache-VPS capacity, transfer time, remaining lease, and stopped writers before `fission advanced cache ...` or `fission advanced dataset ...`. Dataset storage remains local/mounted only.

## Multiple machines

Use `fission run NAME --from FILE --budget TOTAL` for an explicitly chosen set of machines. The JSON file has `schemaVersion: 1` and `machines`, each with a role `name`, normal run options using their CLI spelling, and `command` argv. Per-role budgets sum within TOTAL and the retained ledger. There is no fixed machine-count ceiling. Preview quotes every role before any payment; `--approve` accepts the entire listed set.

Each role becomes `NAME-ROLE`, with its own supervisor, evidence and confirmed cleanup. `status`, `stop` and `status --resume` accept either name. Purchases are sequential and cannot be atomic: if a later purchase fails, previously started tasks remain supervised and missing roles are reported. A group stop requested during creation waits for that approved prepaid purchase sequence to finish, then cancels every purchased member; it releases the creation lock before waiting on child operations. No restart or replacement is purchased. Stop the experiment if partial results are not useful. Separate machines are independently prepared; coordinating network services or synchronizing measurements belongs in the explicitly supplied experiment, not an implicit general-purpose cluster manager.

### Seeded campaign expansion

For independent seeded fuzz workers, compile one local campaign declaration into the
ordinary manifest above before previewing a rental:

```json
{
  "schemaVersion": 1,
  "kind": "campaign",
  "workers": 4,
  "baseSeed": "1000",
  "seedStride": "1",
  "budget": "2.000000",
  "template": {
    "harness": "foundry",
    "budget": "0.500000",
    "duration": "2h",
    "work-duration": "10m",
    "region": "ams",
    "input": ["./fuzz.sh=/workspace/fuzz.sh"],
    "artifact": ["/workspace/result.json"],
    "command": ["bash", "/workspace/fuzz.sh", "{{seed}}", "{{workerIndex}}", "{{workerCount}}"]
  }
}
```

```sh
fission campaign expand campaign.json --output workers.json
fission run fuzz-campaign --from workers.json --budget 2.000000
```

Expansion is local, deterministic, and makes no quote, ledger, or provider request.
It produces `worker-0` through `worker-N`, with `seed = baseSeed + index × seedStride`.
Only whole command arguments `{{seed}}`, `{{workerIndex}}`, and `{{workerCount}}` are
substituted; paths are resolved relative to the campaign declaration. Inspect the
generated ordinary manifest before its normal non-paying `run` preview. This is not a
distributed fuzzer: corpus sharing, result reduction, and finding deduplication remain
explicit workload responsibilities.
