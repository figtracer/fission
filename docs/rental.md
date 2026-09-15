# Rental safety, accounting, and recovery

The normal rental is one managed `fission run`; do not assemble plan/open/prepare/check/job/report/close manually. Preview without `--approve`, inspect the returned quote/resources/timing/provider warning, then repeat unchanged with approval only inside the user's retained budget and duration.

## Authorization and accounting

`fission budget` reads the durable ledger. Initial or lowered ceilings use `--total-spend`/`--vm-max-spend` with `--approve`; only explicit new authorization permits `--raise-to AMOUNT --approval TEXT --approve`. Wallet balance, provider credit, refunds, closed rentals, and failed requests are not spending authority. Leave fee room. The task `--budget` is the entire gateway allocation, not a predicted final bill.

Fission selects the cheapest compatible quote in the requested region while preserving harness floors. A shortlist average is not authority. Provider prepaid credit can outlive TOTAL and early close may not refund it; neither authorizes extra work. `fission advanced spending --refresh` verifies known Tempo USDC.e outflows but missing receipts and other assets remain unknown.

Every request, allocation, and ambiguous outcome remains in `FISSION_HOME`. Never reset history or submit a replacement because a command failed. Keep wallet/SSH credentials and runtime state outside source and reports.

## Durable lifecycle

The detached local supervisor coordinates the recorded task. Terminal disconnect does not stop it. Sleep/reboot pauses that owner while guest job deadlines and provider expiry continue; on wake run `fission status NAME --resume`, which resumes the same intent without another purchase or launch. `status --wait` exit 2 means observation ended unfinished, not that remote work stopped.

TOTAL reserves 30m provisioning, harness preparation, WORK, and 15m cleanup. The last 2m are reserved for the two 60-second HTTP windows for DELETE and confirmation. Evidence transfers share an absolute cutoff. `fission stop NAME` waits for an in-flight operation, records cancellation, and asks the same supervisor to collect available evidence and clean up. Unknown termination, timeout, provider 404, or missing credentials is never confirmed destruction.

Before tools start, bootstrap arms a guest systemd timer to initiate poweroff at the full task deadline if the local owner is unavailable. This is a safety net for a trusted root workload, not a sandbox boundary or exact shutdown-time guarantee. A guest reboot or root command can remove the transient timer. Guest poweroff is not provider destruction: the local owner still requests and confirms deletion on resume. The timer's live firing and gateway behavior after poweroff remain unvalidated.

Final status/report should show outcome, jobs, evidence, observed spending or uncertainty, report path, and cleanup confirmation. A passing process does not by itself establish the experiment's claim.

## Recovery

Use `fission advanced` only for retained legacy workspaces or diagnosed recovery. Never manually mutate a managed task while its supervisor is alive. Creation, resize, upload, launch, and deletion markers are idempotency boundaries: inspect the recorded identifier/effect before considering repair. A confirmed failed preparation may have partial side effects; approve advanced repair only after proving repetition safe. Preserve partial exports and unresolved records.

If the follow-up deletion observation remains unconfirmed, the supervisor writes an unresolved report and exits instead of polling indefinitely or repeating DELETE. `fission status NAME --resume` observes that same recorded deletion. A later destruction confirmation produces a new final report; the earlier unresolved report remains intact. If the provider never confirms destruction, manual provider reconciliation is still required.

Provider history remains material:

- **compute-mpp (September 14, 2026):** the gateway reported a post-payment provisioning-record failure, automatic VM destruction, and account credit, but supplied no credentials to recover the credit. This does not establish an underlying VM-operator fault.
- **smol-orthogonal (September 13, 2026):** lifecycle requests returned `expired_key`; authenticated lifecycle availability remained unresolved.

Warnings do not automatically disqualify a compatible offer, but must be surfaced and interpreted before approval.
