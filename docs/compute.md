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
| Modal | Sandboxes, optionally with a GPU | Managed `run`, results and cleanup |
| Judge0 / Locus MPP | Short code execution | `run --from`, `status`, local results |
| Build With Locus | ARM64 container services and databases | Discovery; recurring credit billing needs separate lifecycle support |

## GPU sandboxes

Use the same managed workflow with a GPU:

```sh
fission run gpu-job --gpu T4 --duration 1h --work-duration 1m --budget 1 -- nvidia-smi
```

Inspect the quote, then add `--approve`. Fission collects results and closes the
sandbox. `--provider modal-tempo` selects a CPU sandbox. Both use the controller
and the usual `status` and `stop` commands. Sandboxes have no SSH access or
CPU/memory/disk guarantees. Omit VM region and machine flags.

Accepted GPU types are T4, L4, A10G, L40S, A100-40GB, A100-80GB, H100, H200 and B200,
optionally with `:COUNT` (1–8). Each command, status check and transfer chunk is a
paid call. Planning leaves room for one observation per 15 seconds plus lifecycle
calls. Transfers share the remaining allocation; termination keeps reserved funds.

The gateway prices any GPU name it receives, including names Modal does not
offer, so a quote is not proof of the hardware. After purchase Fission runs
`nvidia-smi` once and requires the requested count, model and memory before its
bootstrap starts. A mismatch stops preparation and triggers managed cleanup.
The observation is retained in `guestGpu`. Advanced workspaces still require explicit close.

Locus's [billing guide](https://buildwithlocus.com/billing.md) specifies $1.50 per
service/month for MPP-funded workspaces (checked October 15, 2026). The lower
$0.25 price applies to its Polygon funding path. Signup and funding quotes are
separate from container creation. Fission does not automatically fund a shared credit account
or treat workspace credit as a per-task spending limit.

DigitalOcean uses Ubuntu 24.04 and a minimum prepaid day. Its gateway now documents
resize, but our October 15 attempt remained pending beyond the preparation cutoff.
Fission keeps direct provisioning until a resize passes guest verification and
cleanup. Select a `do:` machine and its listed region, or let Fission compare compatible offers. Purchase, SSH,
execution, collection and deletion were verified on October 3, 2026.

DigitalOcean plans are exposed by the same compute gateway as Vultr; another
operator does not provide independent gateway failover. Catalog listings alone
do not establish that an SSH machine can be provisioned and cleaned up.

## Candidates under review

Checked October 15, 2026; these are discovery results, not qualified integrations.

- RunPod GPU plans appear in the compute catalog, but the live provisioning API
  rejects ordinary rentals with “AI deployments only.” Fission does not offer
  these as generic machines until access, execution and cleanup are qualified.
- [AgentVM](https://mpp.agentvm.sh/compute/sessions) currently reports that Tempo
  session settlement is not configured. Earlier paid experiments reached SSH
  and expiry cleanup; they do not establish current availability.
- [OpenVPS](https://github.com/kartojal/openvps) advertises Tempo MPP and SSH into
  Firecracker VMs. Its live endpoints were unreachable during this check.

Neither listing establishes protection from the VM host through attestation.
