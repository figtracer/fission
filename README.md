# fission

temporary compute for your coding agent.

Plan a machine, pay through MPP with Tempo, prepare tools, run durable jobs, collect files, and close it when the task is done. Your agent and wallet stay local.

Requires Node >=22.13, SSH and a configured Tempo CLI wallet. Clone this repository and run `npm link --ignore-scripts`.

```sh
fission budget --total-spend 25 --vm-max-spend 10 --approve
fission ui
fission plan change --recipe foundry --cheapest --budget 1 \
  --region ams --duration 24h
fission open change --plan PLAN_ID --approve
fission wait change bootstrap --duration 5m --max-spend 0.01
fission run change info --duration 1m -- uname -a
fission watch
fission close change --output ./saved-change
```

`ui` shows active and past machines, sortable by name, spend or expiry. Enter opens details, then SSH for a ready VM; `x` saves declared output and closes it. `v` verifies payment amounts and transaction references through free Tempo RPC reads. Missing receipts remain unknown. `spending` exposes the same data as JSON; paid amounts include sender USDC.e fees and exclude other assets and later refunds.

Give your agent [AGENTS.md](AGENTS.md) or [llms.txt](llms.txt). Agents use JSON commands directly. Add `--repo https://github.com/OWNER/REPO --ref FULL_COMMIT` for a public source checkout. Upload private files explicitly.

To work on the tools themselves, select `--recipe foundry-source`, `reth-source` or `tempo-source` with that exact source reference. Each selects its matching hardware floor and prepares Rust 1.95.0 plus native dependencies. After bootstrap, use `fission run change build --duration 1h -- /workspace/build`; build output includes executable versions and hashes in `/workspace/build.json`. Compilation is a separate job so a compiler error leaves the prepared machine usable.

**Available:** Linux x86 VMs through MPP-funded Vultr, prepaid for 24 hours, with SSH and provider expiry. Modal via Tempo supplies shorter Linux sandboxes with opportunistic capacity. Recipes provide Python, pinned Foundry tools, or isolated Reth/Tempo development chains. Source recipes use one shared build harness; live full-VM compilation is pending verification. Custom JSON recipes add preparation, source setup and readiness commands.

**Pricing:** `plan --cheapest --budget AMOUNT` dry-quotes up to three compatible VM offers, selects the cheapest quoted option and returns the exact `open` argv. `--budget` is the whole-workspace allocation; creation is capped at its saved quote and a later price increase stops purchase. `machines` lists offers with their average, range and sample size. This is one provider's capped shortlist, not a market average or spending authorization. Hardware floors and configured ceilings remain binding. Closed allocations and failed request caps stay in the aggregate ledger. Network fees are separate.

**Glue:** plan JSON includes `funding` with the Tempo token, creation amount and workspace allocation. Your agent can preview an existing [Glue refill policy](https://github.com/figtracer/glue/blob/main/docs/services/refill.md) with `glue run --policy FILE`. Glue handles payment-token funding; its swap/input/fee limits stay separate. Fission does not infer a wallet shortfall, install a grant or enable refills.

**Limits:** full Reth keeps its 32 GiB RAM and 2 TiB disk floor. No affordable full-node deployment, separate volumes, custom images, or synced Reth/Lighthouse recipe is verified yet. The included Ethereum observer checks an already configured pair. Provider catalog capacity does not establish workload performance.

Close explicitly when finished; a successful job or closed terminal does not delete a machine. `close --output` saves declared artifacts and bootstrap output; use `download` for other files. Failed exports preserve the machine until expiry. Ambiguous deletion requires provider observation. Preserve `FISSION_HOME` and use `reconcile` after interrupted creation. Legacy Loaner state is reused when present, including its budget.

References: [Glue](https://github.com/figtracer/glue), [Reth](https://reth.rs), [Foundry](https://getfoundry.sh), [Tempo](https://github.com/tempoxyz/tempo), [Modal](https://modal.com/docs/guide/sandboxes).
