# fission

temporary compute for your coding agent.

Plan a machine, pay through Tempo, prepare tools, run durable jobs, collect files, and close it when the task is done. Your agent and wallet stay local.

Requires Node >=22.13, SSH and a configured Tempo CLI wallet. Clone this repository and run `npm link --ignore-scripts`.

```sh
fission budget --total-spend 30 --vm-max-spend 10 --approve
fission ui
fission machines --profile reth-source --region ams --duration 24h
fission plan change --recipe linux --profile reth-source \
  --provider x402-compute --machine MACHINE --region ams \
  --duration 24h --max-spend 8 --total-spend 9
fission open change --plan PLAN_ID --approve
fission wait change bootstrap --duration 5m --max-spend 0.01
fission run change info --duration 1m -- uname -a
fission watch
fission close change --output ./saved-change
```

`ui` shows active and past machines, sortable by name, spend or expiry. Enter opens details, then SSH for a ready VM; `x` saves declared output and closes it. `v` verifies payment amounts and transaction references through free Tempo RPC reads. Missing receipts remain unknown. `spending` exposes the same data as JSON; paid amounts include sender USDC.e fees and exclude other assets and later refunds.

Give your agent [AGENTS.md](AGENTS.md) or [llms.txt](llms.txt). Agents use JSON commands directly. Add `--repo https://github.com/OWNER/REPO --ref FULL_COMMIT` for a public source checkout. Upload private files explicitly.

**Available:** Linux x86 VMs through x402Compute/Vultr, prepaid for 24 hours, with SSH and provider expiry. Modal via Tempo supplies shorter Linux sandboxes with opportunistic capacity. Recipes provide Python, pinned Foundry tools, or isolated Reth/Tempo development chains. Source checkout does not compile a client. Custom JSON recipes add preparation and readiness commands.

**Pricing:** `machines` shows up to three cheapest compatible quotes under the VM ceiling, with their average, range and sample size. The average covers creation, is limited to the queried catalog, and never authorizes spending. `budget --vm-max-spend AMOUNT --approve` sets a whole-workspace ceiling; add `--profile PROFILE` to narrow it. Explicit discovery caps can narrow it further. Saved plans and payments recheck the ceiling. The aggregate ledger allocates each workspace's full `--total-spend`; failed request caps and closed allocations are retained. Network fees are separate.

**Limits:** full Reth keeps its 32 GiB RAM and 2 TiB disk floor. No affordable full-node deployment, separate volumes, custom images, or synced Reth/Lighthouse recipe is verified yet. The included Ethereum observer checks an already configured pair. Provider catalog capacity does not establish workload performance.

Close explicitly when finished; a successful job or closed terminal does not delete a machine. `close --output` saves declared artifacts and bootstrap output; use `download` for other files. Failed exports preserve the machine until expiry. Ambiguous deletion requires provider observation. Preserve `FISSION_HOME` and use `reconcile` after interrupted creation. Legacy Loaner state is reused when present, including its budget.

References: [Glue](https://github.com/figtracer/glue), [Reth](https://reth.rs), [Foundry](https://getfoundry.sh), [Tempo](https://github.com/tempoxyz/tempo), [x402Compute](https://docs.x402layer.cc/agentic-access/x402-compute), [Modal](https://modal.com/docs/guide/sandboxes).
