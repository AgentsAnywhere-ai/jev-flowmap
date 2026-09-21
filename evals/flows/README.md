# Triage evaluation corpus

Until this directory holds a labeled corpus, every threshold the plugin ships is an
invented default and the tool says so in its own output.

## Format

`labeled.jsonl`, one JSON object per line:

```json
{"path": "src/worker/app.ts", "userReachable": true}
{"path": "src/shared/types.ts", "userReachable": false}
```

Paths are relative to the repository you pass as `--root`. **This file stores paths
and labels, never source.** The corpus is public; the repository it describes may
not be.

## Labeling rule

Answer one question per file, from the file itself, not from its name:

> Does this file define behavior that a person or a calling program can reach
> directly: a screen, route, endpoint, tool, command, form or navigation step?

Yes for a rendered view, a route or endpoint handler, a tool or command
registration, a form submission, a navigation or redirect. No for internal plumbing,
configuration, types and schemas, build tooling, tests, fixtures, and helpers
reached only from other code.

Label the borderline cases deliberately rather than skipping them. A corpus of only
obvious files measures nothing, because the naive path heuristic gets those right
too.

## Running it

```sh
node ../../skills/user-flows/scripts/flowmap.mjs eval labeled.jsonl --root /path/to/repo --batch 1,10,30
```

The report gives accuracy at the shipped threshold, the best separating threshold,
the naive heuristic's accuracy for comparison, and every miss with its probability.

Read the `diagnosis` field before touching a threshold. If most misses come back
confident, the question wording or the criteria are wrong, and moving the threshold
will not help.

## What 50 files buys you

Enough to find defects and set a first threshold. Not enough to claim calibration.
Do not let any output say otherwise.
