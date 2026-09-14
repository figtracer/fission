# fission

Temporary compute for your coding agent. Quote a machine, pay through MPP with Tempo, and close it when the task is done.

## Install

Requires Node ≥22.13, Rust, SSH, a configured Tempo CLI wallet, and access to this repository.

```sh
git clone git@github.com:figtracer/fission.git
cd fission
npm run setup
```

Installs the CLI and the Fission skill in `~/.agents/skills/fission`.

## Use

Start an agent session in your project and ask:

> Use Fission to validate this change with Foundry. Spend at most 5 USDC, return the measurements and report, and close the machine when finished.

The agent chooses a harness, checks quotes and budgets, runs the work, collects evidence, and closes the machine. Reports land in `fission/<machine>/<UTC timestamp>-<run>/run.md`, alongside structured data and the attached log.

## Terminal

```sh
fission
fission help
```

The default command opens the Rust TUI for machines, time remaining, spending, and transactions. A separate terminal is optional.

See [the agent skill](skills/fission/SKILL.md) and [rental workflow](docs/rental.md). Plans include funding details for existing [Glue](https://github.com/figtracer/glue) refill policies.
