# Install

## Prebuilt release

Requires Node ≥22.13, SSH, and a configured Tempo CLI wallet. Authenticate `gh` with an account that can read this private repository.

Download the package matching the computer running your agent: `darwin-arm64` for Apple Silicon, `darwin-x64` for Intel Macs, or `linux-x64` for Linux x86 (glibc ≥2.35).

For Apple Silicon:

```sh
gh release download v0.1.1 --repo figtracer/fission --pattern '*-darwin-arm64.tgz*'
shasum -a 256 -c fission-*-darwin-arm64.tgz.sha256
npm install -g ./fission-*-darwin-arm64.tgz --ignore-scripts
fission skill install
fission
```

Use the corresponding platform in both download and install commands. Each package includes the compiled Rust TUI, Node backend, harnesses, and agent skill. Installing a release does not require Rust. Restart your agent session after installing the skill.

## From source

With Rust installed:

```sh
git clone git@github.com:figtracer/fission.git
cd fission
npm run setup
```

`fission` opens the TUI from any terminal. `fission help` lists commands. `FISSION_HOME` selects the machine history and budget directory; keep using the same directory for existing rentals.

Use `Tab` or `1`/`2` to switch between your machines and Available. The catalog preloads at startup, shows the saved catalog immediately on subsequent launches, and refreshes in the background. Available VMs are sorted by their daily catalog estimate. The default view applies the saved VM ceiling; `b` includes higher prices. Enter opens specs and regions, `[`/`]` cycle regions, and Enter again fetches a fresh 24-hour quote. These controls only browse and quote. Agents use saved plans to choose workload requirements, shorter leases, and authorized purchases.

Use `j`/`k` or the arrow keys to move, `h`/Esc to go back, and `l`/Enter to open a row. `gg`/`G` jump to the first/last row; Ctrl-u/Ctrl-d move half a page. `f` filters owned machines, `s` changes their sort order, and `?` opens help.

Your machines are grouped by project and sorted by name. Click a project to expand it, then a machine for details. The mouse wheel scrolls; the navigation and detail buttons also accept clicks. Unresolved requests appear in history and are excluded from the active count; their recovery records and reserved funds stay intact.

## SSH windows

With tmux installed, run `fission tmux`. It opens a dashboard and one SSH window per ready VM. Click a machine's SSH button to switch windows. Detach with your tmux prefix followed by `d`; `fission tmux` reattaches to the same state directory's session.

Confirmed terminal state closes the corresponding window on the next local refresh. SSH keepalives close unresponsive connections after two missed 15-second probes. Disconnected windows reopen only when explicitly selected. Quitting the dashboard closes its managed SSH windows; VM leases continue until the agent or user closes the machines. Other tmux sessions are preserved.

## Build a release

`npm run package` builds a native package and SHA-256 checksum in `dist/`. The manual Release workflow builds all three platforms from its selected commit and publishes a prerelease for the version in `package.json`. Existing release tags and local archives are preserved; bump the package and lockfile versions before releasing again.
