# Unreleased managed redesign

The normal interface is now the Rust dashboard plus `run`, `status`, `stop`, `help`, and `budget`. Foundry, Reth, and Tempo are cohesive harnesses behind one durable managed task; plain Linux is the fallback. Manual lifecycle, jobs, transfers, reports, caches, datasets, SSH, and discovery moved under `fission advanced` for recovery.

Managed runs preview without payment, require explicit `--approve`, preserve retained authorization/history, supervise locally across terminal disconnects, collect bounded evidence, and reserve cleanup time for deletion plus confirmation. Source build mode requires a public repository and full commit SHA; optional patches are applied once before build. Synced Reth supports Ethereum only and requires a canonical full planner/manifest plus independently verified checkpoint.

No release is being produced. Version bumps, tags, and publication remain paused; local development packaging and installation use reviewed source.
