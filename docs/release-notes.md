Pruned full Reth snapshots now verify execution genesis through local IPC network identity. The controller records its IPC path, and readiness retains mainnet identity, canonical payload, peer, sync, and head freshness checks. RPC failures include their parameters and server error.

Storage output names Fission's own storage fee explicitly (`fissionStorageCharge`, replacing `recurringStorageCharge`). User-mounted storage retains its own billing.

Mouse and keyboard tab navigation now leaves the Storage and Help views consistently.

The selected local storage directory now reaches managed tmux sessions even when a tmux server is already running.

Keep verified build artifacts and prepared Reth execution data in a local directory or mounted drive. The Rust TUI's Storage view shows the location and available space. Dataset collection resumes verified chunks; restored datasets use the pinned writer and a fresh node startup.

Named readiness checks distinguish installed tools, verified builds, and synced nodes. Portable experiment records retain the recipe, source, workload, environment, measurements, logs, receipts, and cleanup status. Reruns use a fresh plan and budget.

Concurrent VM requests serialize budget reservations. Free SSH transfers retain their request journals without repeatedly rewriting the monetary ledger. SSH opens from verified, unexpired access details, keeping tmux windows independent of job locks.

Download the native package and verify its matching SHA-256 checksum. Install with `npm install -g ./fission-*.tgz --ignore-scripts`, then install the bundled agent skill. Use `fission help` for commands.

Requires Node ≥22.13, SSH, and a configured Tempo CLI wallet. Linux packages require x86-64 and glibc ≥2.35. Repository access is required to download these private releases.
