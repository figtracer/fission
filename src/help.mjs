import { guide, guideTopics, guidance } from "./onboarding.mjs";
import { harnesses } from "./harnesses.mjs";

const run = `Run a managed Linux task; preview without --approve.

Usage: fission run NAME --harness foundry|reth|tempo|linux --budget AMOUNT
       --duration TOTAL --work-duration WORK --region REGION [OPTIONS]
       [--approve] -- COMMAND [ARG...]

Fission selects compatible quotes, reserves the task budget, prepares and checks
the environment, runs the argv, collects evidence, then destroys and confirms.
The local supervisor survives terminal/agent disconnect. No replacement purchase.
Before payment, failed quotes/capacity checks may select a retained alternative,
cheapest compatible first within the creation cap, with no percentage premium rule.
Resource floors, region, duration and lifecycle headroom stay unchanged. Preview
lists alternatives and failures. Current VM offers still share a single gateway.

Options:
  --mode MODE             See harness help; test never builds release binaries first
  --snapshot PRESET       Synced Reth/Base: minimal, full (default), archive
  --repo URL --ref SHA     Public GitHub source at a full commit; required for test/build
  --patch FILE            Apply git diff --binary HEAD once before source test/build
  --input FILE[=REMOTE]    Upload a regular file, repeatable; default /workspace/basename
  --artifact /workspace/F Collect an output file, repeatable (not a database)
  --cwd DIR               Guest cwd; default /workspace/source with repo, else /workspace
  --cpu N --memory GiB --disk GiB  Set resources; selected snapshot disk remains a minimum
  --machine ID             Require one exact catalog machine; disables fallback
  --no-resize             Direct VM; required above 4 vCPU/8 GiB for short alpha tasks
  --cache-workspace NAME  Use an initialized retained VPS for clean build caches
  --cache-max-bytes N     Bound its compressed and expanded archive sizes
  --prepare-duration D    Raise the preparation allowance for this task
  --output DIR            Local timestamped reports (default ./fission)

Ecosystem-specific options: fission help foundry, reth, or tempo.
Source tasks inspect local caches before quotes. Binary cache candidates require
exact guest verification; they are not Cargo test caches. See help harnesses.

Task file: fission run NAME --from task.json --budget TOTAL [--approve]
Use {schemaVersion: 1, task: {...run options, command: ["program", "arg"]}}.
Choose a built-in harness, or supply an embedded recipe plus cpu, memory, disk,
prepare-duration and scope. Custom recipes define guest preparation and named
readiness checks; preparation argv run after uploads. See help harnesses/task-files.
Budget is both required in the task and bounded by --budget. Paths resolve beside
this file. Preview validates and quotes; document commands only execute on the VM.

Multiple machines: fission run NAME --from experiment.json --budget TOTAL [--approve]
The file supplies schemaVersion: 1 and machines: [{name, harness, mode, budget,
duration, "work-duration", region, command: ["program", "arg"], ...run options}].
Each role has explicit resources/time/cost. File paths resolve beside the manifest.
Preview shows all machines and summed allocations before any purchase. Approval
accepts that set; payments are not atomic and later failure never buys a replacement.
Group stop during creation waits for the approved purchase sequence, then cancels
all purchased roles. Use status/stop NAME or NAME-ROLE. No machine-count limit.

TOTAL includes provisioning + preparation + WORK + cleanup. Default allowances:
30m provisioning, 10m prebuilt / 1h source / 4h synced preparation, 15m cleanup.
They are planning policy based on dated observations, not performance guarantees.
Preview includes the evidence and uncertainty. Short plans reject before spending.
The prepaid lease can outlive TOTAL; no extra execution is authorized by credit.
--no-resize preserves TOTAL and its guest deadline while bypassing starter migration.
Public-alpha automatic resize is limited to targets up to 4 vCPU and 8 GiB RAM;
larger short tasks must use explicit direct provisioning and still prepay one day.
Resizable short leases wait for healthy cloud-init before migration, then require
the trusted guest—not provider plan fields—to show the selected CPU, RAM, root
disk, and healthy initialization. The gateway exposes no provider upgrade-job ID;
an accepted resize remains unfinished until guest verification succeeds.

Example (amount/duration must be authorized):
  fission run my-task --harness foundry --budget 0.50 --duration 2h \\
    --work-duration 10m --region ams --input checks.py --approve -- python3 checks.py

All data is JSON. --help before -- is local; flags after -- belong to the workload.
Use status NAME --wait 10m to observe; stop NAME requests early cleanup.`;

const rent = `Rent a managed Linux machine and hand over SSH access; preview without --approve.

Usage: fission rent NAME --budget AMOUNT --duration TOTAL --region REGION
       [--harness linux|foundry|reth|tempo] [OPTIONS] [--approve]
       fission rent NAME --from task.json --budget AMOUNT [--approve]

Linux is the default. Foundry installs contract tools; Reth defaults to its
executable only; Tempo defaults to an isolated development node. Select a mode
for source preparation, builds or synced nodes. Read the ecosystem's help for
its environment choices. Ordinary repositories can supply a task-file recipe.
The task file accepts the same setup fields as run, with no command/work-duration.

Preview, approve within the user's budget, then status NAME --wait DURATION.
When ready, use fission ssh NAME. Inside the Fission tmux dashboard, --tmux
selects its window (start the dashboard with fission advanced tmux). The owner keeps the
rental until stop NAME or the cleanup cutoff. Disconnecting SSH does not stop it.
No workload, dummy sleep command or experiment report is required.

TOTAL starts at purchase and includes provisioning, preparation and cleanup;
it is not guaranteed hands-on time. Preview retains those allowances. Status
shows usableUntil and readiness; do not count preparation as interactive access.
Request enough total time when the user needs a particular working interval.

Resource, input, source, node, cache and preparation options match help run.
--work-duration and workload argv apply to run only. Status retains spending,
readiness and cleanup even when no report or output artifacts were requested.`;

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
  capabilities: "[foundry|reth|tempo|linux]", recipes: "",
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

Harnesses: foundry, reth, tempo; linux fallback. See help harnesses.
Use rent for access or run for a workflow. No embedded agent runs in the VM.
MPP/Tempo purchase path. See help rental.
--approve uses existing budget and duration authorization.
Durations: s/m/h/d, at least 60s; provider availability and authorization bound leases.
Memory/disk: GiB. Money: USDC.e. Guidance: fission help index [WORDS].
Advanced recovery: fission help advanced. Guides: fission help guides.
FISSION_HOME selects the existing durable state and ledger.`;
  if (key === "install") return "fission install — Install the bundled agent skill.\n\nUsage: fission install [--output DIR]\n\nDefaults to ~/.agents/skills/fission. Preserves an existing different skill.";
  if (key === "rent") return `fission rent — ${rent}`;
  if (key === "ssh") return "fission ssh — Connect to a ready machine.\n\nUsage: fission ssh NAME [--tmux]\n\nRequires an interactive terminal. Disconnecting leaves its managed lifetime intact.\nUse fission stop NAME when finished.";
  if (key === "run") return `fission run — ${run}`;
  if (key === "campaign") return `fission campaign — Expand a deterministic seeded campaign locally; this never reads the ledger, quotes, or purchases.\n\nUsage: fission campaign expand CAMPAIGN.json --output MANIFEST.json\n\nThe campaign declaration has schemaVersion 1, kind "campaign", workers, baseSeed,\nseedStride, budget, and a single worker template. Fission expands worker-0 through\nworker-N with seed = baseSeed + index × seedStride, replacing only whole argv\nelements {{seed}}, {{workerIndex}}, and {{workerCount}}. The template must include\n{{seed}}. The output is an ordinary schemaVersion 1 multi-machine manifest; inspect\nit, then use fission run NAME --from MANIFEST.json --budget CAMPAIGN_BUDGET.\n\nExpansion validates every worker locally, resolves template local paths relative to\nthe campaign file, refuses to overwrite output, and does not coordinate a shared\nfuzz corpus or authorize a purchase. Existing manifests remain unchanged.`;
  if (parts[0] === "index") return JSON.stringify(await guidance(parts.slice(1).join(" ")), null, 2);
  if (["run", "rent"].includes(parts[0]) && parts.length === 2 && Object.hasOwn(harnesses, parts[1]))
    return `${await help([parts[0]])}\n\n${await help([parts[1]])}`;
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
    return `fission advanced ${command} — Low-level recovery.\n\nUsage: fission advanced ${command} ${advanced[command]}\n\nRead help rental for lifecycle safety, help harnesses for preparation/storage.\nRepair requires inspecting partial effects before --approve. Unknown launches and\ntermination outcomes must be observed, never replayed. Output remains structured.`;
  }
  if (key === "guides") return guide();
  if (parts.length === 1 && Object.hasOwn(harnesses, key))
    return (await guide(`harnesses/${key}`)) + (key === "reth" ? `\n\n${await guide("reth")}` : "");
  if (parts.length === 1 && guideTopics.includes(key.split("/")[0])) return guide(key);
  throw new Error(`Unknown help topic: ${key}. Use fission help or fission help advanced.`);
}
