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
  --repo URL --ref SHA     Public GitHub source at a full commit; required for test/build
  --patch FILE            Apply git diff --binary HEAD once before source test/build
  --input FILE[=REMOTE]    Upload a regular file, repeatable; default /workspace/basename
  --artifact /workspace/F Collect an output file, repeatable (not a database)
  --cwd DIR               Guest cwd; default /workspace/source with repo, else /workspace
  --cpu N --memory GiB --disk GiB  Raise harness resource floors
  --prepare-duration D    Raise the preparation allowance for this task
  --output DIR            Local timestamped reports (default ./fission)

Ecosystem-specific options: fission help foundry, reth, or tempo.
Source tasks inspect local caches before quotes. Binary cache candidates require
exact guest verification; they are not Cargo test caches. See help harnesses.

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

Example (amount/duration must be authorized):
  fission run check-a --harness foundry --budget 0.50 --duration 2h \\
    --work-duration 10m --region ams --input checks.py --approve -- python3 checks.py

All data is JSON. --help before -- is local; flags after -- belong to the workload.
Use status NAME --wait 10m to observe; stop NAME requests early cleanup.`;

const status = `Observe tasks or resume the same recorded task.

Usage: fission status [NAME] [--json]
       fission status NAME [--resume] [--refresh] [--wait DURATION]

Default reads saved task/job results, cost uncertainties, report and cleanup.
--resume starts a detached owner if absent; it never purchases or resubmits jobs.
Only locks whose recorded PID has exited can be recovered. Unknown owners remain.
--refresh observes the provider; --wait observes saved progress (no paid polling).
Waiting exits 0 for success, 1 for a finished failure, 2 for an unfinished task.
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
  cache: "list|save|restore (use command-specific help)", "cache list": "[--storage-dir DIR]",
  "cache save": "NAME --max-bytes BYTES [--storage-dir DIR]", "cache restore": "NAME ID --max-bytes BYTES [--storage-dir DIR]",
  dataset: "inspect|save|collect|restore (use command-specific help)", "dataset inspect": "NAME --max-bytes BYTES [--storage-dir DIR]",
  "dataset save": "NAME JOB --duration DURATION --max-bytes BYTES [--storage-dir DIR]",
  "dataset collect": "NAME JOB --max-bytes BYTES [--storage-dir DIR]",
  "dataset restore": "NAME JOB --from FILE --duration DURATION --max-bytes BYTES",
  ssh: "NAME [--tmux]", tmux: "", skill: "install [--output DIR]", "skill install": "[--output DIR]",
  guide: "[TOPIC[/SECTION]]",
};

export async function help(parts = []) {
  const key = parts.join(" ");
  if (!key || key === "help") return `fission — a task, a suitable Linux machine, a bounded result

Usage: fission                     Open the Rust task dashboard
       fission run NAME ... -- CMD Plan and execute one managed task
       fission status [NAME]       Progress, outcome, cost, evidence, cleanup
       fission stop NAME           Cancel work and request confirmed cleanup
       fission budget              Retained authorization (never reset history)
       fission help COMMAND        Focused syntax; COMMAND --help also works

Harnesses: foundry, reth, tempo; linux fallback. See help harnesses.
Read help run first. No embedded agent runs in the VM.
MPP/Tempo purchase path; x402 gateways not yet integrated. See help rental.
--approve uses existing budget and duration authorization.
Durations: s/m/h/d, at least 60s; provider availability and authorization bound leases.
Memory/disk: GiB. Money: USDC.e. Guidance: fission help index [WORDS].
Advanced recovery: fission help advanced. Guides: fission help guides.
FISSION_HOME selects the existing durable state and ledger.`;
  if (key === "run") return `fission run — ${run}`;
  if (parts[0] === "index") return JSON.stringify(await guidance(parts.slice(1).join(" ")), null, 2);
  if (parts[0] === "run" && parts.length === 2 && Object.hasOwn(harnesses, parts[1]))
    return `${await help(["run"])}\n\n${await help([parts[1]])}`;
  if (key === "status") return `fission status — ${status}`;
  if (key === "budget") return `fission budget — ${budget}`;
  if (key === "stop") return "fission stop — Cancel the managed task and collect available evidence before teardown.\n\nUsage: fission stop NAME\n\nReturns recorded cancellation intent; use status NAME --wait DURATION to confirm\ncleanup. Repeating stop observes the same task, not a second purchase or DELETE.";
  if (key === "ui") return "fission — Rust task dashboard.\n\nUsage: fission\n\nRequires an interactive terminal. Press q twice consecutively to exit the dashboard, not the task. Another key or actionable mouse event cancels the first q.\n\nAvailable: b cycles within-budget VM offers, all VM prices, and read-only Gateways. Only usable gateways appear; details show the compute operator, pricing units and supported scope. j/k scrolls details. VM offer details request fresh quotes without payment. See help rental for unavailable candidates.";
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
