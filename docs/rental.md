# Rental safety, accounting, and recovery

Use managed `fission rent` for a machine you will use yourself, or `fission run` for an automated workflow; do not assemble plan/open/prepare/check/job/report/close manually. Preview without `--approve`, inspect the returned quote/resources/timing/provider warning, then repeat unchanged with approval only inside the user's retained budget and duration.

## Authorization and accounting

`fission budget` reads the durable ledger. Initial or lowered ceilings use `--total-spend`/`--vm-max-spend` with `--approve`; only explicit new authorization permits `--raise-to AMOUNT --approval TEXT --approve`. Wallet balance, provider credit, refunds, closed rentals, and failed requests are not spending authority. Leave fee room. The task `--budget` is the entire gateway allocation, not a predicted final bill.

Fission selects the cheapest compatible quote in the requested region while preserving harness floors. A shortlist average is not authority. Provider prepaid credit can outlive TOTAL and early close may not refund it; neither authorizes extra work. `fission advanced spending --refresh` verifies known Tempo USDC.e outflows but missing receipts and other assets remain unknown.

For a task that must bypass starter migration, `fission run --no-resize` buys the selected VM directly for at least one prepaid day while retaining the requested shorter TOTAL, guest deadline, and early cleanup. Every fallback candidate remains direct. During public alpha, automatic starter resizing is limited to selected targets with at most 4 vCPU and 8 GiB nominal RAM; larger short tasks require `--no-resize`. This qualification boundary is not a provider limit, a reliability guarantee for smaller machines, evidence that direct provisioning will succeed, or evidence that unused provider credit is refundable.

Automatic plans retain compatible alternatives from the same quoted shortlist in ascending quote order. Failed final quotes or changed capacity can select another retained candidate **before purchase intent**, up to the approved task creation cap (budget minus lifecycle headroom). There is no percentage premium rule. Every candidate preserves the requested region, duration and resource floors, and is revalidated before payment. Explicit `--machine` plans and older plans without alternatives remain exact. A new invocation quotes afresh; an existing plan never gains unapproved alternatives. Once creation intent exists, errors are observed rather than used to buy a replacement.

Every request, allocation, and ambiguous outcome remains in `FISSION_HOME`. Never reset history or submit a replacement because a command failed. Keep wallet/SSH credentials and runtime state outside source and reports.

## Durable lifecycle

The detached local supervisor coordinates the recorded task. Terminal disconnect does not stop it. Sleep/reboot pauses that owner while guest job deadlines and provider expiry continue; on wake run `fission status NAME --resume`, which resumes the same intent without another purchase or launch. `status --wait` exit 2 means observation ended unfinished, not that remote work stopped.

TOTAL reserves 30m provisioning, harness preparation, WORK, and 15m cleanup. The last 2m are reserved for the two 60-second HTTP windows for DELETE and confirmation. Evidence transfers share an absolute cutoff. `fission stop NAME` waits for an in-flight operation, records cancellation, and asks the same supervisor to collect available evidence and clean up. Unknown termination, timeout, provider 404, or missing credentials is never confirmed destruction.

VM readiness, catalog refresh, guest verification, and bootstrap share the task's absolute preparation cutoff; a retry never opens a fresh window past it. Short leases pin SSH host identity to the recorded compute order across starter resize or IP changes. Before resize, the Ubuntu starter must report healthy completed cloud-init; after access returns, the target must independently report healthy initialization and the selected CPU, nominal RAM class, and underlying root-disk capacity. Filesystem capacity remains a separate workload check. These initialization observations are durable and are not evicted with the bounded sequence of provider/SSH diagnostics.

The gateway acknowledges that resize started but exposes neither Vultr's upgrade-job identifier nor a job-status or reboot action. Provider plan fields, `active`, `ok`, and `resize_pending: false` therefore do not prove migration completed. Fission submits one resize and accepts convergence only from the same host-key-pinned guest; otherwise it reports an unfinished/failing preparation and preserves cleanup time. Evidence setup/collection failure is reported separately and must not suppress an otherwise possible cleanup attempt.

Before tools start, bootstrap arms a guest systemd timer to initiate poweroff at the full task deadline if the local owner is unavailable. This is a safety net for a trusted root workload, not a sandbox boundary or exact shutdown-time guarantee. A guest reboot or root command can remove the transient timer. Guest poweroff is not provider destruction: the local owner still requests and confirms deletion on resume.

Final status/report should show outcome, jobs, evidence, observed spending or uncertainty, report path, and cleanup confirmation. A passing process does not by itself establish the experiment's claim. Resuming after the collection cutoff can lose guest outputs: each unattempted export is recorded as `not_collected` with its cutoff reason, independently of the job outcome. Fission does not extend the rental or invent a local file to recover it.

## Recovery

Use `fission advanced` only for retained legacy workspaces or diagnosed recovery. Never manually mutate a managed task while its supervisor is alive. Creation, resize, upload, launch, and deletion markers are idempotency boundaries: inspect the recorded identifier/effect before considering repair. A confirmed failed preparation may have partial side effects; approve advanced repair only after proving repetition safe. Preserve partial exports and unresolved records.

If the follow-up deletion observation remains unconfirmed, the supervisor writes an unresolved report and exits instead of polling indefinitely or repeating DELETE. `fission status NAME --resume` observes that same recorded deletion. A later destruction confirmation produces a new final report; the earlier unresolved report remains intact. If the provider never confirms destruction, manual provider reconciliation is still required.

## Provider support

VM purchases use MPP through the configured compute gateway; machine alternatives from that gateway are not independent-provider failover. Catalog reads and dry-run quotes are bounded, preview uses one complete snapshot, and purchase revalidates against a fresh snapshot.

A provider is usable only when the same payment identity and ownership route support create, SSH, status, and terminate with bounded full cost and recoverable request identity. Discovery alone is not support. Never treat provider expiry, guest shutdown, or a missing response as confirmed destruction.
