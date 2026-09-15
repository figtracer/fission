# Workload guidance

`fission help index [WORDS]` searches a small local, source-pinned taxonomy. For example, `fission help index foundry symbolic` or `fission help index reth fetcher`. Matching requires all words. Stable IDs route the agent to complete canonical guide sections; this is not a new workload runner or autonomous bug finder.

The [index](taxonomy.json) records a corpus revision, independent full source commits, modes and topic tags. Results and managed previews include its SHA-256. A requested source revision differing from the guidance pin is explicitly marked: inspect that revision's code and executable help before applying guidance. The index never claims that it has automatically followed upstream changes.

Updates are explicit, following [Bugraph](https://github.com/figtracer/bugraph)'s provenance model: review new source commits, update affected entries and canonical guides, increment the corpus revision, and validate every guide link and representative query. No copied vulnerability corpus, graph framework, embeddings or index service is required. The source commit is the guidance review reference, not necessarily the prebuilt runtime version; preparation recipes remain authoritative for executable pins.

Choose [Foundry](harnesses.md#foundry), [Reth](harnesses.md#reth), or [Tempo](harnesses.md#tempo), with the [Linux fallback](harnesses.md#linux) only when none applies. The agent chooses the experiment and interprets evidence; Fission owns preparation, policy and lifecycle. Prefer prebuilt tools for contract tests and source `test` mode for Cargo tests. Availability, compilation and bootstrap do not establish correctness. Do not use Fission for autonomous exploit finding.
