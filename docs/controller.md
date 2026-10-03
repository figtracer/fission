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
corrupt task is reported separately so other tasks can keep running. Legacy
workspaces and paid sandbox polling remain outside automatic supervision.

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
