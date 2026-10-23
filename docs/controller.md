# Always-on controller

Run Fission on a Linux host that stays on. It keeps collecting results and
finishing cleanup when your laptop disconnects. Use the same commands and
Rust dashboard over SSH.

## Set up

Install Fission on that host, then enable its user service across logout:

```sh
sudo loginctl enable-linger "$USER"
fission controller install
fission controller status
```

Use a persistent disk for Fission's state and inputs. `FISSION_HOME` can select
its location before installation; the service records the absolute path.
The controller host has its own bill and lifetime. Keep it running longer than
the tasks it supervises.

Run `fission rent`, `fission run`, `fission status` and `fission stop` on that
host. Set up its Tempo wallet and budget before purchasing. Use limited spending
authority; the controller host is trusted with it. Keep your main wallet elsewhere.
Selected inputs must already exist on the controller before submitting a task.

## Operation

```sh
fission controller status
journalctl --user -u fission-controller
systemctl --user restart fission-controller
systemctl --user stop fission-controller
```

`fission controller run` runs in the foreground for another service manager.
Installation records your executable paths and PATH for background commands.
Install again after changing those paths; it updates and restarts the user service.
A service on your laptop still pauses when the laptop sleeps.

The controller resumes existing authorized tasks. It never purchases a machine
on its own. New purchases require a running controller. Stopping the service
pauses coordination; it does not cancel tasks or delete machines. Use
`fission stop NAME` while the service runs and check cleanup confirmation.

Unknown creation or deletion is shown as needing attention. Inspect the record,
then use `fission status NAME --resume` for one explicit recovery attempt. A
corrupt task is reported separately so other tasks can keep running. Managed Modal
jobs also resume with their existing budgets and polling interval. Legacy workspaces remain outside automatic supervision.

## Recovery and data

State is bound to one host and path. Locks record host, boot and process identity
so a reboot or reused PID does not keep a dead supervisor alive. Older PID-only
locks and incomplete recovery locks require inspection when ownership cannot be
proved. Preserve their records; do not clear locks belonging to live processes.

Do not copy live state between machines or restore an old state backup into a
running controller. A backup can predate a payment, launch or deletion; restoring
it is not supported automatic recovery. Inputs, outputs and SSH keys also use
absolute paths. Reboots keep the original task deadlines.

The host holds workflow data, results, SSH keys and management credentials.

## Cloud deadline watchdog

For deadline cleanup while your computer is offline, deploy the optional
Cloudflare Durable Object worker. It registers compute VM IDs and their fixed
deadlines. It can inspect and delete those VMs. It cannot buy machines, extend
rentals, run commands or collect results. Use the Linux controller for those
ongoing workflow operations.

From a source checkout, with Wrangler installed and logged in:

```sh
wrangler deploy --config cloud/wrangler.jsonc
wrangler secret put FISSION_WATCHDOG_TOKEN --config cloud/wrangler.jsonc
```

Choose a random secret of at least 32 characters. Use that same value in your
local `FISSION_WATCHDOG_TOKEN` environment variable. Add
`--watchdog https://YOUR-WORKER.workers.dev` to a normal `rent` or `run` command.
The preview checks the deployment before any purchase. Cloudflare hosting uses
your Cloudflare account and billing, separately from the Fission task budget.

Fission registers the VM after purchase and before setup. Once registration is
attempted, all deletion requests go through the watchdog. It records a deletion
intent before contacting the provider and never repeats an uncertain DELETE.
Afterward it observes for up to 15 minutes. Unknown state or HTTP 404 never
confirms cleanup. An unreachable provider or uncertain deletion can still need
manual recovery; alarms do not guarantee provider destruction.

The worker receives the VM management key, ID and deadline. It does not receive
your wallet, SSH key, commands or results. The gateway's management key may allow
more operations; this worker restricts its use to GET and DELETE on the fixed
compute endpoint. Keep the worker and its secret under your control. Confirmed
cleanup removes the management key from its stored record.

Watchdog deadlines are immutable. Such rentals cannot be extended. Compute VMs
are supported; Modal sandboxes keep their provider timeout. Browser sessions
keep their purchased lifetime and local cleanup. The watchdog does not close
browser sessions or collect artifacts when your local supervisor is offline.
