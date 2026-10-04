Rent Linux machines with your coding agent. Give it a task and a budget; Fission gets quotes, runs the work, collects results and cleans up. Payments use MPP on Tempo.

- **The built-in harnesses are gone.** We removed the Foundry/Reth/Tempo presets in v0.1.1 because they were getting in the way: more restrictions and complexity for work an agent could already handle. Your agent chooses the software, versions and setup. Fission handles the machines, budgets, results and cleanup.
- **DigitalOcean joins Vultr.** More Linux VM options, with quotes before purchase and no provider signup. Both operators are available through the same MPP gateway.
- **An optional always-on controller.** Run Fission on a Linux host so result collection and cleanup continue while your laptop is off. Use the same CLI and Rust dashboard over SSH.
- **Recovery after restarts.** The controller resumes supervision after a process crash or host reboot, preserving task deadlines and payment records. Unresolved purchases and deletions remain visible for review.
- **Simpler setup and help.** Updated agent instructions and controller documentation. Supply your own commands, repositories and setup.

Validated with live rentals and cleanup on both VM operators, real controller restart/reboot checks, and a separate one-hour recovery run covering 39 interrupted workflows with simulated provider operations.

Packages below include the Rust dashboard for Linux x64 and macOS Apple Silicon / Intel. Requires Node.js 22.13+ and SSH.

[Install](https://github.com/figtracer/fission/blob/v0.1.2/docs/install.md) · [Controller setup](https://github.com/figtracer/fission/blob/v0.1.2/docs/controller.md) · [Full changelog](https://github.com/figtracer/fission/compare/v0.1.1...v0.1.2)
