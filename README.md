# fission

temporary compute for your coding agent.

Quote a VM, pay through MPP with Tempo, prepare tools, run jobs, collect files, and close it when the task is done. Your agent and wallet stay local.

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

`ui` shows active and past machines, expiry, spending and transactions. Enter opens details, then SSH; `x` saves declared output and closes. Agents use JSON commands directly.

Give your agent [AGENTS.md](AGENTS.md) or [llms.txt](llms.txt). Recipes cover Foundry tools and isolated Reth/Tempo development chains. For client development, use `foundry-source`, `reth-source` or `tempo-source` with `--repo URL --ref FULL_COMMIT`. Bootstrap prepares Rust and dependencies; `/workspace/build` runs compilation as a separate job.

`reth-synced` prepares a Reth/Lighthouse controller for separate snapshot import, startup, readiness and candidate-restart jobs. It requires full-node capacity; live synced deployment remains unverified.

**Available:** Linux x86 VMs through MPP-funded Vultr, prepaid for 24 hours, with SSH and provider expiry. Modal supplies shorter Linux sandboxes with opportunistic capacity. Synced Reth/Lighthouse deployment remains unverified: full Reth retains its 32 GiB RAM and 2 TiB disk floor, and no affordable compatible offer is verified.

**Budgets:** planning pays nothing. `--cheapest` compares up to three compatible quotes from one provider; `machines` shows the sample and average. `--budget` covers the workspace allocation, with creation capped at its saved quote. Price increases stop purchase. Hardware floors and spending ceilings remain binding; network fees are separate. Closed allocations and failed request caps stay in the ledger.

**Glue:** plan JSON includes token and funding amounts for an existing [Glue refill policy](https://github.com/figtracer/glue/blob/main/docs/services/refill.md). Fission does not enable refills or authorize swaps.

Close explicitly when finished; job completion or quitting the terminal does not delete a VM. `close --output` saves declared artifacts and bootstrap output; use `download` for other files. Failed exports preserve the VM until expiry. Preserve `FISSION_HOME` and unresolved payment records; use `reconcile` after interrupted creation.

References: [Glue](https://github.com/figtracer/glue), [Reth snapshots](https://snapshots.reth.rs), [Foundry](https://getfoundry.sh), [Tempo](https://github.com/tempoxyz/tempo), [Modal](https://modal.com/docs/guide/sandboxes).
