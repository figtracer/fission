# Harnesses

Every harness uses the same managed contract:

```sh
fission run NAME --harness HARNESS --mode MODE --budget AMOUNT \
  --duration TOTAL --work-duration WORK --region REGION [OPTIONS] -- ARGV
```

Without `--approve`, this is a non-paying preview. The approved run prepares and checks the selected environment, runs argv without shell reinterpretation, exports declared evidence, reports, and cleans up. Defaults are the first listed mode: Foundry `tools`, Reth `dev`, Tempo `dev`, and Linux `tools`.

TOTAL must cover 30m provisioning + preparation (10m prebuilt, 1h build, or 4h synced) + WORK + 15m cleanup. These allowances are estimates, not guarantees; the preview carries dated evidence and uncertainty. `--prepare-duration` can raise, never lower, preparation time.

## Foundry

Modes: `tools` for pinned Forge/Cast contract work; `build` for a changed Foundry revision. Add `--solver z3` to tools for bounded symbolic properties. A symbolic `pass` is bounded by reported assumptions/model; accept a violation only with replay-confirmed counterexample; timeout, unsupported behavior, all-revert paths, solver errors, and zero meaningful exploration are incomplete.

For fuzz/invariant work, preserve test names, seed, run/depth counts, reverts/discards, selector metrics, config, compiler, and logs. No failure found is not proof, and a campaign with no successful handler calls is vacuous. For forks, pin endpoint block/hash and execution model; RPC state is trusted input. Foundry's Ethereum simulation does not implement BSC consensus/native precompiles, and a Base fork does not validate sequencing, derivation, bridge finality, or consensus.

Build a changed revision with a public GitHub repository and exact commit:

```sh
fission run forge-change --harness foundry --mode build --repo https://github.com/OWNER/REPO \
  --ref FULL_40_CHARACTER_SHA --patch ./change.patch --budget AMOUNT \
  --duration 2h --work-duration 10m --region ams -- /workspace/cargo test --locked -p PACKAGE TEST
```

Generate the patch with `git diff --binary HEAD`, including lockfile changes (new files must be tracked or intent-to-add). The patch must be nonempty and is applied once before `/workspace/build`. Readiness checks the exact working-tree hash and compiled binaries, including a patched tree; reusable caches still require clean source. The workload runs in `/workspace/source` by default. Build mode preserves build provenance; it does not establish runtime correctness.

Submodule worktrees must stay clean: provenance records their commits, not uncommitted dependency files. A parent-repository patch cannot carry those files. Commit dependency changes and pin their gitlinks rather than silently testing an unidentified dependency tree.

## Reth

Modes: `dev` for the isolated pinned development chain, `build` for a changed Reth revision, and `synced` for Ethereum mainnet paired with Lighthouse. Only `--chain ethereum` is implemented; Base-Reth and Reth-BSC are unavailable.

For dev, record client version, genesis hash, chain ID, transactions/receipts, nonces and before/after state. Both bundled dev chains use chain ID 1337, so chain ID alone is insufficient. Reth dev mines on transactions; an idle head need not advance. Compilation proves neither sync nor consensus.

Synced mode requires the canonical manifest and full planner JSON, a separately verified recent checkpoint root/epoch and HTTPS URL, explicit head-age bound, and extra disk allowance. Read [reth.md](reth.md); the managed run performs import, startup, readiness and cleanup.

## Tempo

Modes: `dev` for an isolated Tempo node, `tools` for Foundry's Tempo contract model, and `build` for a changed Tempo revision. Tools mode is simulation, not a Tempo node or transaction-envelope/consensus test.

For dev transactions, inspect TIP-20 balances and the receipt's actual fee token/payer; `eth_getBalance` in the pinned development client is a compatibility placeholder. Require the intended raw/receipt transaction type, inclusion, nonce lane, state deltas, and fee-transfer evidence. An estimation error is not an included revert. Keep development keys isolated and out of persisted argv. A development chainspec may expose behavior absent from public networks.

For contract-model tests, pin `network = "tempo"` and the intended `tempo:...` hardfork in `foundry.toml`, inspect resolved config, and include negative controls: successful empty returndata can be an empty account, not implemented behavior.

## Linux

Use `--harness linux` only for ordinary Linux x86_64 shell/Python work outside the three ecosystems. It provides tools readiness, not a blockchain node. Request a shell explicitly in argv when shell syntax is needed.

## Inputs and outputs

`--input LOCAL[=/workspace/PATH]` uploads one regular file and is repeatable; directories are never implicit. The input is fingerprinted at preview and must not change before upload. `--artifact /workspace/FILE` collects a regular file and is repeatable; databases are not artifacts. `--cwd` must be an absolute guest directory. Keep secrets out of all persisted material.

Retained build caches and Reth datasets are optional advanced recovery operations. Inspect compatibility, local capacity, transfer time, remaining lease, and stopped writers before `fission advanced cache ...` or `fission advanced dataset ...`. A same-machine cache result does not establish cross-rental compatibility.
