# loaner

temporary compute for your coding agent.

Loaner lets your local agent plan a workspace, pay through Tempo, prepare tools, run jobs, collect files, and close the workspace when the task is done. Remote jobs survive the local CLI exiting; the provider enforces the workspace lifetime.

## Use

Requires Node >=22.13 and a configured Tempo CLI wallet.

```sh
git clone https://github.com/figtracer/loaner.git
cd loaner
npm link --ignore-scripts

loaner capabilities
loaner budget --total-spend 5 --approve
loaner plan change --recipe foundry --duration 2h --max-spend 1 --total-spend 2
loaner open change --plan PLAN_ID --approve
loaner wait change bootstrap --duration 5m --max-spend 0.01

loaner run change version --duration 1m -- /workspace/forge --version
loaner job change version --refresh
loaner watch
loaner close change --output ./saved-change
```

Give your agent [AGENTS.md](AGENTS.md). `plan`, `run`, `job`, `wait`, and `capabilities` return JSON. `list` and `status` accept `--json`. Plans preserve recipe digests, requirements, budgets and optional source commits. Add `--repo https://github.com/OWNER/REPO --ref FULL_COMMIT` for a public source checkout. Private files use explicit `upload`/`download` commands.

## Available now

**Modal via Tempo:** Linux sandboxes with opportunistic capacity. Recipes supply Python, Foundry 1.8.1, Reth 2.5.2 with a local development chain, or Tempo 1.14.0 with an isolated development chain. Downloads are checksum pinned. Jobs have durable IDs, logs, deadlines and optional readiness commands. No model or wallet runs in the guest.

**Not available:** guaranteed-size builds, Windows rental, full VMs, custom images, or a synced Reth/Lighthouse deployment. Their resource profiles fail before payment; they are requirements, not working providers. Smol’s gateway currently rejects lifecycle access; AgentVM’s MPP profile does not meet the capacity/lifecycle contract. The included Ethereum readiness observer checks peers, sync, fresh execution head and non-optimistic consensus; it does not deploy nodes.

## Lifetime and spending

Close explicitly when finished. A closed terminal, successful job or closed PR does not terminate the workspace. `close --output` exports declared files and bootstrap logs first; use `download` for other outputs. Failed export preserves the workspace until expiry. `--discard-output` closes without saving.

The aggregate budget conservatively allocates each workspace’s `--total-spend`. Every gateway request reserves its cap, including failed or ambiguous calls. Allocations are not automatically reclaimed. `--max-spend` caps creation; later calls cost at most 0.0001 USDC.e each, and transfers require multiple calls. Network fees are separate. Two calls are reserved for shutdown/confirmation.

Cached views are free; explicit refresh/wait is paid. Deadlines shown locally are estimates. Preserve `~/.local/state/loaner` (`LOANER_HOME` overrides it), reconcile interrupted requests, and retrieve files before expiry.

References: [Glue](https://github.com/figtracer/glue), [Reth](https://reth.rs), [Foundry](https://getfoundry.sh), [Tempo](https://github.com/tempoxyz/tempo), [Modal](https://modal.com/docs/guide/sandboxes).
