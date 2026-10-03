import { guide, guideTopics } from "./onboarding.mjs";

const run = `Run your commands on a Linux machine; preview without --approve.

Usage: fission run NAME --budget AMOUNT --duration TOTAL --work-duration WORK
       --region REGION [OPTIONS] [--approve] -- COMMAND [ARG...]
       fission run NAME --from task.json --budget AMOUNT [--approve]

Fission selects a compatible machine, runs your commands, collects requested
files and logs, and cleans up. You choose the software, setup and success checks.
Commands are argv arrays; use sh -c explicitly for a shell script.

Options:
  --cpu N --memory GiB --disk GiB  Minimum machine resources
  --machine ID                    Select an exact catalog machine
  --no-resize                     Direct provisioning (required above 4 CPU/8 GiB)
  --input FILE[=/workspace/PATH]   Upload a file; repeatable
  --secret FILE[=NAME]             SSH file at /workspace/.fission/secrets/NAME
  --encrypt-to AGE_RECIPIENT       Encrypt collected files and logs with local age
  --artifact /workspace/PATH      Retrieve an output file; repeatable
  --cwd DIR                       Guest working directory (default /workspace)
  --repo URL --ref SHA            Optional public GitHub checkout at a full commit
  --prepare-duration D            Setup allowance (default 10m)
  --output DIR                    Local results (default ./fission)

TOTAL includes 30m provisioning, setup, WORK and 15m cleanup. Allowances are
estimates, not performance guarantees. A prepaid lease may outlast your task.
Large direct machines may require prepaying a day; inspect the quote.

A task file contains {schemaVersion: 1, task: {...options, command: ["program"]}}.
Optional preparation contains argv arrays run after inputs arrive. Optional checks
contain {name, scope: "tools", argv, result: "exit"|"json"}; JSON checks must emit
{"ready":true}. No application checks are required or inferred. Setup failures
stop the run. Use scripts or source archives for any repository or toolchain.

Secrets are file references, read once when sent; values stay out of command
arguments and transfer records. Workloads can still disclose them in output.
Encrypted collection needs age locally and a native age1 public recipient; the
private identity is never needed by Fission. Metadata and observations remain
local plaintext. See docs/privacy.md for recovery and decryption.

For multiple machines, replace task with machines: [{name, ...task}, ...]. Each
has its own budget and lifetime; --budget bounds the combined allocation.
Purchases are sequential, not atomic. Fission never silently buys a replacement.
Coordination between workloads is supplied by your commands.

See help tasks for an example and help code for short jobs without a VM.
Use status NAME --wait 10m to observe; stop NAME requests early cleanup.`;

const rent = `Rent a Linux machine for SSH access; preview without --approve.

Usage: fission rent NAME --budget AMOUNT --duration TOTAL --region REGION
       [--cpu N --memory GiB --disk GiB] [--approve]
       fission rent NAME --from task.json --budget AMOUNT [--approve]

Use status NAME --wait 10m, then ssh NAME. Install and run whichever software
you need. Optional task-file preparation runs your setup before handover.
Use the same fields as run, omitting command and work-duration.

TOTAL includes provisioning, setup and cleanup from purchase, not guaranteed
hands-on time. The rental stays open until stop NAME or its authorized cutoff.
Disconnecting SSH does not stop it. Use stop NAME and confirm cleanup with status.
SSH --tmux selects its window inside the Fission tmux dashboard.
See help run for resource, transfer and setup options.`;

const status = `Observe tasks or resume the same recorded task.

Usage: fission status [NAME] [--json]
       fission status NAME [--resume] [--refresh] [--wait DURATION]

Default reads saved task/job results, cost uncertainties, report and cleanup.
--resume starts a detached owner if absent; it never purchases or resubmits jobs.
Only locks whose recorded PID has exited can be recovered. Unknown owners remain.
--refresh observes the provider; --wait observes saved progress (no paid polling).
For rentals, waiting stops when access is ready or cleanup finishes.
Waiting exits 0 for success/ready/closed, 1 for a finished failure, 2 if unfinished.
Ctrl-C stops waiting, not the task. Use stop for cancellation.
Host sleep pauses coordination; guest job deadlines and prepaid lease still bound
work. Bootstrap also arms guest poweroff at the full task deadline. Poweroff does
not confirm provider destruction. On wake use --resume; see help rental for limits.`;

const budget = `Inspect or record the retained authorization ledger.

Usage: fission budget
       fission budget --total-spend AMOUNT --vm-max-spend AMOUNT --approve
       fission budget --vm-max-spend AMOUNT [--profile PROFILE] --approve
       fission budget --raise-to AMOUNT --approval TEXT --approve

Initialize only from the user's authorization. --total-spend can lower an existing
ceiling, not increase/reset it. --raise-to records newly authorized funds with a
dated amendment; never infer permission from wallet balance or a closed rental.
Allocations and unresolved requests remain retained. Fees need separate room.
Read fission help rental for accounting and recovery details.`;

// Recovery syntax shares the actual low-level implementations, not a second
// lifecycle. Detailed policy belongs in the guides rather than a duplicate index.
const advanced = {
  plan: "NAME --recipe RECIPE --budget AMOUNT --duration DURATION --cheapest --region REGION [--repo URL --ref SHA] [--cpu N --memory GiB --disk GiB]",
  open: "NAME --plan PLAN_ID --approve",
  prepare: "NAME [--duration DURATION]",
  repair: "NAME --duration DURATION --approve",
  reconcile: "NAME",
  close: "NAME [--output NEW_DIRECTORY | --discard-output]",
  run: "NAME JOB --duration DURATION [--from experiment.json | -- COMMAND ARG...]",
  jobs: "NAME", job: "NAME JOB [--refresh]", wait: "NAME JOB --duration DURATION --max-spend AMOUNT",
  check: "NAME --scope tools|build|node --duration DURATION [--max-head-age SECONDS]",
  exec: "NAME [--json] -- COMMAND ARG...", upload: "NAME LOCAL_FILE /REMOTE_FILE", download: "NAME /REMOTE_FILE NEW_LOCAL_FILE",
  report: "NAME [JOB] [--log FILE] [--notes FILE] [--measurements FILE] [--output DIR]",
  list: "[--json]", status: "NAME [--refresh] [--json]", spending: "[--refresh]",
  machines: "--region REGION [--profile PROFILE] [--duration DURATION] [--max-spend AMOUNT] [--cpu N --memory GiB --disk GiB]",
  capabilities: "", recipes: "",
  storage: "[--storage-dir DIR] [--max-bytes BYTES]",
  cache: "init|list|save|restore (use command-specific help)", "cache init": "HOST",
  "cache list": "[--storage-dir DIR | --cache-workspace HOST]",
  "cache save": "NAME --max-bytes BYTES [--storage-dir DIR | --cache-workspace HOST]",
  "cache restore": "NAME ID --max-bytes BYTES [--storage-dir DIR | --cache-workspace HOST]",
  dataset: "inspect|save|collect|restore (use command-specific help)", "dataset inspect": "NAME --max-bytes BYTES [--storage-dir DIR]",
  "dataset save": "NAME JOB --duration DURATION --max-bytes BYTES [--storage-dir DIR]",
  "dataset collect": "NAME JOB --max-bytes BYTES [--storage-dir DIR]",
  "dataset restore": "NAME JOB --from FILE --duration DURATION --max-bytes BYTES",
  ssh: "NAME [--tmux]", tmux: "", skill: "install [--output DIR]", "skill install": "[--output DIR]",
  guide: "[TOPIC[/SECTION]]",
};

export async function help(parts = []) {
  const key = parts.join(" ");
  if (!key || key === "help") return `fission — rent machines and run tasks with your coding agent

Usage: fission                     Open the Rust task dashboard
       fission install             Install the agent skill
       fission rent NAME ...      Prepare a machine for your own use
       fission ssh NAME           Connect to a ready machine
       fission run NAME ... -- CMD Plan and execute one managed task
       fission status [NAME]       Progress, outcome, cost, evidence, cleanup
       fission stop NAME           Cancel work and request confirmed cleanup
       fission budget              Retained authorization (never reset history)
       fission campaign expand     Expand a local seeded worker manifest
       fission help COMMAND        Focused syntax; COMMAND --help also works

You supply the workflow; Fission manages machines, budgets and cleanup.
Use rent for access or run for a workflow. No embedded agent runs in the VM.
MPP/Tempo purchase path. See help rental.
--approve uses existing budget and duration authorization.
Durations: s/m/h/d, at least 60s; provider availability and authorization bound leases.
Memory/disk: GiB. Money: USDC.e.
Advanced recovery: fission help advanced. Guides: fission help guides.
FISSION_HOME selects the existing durable state and ledger.`;
  if (key === "code") return `Run a short source file through Judge0 using MPP.

Usage: fission run NAME --from FILE --budget AMOUNT [--approve]
       fission status NAME

FILE: {"schemaVersion":1,"execution":{"provider":"judge0","source":"check.py",
"language":71,"cpuSeconds":1,"wallSeconds":3,"memoryKiB":128000}}

Paths resolve beside FILE. Optional stdin, expectedOutput and output directory.
Language is the provider's numeric language ID (71 is Python 3); resource limits
must be explicit. Network access is disabled. Preview sends source for a fresh
quote but never pays. Approval executes once and saves stdout, stderr, status,
timings, source hash, receipt and local run.md/run.json under fission/NAME/TIME.
Budget shares the existing aggregate authorization. Provider errors still may cost
money. Status, stop and resume read saved results and never submit another payment.
This backend has no SSH, repository checkout, preparation harness or persistent VM.
Use an ordinary Linux run when the task needs those capabilities.`;
  if (key === "install") return "fission install — Install the bundled agent skill.\n\nUsage: fission install [--output DIR]\n\nDefaults to ~/.agents/skills/fission. Preserves an existing different skill.";
  if (key === "rent") return `fission rent — ${rent}`;
  if (key === "ssh") return "fission ssh — Connect to a ready machine.\n\nUsage: fission ssh NAME [--tmux]\n\nRequires an interactive terminal. Disconnecting leaves its managed lifetime intact.\nUse fission stop NAME when finished.";
  if (key === "run") return `fission run — ${run}`;
  if (key === "campaign") return `fission campaign — Expand a deterministic seeded campaign locally; this never reads the ledger, quotes, or purchases.\n\nUsage: fission campaign expand CAMPAIGN.json --output MANIFEST.json\n\nThe campaign declaration has schemaVersion 1, kind "campaign", workers, baseSeed,\nseedStride, budget, and a single worker template. Fission expands worker-0 through\nworker-N with seed = baseSeed + index × seedStride, replacing only whole argv\nelements {{seed}}, {{workerIndex}}, and {{workerCount}}. The template must include\n{{seed}}. The output is an ordinary schemaVersion 1 multi-machine manifest; inspect\nit, then use fission run NAME --from MANIFEST.json --budget CAMPAIGN_BUDGET.\n\nExpansion validates every worker locally, resolves template local paths relative to\nthe campaign file, refuses to overwrite output, and does not coordinate a shared\nfuzz corpus or authorize a purchase. Existing manifests remain unchanged.`;
  if (key === "status") return `fission status — ${status}`;
  if (key === "budget") return `fission budget — ${budget}`;
  if (key === "stop") return "fission stop — Cancel the managed task and collect available evidence before teardown.\n\nUsage: fission stop NAME\n\nReturns recorded cancellation intent; use status NAME --wait DURATION to confirm\ncleanup. Repeating stop observes the same task, not a second purchase or DELETE.";
  if (key === "ui") return `fission — Rust task dashboard.

Usage: fission

Tasks: Succeeded, Active, Unsuccessful, Unresolved, then Closed history under all records.
Experiments stay together: active members keep the group active; otherwise its
least-successful member determines the group. Unresolved creation/cleanup is not
confirmed destruction, even after successful work. These rows are dimmed, not hidden.
[advanced] marks unfinished legacy workspaces without a task supervisor.

Requires an interactive terminal. Press q twice consecutively to exit the dashboard,
not the task. Another key or actionable mouse event cancels the first q.

Available: b cycles within-budget VM offers, all VM prices, and read-only Gateways.
Only usable gateways appear; details show the compute operator, pricing units and
supported scope. j/k scrolls details. VM offer details request fresh quotes without
payment. See help rental for unavailable candidates.`;
  if (key === "advanced") return `Secondary recovery interface; not the normal task workflow.\n\nUsage: fission advanced COMMAND ...\n\n${Object.keys(advanced).filter((key) => !key.includes(" ")).join(", ")}\n\nUse fission help advanced COMMAND [SUBCOMMAND] for syntax. Saved old plans/jobs\nremain readable. Direct-open and watch were removed; no history is migrated.\nNever manually mutate a managed task while its supervisor is active.`;
  if (parts[0] === "advanced" && Object.hasOwn(advanced, parts.slice(1).join(" "))) {
    const command = parts.slice(1).join(" ");
    return `fission advanced ${command} — Low-level recovery.\n\nUsage: fission advanced ${command} ${advanced[command]}\n\nRead help rental for lifecycle safety, help tasks for setup and execution.\nRepair requires inspecting partial effects before --approve. Unknown launches and\ntermination outcomes must be observed, never replayed. Output remains structured.`;
  }
  if (key === "guides") return guide();
  if (parts.length === 1 && guideTopics.includes(key.split("/")[0])) return guide(key);
  throw new Error(`Unknown help topic: ${key}. Use fission help or fission help advanced.`);
}
