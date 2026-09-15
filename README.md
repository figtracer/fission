# Fission

Fission runs one bounded task on temporary Linux compute. Its Foundry, Reth, and Tempo harnesses select resources, prepare and check the environment, run an argv, collect evidence, and request confirmed cleanup. Plain Linux is the fallback. No coding agent or LLM runs on the guest.

```sh
# Preview: quotes and records a plan, but pays nothing.
fission run check-a --harness foundry --budget AMOUNT --duration 2h \
  --work-duration 10m --region ams --input ./check.sh -- bash /workspace/check.sh

# Execute the reviewed plan within existing authorization.
fission run check-a --harness foundry --budget AMOUNT --duration 2h \
  --work-duration 10m --region ams --input ./check.sh --approve -- bash /workspace/check.sh

fission status check-a --wait 10m
fission stop check-a
```

Bare `fission` opens the Rust task dashboard. `run`, `status`, `stop`, `help`, and `budget` are the normal interface; recovery and retained-data operations live under `fission advanced`.

Start with `fission help run`, then [harness selection](docs/harnesses.md), [rental safety](docs/rental.md), or the [synced Ethereum reference](docs/reth.md). See [installation](docs/install.md) for the source-first workflow while releases are paused.
