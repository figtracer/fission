# Synced Ethereum and Base with Reth

`reth --mode synced` is one managed mainnet run, not a sequence of manual download/start/check jobs. `--chain ethereum` uses pinned Reth 2.5.2 and Lighthouse 8.2.2. `--chain base` uses the signed pinned Base 1.4.0 unified execution/rollup-consensus binary. BSC is not implemented.

## Supply canonical inputs

Before previewing, obtain an exact manifest from [Reth snapshots](https://snapshots.reth.rs) and produce the pinned importer's canonical full planner JSON:

```sh
reth download --chain mainnet --manifest-path MANIFEST.json --full --print-plan-json --quiet > PLAN.json
```

Retain the planner binary identity, invocation, preset, manifest digest, archive list, block, and total compressed/output sizes. Fission requires schema version 1, chain ID 1, a matching manifest block, complete archive sizes, and exact totals. It computes a conservative coexistence disk floor from download + output + positive `--extra-disk-gib`; headline compressed size is insufficient.

Select a recent HTTPS consensus checkpoint from a source you trust and independently verify its 32-byte block root and epoch. Fission validates the syntax and HTTPS transport, not the source's trustworthiness.

```sh
fission run mainnet-check --harness reth --mode synced --chain ethereum \
  --manifest MANIFEST.json --snapshot-plan PLAN.json \
  --checkpoint-url https://TRUSTED_SOURCE/ --checkpoint 0xROOT:EPOCH \
  --max-head-age SECONDS --extra-disk-gib GiB --budget AMOUNT \
  --duration TOTAL --work-duration WORK --region REGION -- ARGV
```

Run first without `--approve`. Inspect computed disk/resources, quote, 4h preparation allowance, evidence, and uncertainty. Then repeat unchanged with `--approve` if authorized.

## What readiness means

Import completion is not readiness: the full preset may require index reconstruction and catch-up. Managed readiness requires healthy owned processes, matching Ethereum genesis identities, connected peers, non-optimistic online consensus, and two fresh observations with advancing canonical execution payloads inside the requested head-age bound. Peer count alone does not prove inbound reachability or historical consensus backfill.

The guest binds RPC, Engine, and consensus APIs to loopback, protects JWT material, and opens the execution/consensus peer ports in UFW; provider filtering remains separate. No validator keys or staking are involved.

## Candidate and retained data

A synced workload may consume an explicitly supplied/built candidate, but database compatibility and migration risk remain experiment decisions. Preserve manifest/client pins, checkpoint provenance, readiness observations, command output, and small reports. The managed supervisor stops work, gathers bounded evidence, and tears down; do not declare cleanup from a missing response.

Dataset inspect/save/collect/restore and direct guest controller operations are advanced recovery only (`fission advanced dataset ...`, `fission advanced exec ...`). Stop writers, verify available local/staging capacity and remaining lease, and retain hashes before capture. Restore still requires catch-up and fresh readiness. Full cross-rental roundtrip and compatible prebuilt indexes remain unvalidated.

## Base mainnet

Select an exact Base V2 manifest from `https://chain.base.org/api/snapshots`, save it locally, and use the pinned Base 1.4.0 binary to produce the full plan without downloading:

```sh
base snapshot download --chain base --full --manifest-path MANIFEST.json \
  --datadir EMPTY_DIRECTORY --non-interactive --print-plan-json \
  --logs.stdout.quiet > PLAN.json
```

Supply the manifest's original immutable URL as well as the local bytes. Fission fingerprints the local manifest, requires Base chain ID 8453/storage V2, safe output paths with BLAKE3 checksums, and exact full-plan compressed/output totals. The unsigned manifest is operator-trusted, content-pinned input: its checksums establish restored-file integrity, not independent chain-state correctness.

Base rollup consensus requires existing Ethereum L1 execution and beacon origins. Fission does not provision those services. Both URLs are persisted in task state and must be credential-free HTTPS origins: no userinfo, path, query, fragment, custom port, secret-bearing hostname, or authorization header. There are deliberately no default community endpoints. Authenticated endpoint support requires a future secret transport and is not implemented.

```sh
fission run base-mainnet-check --harness reth --chain base --mode synced \
  --manifest MANIFEST.json --manifest-url https://mainnet-v2-snapshots.base.org/ID/manifest.json \
  --snapshot-plan PLAN.json --l1-execution-url https://L1_EXECUTION_ORIGIN/ \
  --l1-beacon-url https://L1_BEACON_ORIGIN/ --max-head-age SECONDS \
  --max-safe-age SECONDS --max-l1-head-age SECONDS --max-l1-lag-blocks BLOCKS \
  --max-tip-lag-blocks BLOCKS --extra-disk-gib GiB --prepare-duration DURATION \
  --no-resize --budget AMOUNT --duration TOTAL --work-duration WORK --region REGION -- ARGV
```

Base requires an explicit preparation allowance of at least 4h because no managed live timing exists. The 16 vCPU/64 GiB floor is conservative planning, not measured adequacy; disk is raised to compressed + expanded full-plan bytes + the explicit allowance. Preview first and expect current snapshots to require multi-terabyte local NVMe capacity.

Readiness checks the L1 execution chain/freshness and beacon spec/head/blob APIs; Base chain/genesis and rollup config; execution and gossip peers; false execution sync; unsafe/safe/finalized block-hash coherence and ordering; unsafe/safe freshness; bounded L1 derivation/tip lag; and `optimism_outputAtBlock`. Preparation requires two observations where unsafe advances and safe or L1 derivation also advances under the same service invocation. Work receives a fresh short readiness gate.

This integration is local-artifact and fixture validated, not live Base-sync qualified. It does not establish resource adequacy, snapshot/catch-up duration, independent L1 validity, production readiness, sequencing, bridge finality, or a successful multi-terabyte managed restore. A paid live validation is still required before those claims.
