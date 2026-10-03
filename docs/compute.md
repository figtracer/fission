# Choosing compute

Use a Linux machine for repository builds, your own software, SSH, or
long-running work. Use Judge0 for a short, self-contained source file.

## Short code jobs

Ask your agent: “Run this Python check cheaply and bring back the output.”
The agent supplies a task file:

```json
{
  "schemaVersion": 1,
  "execution": {
    "provider": "judge0",
    "source": "check.py",
    "language": 71,
    "cpuSeconds": 1,
    "wallSeconds": 3,
    "memoryKiB": 128000
  }
}
```

Preview with `fission run my-check --from task.json --budget 0.01`; add
`--approve` within the user's authorization. The aggregate Fission budget also
applies. Limits are explicit; select the language ID from
[Judge0's API guide](https://paywithlocus.com/mpp/judge0.md).

Paths resolve relative to the task file. Optional fields are `stdin`,
`expectedOutput`, and `output` (the local results directory). Network access is
disabled. Quote discovery sends the source to the provider without paying.
The displayed price is a fresh quote, not a hardcoded tariff.

Each approved execution saves a request intent before payment, then preserves the
provider response and receipt. `fission status my-check` reads that record.
A user-code failure exits nonzero and retains its paid result. An interrupted or
ambiguous request remains unresolved; status, stop and resume never submit it
again. Results are saved under `fission/my-check/TIMESTAMP/run.md` and `run.json`,
including source hash, language, limits, output, timing, and payment reference.
There is no persistent machine to delete. Transaction fees and verified on-chain
outflow are distinct from the quoted service charge.

## Provider selection

| Option | Workload | Integration |
| --- | --- | --- |
| Compute gateway / Vultr | Linux VMs and prepared environments | Managed rentals and tasks |
| Modal | Sandboxes | Existing sandbox interface |
| Judge0 / Locus MPP | Short code execution | `run --from`, `status`, local results |
| Build With Locus | ARM64 container services and databases | Discovery; recurring credit billing needs separate lifecycle support |
| Compute gateway / DigitalOcean | Linux VMs | Discovery; OS selection and lifecycle qualification pending |

Locus's [billing guide](https://buildwithlocus.com/billing.md) specifies $1.50 per
service/month for MPP-funded workspaces (checked October 2, 2026). This differs
from its overview's $0.25 headline. Signup and funding quotes are separate from
container creation. Fission does not automatically fund a shared credit account
or treat workspace credit as a per-task spending limit.

DigitalOcean plans are exposed by the same compute gateway as Vultr; another
operator does not provide independent gateway failover. Catalog listings alone
do not establish that an SSH machine can be provisioned and cleaned up.
