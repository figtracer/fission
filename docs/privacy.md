# Privacy

Fission keeps orchestration, wallet access and records on your computer. Running
on a rented machine still entrusts the workload to its host. An execution API also
receives commands and transferred content; SSH encrypts transport, not the guest's
memory against its operator. No-signup rental does not make payments anonymous.

## What leaves your computer

| Data | Destination |
|---|---|
| Machine requirements and purchase details | Gateway and provider; payment transactions are public |
| Commands and explicitly selected input files | Rented machine; execution API when using an API-backed sandbox |
| Job output and requested artifacts | Downloaded to local records; API-backed execution also passes through its gateway |
| Wallet credentials | Stay with the local payment tool; Fission does not install them on the guest |

Fission does not implicitly upload your working directory. For private source,
provide a selected archive through `--input`. A Git archive avoids copying the
entire `.git` directory, but tracked secrets still require review. Use scoped,
short-lived credentials when a workflow needs authenticated access. Never put
credentials in command arguments: plans, job specifications and reports retain
commands. Uploaded files are also retained on the guest until cleanup. Fission
does not identify or scrub every possible secret in arbitrary program output.

## Local results and sharing

Each new machine report includes `summary.json`: known outcome, duration, exit code,
spending amounts and cleanup confirmation. It is built from a fixed list of fields
and contains no commands, paths, source identifiers, timestamps, transaction links,
free text, logs or artifacts. `fission status NAME` returns its path. Share this
file alone after review. Amounts and durations may still be identifying context;
the summary is not an anonymity guarantee or a replayable experiment.

The surrounding report directory is the detailed local record. It retains
commands, preparation, source and file metadata, logs, requested artifacts and
payment receipts for diagnosis and reproducibility. Encrypt it yourself before
uploading it to storage or sharing it with an intended recipient. Build caches
can contain source paths, code and embedded credentials; treat them as private
inputs and reuse them only across trusted workloads.

New guest jobs use an owner-only creation mask (`077`), including inherited
workload processes. New uploads, local records and copied report evidence are
owner-only files. Existing files and directories are not retroactively hardened.
Archive extraction and user tools can restore their own permissions.
A workflow that deliberately shares files with another Unix user can set its own
`umask` or permissions. File permissions do not isolate programs running as the
same user, root or the infrastructure operator.

Cleanup records provider-confirmed termination, not proof that every provider
backup or physical copy was erased. Closing the terminal alone does not delete a
machine. Preserve Fission's accounting and cleanup records when cleaning local
results.

## Protecting execution from the host

This requires a different provider capability: confidential VMs with verifiable
hardware attestation. A future integration must verify the expected guest image
and policy before releasing workload data or keys, and reject an ordinary-VM
fallback when confidentiality is required. Hardware support alone is insufficient.
Fission currently does not provide this guarantee. Network destinations, traffic
timing, machine allocation and payment metadata also need separate consideration.

Zero-knowledge proofs can establish specific statements about a computation;
they do not automatically hide an arbitrary CI command running on an ordinary VM.
See the [Confidential Computing Consortium](https://confidentialcomputing.io/) and
[attestation architecture](https://docs.edgeless.systems/contrast/architecture/attestation/overview).
