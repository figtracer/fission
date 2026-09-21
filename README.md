# Fission

Rent machines and run tasks with your coding agent.

Ask for a machine, or give your agent a workflow and a budget. Fission handles
quotes, setup, execution and cleanup, with built-in Foundry, Reth and Tempo
environments. Use SSH yourself or run tasks across multiple machines. Payments
use MPP on Tempo.

Download the [package for your platform](https://github.com/figtracer/fission/releases/tag/v0.1.0)
and verify its checksum ([installation guide](docs/install.md)). Requires Node.js 22.13+ and SSH.

```sh
npm install -g ./fission-0.1.0-PLATFORM.tgz --ignore-scripts
fission install
fission
```

The package includes the Rust dashboard and agent skill. Configure your
[Tempo wallet](https://docs.tempo.xyz/cli) before buying a machine.

Tell your agent: **“Get me a Linux machine within this budget”** or
**“Run this workflow on Linux and bring back the results.”** Every rental has a
budget and deadline; automated workflows also return local results and spending.

Use `fission help` to explore commands.

[Installation](docs/install.md) · [Agent skill](skills/fission/SKILL.md) ·
[Environments](docs/harnesses.md) · [Synced nodes](docs/reth.md) ·
[Budgets and recovery](docs/rental.md)
