# Using loaner

Run `loaner list --json` before opening another workspace. Use `loaner open` without `--approve` to inspect the recipe and current quote. A purchase requires the user's duration and spending authorization.

Keep the task's workspace while it is useful. Download important outputs before its deadline, then call `loaner close NAME --output DIR` when the user considers the task finished. Use `--discard-output` only when discarding the remaining files is intended. PR state is not the lifetime authority.

Preserve unresolved request records. Reconcile saved responses instead of purchasing again after a timeout. Report termination only when confirmed by the provider. Keep runtime state, credentials and experiment records outside this repository.

Recipe commands execute in the remote sandbox. Transfer only explicitly selected source files; never upload local wallet state or credentials. Read the README for provider and file-transfer limits.
