# Fission

Temporary Linux compute for your coding agent, paid through MPP.

Ask your agent: **“Test this change on Linux within this budget.”** It prepares a
task, finds a suitable machine, checks readiness, runs the work, and returns a
local report with results, spending and cleanup status.

Foundry, Reth and Tempo provide built-in setup. Task files can describe other
software, node configurations, inputs and readiness checks using the same lifecycle.

```sh
fission       # Open the Rust dashboard
fission help  # Explore commands
```

The task includes its own budget, resource requirements, preparation allowance and
work deadline. Approval is bounded by the retained spending authorization. Reports
include measured timing and any unresolved cost or cleanup information.

Install from a reviewed checkout with Node.js 22.13+, Rust and SSH:

```sh
npm install
npm run setup
```

- [Agent skill](skills/fission/SKILL.md)
- [Task files and harnesses](docs/harnesses.md#task-files)
- [Synced nodes](docs/reth.md)
- [Budgets and recovery](docs/rental.md)
- [Installation](docs/install.md)

Fission is an independent, early-stage project. Releases are currently paused.
