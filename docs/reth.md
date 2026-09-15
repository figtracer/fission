# Synced Ethereum with Reth

`reth --mode synced` is one managed Ethereum mainnet run using pinned Reth 2.5.2 and Lighthouse 8.2.2. It is not a normal sequence of manual download/start/check jobs. Base and BSC variants are not implemented.

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

Evidence from one September 14, 2026 Amsterdam run (16 vCPU, 128 GiB RAM, 3.2 TB nominal disk; 726,194,576,598 downloaded bytes; 962,683,657,146 output bytes) measured about 59m import, 40m28s index reconstruction, 2h41m from import start to readiness, and 3h39m from rental request to paired readiness. Network throughput was not measured; diagnostics/migration were included. This one sample is neither a guarantee nor a bound for another machine, snapshot, or date. A warm restart passed, while a later observation lost `consensusSynced`; continuous readiness is unproven.

## Candidate and retained data

A synced workload may consume an explicitly supplied/built candidate, but database compatibility and migration risk remain experiment decisions. Preserve manifest/client pins, checkpoint provenance, readiness observations, command output, and small reports. The managed supervisor stops work, gathers bounded evidence, and tears down; do not declare cleanup from a missing response.

Dataset inspect/save/collect/restore and direct guest controller operations are advanced recovery only (`fission advanced dataset ...`, `fission advanced exec ...`). Stop writers, verify available local/staging capacity and remaining lease, and retain hashes before capture. Restore still requires catch-up and fresh readiness. Full cross-rental roundtrip and compatible prebuilt indexes remain unvalidated.
