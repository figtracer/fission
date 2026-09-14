# Rental

Use this guide when renting compute or recovering an existing workspace. Amounts below are placeholders for the user's existing authorization.

## Quote and open

Inspect `fission budget` and `fission list --json`. For initial setup, record the agreed aggregate gateway budget with `fission budget --total-spend AMOUNT --approve` and a VM ceiling with `fission budget --vm-max-spend AMOUNT --approve`. Leave network-fee room within the user's overall authorization. Reuse the existing ledger; its aggregate ceiling can only be lowered while still covering retained allocations and configured ceilings.

For an ordinary Foundry VM:

```sh
fission plan NAME --recipe foundry --cheapest --budget AMOUNT --region ams --duration 24h
fission open NAME --plan PLAN_ID --approve
```

Choose the recipe/profile for the task. Planning pays nothing and returns executable `open` arguments. Opening the reviewed plan rechecks its terms and submits `bootstrap` once. Use `--approve` within existing authorization; changes beyond it require a new user decision.

`--budget` is the whole-workspace gateway allocation. It replaces `--max-spend` and `--total-spend`; creation is capped at the final quote. The 0.0003 lifecycle accounting floor is not an estimate of future usage. Allow room for observations, commands, exports, and shutdown. Allocations remain retained after close; failed requests retain their reserved caps. Two operation caps are protected for termination/status.

`--cheapest` requires budget mode, an explicit region and duration. It selects the lowest successful quote among up to three compatible catalog candidates under the ceiling. A chosen machine and `--cheapest` are mutually exclusive. For manual selection, use `fission machines --profile PROFILE --region ams --duration 24h`, then pass the returned provider, machine, and region to `plan`. Profile ceilings and discovery caps only narrow the global VM ceiling. Empty offers preserve requirements and budget.

Discovery reads all four compute catalog categories and fails on incomplete retrieval. Quote statistics describe one provider's capped shortlist. Capacity uses vCPUs and GiB, with decimal disk GB converted conservatively. The compute backend provisions Vultr Ubuntu 24.04 x86 VMs with private per-workspace SSH and management credentials. A 24-hour request rents the target directly; shorter requests use the credit conversion below. Early close carries no refund guarantee.

## Shorter target leases

For a shorter target lease, use `--duration 2h` with `--cheapest`, or a compatible explicit `--machine`. The plan quotes prepaid starter funding and records both machines, rates, requested target time, and estimated converted time. Supported routes stay within the verified Vultr `vc2` or AMD `voc-m` families and upgrade CPU, RAM, and disk in the same region. `open --approve` authorizes the saved starter purchase and one disk-growing resize using existing credit, with no additional payment.

Funding uses whole starter days and includes a 30-minute preparation allowance, based on the observed 13-minute migration plus provisioning and guest checks. The estimate is not a fixed expiry; small targets can receive substantially more prepaid time than requested. The requested duration is the minimum remaining target lease before bootstrap, covering preparation and work from that point.

`open` records and submits resize, then returns while migration runs. Observe `status NAME --refresh --json`; call `prepare NAME` to continue. Preparation observes the existing resize, verifies target resources and actual expiry, and submits bootstrap once. It returns without bootstrap while migration is pending. Lost acknowledgements are resolved by observing the same target; resize is never automatically resubmitted. If capacity or remaining time falls short, inspect or close the machine.

Guest verification records usable memory, CPU, filesystem capacity, and free space. RAM uses provider nominal GiB plus usable guest memory rounded upward to a whole GiB for reserved pages. Workload-specific free-space gates still apply before snapshot import. The TUI shows observed resources during migration rather than presenting the target as already available.

## Run and collect

Observe bootstrap with `fission job NAME bootstrap --refresh`. Use `fission run NAME JOB --duration DURATION -- COMMAND ARG...` for work in `/workspace`, with a unique job name. Commands use argv; request an explicit shell when needed. `fission jobs NAME` lists recorded jobs.

`job --refresh` observes a workload; `status --refresh --json` observes its provider. `list`, ordinary `status`, and `watch` use cached state. A refreshed `watch` needs a foreground spending cap. `wait` exit 2 means its observation time/budget ended; inspect the returned phase because the remote job may continue. Exit 1 indicates failure or error. Stopping an observer leaves the remote lease in effect. The job supervisor bounds its foreground process group; detached services can run until explicit stop or lease expiry.

Download the returned log path and required outputs with `fission download NAME /remote/file NEW_LOCAL_FILE`. Stop writers first: exports stream regular files with checksum verification and a three-minute SSH limit. Keep snapshots and databases remote. Sandbox transfers suit modest files.

`fission close NAME --output NEW_DIRECTORY` saves recipe-declared files and bootstrap output, then terminates. Download arbitrary job outputs separately. Use `--discard-output` when remaining files can be discarded. Confirm the returned termination state; an export failure leaves the VM subject to its lease.

## Recovery

Preserve uncertain records. `fission reconcile NAME` recovers saved creation responses and observes the same resource. A missing remote ID needs provider/payment investigation. `termination_unknown` needs a fresh provider observation before another close or a cleanup claim. A launch marker without a running/completed supervisor remains unresolved; inspect the recorded job rather than submitting an equivalent one.

If provisioning ended before bootstrap was recorded, observe the existing VM and explicitly `prepare NAME`. Recorded bootstrap jobs are observed, not replayed. Only `not_submitted`, written when the reservation boundary rejected a request before dispatch, permits replanning with that name. Before removing a stale operation lock, verify its PID has exited.

A provider resize sets `resizePending` and blocks new work while status/recovery remain available. The earliest recorded expiry bounds work during migration. After completion, `observedResources` describes current provider capacity separately from the saved plan.

## Funding and receipts

The plan's `funding` object carries Tempo chain 4217, the exact USDC.e payment token, creation amount, and allocation. Wallet balance and shortfall remain unknown. Use its preview arguments for an existing authorized Glue policy, matching the sender and `receiveToken` (`usdc.e`); Glue's `token` denotes swap input. New refill policies, targets, grants, or swap budgets need separate authorization. Fission supplies the handoff; the operator manages Glue execution.

`fission spending --refresh` verifies saved transaction references through free Tempo RPC reads. It reports deduplicated sender USDC.e outflow, including fees in that token. Missing receipts remain unknown; other assets and later refunds are excluded. Receipts describe payments, while the retained ledger bounds authorization.

## Provider history

`!` marks a provider with a recorded request failure. Failed provider operations retain this marker in local history; successful later requests do not clear it. User job exit codes and cancelled observers are separate from provider failures. The TUI shows the symbol; CLI quotes and plans include a warning linked here. The marker describes provider history, independently of the selected machine's state, and leaves the provider selectable where it otherwise meets requirements.

- **compute-mpp:** On September 14, 2026, the MPP gateway reported a provisioning-record failure after payment, automatic VM destruction, and account credit. It supplied no credentials to recover that credit. The response concerns the gateway; it does not establish a fault in its underlying VM operator.
- **smol-orthogonal:** Lifecycle requests returned `expired_key` on September 13, 2026. Authenticated lifecycle access remains a separate availability requirement.
