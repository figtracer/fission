# Fission for agents

Fission rents Linux machines and executes user-supplied workflows. Do not select
an ecosystem harness or impose application-specific versions, topology or checks.
Read the bundled [skill](skills/fission/SKILL.md), `fission help run` or
`fission help rent`. Task files and setup are documented in [tasks](docs/tasks.md).

Preserve budgets, payment intent, deadlines, SSH identity, cleanup reservations,
receipts and machine history. Unknown creation never authorizes replacement;
unknown deletion never confirms cleanup. Existing records may contain legacy
harness fields; their recovery paths must preserve the recorded contract.

## Working on Fission

Keep the Node backend authoritative for plans, payment, durable state, jobs, and lifecycle; the Rust TUI is a client and Python execution helpers run on the guest. Keep one repository and the existing local runner (no Orbs). Version bumps, tags, publication, paid rentals and screen use require explicit authorization. Repository visibility remains the user’s decision. Command contracts belong in code/help; docs provide workflow and interpretation without duplicating policy implementation.

Consult Amp's built-in Oracle whenever guidance or planning help is needed, including consequential design decisions and unresolved technical questions. Use its advice to inform the plan, then verify and own the implementation.

Stay on major zero; use minor increments only when future publication is requested. Keep experiment fixtures and reports outside the product repository. Run `FISSION_TEST_DIR=/absolute/verification npm test` against the external suite, plus a locked Rust build and representative executable workflows within the current spending authority. Do not turn fixture checks into live-validation claims.
