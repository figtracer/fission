# Workload cards

Start with `fission capabilities [foundry|reth|tempo|base|bsc]`, then read the selected ID with `fission help ID`. Stable IDs, facets, related links, and complete records borrow from [Bugraph](https://github.com/figtracer/bugraph); this is a task index, not an autonomous bug finder. Use it for user-directed changes and properties of your own code.

`validated` means the dated evidence in the index passed, not that every project or current network is ready. `unvalidated` means a preparation route exists but this workload lacks recorded validation. `unavailable` means there is no bundled recipe/profile for it. Every card still requires task-specific checks. Read [Rental](rental.md) before purchasing; metadata never grants spending authority.

Prefer pinned prebuilt tools when testing contracts. Compile a client only when changing that client or when required features are absent from the pinned binary. For unchanged source revisions, inspect [compiled-cache compatibility](harnesses.md#reuse-compiled-artifacts). An index reduces discovery work; it does not replace binaries, snapshots, or compilation of changed code. Keep credentials out of persisted argv, recipes, and logs; Fission has no secret-injection API.

## Foundry tests

Use recipe `foundry` for unit, fuzz, and stateful invariant tests. Upload your project with pinned compiler/dependencies, check `tools`, then run a distinct bounded job, for example:

```sh
fission run NAME tests --duration 10m -- /workspace/forge test --root /workspace/project --fuzz-runs 128 --fuzz-seed 0x1234 --json
```

Choose runs, seed, invariant depth, and time from the property; these example values are not universal coverage targets. Require the expected test names/counts and `Success`, inspect fuzz runs and invariant selector metrics. A campaign that makes no successful handler calls is vacuous; set `fail_on_revert` where appropriate or inspect reverts/discards explicitly. A passing fuzz campaign means no failure found in those runs, not a proof.

Retain source/compiler pins, configuration, seed, counts, failures and logs. Related: [symbolic properties](#foundry-symbolic), [Base forks](#base-contract-fork), [BSC forks](#bsc-contract-fork). Reference: [Foundry testing](https://getfoundry.sh/forge/tests/overview/).

## Foundry symbolic

Use recipe/profile `foundry-symbolic`: checksum-pinned Foundry 1.8.1 and external Z3 5.1.0, without building Foundry. It requires a saved Linux x86_64 VM plan with glibc >= 2.39 (Ubuntu 24.04); size CPU/RAM for your properties. Bootstrap records versions and hashes in `/workspace/symbolic-tools.json`. Upload a project with pinned compiler/dependencies and check `tools` before running.

```sh
fission run NAME properties --duration 10m -- /workspace/forge test --root /workspace/project --symbolic --symbolic-solver /workspace/z3 --symbolic-timeout 30 --match-contract Properties --json
```

Use `check*` or `prove*` property functions; `test*` functions remain ordinary tests. Pass the solver's absolute path: it is not installed on PATH. Select exploration bounds and solver timeouts deliberately using this pinned Forge's help. Decode each test's `symbolic` object, not just exit status:

- `pass`: no feasible violation within `bounds`, under the listed `assumptions` and engine model. Report those limits; this is not an unbounded safety claim or audit.
- `fail_counterexample`: require `replay.status == confirmed`; retain calldata, arguments and the counterexample artifact, then turn the failing input into a regression test.
- `incomplete`: timeout, solver error, unsupported behavior, or all paths reverting is not proof or a confirmed counterexample. Inspect the reason, narrow the property or adjust explicit bounds, and report what remains unproven.

Save `bounds`, `assumptions`, solver identity/statistics, replay status and artifacts. Zero `smt_queries` means that property did not exercise the external solver. September 14 validation exercised three SMT queries for widened uint8 addition and confirmed `(0, 1)` as a counterexample to wrapping subtraction being <= its first operand. These synthetic properties do not establish general engine correctness.

The same addition property also returned `incomplete` with an absent solver (`incomplete.kind = error`), an empty-response `/bin/true` solver (`error`), and `--symbolic-max-depth 1` (`stuck`). All three exited 1 with top-level `Failure`, no counterexample, and replay `not_required`; the normal Z3 run passed with three SMT queries. Exit 1 or `Failure` alone cannot distinguish infrastructure/exploration limits from a violated property. These checks did not test solver timeouts or every unsupported opcode.

Related: [tests](#foundry-tests), [changed Foundry source](#foundry-source-build). Pinned implementation contracts: [Forge runner](https://github.com/foundry-rs/foundry/blob/v1.8.1/crates/forge/src/runner.rs), [structured results](https://github.com/foundry-rs/foundry/blob/v1.8.1/crates/forge/src/result.rs), [Z3 release](https://github.com/Z3Prover/z3/releases/tag/z3-5.1.0).

## Foundry source build

Use `foundry-source` with an exact repository revision when changing Forge, Cast, Anvil, Chisel, or engine behavior. Follow [source builds](harnesses.md#source-builds), then check `build` and run the relevant upstream tests or benchmark. Preparation alone does not compile anything. Source builds preserve the revision's default features; verify the resulting executable exposes any required symbolic features and install a compatible solver explicitly.

Compare baseline/candidate under comparable conditions for performance claims. Preserve revisions, patch, flags, measurements and logs. Restore a compatible [compiled cache](harnesses.md#reuse-compiled-artifacts) for an unchanged revision; do not rebuild merely to run [contract tests](#foundry-tests). A same-VM restore passed; cross-rental restore remains unvalidated. Reference: [Foundry source](https://github.com/foundry-rs/foundry).

## Reth development

Use recipe `reth` for the pinned private development chain on guest loopback port 8545, not Ethereum mainnet. Supply your transaction client separately; this recipe installs Reth, not Cast. September 14 validation composed the unchanged Reth/Tempo preparation with prebuilt Cast 1.8.1 on one Linux x86_64 VM; no client compilation was needed.

Check `node` immediately before execution. Record `web3_clientVersion`, chain ID and genesis hash: both bundled development chains use **1337**, so chain ID alone cannot distinguish Reth from Tempo. This Reth recipe mines on transactions, not a fixed timer; an idle head need not advance. Keep public development keys and unlocked accounts on the isolated guest, never on funded/public networks.

Reth 2.5.2 passed four signed type-2 transactions: deploy a storage contract, set 42, transfer 1 ETH, and revert a write of 7 while preserving 42. Blocks advanced 0→4, nonces 0→4, and each receipt matched its transaction and containing block. Sender balance changes equaled transferred value plus `gasUsed × effectiveGasPrice`. A wrong-chain transaction was rejected without consuming a nonce, changing state or mining a block. For an included-revert test, provide an explicit sufficient gas limit; a failed gas estimate is not an included transaction.

Retain raw transactions, receipts, block identity, before/after state and logs. Bootstrap/readiness alone does not validate these assertions, and this proof is not public consensus or reorg coverage. For client changes use [Reth source](#reth-source-build); for public-network state use [paired mainnet](#reth-mainnet). References: [pinned development options](https://github.com/paradigmxyz/reth/blob/5a6940e351fed80458fe6c9da8581cbe4b8bd036/crates/node/core/src/args/dev.rs), [actual genesis allocations](https://github.com/paradigmxyz/reth/blob/5a6940e351fed80458fe6c9da8581cbe4b8bd036/crates/chainspec/res/genesis/dev.json).

## Reth source build

Use `reth-source` with exact baseline/candidate revisions for client execution, database, RPC or performance changes. Follow [source builds](harnesses.md#source-builds), check `build`, then run a representative targeted test or benchmark. Record feature flags and input data identity; do not call a current-head-only benchmark a speedup.

Reuse [compatible compiled binaries](harnesses.md#reuse-compiled-artifacts) for unchanged source, and separately preserve data when it is needed. Compilation does not establish sync or consensus. Related: [development chain](#reth-development), [paired mainnet](#reth-mainnet). Reference: [Reth source](https://github.com/paradigmxyz/reth).

## Reth mainnet

Use recipe/profile `reth-synced`, not the development-chain recipe. Read the complete [Synced Reth guide](reth.md) before selecting a manifest, sizing disk/transfer/lease, importing, obtaining a freshly verified checkpoint and starting Reth with Lighthouse. Import and sync are separate bounded jobs. Reusing a compatible dataset avoids reimport but still needs catch-up and fresh paired readiness.

Require the full `node` readiness result with the task's explicit head-age bound: identity, canonical execution payload, peer/sync state, resources and healthy owned processes. Readiness is timestamped. September 14 paired readiness and managed warm restart passed; a later check lost `consensusSynced`. Continuous readiness has not been established.

Save manifest/client pins, readiness observations and logs; stop owned services before dataset capture or close. Compatible prebuilt indexes and a full-size cross-rental dataset roundtrip remain follow-ups, not proven optimizations. Related: [Reth source](#reth-source-build), [Base node](#base-node), [BSC node](#bsc-node). Reference: [Reth](https://github.com/paradigmxyz/reth).

## Tempo development

Use recipe `tempo` for the isolated development node on guest loopback port 8645. Supply a signer separately and check `node` before execution. Ordinary EIP-1559 signing with prebuilt Cast 1.8.1 worked for TIP-20 transfers and contract execution on Tempo 1.14.0. Tempo type `0x76` features need Tempo-aware signing; this proof did not test that envelope, batching, sponsorship or parallel nonces. Read the pinned client's help instead of assuming it needs a source build.

**Use TIP-20 balances and the receipt's fee token.** In this pin, `eth_getBalance` ignores the address/block and returns a constant compatibility placeholder, not spendable native currency. The validated transfer sent 1 pathUSD (`0x20c0000000000000000000000000000000000000`) but paid its fee in AlphaUSD (`0x20c0000000000000000000000000000000000001`). Do not assume the transferred token pays fees. Check `feeToken`, `feePayer`, token `balanceOf` deltas and fee-transfer logs. For the tested transactions, charged fee-token base units equaled `ceil(gasUsed × effectiveGasPrice / 10^12)`, including the reverted transaction.

September 14 validation passed four included type-2 transactions: pathUSD transfer, contract deployment, storage update to 42, and a reverted write of 7 that preserved 42. Receipts, block inclusion and nonces agreed; total fees were 2,209 AlphaUSD base units. Wrong-chain and nonzero-native-value transactions returned `invalid chain ID` and `value transfer not allowed` without consuming nonces or changing token balances/storage. An earlier pathUSD-fee assertion failed after the transfer succeeded; the continuation verified that existing transaction using historical AlphaUSD balances rather than resending it.

Do not copy Ethereum gas ceilings: this development schedule charges 500,000 gas for creation before execution/code deposit. The tested tiny deployment used **541,466 gas**, and the fresh-recipient TIP-20 transfer used **541,126 gas**. A 1,000,000-gas test ceiling was sufficient; it is not a universal default. Estimate successful calls on the intended chain, and separately cap deliberate revert tests.

The recipe's one-second blocks advanced while idle. Record genesis hash as well as chain ID 1337 to distinguish it from [Reth development](#reth-development). Preserve node/client versions, transaction types, assertions and logs without private keys; stop owned nodes after the workload. A development chainspec can activate features absent on live networks and does not establish public consensus. Related: [contract model](#tempo-contracts), [Tempo source](#tempo-source-build). Pinned references: [RPC balance behavior](https://github.com/tempoxyz/tempo/blob/1ec5653e39c97e02807dddf5e7106e979f3ad909/crates/node/src/rpc/mod.rs), [gas schedule](https://github.com/tempoxyz/tempo/blob/1ec5653e39c97e02807dddf5e7106e979f3ad909/crates/revm/src/gas_params.rs), [fee conversion](https://github.com/tempoxyz/tempo/blob/1ec5653e39c97e02807dddf5e7106e979f3ad909/crates/primitives/src/transaction/mod.rs), [value rejection and fee handling](https://github.com/tempoxyz/tempo/blob/1ec5653e39c97e02807dddf5e7106e979f3ad909/crates/revm/src/handler.rs).

## Tempo contracts

Use recipe `foundry` and Forge's explicit `--network tempo` for contract tests against its Tempo EVM model. This option exists in pinned Forge 1.8.1; inspect that version's help/configuration and pin the target hardfork and project compiler. Do not infer Tempo behavior from a default Ethereum run.

Forge 1.8.1 rejects `--hardfork`. Put the selection in the project's `foundry.toml`, under the selected profile; `forge config --root /workspace/project --json` should resolve both fields:

```toml
[profile.default]
network = "tempo"
hardfork = "tempo:T5"
```

Choose the hardfork for the change, not merely the latest name. September 14 validation on Linux x86_64, Forge 1.8.1 and Solidity 0.8.30 passed five assertions in both the default Tempo model and explicit T5: FeeManager `userTokens` zero sentinel, implicit approval of FeeManager but not an EOA, nonzero payment-channel domain separator, and absence at a neighboring address. Under explicit T4, the genesis FeeManager read still worked while the tested T5 registry selector and channel response were unavailable. This establishes those boundaries, not all Tempo precompiles or gas semantics.

Require returned data length and decoded values: a static call to an empty Ethereum account can succeed with empty data. The Ethereum control verified this absence, and the identical positive FeeManager assertion failed on Ethereum. Keep such negative controls so an ignored network/hardfork cannot silently pass. Forge simulation is not a Tempo node, transaction-envelope integration, or consensus test; use [Tempo development](#tempo-development) or [source tests](#tempo-source-build) for those layers. Record network/hardfork, versions, inputs and results. References: [pinned precompile tests](https://github.com/foundry-rs/foundry/blob/982849d3140c01fd3b72905759581a132df7aa98/crates/forge/tests/cli/precompiles.rs), [Tempo documentation](https://docs.tempo.xyz/).

## Tempo source build

Use `tempo-source` with an exact revision for changes to the Tempo client. Follow [source builds](harnesses.md#source-builds), check `build`, and run tests selected for the changed protocol behavior. Reuse [compatible compiled artifacts](harnesses.md#reuse-compiled-artifacts) only for unchanged code/environment.

Native source workload validation passed; that does not establish public-network consensus or all protocol features. Preserve test names, revisions, flags and logs, and compare baseline/candidate for performance claims. Related: [development chain](#tempo-development), [contract model](#tempo-contracts). Reference: [Tempo source](https://github.com/tempoxyz/tempo).

## Base contract fork

Use recipe `foundry` to test your contracts against RPC-reported Base state without building a Base client. Supply an endpoint with historical state support. Check `eth_chainId == 8453`; record a finalized block number and hash from that endpoint, then run:

```sh
fission run NAME base-tests --duration 10m -- /workspace/forge test --root /workspace/project --match-contract BaseTests --network optimism --fork-url https://mainnet.base.org --fork-block-number BLOCK --json
```

Replace `BLOCK` with the recorded number, verify each expected test passed and its `fork_block_number` matches, and retain endpoint/block/hash plus logs. Public endpoints have rate and history limits; unavailable state is an RPC limitation, not a contract verdict. Do not put secret RPC tokens in argv.

Forge 1.8.1 inferred the Optimism model from Base's endpoint identity when no network was selected; an explicit `--network ethereum` retained chain ID 8453 but changed execution rules. Neither chain ID nor a passing Ethereum override establishes OP behavior. There is no `--network base`, and the test JSON does not identify the resolved execution model. Pin the intended hardfork in `foundry.toml` (not a `--hardfork` flag), for example `hardfork = "optimism:isthmus"` under `[profile.default]`. That example is a selected model, not a claim that Isthmus matches every Base block.

September 14 validation at block **51,307,369** distinguished inferred/explicit OP from explicit Ethereum: OP rejected a 112,896-byte BN254 pairing input that Ethereum accepted; valid/invalid P256 inputs returned 1/empty data. Pinned Isthmus accepted P256 with 5,000 gas. Offline Ecotone lacked P256 and the pairing cap, while Ethereum Osaka required more than 5,000 gas for the valid P256 call. These are selected behavioral controls, not complete hardfork or gas validation.

**Choose call isolation deliberately.** This binary defaults to `isolate = true`. A fixture funded with exactly its 1 ETH deposit reverted before WETH code executed under both default OP and pinned Isthmus; its identical Ethereum run passed. With `--network optimism --no-isolate` and pinned Isthmus, the same fixture deposited 1 ETH, transferred 0.4 WETH, withdrew 0.6 ETH, and verified both token balances and the wrapper reserve while the OP controls still passed. Isolation runs top-level calls as separate transactions; OP fees can require additional caller balance. The exact underlying validation error was hidden by the revert. Use `--no-isolate` for deliberately selected contract-call tests, not as an automatic workaround for fee/transaction tests. Keep failed controls and do not switch to Ethereum just to obtain a pass.

Fork simulation does not validate the sequencer, L1 derivation, bridge finality or consensus. RPC state remains trusted input. Related: [tests](#foundry-tests), [Base node](#base-node). References: [Base network information](https://docs.base.org/base-chain/network-information), [pinned network inference](https://github.com/foundry-rs/foundry/blob/982849d3140c01fd3b72905759581a132df7aa98/crates/evm/core/src/opts.rs), [isolated-call executor](https://github.com/foundry-rs/foundry/blob/982849d3140c01fd3b72905759581a132df7aa98/crates/evm/evm/src/inspectors/stack.rs).

## Base node

Unavailable: there is no bundled Base node recipe or validated resource profile. Do not rename `reth-synced` or use an Ethereum snapshot as a substitute. A concrete integration needs compatible execution/consensus client pins, Base genesis/config, snapshot identity, L1 execution and beacon dependencies, and measured disk/transfer requirements.

Readiness must cover Base chain identity, derivation and safe/finalized progress, execution/consensus pairing, L1 availability, peers and freshness. Keep snapshot/bootstrap separate from sync and record the chosen client before quoting. Until validated, use [Base contract forks](#base-contract-fork) only for their stated narrower scope. References: [maintained Base node repository](https://github.com/base/base), [Base documentation](https://docs.base.org/).

## BSC contract fork

Use recipe `foundry` for your contracts against RPC-reported BSC state, subject to its Ethereum-model limitations below. Supply historical-state RPC access; verify `eth_chainId == 56` and record a finalized block number and hash before running:

```sh
fission run NAME bsc-tests --duration 10m -- /workspace/forge test --root /workspace/project --match-contract BscTests --network ethereum --fork-url https://bsc-dataseed.binance.org --fork-block-number BLOCK --json
```

Replace `BLOCK`, require expected test names and successful assertions with matching `fork_block_number`, and retain the endpoint/block/hash and logs. Missing state or rate limits are RPC failures, not contract findings. Keep secret endpoint tokens out of persisted argv.

Forge 1.8.1 has no `--network bsc` (the CLI rejects it). Its inferred model accepted the Ethereum pairing input and treated BSC-native precompile addresses `0x64`–`0x69` as empty accounts: calls succeeded with empty returndata. At the same block the public BSC endpoint rejected the empty call to `0x64` with `deprecated`, while its identity-precompile control returned the expected bytes. This is an observed RPC-versus-simulation discrepancy; the other five native addresses were not compared with live RPC. Reading BSC state does not supply BSC's precompile implementations or hardfork rules. Do not validate contracts depending on those semantics through this route.

September 14 validation at block **121,873,529** passed the WBNB 1 BNB deposit / 0.4 WBNB transfer / 0.6 BNB withdrawal assertions, including recipient balance and wrapper reserve, under the inferred Ethereum model. System-contract code at `0x1000` was readable. This validates that fixture's execution over forked state, not BSC-specific execution compatibility or Parlia consensus. Record the Ethereum hardfork and isolation settings used; no BSC schedule is implied by chain ID 56. Public RPC state is not independently verified by this harness.

Related: [tests](#foundry-tests), [BSC node](#bsc-node). References: [BNB Chain documentation](https://docs.bnbchain.org/), [BSC precompile map](https://github.com/bnb-chain/bsc/blob/edb32e784cc3fc87a18b295d6cdb7d21430ff53a/core/vm/contracts.go).

## BSC node

Unavailable: choose BSC Geth/Parlia or Reth-BSC before designing a recipe. Their database layouts, snapshots, configuration and resource floors are not interchangeable; neither accepts the generic Ethereum snapshot workflow unchanged.

A future integration needs pinned client/genesis/config and compatible snapshot, measured storage/transfer bounds, and BSC-specific readiness covering identity, peers, head progress, sync and finality. Record which consensus/execution path is actually tested. Use [BSC contract forks](#bsc-contract-fork) for the narrower existing route. References: [BSC client](https://github.com/bnb-chain/bsc), [Reth-BSC](https://github.com/bnb-chain/reth-bsc).
