# Ethereum and Base nodes

Use one `--harness reth --mode synced` task. Fission imports the selected snapshot,
starts the clients, waits for readiness, runs the workload and cleans up. Choose
`--chain ethereum` (default) or `--chain base`, and
`--snapshot minimal|full|archive` (default `full`).

## Choose data and clients

Start with the chain, required block range, RPC methods and completion evidence.
The preset selects upstream snapshot components and pruning configuration. The
node preserves that generated configuration; Fission does not force `--full` at
startup. Missing historical data cannot be recreated by disabling pruning or
rebuilding indexes. Add workload checks for coverage and required RPC methods.
`node.rpcModules` enables additional local APIs such as `debug` and `trace`.

Default clients are Reth 2.5.2 + Lighthouse 8.2.2, or unified Base 1.4.0. Select
another compatible release with task-file `node.execution` / `node.consensus`:
HTTPS release archive URL, independently verified SHA-256, executable basename and
exact version. Fission verifies the asset and reported binary version. Match the
manifest's Reth version exactly; a newer snapshot need not fit an older client.
See [node configuration](harnesses.md#node-configuration) for upstream arguments,
network identity and additional readiness checks.

## Ethereum inputs

Fetch the unedited manifest from [Reth snapshots](https://snapshots.reth.rs). The
importer accepts Ethereum storage V2 manifests from the official snapshot host.
Use the matching client to generate a canonical plan with the selected preset:

```sh
reth download --chain mainnet --manifest-path MANIFEST.json \
  --archive --print-plan-json --quiet > PLAN.json
```

Use `--minimal` or `--full` for those selections. Retain client identity, invocation,
manifest hash, block and plan. Preview checks structure and size totals; the guest
regenerates and compares the selected canonical plan before download. That final
comparison currently happens after purchase, so generate the input with the actual
matching client before preview rather than hand-authoring it.

Resolve a recent consensus checkpoint using the operator's trust policy. Verify
its HTTPS source, 32-byte block root and epoch independently. URL syntax validation
alone does not establish trust.

```sh
fission run history-check --harness reth --mode synced --snapshot archive \
  --manifest MANIFEST.json --snapshot-plan PLAN.json \
  --checkpoint-url https://TRUSTED_SOURCE/ --checkpoint 0xROOT:EPOCH \
  --max-head-age SECONDS --extra-disk-gib GiB --prepare-duration DURATION \
  --no-resize --budget AMOUNT --duration TOTAL --work-duration WORK \
  --region REGION -- ARGV
```

Preview first without `--approve`, then repeat unchanged when authorized. An agent
resolves these inputs and writes a task file when extra client configuration is
needed; the user does not need to assemble a sequence of lifecycle commands.

## Base inputs

Resolve a manifest through [Base snapshots](https://chain.base.org/api/snapshots)
and use the matching Base client to generate the selected plan:

```sh
base snapshot download --chain base --archive --manifest-path MANIFEST.json \
  --datadir EMPTY_DIRECTORY --non-interactive --print-plan-json \
  --logs.stdout.quiet > PLAN.json
```

Snapshot chain names are `base`, `base-sepolia`, `base-zeronet`; their corresponding
`node.network` values are `mainnet`, `sepolia`, `zeronet`. Other configured chains
need explicit identity and compatible upstream inputs. Supply local manifest bytes
and their immutable HTTPS `manifest-url`. Chain ID, storage V2, safe output paths,
BLAKE3 file checksums and selected-plan totals are validated. Content integrity does
not independently establish chain-state correctness.

Supply `l1-execution-url` and `l1-beacon-url`: credential-free HTTPS origins. These
are existing dependencies, persisted in task state; authenticated endpoints need a
separate secret transport. Include `max-head-age`, `max-safe-age`,
`max-l1-head-age`, `max-l1-lag-blocks`, `max-tip-lag-blocks` and `extra-disk-gib`.
For another network, resolve `node.chainId`, `node.l1ChainId` and
`node.genesisHash`; known chain IDs default automatically, but only mainnet has a
bundled genesis hash. Client options pass through `node.args`. More elaborate
service layouts can extend the built-in recipe with explicit preparation/checks.

## Resources and timing

Disk is computed from compressed + expanded selected-plan bytes + positive scratch
allowance. CPU/RAM can be explicitly selected for the workload. Preview shows the
resulting machine quotes and budget; a smaller snapshot does not inherit a fixed
2 TB disk floor. Restore, indexing and catch-up still need space and time.

Minimal/archive and Base require explicit `prepare-duration`, at least the current
4h synced planning allowance. Total duration also covers 30m provisioning, workload
and 15m cleanup. Larger allowances require explicit user authorization. These are
planning allowances, not performance guarantees. The existing full Ethereum run
is one dated observation, not evidence for archive, smaller machines or Base.
Local planner validation covers all three presets; multi-terabyte minimal/archive
restores and live Base sync remain unmeasured.

## Readiness and retained evidence

Ethereum readiness checks owned processes, matching genesis, connected peers,
non-optimistic online consensus and fresh advancing canonical execution payloads.
Base checks L1 execution/beacon identity and freshness, rollup configuration,
execution/gossip peers, coherent unsafe/safe/finalized hashes, derivation/tip lag
and `optimism_outputAtBlock`. Preparation requires advancing observations under the
same service invocation. A fresh readiness gate precedes the workload.

These checks establish the running pair, not historical coverage, validator
participation or workload correctness. Add named checks for the requested result.
RPC/Engine/consensus APIs stay local to the guest. Preserve snapshot/client pins,
checkpoint provenance, observations, command output and small reports.

Build caches retain binaries. Database reuse needs separately verified compatible
storage, capacity, transfer costs and stopped writers; restoration still requires
catch-up and fresh readiness. Dataset operations remain advanced recovery. The
managed supervisor exports bounded evidence and confirms provider cleanup.
