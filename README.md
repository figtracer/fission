# loaner

temporary workspaces for the few hours you need another machine.

Loaner opens a paid Linux workspace, prepares it for your task, and keeps its remaining time visible in your terminal. Your existing agent runs commands and brings files back. Close it when the work is done; the provider's deadline remains in force if your computer goes offline.

The first provider is [Modal through Tempo](https://modal.mpp.tempo.xyz). It supplies an isolated Linux **sandbox**, not an unrestricted VM. Loaner adds recipes, saved session state, file transfer and a terminal view. Payments use your existing Tempo CLI wallet. There is no Loaner payment endpoint or background daemon.

## Start

Use Node >=22.13 and an already configured [Tempo CLI](https://tempo.xyz/).

```sh
git clone https://github.com/figtracer/loaner.git
cd loaner
npm link --ignore-scripts

loaner recipes
loaner open node-work --recipe reth --duration 2h --max-spend 1
```

The last command previews the price, recipe commands and duration. Add `--approve` to purchase:

```sh
loaner open node-work --recipe reth --duration 2h --max-spend 1 --approve
loaner list
loaner watch
loaner exec node-work -- /workspace/reth --version
```

The `reth` recipe downloads the official Reth 2.5.2 executable, verifies its SHA-256, starts a local development chain, and waits for its RPC. RPC is available inside the workspace at `http://127.0.0.1:8545`. It does not sync mainnet or install a Rust source-build toolchain. The `linux` recipe creates an empty `/workspace` with the provider's Python runtime.

## Bring work in and out

```sh
loaner upload node-work ./task.py /workspace/task.py
loaner exec node-work -- python3 /workspace/task.py
loaner download node-work /workspace/result.json ./result.json
loaner close node-work --output ./saved-node-work
```

Transfers operate on individual files and verify SHA-256. Upload and download destinations must be new. Archive a project yourself before uploading it; only the files you explicitly select leave your computer. Uploads use 4 KiB chunks to fit the payment gateway; downloads use 48 KiB chunks. This interface is intended for modest source and output files, not large chain databases.

`close --output` collects the recipe's declared files into a new directory before requesting termination. The Reth recipe declares `/workspace/reth.log`. Download other outputs explicitly. Stop processes writing an artifact before exporting it. If export fails, Loaner keeps the session and reports the partial output path; its original expiry still applies.

To finish without saving declared files:

```sh
loaner close node-work --discard-output
```

Provider expiry can destroy unsaved files. An offline laptop cannot export them. Neither a closed terminal nor a closed PR is a completion signal; your agent should call `close` when you consider the task finished.

## Track sessions

`list`, `status NAME` and `watch` read local observations and cost nothing. The table shows elapsed time, estimated time left and the age of the last provider observation. The gateway does not return an authoritative creation timestamp, so passing the displayed deadline means expiry needs confirmation.

```sh
loaner status node-work --refresh --json
loaner watch --refresh --max-spend 0.01
```

Refreshing costs at most 0.0001 USDC.e per workspace per call. Watch refreshes every 30 seconds within its explicit total cap. Its countdown redraws locally. Ctrl-C exits the view; it does not close workspaces. Agent-facing state is available with `--json`.

## Costs and recovery

`open --max-spend` caps the creation payment. Creation buys a bounded duration, including preparation. Subsequent command, status and termination requests each have a 0.0001 USDC.e cap. File transfers make multiple requests. These are gateway charges; network fees are separate. Loaner adds no fee. Early termination is not a promise of a refund.

State lives in `~/.local/state/loaner` with private file permissions. Set `LOANER_HOME` to choose another directory and `LOANER_TEMPO` to select the installed Tempo executable. Preserve state and receipts.

```sh
loaner reconcile node-work
```

Reconciliation recovers a remote ID from a saved creation response and observes the provider. It never repeats a purchase or preparation command. A lost response with no recoverable ID requires provider/payment investigation; Loaner keeps the unresolved record and refuses to reuse its name. It does not promise provider-wide discovery. After an interrupted operation, inspect the lock's PID; remove only a stale lock once its process has exited.

The current gateway exposes no verified extension, custom-image, capacity-selection, SSH or public-port interface. Choose the duration at creation. Full-kernel workloads and large builds need a different provider.

## Recipes

A local JSON file defines `name`, optional `description`, `prepare` (arrays of command arguments), and `artifacts` (absolute remote file paths). Pass its path to `--recipe`. Preparation runs remotely and is displayed before approval. A recipe cannot select a payment endpoint, increase runtime or receive your wallet credentials. Failed preparation triggers a termination attempt and preserves diagnostics in local request state.

## References

- [Glue](https://github.com/figtracer/glue): small CLI services, agent-readable state and explicit lifecycle controls.
- [Reth](https://github.com/paradigmxyz/reth): the pinned node used by the first prepared recipe.
- [Modal sandbox lifecycle](https://modal.com/docs/guide/sandbox-lifecycle): the underlying workspace model.
- [Kurtosis Ethereum package](https://github.com/ethpandaops/ethereum-package): a reference for future recipes requiring a complete private network.
