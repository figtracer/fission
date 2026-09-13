# loaner

temporary workspaces for the few hours you need another machine.

Loaner rents a Linux sandbox through [Tempo](https://tempo.xyz/) and [Modal](https://modal.mpp.tempo.xyz), prepares it from a recipe, and tracks its lifetime in your terminal. Your existing agent runs commands, transfers files, and closes it when the task is done. The provider enforces expiry even if your computer goes offline.

One CLI, two recipes, no background service or separate payment endpoint.

## Use

Requires Node >=22.13 and a configured Tempo CLI wallet.

```sh
git clone https://github.com/figtracer/loaner.git
cd loaner
npm link --ignore-scripts

# Preview; add --approve to purchase.
loaner open node-work --recipe reth --duration 2h --max-spend 1
loaner open node-work --recipe reth --duration 2h --max-spend 1 --approve

loaner watch
loaner exec node-work -- /workspace/reth --version
loaner upload node-work ./task.py /workspace/task.py
loaner exec node-work -- python3 /workspace/task.py
loaner download node-work /workspace/result.json ./result.json
loaner close node-work --output ./saved-node-work
```

`close --output` saves the recipe’s declared files before termination; Reth declares only `/workspace/reth.log`. Download other outputs explicitly. If export fails, the workspace remains open until its original expiry. Use `--discard-output` to close without saving. Unsaved files disappear on expiry; closing your terminal or PR does not close the workspace.

## Available now

- **linux:** an empty `/workspace`, shell and Python.
- **reth:** checksum-verified Reth 2.5.2 executable and a local development chain, with RPC inside the sandbox at `127.0.0.1:8545`. No mainnet sync or Rust build toolchain.
- **Custom recipes:** pass a JSON file to `--recipe`, containing `name`, `prepare` (command-argument arrays), and `artifacts` (absolute remote file paths).

These are sandboxes: no verified SSH, public ports, custom images, capacity selection or duration extensions. Transfers support individual modest files, verify SHA-256, and require new destinations.

## Lifetime and cost

`list`, `status NAME` and `watch` show free, cached observations with estimated deadlines. `status NAME --refresh` checks the provider; `watch --refresh --max-spend 0.01` checks every 30 seconds within that total cap. `list` and `status` support `--json` for agents.

`open --max-spend` caps creation only, including preparation time. Subsequent command, status and termination requests each have a 0.0001 USDC.e cap; transfers make multiple requests. Network fees are separate. Early closure does not guarantee a refund.

State is saved in `~/.local/state/loaner` (`LOANER_HOME` overrides it). After an interrupted request, preserve it and use `reconcile NAME`; purchases are never automatically retried. A lost creation response without a recoverable ID needs provider/payment investigation.

Inspired by [Glue](https://github.com/figtracer/glue), using [Reth](https://github.com/paradigmxyz/reth) and [Modal’s sandbox lifecycle](https://modal.com/docs/guide/sandbox-lifecycle). [Kurtosis](https://github.com/ethpandaops/ethereum-package) is a reference for future network recipes.
