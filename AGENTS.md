# Fission for agents

Rent temporary compute for a specific task, prepare its environment, run the work, retrieve the result, and close the machine. Use the user's agreed requirements, budget, and completion condition. Continue through cleanup within that authorization; routine observations and already-authorized operations need no repeated approval.

## Entry points

Use the bundled [Fission skill](skills/fission/SKILL.md) for change-validation tasks and standardized reports. Use `fission help` for syntax, `fission capabilities` for profiles, and `fission list --json` for saved machines. Agents use CLI results; bare `fission` opens the human-facing Rust TUI.

Read the guide that matches the operation:

- [Rental](docs/rental.md): before planning or purchasing; also covers funding, jobs, exports, and ambiguous outcomes.
- [Harnesses](docs/harnesses.md): when choosing Foundry/Reth/Tempo preparation, compiling source, or defining a recipe.
- [Synced Reth](docs/reth.md): before sizing or starting a Reth/Lighthouse snapshot workflow.

## Operating boundaries

- Pay through MPP with Tempo, using the saved plan's exact chain, token, and quote. Keep purchases and lifecycle operations within the aggregate authorization and VM ceiling. A shortlist average informs selection; it grants no spending authority.
- Preserve the authorization ledger in `FISSION_HOME`, including closed allocations and unresolved requests. Keep wallet credentials, SSH keys, runtime state, and experiment records outside the repository.
- Match the actual workload: source builds, development chains, and synced nodes have different requirements. Preserve hardware floors when offers are unavailable; full Reth needs at least 32 GiB RAM and 2048 GiB disk, plus manifest-derived sizing.
- Record each purchase and job once. Observe uncertain outcomes using their existing identifiers before deciding the next action. An observer timeout can leave remote work running.
- Judge completion from the requested workload's result. Bootstrap prepares an environment; node readiness requires fresh observations. Save required outputs, close when the task is done independently of PR state, and confirm provider termination.

## Working on Fission

During private iteration, keep fixes in source without routine version bumps, tags, or GitHub releases. Prepare a clean 0.1.x release when the user requests publication.

The Node backend owns plans, payments, durable state, jobs, and lifecycle operations. The Rust TUI uses that backend; Python harnesses run on the guest. Keep these ownership boundaries and the single-repository layout. Keep the README brief, command syntax in `fission help`, and operational detail in the relevant guide. Changes to code-enforced spending, replay, or readiness boundaries require an explicit behavior decision.
