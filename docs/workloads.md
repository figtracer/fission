# Workload guidance

Fission no longer maintains a separate workload-card catalogue. Choose one of the three cohesive harnesses and its mode in [harnesses.md](harnesses.md):

- [Foundry](harnesses.md#foundry): tools, bounded symbolic work with Z3, or source build
- [Reth](harnesses.md#reth): private dev chain, source build, or synced Ethereum
- [Tempo](harnesses.md#tempo): private dev chain, Foundry contract model, or source build

Use the [Linux fallback](harnesses.md#linux) only when none applies. Detailed synced-node inputs and evidence are in [reth.md](reth.md). Historical detailed cards are intentionally not duplicated in this repository; their useful result-interpretation and limitation guidance has been consolidated into those sections.

The harness selects infrastructure; the agent still chooses a representative, bounded command and completion condition. Prefer prebuilt tools for contract tests and compile only changed clients. Availability and bootstrap do not establish readiness or correctness. Do not use Fission for autonomous exploit finding.
