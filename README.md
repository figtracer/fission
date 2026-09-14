# fission

Temporary compute for your coding agent. Quote a machine, pay through MPP with Tempo, and close it when the task is done.

## Install

Requires Node ≥22.13, Rust, SSH, and a configured Tempo CLI wallet.

```sh
git clone git@github.com:figtracer/fission.git
cd fission
npm run build
npm link --ignore-scripts
```

## Open

```sh
fission
```

The Rust TUI shows machines, time remaining, spending, and transactions. Select a machine to open SSH or save its files and close it.

```sh
fission help
```

## For agents

Give your agent [AGENTS.md](AGENTS.md). Harnesses cover Foundry, Reth, and Tempo, with quotes and budgets checked before purchase. Plans include funding details for existing [Glue](https://github.com/figtracer/glue) refill policies.
