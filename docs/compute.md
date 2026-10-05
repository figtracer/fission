# Choosing compute

Use a Linux VPS for repository builds, SSH or long-running work. You get a
machine with its own resources and a rental deadline. A sandbox runs commands
inside a managed environment; a short code job returns a result without leaving
a machine to connect to. Use Judge0 for a short, self-contained source file.

The payment gateway sells access; the infrastructure operator runs the machine.
For example, the compute gateway provisions VMs on Vultr and DigitalOcean. SSH goes directly to
the guest, while provisioning and deletion go through the gateway. Both parties
see rental metadata, and the operator remains trusted with execution.

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
| Compute gateway / Vultr and DigitalOcean | Linux VMs and prepared environments | Managed rentals and tasks |
| Modal | Sandboxes, optionally with a GPU | Advanced sandbox interface; see GPU sandboxes |
| Judge0 / Locus MPP | Short code execution | `run --from`, `status`, local results |
| Build With Locus | ARM64 container services and databases | Discovery; recurring credit billing needs separate lifecycle support |

## GPU sandboxes

Modal sandboxes can attach a GPU. Plan one with
`fission advanced plan NAME --provider modal-tempo --gpu H100 --duration 1h --budget 5`,
inspect the quote, then `fission advanced open NAME --plan ID --approve`. Use
`advanced exec`, `run` and `job` for work and `advanced close NAME` when done.
Accepted types are T4, L4, A10G, L40S, A100-40GB, A100-80GB, H100, H200 and B200,
optionally with `:COUNT` (1-8). This is a sandbox, not an SSH VM, and managed
`run`/`rent` do not use it: each command, status check and job poll is a paid call.

The gateway prices any GPU name it receives, including names Modal does not
offer, so a quote is not proof of the hardware. After purchase Fission runs
`nvidia-smi` once and requires the requested count, model and memory before its
bootstrap starts. A mismatch leaves the sandbox `prepare_failed` with the
observation in `guestGpu`; close it with `--discard-output`. The budget keeps
0.0001 more lifecycle room for that check.

Locus's [billing guide](https://buildwithlocus.com/billing.md) specifies $1.50 per
service/month for MPP-funded workspaces (checked October 2, 2026). This differs
from its overview's $0.25 headline. Signup and funding quotes are separate from
container creation. Fission does not automatically fund a shared credit account
or treat workspace credit as a per-task spending limit.

DigitalOcean uses Ubuntu 24.04 and a minimum prepaid day. Select a `do:` machine
and its listed region, or let Fission compare compatible offers. Purchase, SSH,
execution, collection and deletion were verified on October 3, 2026.

DigitalOcean plans are exposed by the same compute gateway as Vultr; another
operator does not provide independent gateway failover. Catalog listings alone
do not establish that an SSH machine can be provisioned and cleaned up.

## Candidates under review

Checked October 3, 2026; these are discovery results, not qualified integrations.

- [AgentVM](https://mpp.agentvm.sh/compute/sessions) advertises Tempo MPP sessions
  on Hetzner, up to 4 vCPU, 16 GB RAM and 160 GB disk, for up to six hours. Its
  discovery endpoint responded. Earlier paid checks reached SSH and observed expiry
  cleanup, but a documented early-stop operation and durable renewal/settlement
  remain unqualified for managed rentals.
- [OpenVPS](https://github.com/kartojal/openvps) advertises Tempo MPP and SSH into
  Firecracker VMs. Its live endpoints were unreachable during this check.

Neither listing establishes protection from the VM host through attestation.
