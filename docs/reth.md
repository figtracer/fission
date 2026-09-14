# Synced Reth

Use this guide before planning a full Reth/Lighthouse workload. `reth-synced` prepares Reth 2.5.2, Lighthouse 8.2.2, and `/workspace/ethereum` on a Linux x86 VM with systemd. Its profile retains at least 8 vCPU, 32 GiB RAM, and 2048 GiB disk. Import and node startup are separate jobs after bootstrap.

## Size before quoting

Select an exact manifest from [Reth snapshots](https://snapshots.reth.rs). Headline sizes describe compressed downloads. Ask the pinned Reth importer for its canonical selection:

```sh
reth download --chain mainnet --manifest-path FILE --full --print-plan-json --quiet
```

Record the binary, manifest digest, preset, and invocation outside the repo; the output omits the preset name. Add `totalDownloadSize` and `totalOutputSize`, plus an explicit allowance for consensus, growth, builds, OS/filesystem, and extraction. Round upward to GiB and pass `--disk GiB` to discovery and planning. This conservative coexistence envelope supplements the profile floor. Archive needs its own sizing; minimal is a different workload requiring an explicit choice.

Budget lease time for preparation, transfer, extraction, syncing, the requested work, and export. Verify actual guest resources and free space before import.

## Import

Upload the exact manifest, then run this command in a bounded Fission job:

```sh
/workspace/ethereum download --manifest /workspace/manifest.json --sha256 DIGEST --extra-disk-gib ALLOWANCE
```

The controller re-runs the pinned full planner and checks actual free space. It records the attempt before transfer and publishes `/workspace/ethereum-data/snapshot.json` after successful import. Other jobs can consume disk, so preserve capacity during import. Failed staging remains recorded; inspect it before manual recovery rather than automatically repeating the download.

## Start and observe

Select a recent mainnet checkpoint and independently verify its block root and epoch, then run:

```sh
/workspace/ethereum start --checkpoint-url TRUSTED_HTTPS_URL --checkpoint BLOCK_ROOT:EPOCH --max-head-age SECONDS
```

The controller records intent before starting owned systemd units. Readiness requires two fresh observations with an advancing, canonical consensus execution payload, matching genesis identities, connected peers, and non-optimistic online execution. Treat readiness as a timestamped observation. Peer counts alone do not establish inbound reachability or historical consensus backfill.

`status --max-head-age SECONDS` checks the pair; `wait` with the same flag observes until ready. A startup/wait timeout stops the observer while services remain bounded by the lease. `stop` stops and verifies both owned service cgroups. `restart` takes the same checkpoint/readiness flags and stops the previous pair before recording a new invocation.

Preparation adds UFW allowances for execution TCP/UDP 30303 and consensus TCP/UDP 9000 plus UDP 9001, preserving existing firewall settings. Verify provider-level filtering separately. RPC, Engine, and consensus APIs bind to loopback; JWT permissions are 0600. Units use `Restart=no`; this workflow needs no validator keys or staking.

## Candidate and outputs

Pass `--reth /workspace/CANDIDATE` to use an explicitly uploaded or built executable. The controller copies it to a digest-addressed path while retaining the pinned importer. Assess database compatibility before startup; a candidate can migrate data, so rollback is an explicit recovery decision. Budget source/build space separately.

Automatic close exports contain tool provenance and bootstrap output. Stop writers, then download small snapshot/start reports and bounded journal excerpts explicitly. Keep live logs and databases on the guest. Complete the [rental cleanup](rental.md#run-and-collect) after collecting the task's result.
