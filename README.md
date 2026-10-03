# Fission

Rent Linux machines with your coding agent.

Give it a task and a budget. Fission gets quotes, runs your commands and cleans
up when the work is done. SSH in yourself or coordinate work across machines.
Payments use MPP on Tempo.

[Install](docs/install.md) · [Agent skill](skills/fission/SKILL.md) ·
[Docs](docs/tasks.md) · [Compute options](docs/compute.md)

## Install

Download the [package for your platform](https://github.com/figtracer/fission/releases/tag/v0.1.1)
and verify its checksum. Requires Node.js 22.13+ and SSH.

```sh
npm install -g ./fission-0.1.1-PLATFORM.tgz --ignore-scripts
fission install
fission
```

This installs the agent skill and opens the Rust dashboard. Set up your
[Tempo wallet](https://docs.tempo.xyz/cli) before buying a machine.

## Use it

“Get me a Linux machine within $2.”

“Run this PR on Linux and bring back the results.”

You choose the software and commands. Fission tracks spending, results and
cleanup. Short source-file jobs can use Judge0 without renting a machine.

Run `fission help` for commands.

[Budgets and recovery](docs/rental.md) · [Data and privacy](docs/privacy.md)
