# Rental safety, accounting, and recovery

The normal rental is one managed `fission run`; do not assemble plan/open/prepare/check/job/report/close manually. Preview without `--approve`, inspect the returned quote/resources/timing/provider warning, then repeat unchanged with approval only inside the user's retained budget and duration.

## Authorization and accounting

`fission budget` reads the durable ledger. Initial or lowered ceilings use `--total-spend`/`--vm-max-spend` with `--approve`; only explicit new authorization permits `--raise-to AMOUNT --approval TEXT --approve`. Wallet balance, provider credit, refunds, closed rentals, and failed requests are not spending authority. Leave fee room. The task `--budget` is the entire gateway allocation, not a predicted final bill.

Fission selects the cheapest compatible quote in the requested region while preserving harness floors. A shortlist average is not authority. Provider prepaid credit can outlive TOTAL and early close may not refund it; neither authorizes extra work. `fission advanced spending --refresh` verifies known Tempo USDC.e outflows but missing receipts and other assets remain unknown.

For a task that must bypass starter migration, `fission run --no-resize` buys the selected VM directly for at least one prepaid day while retaining the requested shorter TOTAL, guest deadline, and early cleanup. Every fallback candidate remains direct. This is a diagnostic/selection constraint, not evidence that resizing works or that unused provider credit is refundable.

Automatic plans retain compatible alternatives from the same quoted shortlist in ascending quote order. Failed final quotes or changed capacity can select another retained candidate **before purchase intent**, up to the approved task creation cap (budget minus lifecycle headroom). There is no percentage premium rule. Every candidate preserves the requested region, duration and resource floors, and is revalidated before payment. Explicit `--machine` plans and older plans without alternatives remain exact. A new invocation quotes afresh; an existing plan never gains unapproved alternatives. Once creation intent exists, errors are observed rather than used to buy a replacement.

Every request, allocation, and ambiguous outcome remains in `FISSION_HOME`. Never reset history or submit a replacement because a command failed. Keep wallet/SSH credentials and runtime state outside source and reports.

## Durable lifecycle

The detached local supervisor coordinates the recorded task. Terminal disconnect does not stop it. Sleep/reboot pauses that owner while guest job deadlines and provider expiry continue; on wake run `fission status NAME --resume`, which resumes the same intent without another purchase or launch. `status --wait` exit 2 means observation ended unfinished, not that remote work stopped.

TOTAL reserves 30m provisioning, harness preparation, WORK, and 15m cleanup. The last 2m are reserved for the two 60-second HTTP windows for DELETE and confirmation. Evidence transfers share an absolute cutoff. `fission stop NAME` waits for an in-flight operation, records cancellation, and asks the same supervisor to collect available evidence and clean up. Unknown termination, timeout, provider 404, or missing credentials is never confirmed destruction.

VM readiness, catalog refresh, guest verification, and bootstrap share the task's absolute preparation cutoff; a retry never opens a fresh window past it. Short leases pin SSH host identity to the recorded compute order across starter resize or IP changes. Before resize, the Ubuntu starter must report healthy completed cloud-init; after access returns, the target must independently report healthy initialization and the selected CPU, nominal RAM class, and underlying root-disk capacity. Filesystem capacity remains a separate workload check. These initialization observations are durable and are not evicted with the bounded sequence of provider/SSH diagnostics.

The gateway acknowledges that resize started but exposes neither Vultr's upgrade-job identifier nor a job-status or reboot action. Provider plan fields, `active`, `ok`, and `resize_pending: false` therefore do not prove migration completed. Fission submits one resize and accepts convergence only from the same host-key-pinned guest; otherwise it reports an unfinished/failing preparation and preserves cleanup time. Evidence setup/collection failure is reported separately and must not suppress an otherwise possible cleanup attempt.

Before tools start, bootstrap arms a guest systemd timer to initiate poweroff at the full task deadline if the local owner is unavailable. This is a safety net for a trusted root workload, not a sandbox boundary or exact shutdown-time guarantee. A guest reboot or root command can remove the transient timer. Guest poweroff is not provider destruction: the local owner still requests and confirms deletion on resume.

On one Linux x86_64 Tempo dev VM (September 15, 2026), the unchanged one-hour timer started its poweroff service and the same boot reported `stopping` while the local owner was suspended. Resuming the owner confirmed provider destruction. Final kernel/hypervisor poweroff was not observed; this did not test an actual host or guest reboot.

Final status/report should show outcome, jobs, evidence, observed spending or uncertainty, report path, and cleanup confirmation. A passing process does not by itself establish the experiment's claim. Resuming after the collection cutoff can lose guest outputs: each unattempted export is recorded as `not_collected` with its cutoff reason, independently of the job outcome. Fission does not extend the rental or invent a local file to recover it.

## Recovery

Use `fission advanced` only for retained legacy workspaces or diagnosed recovery. Never manually mutate a managed task while its supervisor is alive. Creation, resize, upload, launch, and deletion markers are idempotency boundaries: inspect the recorded identifier/effect before considering repair. A confirmed failed preparation may have partial side effects; approve advanced repair only after proving repetition safe. Preserve partial exports and unresolved records.

If the follow-up deletion observation remains unconfirmed, the supervisor writes an unresolved report and exits instead of polling indefinitely or repeating DELETE. `fission status NAME --resume` observes that same recorded deletion. A later destruction confirmation produces a new final report; the earlier unresolved report remains intact. If the provider never confirms destruction, manual provider reconciliation is still required.

Provider history remains material:

- **compute-mpp (September 14, 2026):** the gateway reported a post-payment provisioning-record failure, automatic VM destruction, and account credit, but supplied no credentials to recover the credit. This does not establish an underlying VM-operator fault.
- **smol-orthogonal (September 13, 2026):** lifecycle requests returned `expired_key`; authenticated lifecycle availability remained unresolved.

Warnings do not automatically disqualify a compatible offer, but must be surfaced and interpreted before approval.

## Gateway qualification

MPP and x402 are permitted payment protocols. The implemented VM purchase path remains `compute-mpp` through `compute.x402layer.cc`; its Vultr plan alternatives are **not independent gateways**. Catalog reads and dry-run quotes have 60-second bounds; errors identify the stage, gateway and failed catalog category or plan. Preview reuses one complete catalog snapshot; purchase revalidates against a fresh snapshot. A catalog-wide outage still blocks selection. Failed shortlist quotes retain their reasons rather than only a count.

Free discovery on September 15, 2026 found these additional candidates:

| Gateway | Observed capability | Remaining blocker |
| --- | --- | --- |
| [VPS PhoneAgent](https://vps.phoneagent.xyz/llms.txt) via Mercator | x402 VPS rental; live monthly SKUs from $12.99 | Hourly sandboxes documented unavailable; Mercator `/rent` quotes returned non-retryable `invalid_challenge`/402; immediate destroy not documented |
| [AgentMetal](https://agentmetal.dev/llms.txt) | Live VPS catalog from $1.20/day, SSH, US regions | Early destroy requires an account bearer key; no configured Base signing/authentication path or verified x86 lifecycle |
| [Palmyr](https://palmyr.ai/compute/plans) | Hetzner x86 VPS plans, monthly billing, SSH and paid destroy | Mercator lists SSH-key registration only, not provision/status/destroy; all lifecycle calls require the original payer identity |
| BlockRun via [Mercator](https://mercator.tempo.xyz/docs) | Direct 402 advertises $0.011 per 300s CPU sandbox and $0.002 per lifecycle call | Repeated create quotes return `invalid_challenge`; Mercator rejects exec/status/terminate as not cataloged. Direct endpoints respond in under a second; this is not evidence of a provisioning timeout |
| Vaaya via [Mercator](https://mercator.tempo.xyz/docs) | Live advisory quotes: $0.05 per 300s create, $0.01 per exec | Mercator explicitly rejects status/terminate as not cataloged, although direct routes return payment challenges. No complete lifecycle or reserved x86 resources verified |
| [OpenVPS](https://github.com/kartojal/openvps) | Independent Firecracker VM implementation with MPP, SSH, status and immediate delete | Published deployment `openvps.sh` refused HTTPS connections; code availability does not prove a running service |
| [PayWeave Sandbox](https://sandbox.payweave.services/skill.md) | $0.01 single-use execution, MPP USDC.e or x402, at most 60s | No persistent machine, SSH, capacity guarantees or separate status/terminate routes; incompatible with existing managed preparation and artifact transfers |

Palmyr's [pinned compute implementation](https://github.com/0xArtex/Palmyr/blob/64f9aa9113875762259a7b6a39d1d421b1e295de/src/routes/compute.ts) requires an explicit location to prevent automatic architecture substitution. Its destroy costs 0.10 USDC in addition to monthly provisioning. When an intermediary pays, the intermediary's wallet owns the VM: catalog discovery alone does not establish that later status and deletion will use the same identity.

Mercator can accept Tempo payment while handling downstream x402, so direct Base signing is not inherently required. A usable integration still needs cataloged lifecycle routes, stable ownership, bounded full cost, recoverable request identity, Linux x86 resources and verified artifact/SSH/cleanup behavior. None of these newly discovered gateways has passed that complete Fission validation. Do not label them supported, create a second wallet, or infer refunds from a provider promise.

The September 15 BlockRun/Vaaya checks compared fresh service descriptions, unsigned direct challenges, and Mercator quotes for all four operations. BlockRun's header contains x402 v2 resource/payment fields, while its JSON body omits the resource and also advertises an alternate `WWW-Authenticate` challenge. Parser incompatibility is a hypothesis, not a proven root cause; Mercator source was unavailable. Vaaya's create/exec quotes succeeded repeatedly. Its missing lifecycle routes are a distinct catalog restriction, not a timeout to retry indefinitely. A Python-urllib probe also hit an edge 403; curl reached the actual API, so that client-specific failure is not a provider outage.

Enable a candidate only after the same payment/ownership route supports create, exec, status and terminate, and a bounded live cycle confirms execution, locally retained output and cleanup. Never use another Modal tenant's lifecycle endpoint as a workaround, buy an unmanageable sandbox to test an already-blocked route, or treat expiry as destruction. The dashboard's read-only Gateways view shows the usable subset of the metadata that `advanced capabilities` emits in full; dated per-call/per-month advisories stay separate from comparable live VM offers.
