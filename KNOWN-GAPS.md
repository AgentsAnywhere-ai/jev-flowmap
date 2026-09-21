# Known gaps

Dated, honest, and updated on every release. A gap closed here must be closed in
the code first.

## Open

### Thresholds are uncalibrated (opened 2026-09-21, blocking a 1.0)

Every band in `skills/user-flows/references/questions.json` is an invented default.
No labeled evaluation has run. Until one does, the tool cannot honestly describe any
probability as an accuracy, and `FLOWS.md` says so in its limitations block.

Closing it needs `evals/flows/labeled.jsonl`: roughly 50 files from a real
repository, each hand-labeled user-reachable or not. See `evals/flows/README.md`.
Jevify is the intended first corpus because it exercises three surfaces at once.

### The batch-size accuracy tradeoff is unmeasured (opened 2026-09-21)

Triage puts up to ten file excerpts in one state to save requests. Irrelevant
context is a documented Jev weakness, so batching may cost accuracy. `flowmap eval
--batch 1,10,30` exists to measure this and has not been run. The default of 10 is
a guess.

### Surface classification is written but not wired (opened 2026-09-21)

`references/questions.json` carries the `surface` Choice question with criteria that
separate `http_api` from `agent_tool` by caller and discovery contract rather than
transport. The script does not yet call it; `surface` currently comes from whatever
the agent writes into `steps.json`. The criteria are the part most likely to be
wrong, and nothing measures them yet.

### Head extraction is a regex, not a parse (opened 2026-09-21)

`makeHead` takes the first 600 bytes plus a line-level `export` match. A file whose
entry points appear later and which exports nothing recognizable can be missed at
triage. This is a deliberate tradeoff against carrying a parser per language, but
the miss rate is unknown until the corpus exists.

### No command surface (opened 2026-09-21)

The plugin ships a skill and no slash command. Driving the four stages by hand means
typing node invocations. A `/user-flows` command wrapping the sequence is the
obvious next addition, deferred until the stage boundaries stop moving.

### Vendored trees need an explicit --exclude (opened 2026-09-21)

Running against a real project surfaced 35 of 62 selected files coming from
vendored third-party skill templates that git tracks. Jev was right about them:
they are user-reachable code. They are just not that project's own surface, which
is a distinction the question cannot make from a file excerpt. `--exclude` is the
workaround. Inferring it, for example from a `vendor` or `templates` convention,
is guesswork we have not earned.

### Gitignore negations are not applied (opened 2026-09-21)

`!pattern` lines are recorded as unsupported and the files they re-include stay
skipped. Erring toward skipping is deliberate: a half-applied negation would read
a file the project asked us not to read. The run names every rule it ignored.

## Closed

### Own source classified as binary (closed 2026-09-21, v0.1.0)

The first live run dropped `flowmap.mjs` from its own triage. A unicode escape in
the path-validation regex had been written to disk as a raw NUL byte, so the file
tripped the NUL-byte binary check. Fixed, with a regression test that scans every
source file for raw control bytes.

### Secrets and build output reached the provider (closed 2026-09-21, v0.1.0)

Pointing the tool at a real project would have uploaded its ignored `.local/`
tokens and, separately, minified build output sitting behind a nested
`.gitignore`. Fixed three ways: a wider secret deny list, gitignore awareness
including nested files, and build-output directories in the deny segments.
