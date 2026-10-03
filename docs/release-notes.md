# Fission 0.1.1

Rent a Linux machine or run your own commands within a budget.

- `rent` hands over SSH access. `run` executes your workflow and collects results.
- Setup and application checks are optional and user-supplied.
- Quotes, budgets, deadlines, multi-machine tasks and confirmed cleanup stay managed.
- The dashboard, help and agent skill describe the same generic workflow.

## Updating

This release removes bundled Foundry/Reth/Tempo environments and their flags.
Replace old harness/mode options with setup scripts or task-file `preparation`.
New runs no longer infer node configuration, application readiness or source caches.
Existing machine records retain their original deadlines and recovery behavior.
See [task files](https://github.com/figtracer/fission/blob/main/docs/tasks.md).

Download your platform package and matching checksum. Requires Node.js 22.13+
and SSH. The Rust dashboard is included.

```sh
npm install -g ./fission-0.1.1-PLATFORM.tgz --ignore-scripts
fission install
fission
```

If an older agent skill is installed, preserve or remove that file before running
`fission install`; installation will not overwrite a different skill.

## Validation

Generic command execution, artifact return, failed-work cleanup, optional failing
checks and plain rental handover were exercised with the actual CLI and local
provider fixtures. No live VM was purchased for this refactor: the retained test
allocation was already fully allocated. Platform packages are built and their
installation checked by the release workflow.
