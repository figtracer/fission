# fission

Temporary compute for your coding agent. Quote a machine, pay through MPP with Tempo, and close it when the task is done.

## Install

Install a [prebuilt release](docs/install.md) for macOS or Linux, including the agent skill. Requires Node ≥22.13, SSH, a configured Tempo CLI wallet, and repository access. [Source setup](docs/install.md#from-source) is also available.

## Use

Start an agent session in your project and ask:

> Use Fission to validate this change with Foundry. Spend at most 5 USDC, return the measurements and report, and close the machine when finished.

The agent chooses a harness, checks quotes and budgets, runs the work, collects evidence, and closes the machine. Reports land in `fission/<machine>/<UTC timestamp>-<run>/run.md`, alongside structured data and the attached log.

## Terminal

```sh
fission
fission help
fission help plan
fission help guides
```

The TUI shows your machines, time remaining, spending, and transactions. Press `a` to browse available VMs and fetch quotes. A separate terminal is optional.

See [the agent skill](skills/fission/SKILL.md) and [rental workflow](docs/rental.md).
