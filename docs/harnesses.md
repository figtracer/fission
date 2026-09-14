# Harnesses

Choose preparation by the work the machine must perform. Use `fission recipes` for recipe details and `fission capabilities` for current hardware profiles. Apply the [rental workflow](rental.md) to purchase, run, and close.

| Work | Recipe | Result of bootstrap |
|---|---|---|
| Shell commands | `linux` | Workspace |
| Foundry tools | `foundry` | Forge, Cast, Anvil, and Chisel |
| Reth development chain | `reth` | Private local chain |
| Tempo development chain | `tempo` | Isolated chain on loopback port 8645 |
| Compile a client | `foundry-source`, `reth-source`, `tempo-source` | Checkout, compiler, dependencies, and `/workspace/build` |
| Reth with Lighthouse | `reth-synced` | Pinned tools and `/workspace/ethereum`; follow [Synced Reth](reth.md) |

Runtime sandboxes have opportunistic capacity. Use a VM and explicit requirements for guaranteed resources or P2P. Development chains run privately on the guest; production network participation is a separate workload.

## Source builds

Source recipes require `--repo https://github.com/OWNER/REPO --ref FULL_COMMIT` and select their matching hardware profile. Resolve a PR to its exact 40-character head SHA. The checkout verifies HEAD and records submodules. Upload private source explicitly, keeping GitHub and wallet credentials local.

Bootstrap installs pinned Rust 1.96.1 and native dependencies. Run the build separately:

```sh
fission run NAME build --duration 1h -- /workspace/build
```

Choose a job duration within the remaining lease. The helper builds the selected release executables with `--locked`, preserves upstream default features, and copies successful binaries into `/workspace`. `/workspace/build.json` records the commit, local changes, toolchain, versions, and hashes. Download it and required binaries explicitly; automatic close exports include source preparation provenance and bootstrap output.

The wrappers `/workspace/cargo`, `/workspace/rustc`, and `/workspace/rustup` work without shell activation. Pass `--manifest-path /workspace/source/Cargo.toml` when invoking Cargo outside the checkout. A failed build leaves the workspace available for diagnosis and a separately named follow-up job. Toolchain or feature changes are explicit decisions; saved plans retain their embedded preparation.

Reth source preparation targets Ubuntu 24.04 and includes `m4`, LLVM 22 development packages, and Polly for the default GMP/JIT features. The official LLVM repository uses a verified signing-key fingerprint and scoped `signed-by` key. Other source revisions can require different dependencies. Confirm the requested workload after compilation; build success establishes binary production.

## Custom recipes

Pass a JSON file to `--recipe`. Its fields are `name`, optional `description`, `prepare` argv arrays, `artifacts` absolute remote paths, optional `afterCheckout` argv arrays, and optional `readiness` argv arrays. `afterCheckout` requires a source reference.

Saved-plan bootstrap runs preparation, checkout, then after-checkout commands once. Readiness probes repeat every 15 seconds inside the bootstrap deadline; use bounded, read-only commands. The `output.log` artifact basename is reserved for bootstrap output. Recipes describe preparation and files; the backend owns payment and runtime settings. Use saved plans for this workflow; legacy direct open supports synchronous preparation and a creation-only cap.
