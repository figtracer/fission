# Privacy

Fission protects transfers and can encrypt exported files. Ordinary VM providers
are still trusted with your running workload. There is no blanket private mode.

| Protection | What it covers | What it does not cover |
|---|---|---|
| SSH | Commands and files in transit to the VM | The host can inspect the guest |
| `--secret` | Keeps credential contents out of plans and transfer records | The guest receives plaintext; commands can disclose it |
| `--encrypt-to` | Collected files and logs saved as ciphertext on the controller | Guest files, commands and local metadata remain plaintext |
| Owner-only files | Access by other ordinary Unix users | Root, the same user and the VM host |
| Confirmed cleanup | Provider reports the machine deleted | Backup erasure or untraceable activity |

Encryption currently happens on the controller **after SSH transfer**, not on the
VM. Your decryption key stays with you. Payments and rental metadata remain
observable; no-signup rental does not make them anonymous.

The controller is the computer running Fission. By default it is your computer;
running it on a cloud host puts wallet access, commands, secret inputs and records
on that host instead. That host becomes another party you trust.

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
short-lived credentials when a workflow needs authenticated access. Use `--secret FILE[=NAME]` for secret file inputs. Never put
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
payment receipts for diagnosis and reproducibility. Use `--encrypt-to` to collect encrypted files, or encrypt the detailed record
yourself before uploading it to storage or sharing it with an intended recipient. Build caches
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

## Secret files

Add `--secret ./token=api` to a run or rental. The workload reads
`/workspace/.fission/secrets/api`. Task files use `"secret": ["./token=api"]`,
with local paths resolved beside the task file. Use files, never inline values.

Fission reads the file at dispatch and sends it once through SSH stdin. Plans
retain its reference, not its content or content hash. A symlink used as the local file and symlinked
guest parents are rejected; the guest file is created exclusively with mode 0600.
An uncertain send fails preparation and leads to cleanup, rather than resending
or guessing that the file is ready. The original local file remains yours.
Secrets stay on the guest for the rental lifetime; destruction is not proof of
secure erasure. Use short-lived credentials and revoke them when appropriate.

The reserved secret directory cannot be selected as an artifact. Collection also
rejects symlinks and hard links to files there. Your commands can still copy a
secret elsewhere, print it, or return it from a check. Fission does not scrub such
output, command arguments or observations. Ordinary input files keep their
existing fingerprinted transfer behavior. Secret transfer requires SSH, and never
falls back to an API request containing the secret.

## Encrypted exports

Install [age](https://github.com/FiloSottile/age) locally when you need encrypted
exports. Generate and keep your identity yourself:

```sh
age-keygen -o identity.txt
age-keygen -y identity.txt
```

Pass the printed public recipient as `--encrypt-to age1…`, or `"encrypt-to"` in a
task file. Fission validates it before quoting or buying. Only native X25519 age
recipients are supported. Fission never needs the private identity.

Requested artifacts and collected job logs stream from SSH through local age
before they reach a local file. Fission verifies the source stream and successful
encryption before publishing a `.age` file; failed transfers retain only partial
ciphertext and never fall back to plaintext. Cleanup still proceeds. Reports
copy the ciphertext and record its format and public recipient. Decrypt with:

```sh
age --decrypt --identity identity.txt --output result.txt artifact.age
```

Use decrypted output only after age exits successfully; authentication errors
can leave partial output. Keep your identity safe: Fission cannot recover it.

This protects collected file contents, not every local record. Commands, file
names, sizes, checksums, status/check observations, spending and source metadata
remain in the owner-only records. Plaintext still exists on the guest and in
memory while streaming. Encrypting exports does not hide execution from the host
or retroactively encrypt older results. Fission does not upload ciphertext to an
external storage service automatically.

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
