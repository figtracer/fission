# Fission 0.1.0

Rent machines and run tasks with your coding agent.

- Get a prepared machine with `rent`, connect with `ssh`, or execute a workflow with `run`.
- Built-in Foundry, Reth and Tempo setup; custom Linux environments and multi-machine tasks.
- Preview quotes before payment. Budgets, readiness, deadlines, results and cleanup share one managed lifecycle.
- Rust dashboard with keyboard/mouse navigation and optional tmux SSH windows.
- Agent skill routes ordinary requests to the required setup, including configurable node and snapshot preparation.

Download the package for macOS Apple Silicon, macOS Intel or Linux x86_64 and its
matching `.sha256` file. Verify the checksum, then:

```sh
npm install -g ./fission-0.1.0-PLATFORM.tgz --ignore-scripts
fission install
fission
```

Requires Node.js 22.13+, SSH and a configured Tempo wallet for MPP payments.
Linux requires glibc 2.35+. Rust is needed only when building from source.
Use `fission help` for commands and the installation guide for platform details.

Live qualification: four small Linux/Foundry/Reth-tools/Tempo-dev rentals reached
readiness in roughly 140–160 seconds and were confirmed deleted. Total verified
receipt outflow: 0.880144 USDC.e. These checks do not establish full-node sync times
or every supported configuration. AgentVM is listed with prototype evidence;
managed integration remains pending. Multi-machine service wiring is supplied by
the workflow. Provider warnings retain earlier failures.
