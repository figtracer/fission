# Fission for agents

Fission turns an authorized budget, duration, source/input, workload argv, and completion condition into one managed Linux run. Use Foundry, Reth, Tempo or Linux shortcuts where they fit; otherwise describe the environment in a managed task file (see docs/harnesses.md#task-files). Built-ins are defaults, not an allowlist. The local agent chooses and interprets the experiment. Fission owns quote selection, provisioning, preparation/readiness, durable execution, evidence, and cleanup; it never embeds an LLM on the VM.

## Normal workflow

1. Read `fission help run`, `fission budget`, and the relevant section of [docs/harnesses.md](docs/harnesses.md). Read [docs/reth.md](docs/reth.md) before synced Ethereum and [docs/rental.md](docs/rental.md) for authorization or recovery questions.
2. Preview `fission run NAME --harness ... --budget ... --duration TOTAL --work-duration WORK --region ... -- ARGV`. Preview pays nothing. Inspect quote, resources, timing evidence, uncertainty, provider warning, and retained authorization.
3. Repeat the identical command with `--approve` only inside existing authorization. Do not treat balance, provider credit, or a failed/closed run as permission.
4. Observe with `fission status NAME [--wait DURATION]`. After local sleep/reboot, use `--resume`; this resumes the same recorded work and never purchases or submits it again.
5. Use `fission stop NAME` for early cancellation, then status until cleanup is confirmed. Unknown is never confirmed destruction.

Use `--repo` with a public GitHub URL and `--ref` with a full 40-character SHA for test/build modes. `test` prepares source and runs the selected Cargo tests without a release build first; `build` produces release binaries. `--patch` is applied once before testing/building; use `--input FILE[=/workspace/path]` for regular workload files and `--artifact /workspace/file` for bounded outputs. Keep credentials out of argv, patches, inputs, logs, and reports.

Read `help run HARNESS` for scoped options and `help index WORDS` for revision-pinned guidance. Verify differing revisions against source/help. Source previews inspect local, mounted, or explicitly selected VPS-backed caches before quotes; exact-identity release-binary reuse is not Cargo test/incremental caching. A cache VPS is a separate retained advanced workspace with its own lease/budget and explicit destruction, never a managed workload or automatic replacement. Inspect artifact collection separately from test success. For explicitly approved multi-machine work, `run NAME --from FILE --budget TOTAL` uses ordinary per-role tasks and a summed budget; purchases are sequential, with no automatic replacements. Multi-day durations still require explicit authorization.

All manual lifecycle, jobs, transfers, reports, storage, cache, dataset, SSH, and discovery commands are secondary: `fission advanced COMMAND`. Never mutate a managed task through advanced commands while its supervisor is alive.

The dashboard groups by outcome: Succeeded, Active, Unsuccessful, Unresolved, then collapsed Closed history under all records. Experiments stay together; active members keep the group active, otherwise its least-successful member determines the group. Succeeded requires confirmed cleanup; Unresolved is never proof of destruction. `[advanced]` marks unfinished legacy workspaces without a task supervisor, not a second class of supported managed runs. Use `status` and reports for authoritative outcome, costs and cleanup rather than inferring them from list position or dim styling.

## Boundaries

- Use MPP/Tempo for purchases. Catalog presence does not establish a usable VM lifecycle. Do not add wallets, keys, swaps, bridges or on-ramps to enable a provider. Preserve the `FISSION_HOME` ledger, allocations, unresolved requests, receipts, and existing workspace history. Record each purchase and launch once; observe ambiguous effects rather than replaying them.
- Automatic selection prefers the cheapest compatible retained candidates within the task creation cap, preserving lifecycle headroom, resources, region and duration. There is no percentage premium limit. Fallback is allowed only before purchase intent; an ambiguous creation never authorizes another machine. Explicit machine plans remain exact. All currently eligible VM plans share one gateway; do not claim independent-provider failover.
- Public-alpha automatic resize is limited to selected targets at or below 4 vCPU and 8 GiB RAM. Larger short tasks require `--no-resize`, which buys the selected VM directly (at least one prepaid day) while preserving the shorter task deadline; preview and fallback candidates must all remain direct. This is an evidence boundary, not a provider limit or proof that direct provisioning succeeds.
- Total duration includes policy allowances of 30m provisioning, 10m prebuilt or 1h source build or 4h synced preparation, requested work, and 15m cleanup. These dated-evidence estimates are not guarantees. Cleanup reserves its final 2m for DELETE plus confirmation.
- VM status, SSH readiness, initialization, guest verification and bootstrap share the original absolute preparation cutoff. Resize requires healthy completed cloud-init on the starter and target plus guest-observed selected CPU, nominal RAM class and underlying root disk; provider plan/status fields do not establish convergence because the gateway exposes no upgrade-job state. Inspect bounded access observations and durable initialization evidence after failure. Never weaken host-key checks, repeat resize, or postpone cleanup to obtain SSH.
- A local sleep pauses the owner, not guest deadlines or prepaid expiry. Bootstrap arms guest shutdown at the full task deadline; that is not provider deletion. Resume on wake. Observer timeout or provider 404 does not prove the VM stopped.
- Judge the requested result, not bootstrap success. Distinguish bounded test evidence, symbolic pass, replay-confirmed counterexample, and incomplete execution. Compare equivalent baseline/candidate conditions for performance claims.
- Close independently of PR state. Return outcome, measurements, interpretation, limitations, observed cost/uncertainty, report path, and cleanup status.

## Working on Fission

Keep the Node backend authoritative for plans, payment, durable state, jobs, and lifecycle; the Rust TUI is a client and Python harnesses run on the guest. Keep one repository and the existing local runner (no Orbs). During the release pause, do not bump versions, tag, publish, rent machines, or use screens for repository validation unless explicitly authorized. Command contracts belong in code/help; docs provide workflow and interpretation without duplicating policy implementation.

Consult Amp's built-in Oracle whenever guidance or planning help is needed, including consequential design decisions and unresolved technical questions. Use its advice to inform the plan, then verify and own the implementation.

Stay on major zero; use minor increments only when future publication is requested. Preserve historical prereleases. Keep experiment fixtures and reports outside the product repository. Run `FISSION_TEST_DIR=/absolute/verification npm test` against the external suite, plus a locked Rust build and representative executable workflows within the current spending authority. Do not turn fixture checks into live-validation claims.
