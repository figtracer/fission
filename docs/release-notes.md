The catalog preloads at startup and refreshes behind a responsive TUI. Saved catalogs open immediately. Lists scroll one row at a time; mouse controls and Vim-style navigation share a cleaner layout. Press `?` for keyboard help.

Temporary compute for your coding agent, with a Rust TUI, MPP quotes and budgets, Foundry/Reth/Tempo harnesses, and timestamped run reports.

Download the native package for your agent's computer and verify its matching SHA-256 checksum. Install with `npm install -g ./fission-*.tgz --ignore-scripts`, then run `fission skill install`. Start a new agent session or run `fission` to open the TUI.

Requires Node ≥22.13, SSH, and a configured Tempo CLI wallet. Linux packages require x86-64 and glibc ≥2.35. Repository access is required to download these private releases.
