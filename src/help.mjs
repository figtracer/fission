import { guide, guideTopics } from "./onboarding.mjs";
import { operationCap } from "./workspace.mjs";

const commands = {
  help: `Show command help or read a local guide.

Usage: fission help [COMMAND [SUBCOMMAND] | guides | TOPIC[/SECTION]]

Examples:
  fission help plan
  fission dataset save --help
  fission help guides
  fission help harnesses/readiness

COMMAND --help and COMMAND -h show the same command reference.
Help is local: it never purchases, refreshes, or opens a terminal.`,
  ui: `Open the Rust TUI (also the default with no command).

Usage: fission
       fission ui

Requires an interactive terminal. Press ? for keyboard help; q exits without
closing machines. See fission help tmux for managed SSH windows.`,
  tmux: `Open the TUI with managed SSH windows.

Usage: fission tmux

Requires tmux and an interactive terminal. Reattaches to the session for this
state directory. Quitting closes its SSH windows, not the rented machines.
See docs/install.md for terminal controls.`,
  skill: `Install the bundled agent skill.

Usage: fission skill install [--output DIR]

Default: ~/.agents/skills/fission. A different existing skill is preserved.`,
  guide: `Read local operation guides (compatibility entry point).

Usage: fission guide [TOPIC[/SECTION]]

Equivalent to fission help guides or fission help TOPIC[/SECTION].
Full guides and complete sections retain their original text.`,
  capabilities: `Show providers, resource profiles, and workload guidance as JSON.

Usage: fission capabilities [foundry|reth|tempo|base|bsc]

Profiles describe resource floors, not readiness or performance guarantees.
An ecosystem filters only workloads; providers, profiles, and units stay available.
Workload status is dated evidence, not a live readiness check. Read a complete
card with fission help ID, for example fission help workloads/foundry-symbolic.
Use fission recipes for preparation recipes; fission machines for live offers.`,
  recipes: `Show preparation recipes as JSON.

Usage: fission recipes

linux, foundry, reth, tempo: shell, tools, or local development chains.
foundry-symbolic: prebuilt Forge and Z3, with a matching Linux x86_64 VM profile.
foundry-source, reth-source, tempo-source: pinned checkout and build tooling.
reth-synced: Reth/Lighthouse snapshot and node tooling, not a ready synced node.
See fission help harnesses/choose-a-harness.`,
  machines: `Quote available VMs, without purchasing.

Usage: fission machines --region REGION [OPTIONS]

Options:
  --profile PROFILE                 Workload floor (default: runtime)
  --duration DURATION               Target lease (default: 24h)
  --max-spend AMOUNT                Narrow the saved VM discovery ceiling
  --cpu N --memory GiB --disk GiB    Raise resource requirements
  --os linux --arch x86_64 --kind vm Select required capabilities

Requires a saved VM ceiling or --max-spend. Returns JSON; exit 2 means no
compatible quote. Available offers are distinct from saved machines in list.
Example: fission machines --profile reth-source --region ams --duration 2h`,
  budget: `Inspect or record the retained authorization ledger.

Usage: fission budget
       fission budget --total-spend AMOUNT --approve
       fission budget --vm-max-spend AMOUNT [--profile PROFILE] --approve
       fission budget --raise-to AMOUNT --approval TEXT --approve

--total-spend initializes or lowers the aggregate authorization; it cannot
increase or reset an existing ledger. --vm-max-spend sets the VM ceiling.
Initialize the ledger first; open legacy creation-only workspaces block setup.
Without --profile the VM ceiling applies to all profiles; a profile cap can
only narrow it. Both ceiling options may be recorded in the same invocation.
--raise-to separately records a newly authorized higher aggregate limit with
the user's approval text. It appends an amendment without clearing allocations,
requests, or VM ceilings. It does not infer authorization from wallet balance.
Returns JSON including authorizationAmendments. See fission help rental.`,
  spending: `Show recorded payment outflow and unresolved receipts as JSON.

Usage: fission spending [--refresh]

Default: saved receipts. --refresh verifies recorded transactions through
free Tempo RPC reads. Missing evidence remains unknown; wallet balance or
unused allocations do not authorize spending. See fission help budget.`,
  plan: `Quote and save a rental plan, without purchasing.

Usage: fission plan NAME --recipe RECIPE --budget AMOUNT --duration DURATION [OPTIONS]
       fission plan NAME --from experiment.json --budget AMOUNT --duration DURATION [OPTIONS]

Selection:
  --cheapest --region REGION        Choose the cheapest compatible quoted VM
  --provider compute-mpp --machine ID --region REGION
                                   Choose an explicit ID from machines output
  --profile PROFILE                 Workload floor (source/synced recipes infer it)
  --cpu N --memory GiB --disk GiB    Raise resource requirements
  --os linux --arch x86_64 --kind vm|sandbox
                                   Require provider capabilities
  --repo URL --ref FULL_COMMIT      Public GitHub source; required for source recipes

Funding:
  --budget AMOUNT                   Whole-workspace allocation; preferred form
  --max-spend AMOUNT --total-spend AMOUNT
                                   Advanced alternative: creation and workspace caps

RECIPE is a bundled name (see fission recipes) or a recipe JSON file.
--budget caps creation at the final quote and leaves at least 0.0003 for
lifecycle accounting; that floor is not an estimate of future usage.
Do not combine --budget with the separate caps. --cheapest requires --budget
and cannot be combined with --machine. Without VM selection, the provider
defaults to modal-tempo, which cannot guarantee x86 or hardware capacity.
Read fission help rental before purchasing; fission help reth for snapshots.
Amounts must come from existing authorization; network fees are separate.
Returns JSON with a saved plan ID and exact open arguments; exit 2 means
unavailable. Below 24h, supported VM plans fund a starter and resize it.

Example:
  fission plan build --recipe foundry --budget AMOUNT --cheapest --region ams --duration 2h
  fission open build --plan PLAN_ID --approve`,
  open: `Purchase a reviewed saved plan within existing authorization.

Usage: fission open NAME --plan ID --approve

Rechecks the saved quote and requirements. Returns JSON. Observe bootstrap
with job NAME bootstrap --refresh; after a pending resize use prepare.
Never replay an unknown purchase.

Compatibility: fission open NAME --recipe RECIPE --duration DURATION --max-spend AMOUNT [--approve]
This older sandbox-only form previews without --approve and caps creation only.
Prefer plan --budget followed by open --plan for retained workspace allocations.
See fission help rental.`,
  prepare: `Verify capacity and continue recorded preparation.

Usage: fission prepare NAME [--duration SHORTER_REMAINING_MINIMUM]

Observes an existing resize and starts bootstrap once when capacity/time gates
pass. --duration explicitly accepts a shorter remaining window after resize;
it never extends the lease or repeats payment. Returns JSON.`,
  run: `Submit a bounded job once, using a distinct job name.

Usage: fission run NAME JOB --duration DURATION -- COMMAND [ARG...]
       fission run NAME JOB --from experiment.json --duration DURATION

Pass argv after --, including remote flags such as --help. Use an explicit
shell for shell syntax. --from reuses a compatible recorded workload and cannot
be combined with a command. Returns JSON; observe the same job with job or wait.
Example: fission run build compile --duration 1h -- /workspace/build`,
  jobs: `List recorded jobs on a saved machine as JSON.

Usage: fission jobs NAME

Local observations only. Use job NAME JOB --refresh to observe remote progress.`,
  job: `Show one recorded job and its remote log path as JSON.

Usage: fission job NAME JOB [--refresh]

Default: local record. --refresh observes the same remote job, not a new run.
Use wait for bounded observation; download the returned log path before close.`,
  wait: `Observe the same job within a time and request-spending cap.

Usage: fission wait NAME JOB --duration DURATION --max-spend AMOUNT

Returns JSON. Exit 0: succeeded; 1: failed/error; 2: observation stopped
(deadline, budget, or interrupt). Inspect the phase: work may still be running.
Example: fission wait build compile --duration 5m --max-spend 0.01`,
  check: `Record fresh, structured workload readiness.

Usage: fission check NAME --scope tools|build|node --duration DURATION [--max-head-age SECONDS]

--max-head-age is required only for synced Reth node checks. A timestamped
ready result is not a promise of continuous synchronization. Returns JSON;
exit 1 means not ready or error. See fission help harnesses/readiness.`,
  list: `List saved machines (not available provider offers).

Usage: fission list [--json]

Local table by default; --json returns machine records. No provider refresh.
Example: fission list --json`,
  status: `Show one saved machine.

Usage: fission status NAME [--refresh] [--json]

Local table by default; --json returns a machine record. --refresh observes
the provider, which can cost a capped request. Job progress is separate:
use fission job NAME JOB --refresh.`,
  watch: `Watch saved machines, optionally refreshing within a cap.

Usage: fission watch [--refresh --max-spend AMOUNT]

Local by default. --refresh requires --max-spend; a cap without --refresh is
rejected. Ctrl-C stops watching, not the machines. Non-TTY output is one table.`,
  ssh: `Connect to an existing VM over SSH.

Usage: fission ssh NAME [--tmux]

--tmux selects its managed SSH window in the fission tmux session.
Use exec for non-interactive argv execution.`,
  exec: `Execute argv on an existing machine.

Usage: fission exec NAME [--json] -- COMMAND [ARG...]

Default: remote stdout/stderr. --json returns the execution result. Flags after
-- belong to the remote command. Exit 1 means a nonzero remote exit or error.
Use run for bounded, durable jobs. Example: fission exec build -- uname -m`,
  upload: `Upload a local file to a machine.

Usage: fission upload NAME LOCAL_FILE /remote/file

Transfers can use multiple requests. Returns JSON; keep within lease and budget.`,
  download: `Download a remote file before closing the machine.

Usage: fission download NAME /remote/file NEW_LOCAL_FILE

Stop writers first. Existing destination files are preserved. Returns JSON.
For full Reth datasets, use dataset with explicit storage and byte limits.`,
  report: `Save a timestamped report from retained local evidence.

Usage: fission report NAME [JOB] [--log FILE --notes FILE --measurements FILE --output DIR]

Default root: ./fission. Saves NAME/<UTC timestamp>-JOB/run.md and run.json,
plus an attached log and an eligible portable experiment.json. Returns JSON.
--measurements takes an array of {name, value, unit, context} observations.
No provider requests. Save logs before close; generate the report after cleanup.`,
  storage: `Inspect local or user-mounted storage capacity as JSON.

Usage: fission storage [--storage-dir DIR] [--max-bytes BYTES]

--max-bytes checks whether that many bytes fit; it does not reserve space.
Default: FISSION_STORAGE_DIR or FISSION_HOME/.cache. Explicit directories must
already exist. Files remain there after rental cleanup.`,
  cache: `Reuse compatible compiled build artifacts.

Usage: fission cache list|save|restore [ARGS]

Subcommands:
  list       List local caches
  save       Save a verified build from a machine
  restore    Restore an exact compatible build to a machine

Use fission help cache SUBCOMMAND for syntax. Returns JSON.
See fission help harnesses/reuse-compiled-artifacts.`,
  "cache list": `List local compiled-build caches as JSON.

Usage: fission cache list [--storage-dir DIR]

No machine request. The directory defaults to FISSION_STORAGE_DIR or FISSION_HOME/.cache.`,
  "cache save": `Save a verified build from a machine.

Usage: fission cache save NAME --max-bytes BYTES [--storage-dir DIR]

Checks storage capacity and the explicit transfer limit. Returns JSON.
See fission help harnesses/reuse-compiled-artifacts.`,
  "cache restore": `Restore an exact compatible compiled build.

Usage: fission cache restore NAME ID --max-bytes BYTES [--storage-dir DIR]

Compatibility includes source revision and environment; this is not a
cross-commit incremental cache. Returns JSON. Follow with check --scope build.`,
  dataset: `Save, collect, or restore a bounded Reth dataset.

Usage: fission dataset inspect|save|collect|restore [ARGS]

Subcommands:
  inspect    Inspect size and storage fit
  save       Stage a dataset as a bounded job
  collect    Collect or resume transfer of that saved dataset
  restore    Restore a saved manifest as a bounded job

Use fission help dataset SUBCOMMAND for syntax. Returns JSON.
See fission help harnesses for storage, stopped-node, and compatibility checks.`,
  "dataset inspect": `Inspect a remote dataset and local storage fit.

Usage: fission dataset inspect NAME --max-bytes BYTES [--storage-dir DIR]

Returns JSON. Inspect size, staging space, transfer time, and remaining lease
before saving. No full-size live roundtrip has been validated.`,
  "dataset save": `Stage a stopped Reth dataset as a bounded job.

Usage: fission dataset save NAME JOB --duration DURATION --max-bytes BYTES [--storage-dir DIR]

Stop the managed node pair first. Returns JSON. Use dataset collect with the
same machine and job identifiers; do not repeat save to resume collection.`,
  "dataset collect": `Collect or resume transfer of an already saved dataset.

Usage: fission dataset collect NAME JOB --max-bytes BYTES [--storage-dir DIR]

Uses the recorded save job with hashed/resumable transfer. Returns JSON.
See fission help harnesses for storage and transfer planning.`,
  "dataset restore": `Restore a compatible dataset from a saved manifest.

Usage: fission dataset restore NAME JOB --from manifest.json --duration DURATION --max-bytes BYTES

Returns JSON. Local manifests and chunks must remain available. Storage,
compatibility, and stopped-node checks still apply; readiness is a separate check.`,
  close: `Export declared output if requested, then terminate and confirm.

Usage: fission close NAME [--output NEW_DIRECTORY | --discard-output]

Choose one output option when the recipe declares artifacts.
--output saves recipe-declared files and bootstrap output, not arbitrary job
outputs. Download those separately first. --discard-output explicitly skips
remaining exports. Returns JSON; do not claim cleanup without confirmed state.
An export failure leaves the machine subject to its lease. Never replay a
close with an unknown outcome; see fission help rental/recovery.`,
  reconcile: `Recover saved responses and observe the same resource.

Usage: fission reconcile NAME

Returns JSON. Preserve existing request identifiers and allocations. A missing
VM ID is not proof that purchase did nothing. See fission help rental/recovery.`,
};

export async function help(parts = []) {
  const key = parts.join(" ");
  if (!key) {
    const groups = {
      "Discover and plan": ["capabilities", "recipes", "machines", "budget", "spending", "plan", "open", "prepare"],
      "Run and observe": ["run", "jobs", "job", "wait", "check", "list", "status", "watch", "ssh", "exec"],
      "Collect and finish": ["upload", "download", "report", "storage", "cache", "dataset", "close", "reconcile"],
      "Terminal and help": ["tmux", "skill", "help"],
    };
    return `fission — temporary compute for your coding agent

Usage: fission                         Open the Rust TUI
       fission COMMAND [ARGS] [OPTIONS]
       fission help COMMAND [SUBCOMMAND]
       fission help TOPIC[/SECTION]

${Object.entries(groups).map(([title, names]) => `${title}\n${names.map((name) => `  ${name.padEnd(14)}${commands[name].split("\n", 1)[0]}`).join("\n")}`).join("\n\n")}

Guides: fission help guides            List local topics and complete sections
        fission help rental           Rental, funding, jobs, and recovery
        fission help harnesses        Workloads, readiness, and storage
        fission help reth             Synced Reth/Lighthouse

Examples: fission list --json
          fission plan --help
          fission help dataset save
          fission help harnesses/readiness

Conventions: --help / -h is command-specific; flags after -- belong to the job.
Durations use s/m/h (60s–24h); memory/disk use GiB; amounts use USDC.e.
Data commands return JSON except list/status (add --json), exec (add --json),
and watch (table). Existing guide and ui commands remain supported.
MPP/Tempo only. Quotes precede purchase; --approve uses existing authorization.
Modal exec/status/terminate cap: ${operationCap} USDC.e per request. Compute VM
management/SSH is free after prepaid rental. Transfers may use multiple requests.
FISSION_HOME selects retained state; FISSION_TEMPO selects the Tempo binary.
Setup and terminal controls: docs/install.md.`;
  }
  if (key === "guides") return guide();
  if (parts.length === 1 && guideTopics.includes(key.split("/")[0])) return guide(key);
  const reference = key === "skill install" ? commands.skill : Object.hasOwn(commands, key) ? commands[key] : undefined;
  if (!reference) throw new Error(`Unknown help topic: ${key}. Run fission help for commands or fission help guides for guides.`);
  return `fission ${key} — ${reference}`;
}
