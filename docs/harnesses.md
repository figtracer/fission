# Harnesses

Choose preparation by the work the machine must perform. Use `fission recipes` for recipe details and `fission capabilities` for current hardware profiles. Apply the [rental workflow](rental.md) to purchase, run, and close.

| Work | Recipe | Result of bootstrap |
|---|---|---|
| Shell commands | `linux` | Workspace |
| Foundry tools | `foundry` | Forge, Cast, Anvil, and Chisel |
| Reth development chain | `reth` | Private local chain |
| Tempo development chain | `tempo` | Isolated chain on loopback port 8645 |
| Compile a client | `foundry-source`, `reth-source`, `tempo-source` | Checkout, compiler, dependencies, and `/workspace/build` |
| Reth with Lighthouse | `reth-synced` | Pinned tools and `/workspace/ethereum`; follow [Synced Reth](reth.md) |

Runtime sandboxes have opportunistic capacity. Use a VM and explicit requirements for guaranteed resources or P2P. Development chains run privately on the guest; production network participation is a separate workload.

## Source builds

Source recipes require `--repo https://github.com/OWNER/REPO --ref FULL_COMMIT` and select their matching hardware profile. Resolve a PR to its exact 40-character head SHA. The checkout verifies HEAD and records submodules. Upload private source explicitly, keeping GitHub and wallet credentials local.

Bootstrap installs pinned Rust 1.96.1 and native dependencies. Run the build separately:

```sh
fission run NAME build --duration 1h -- /workspace/build
```

Choose a job duration within the remaining lease. The helper builds the selected release executables with `--locked`, preserves upstream default features, and copies successful binaries into `/workspace`. `/workspace/build.json` records the commit, local changes, toolchain, versions, and hashes. Download it and required binaries explicitly; automatic close exports include source preparation provenance and bootstrap output.

The wrappers `/workspace/cargo`, `/workspace/rustc`, and `/workspace/rustup` work without shell activation. Pass `--manifest-path /workspace/source/Cargo.toml` when invoking Cargo outside the checkout. A failed build leaves the workspace available for diagnosis and a separately named follow-up job. Toolchain or feature changes are explicit decisions; saved plans retain their embedded preparation.

Reth source preparation targets Ubuntu 24.04 and includes `m4`, LLVM 22 development packages, and Polly for the default GMP/JIT features. The official LLVM repository uses a verified signing-key fingerprint and scoped `signed-by` key. Other source revisions can require different dependencies. Confirm the requested workload after compilation; build success establishes binary production.

## Custom recipes

Pass a JSON file to `--recipe`. Its fields are `name`, optional `description`, `prepare` argv arrays, `artifacts` absolute remote paths, optional `afterCheckout` argv arrays, and optional `readiness` argv arrays. `afterCheckout` requires a source reference.

Saved-plan bootstrap runs preparation, checkout, then after-checkout commands once. Readiness probes repeat every 15 seconds inside the bootstrap deadline; use bounded, read-only commands. The `output.log` artifact basename is reserved for bootstrap output. Recipes describe preparation and files; the backend owns payment and runtime settings. Use saved plans for this workflow; legacy direct open supports synchronous preparation and a creation-only cap.

## Readiness

Ask for the scope the experiment needs:

```sh
fission check NAME --scope tools --duration 1m
fission check NAME --scope build --duration 1m
fission check NAME --scope node --duration 1m --max-head-age 120
```

`tools` observes installed executables. Source recipes offer `build`, which checks a clean checkout, build identity, and executable hashes. Development-chain recipes offer `node`, which verifies the local chain identity. Synced Reth's `node` scope also requires a completed compatible snapshot import, the import's free-disk allowance, healthy Reth/Lighthouse processes, connected peers, verified canonical execution payloads, zero consensus sync distance, and a head within the explicitly chosen age. `--max-head-age` applies to synced Reth only; choose it for the task.

Results contain `schemaVersion`, `scope`, `ready`, `observedAt`, and named observations. Exit status is zero only for a ready result. Each observation is saved locally and included in subsequent reports. Check immediately before the workload; readiness is a timestamped observation. Preparation and long sync waits remain separate bounded jobs. A check allows at most two minutes, keeping its guest deadline inside the three-minute SSH transport bound.

Custom recipes can set `schemaVersion: 1` and add `checks`:

```json
{
  "name": "custom-tool",
  "scope": "tools",
  "argv": ["/workspace/tool", "--version"],
  "result": "exit"
}
```

Place these objects in the recipe's `checks` array. Names must be unique. A check with `result: "exit"` requires exit code zero. With `result: "json"`, stdout must also be an object containing `"ready": true`; put measured and expected values alongside it. Probes should be read-only and bounded. The agent chooses the scope and interprets evidence; the backend retains payment, lease, and lifecycle ownership.

## Reuse compiled artifacts

After a successful source build, save its binaries and provenance locally:

```sh
fission cache save NAME --max-bytes 1000000000
fission cache list
fission cache restore NEXT_MACHINE CACHE_ID --max-bytes 1000000000
fission check NEXT_MACHINE --scope build --duration 1m
```

The byte limit bounds both the archive and uncompressed files; set it for the expected artifacts. The cache lives under `FISSION_HOME/.cache/builds`, survives rental cleanup, and has no recurring provider storage fee. A save needs local disk for the archive; restore needs guest disk for the archive and staged files. Only the selected executables and `build.json` enter the bundle.

Prepare the same source recipe and revision on the next rental first. Restore verifies source commit and lockfile, submodules, compiler, native packages, CPU features, operating system, build flags, harness digest, and binary hashes. It preserves an existing build record and records the cache's origin when successful. Compatibility is deliberately conservative. A cache reuses a completed build for that exact environment; changes to the source require a new build.

## Portable experiments

```sh
fission report NAME JOB --log output.log --measurements measurements.json
fission plan NEXT --from fission/NAME/TIMESTAMP-JOB/experiment.json \
  --budget 1 --cheapest --region ams --duration 1h
# Open the returned plan, prepare its environment and required inputs, then:
fission run NEXT run0 --from fission/NAME/TIMESTAMP-JOB/experiment.json --duration 10m
```

A report contains the source pin, embedded recipe, harness hashes, commands and working directory, quoted and observed resources, timestamped readiness, measurements, supplied logs, receipts, and cleanup status. `experiment.json` hashes the attached report files and lets another agent create a fresh plan using the original requirements. Reruns require a new budget and explicit launch. The record does not authorize payment. Restore or upload workload inputs before launch; dataset paths in a command identify preparation requirements.

Measurements are an array of `{ "name": "elapsed", "value": 12.4, "unit": "s", "context": "describe the measured workload" }`. They are supplied observations, separate from recorded process timing. Save a report after cleanup to include its final confirmation. Older reports whose exact recipe cannot be recovered remain readable; portable records require a verified recipe and an explicit workload job.

The lifecycle separation follows [Centaur's harness interface](https://github.com/paradigmxyz/centaur/blob/main/crates/harness-server/src/traits.rs) and the task-specific environment approach in [LangChain's harness guide](https://www.langchain.com/blog/how-to-build-a-custom-agent-harness). Fission keeps the coding agent outside the guest and uses a small recipe contract for preparation, observations, execution, and artifacts.

## Your own storage

Choose an existing directory on the local disk, an attached drive, or storage you mount yourself. Check capacity first:

```sh
fission storage --storage-dir /Volumes/Data/fission --max-bytes 1200000000000
```

Pass `--storage-dir` to cache and dataset collection commands, or set `FISSION_STORAGE_DIR` for subsequent commands and the TUI. The TUI's **Storage** button (`o`) shows the selected path and available space. The default is `FISSION_HOME/.cache`. Choosing a different directory moves no existing files and opens no paid storage account.

For a completed Reth full import, preserve the execution database under your custody:

```sh
fission dataset inspect NAME --max-bytes 1200000000000 --storage-dir /Volumes/Data/fission
fission exec NAME -- /workspace/ethereum stop
fission dataset save NAME save0 --duration 2h --max-bytes 1200000000000 --storage-dir /Volumes/Data/fission
# Observe save0 to completion, then collect its chunks:
fission dataset collect NAME save0 --max-bytes 1200000000000 --storage-dir /Volumes/Data/fission
# On another prepared reth-synced VM:
fission dataset restore NEXT restore0 --from /Volumes/Data/fission/datasets/ID/manifest.json --duration 2h --max-bytes 1200000000000
```

Choose limits and durations from the inspection and remaining lease. Saving holds the Reth controller's mutation lock and requires its node processes to be stopped. It stages an uncompressed archive on the guest, so both guest staging space and local storage must accommodate it. Collection uses verified 64-MiB chunks and reuses completed local chunks when resumed. Restore verifies the saved manifest digest, pinned writer, chain, format, chunk hashes, and available guest space before unpacking into a fresh data directory. Preserve unresolved or partial operations for inspection.

The saved dataset contains execution data and import metadata. Start Lighthouse again with a freshly verified checkpoint, then check node readiness before the next experiment. Transfer time, catch-up time, and the provider's transfer allowance still matter. Local storage is an explicit alternative to recurring provider storage; choose paid storage separately if its economics suit the workload.
