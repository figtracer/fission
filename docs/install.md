# Installation

Install from the current source checkout. You need Node.js 22.13+, Rust, SSH and
repository access.

```sh
git clone https://github.com/figtracer/fission.git
cd fission
npm run setup
fission
```

`npm run setup` builds the Rust dashboard, links `fission` globally and installs
the agent skill. The global command uses this checkout. Use `fission help` for
commands, or ask your agent to get a machine or run a workflow within a budget.

Before purchasing, configure the Tempo CLI wallet for MPP payments. Machine
previews show the quote, resources and lifetime before approval.

For an existing checkout, pull the latest changes and rerun `npm run setup`.
If the skill installer reports an existing different skill, compare it with
`skills/fission/SKILL.md` before replacing your local copy.

Current installation uses source; historical prerelease archives contain an older
interface. Release publication remains paused.
