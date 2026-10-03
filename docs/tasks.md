# Tasks

Give Fission a machine budget, lifetime and your commands. Your agent decides what
to install and how to check the result. Fission handles quotes, access, execution,
requested files and cleanup. No application-specific setup is selected.

## Commands

```sh
fission rent work --budget 2 --duration 2h --region ams
fission run work --budget 2 --duration 2h --work-duration 10m --region ams -- sh -c 'uname -a'
```

These commands preview without paying. Repeat with `--approve` inside the user's
authorization. Use `status work`, `ssh work` for rentals, and `stop work` to finish.
Amounts are examples, not live quotes. `fission help run` lists all options.

## Task files

```json
{
  "schemaVersion": 1,
  "task": {
    "budget": "2",
    "duration": "2h",
    "work-duration": "10m",
    "region": "ams",
    "input": ["work.py"],
    "preparation": [["sh", "-c", "command -v python3"]],
    "command": ["python3", "/workspace/work.py"],
    "artifact": ["/workspace/result.json"]
  }
}
```

Preview with `fission run work --from task.json --budget 2`. Local file paths
resolve beside the task file. Preparation runs after uploads. Commands, including
setup, belong to the user; they can install any needed tools or fetch source.
Optional `checks` run before the workload and use named argv checks with scope
`tools` and result `exit` or `json`. JSON checks return `{"ready":true}` on success.
An omitted check means no application readiness assertion was requested.

An optional embedded `recipe` supplies `name`, `prepare` argv arrays and `artifacts`,
plus optional `afterCheckout`, `readiness` or named `checks`. Recipe preparation
runs before inputs arrive. Most workflows only need `preparation` and `command`.

For several machines, use `machines: [{"name":"one", ...task}, ...]` instead of
`task`. Each role has a budget; the outer command bounds their sum. Roles are
purchased sequentially. Supply coordination and networking in your own commands.

## Limits and results

Machine resources, available providers and payment authorization still constrain
what can be bought. A program's dependencies, sync time and success criteria are
supplied by the user or their agent. Extend preparation and work allowances for
long operations; the budget never grows automatically.

Results include command exit status, logs, requested artifacts, spending and
cleanup status. A successful exit does not independently prove application
correctness. Failed setup or work still triggers cleanup. Unknown deletion is
never confirmed destruction. See [rental recovery](rental.md).

## Older task files

Ecosystem flags and bundled Foundry/Reth/Tempo setup have been removed from new
tasks. Replace them with your own setup and commands. Existing machine records
retain their original deadlines and can still be observed, resumed or stopped;
legacy runtime handling remains for those records. No ledger or history is reset.
