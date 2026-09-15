# Installation

Releases are paused. Install and run from a reviewed local source checkout; do not use an old prerelease archive as the current managed interface.

Requirements: Node.js 22.13 or newer, Rust toolchain for the native TUI build, SSH, Linux x86_64 guests, and a configured Tempo CLI wallet for approved MPP payments.

```sh
git clone PRIVATE_REPOSITORY_URL fission
cd fission
npm install
npm run setup
fission help
```

Use the repository's current package scripts as authoritative and review the checkout/revision before installation. Setup builds and links the local checkout, then installs the bundled skill through the advanced interface. To install only the skill after inspecting `skills/fission/SKILL.md`, use `fission advanced skill install`.

Do not publish, tag, bump the package version, or create a release while the pause remains in effect. Existing prereleases and checksums are historical only.
