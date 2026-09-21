# Installation

Download the [0.2.0 release](https://github.com/figtracer/fission/releases/tag/v0.2.0)
package and matching checksum for your machine:

| Platform | Package |
| --- | --- |
| macOS Apple Silicon | `fission-0.2.0-darwin-arm64.tgz` |
| macOS Intel | `fission-0.2.0-darwin-x64.tgz` |
| Linux x86_64 | `fission-0.2.0-linux-x64.tgz` |

Requires Node.js 22.13+ and SSH; Linux requires glibc 2.35+. The dashboard is
prebuilt, so Rust is unnecessary. While the repo is private, downloads require
repository access.

Verify the downloaded file with `shasum -a 256 -c PACKAGE.tgz.sha256` on macOS or
`sha256sum -c PACKAGE.tgz.sha256` on Linux, then substitute its filename below:

```sh
npm install -g ./PACKAGE.tgz --ignore-scripts
fission advanced skill install
fission
```

Use `fission help` for commands. Configure your [Tempo wallet](https://docs.tempo.xyz/cli)
before purchasing. Previews show quotes, resources and lifetime before approval.

## From source

Building requires Rust in addition to Node.js and SSH:

```sh
git clone https://github.com/figtracer/fission.git
cd fission
npm run setup
fission
```

Setup builds the dashboard, links the checkout globally and installs the agent
skill. For updates, pull and rerun setup. If the skill installer detects a different
existing skill, compare it with `skills/fission/SKILL.md` before replacing your copy.
