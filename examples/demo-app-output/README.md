# What jev-flowmap produced for demo-app

These are **real artifacts from a real run**, not hand-written illustrations. The
whole run was 16 requests, about 1.3 seconds of provider time, and **$0.0010**.

One caveat on reproducing it: this triage was captured when the default batch size
was 10 files per request. The default is now 1, on the evidence that smaller state
reads more accurately, so your numbers will differ slightly from the ones in
`triage.json`. The separation holds either way.

Reproduce it yourself:

```sh
export TYPESAFE_API_KEY=...
node ../../skills/user-flows/scripts/flowmap.mjs triage ../demo-app
cp steps.json .flows/steps.json     # stage 2 is the agent's; this is what it wrote
node ../../skills/user-flows/scripts/flowmap.mjs verify .flows/steps.json
node ../../skills/user-flows/scripts/flowmap.mjs render
```

## The files

| File | Stage | What to look at |
|---|---|---|
| `triage.json` | 1, Jev | `files[]` with a reach probability each, plus `shadow` |
| `steps.json` | 2, agent | the proposed flows, every step citing line ranges |
| `verdicts.json` | 3, Jev | five probabilities per step and the label they produced |
| `flows.json` | assembled | the graph, the artifact of record |
| `FLOWS.md` | rendered | what a person reads |

## Four things worth reading closely

### 1. It refused a step that does not exist

`steps.json` deliberately claims the user confirms deletion in a dialog. No such
dialog is in the source. Verification returned `supported: 0.02`, and the step was
removed from the graph and moved to "claims the source does not support" in
`FLOWS.md` rather than quietly dropped.

This is the property that makes the output worth reading. A flow map you cannot
trust to omit invented steps is just prose.

### 2. It found the dead end

`src/web/account.js` empties the page on an expired session, with no message, no
retry and no way back to sign in. `account:2` came back `terminal_failure: 0.96`.

Nothing in the step text said "dead end". The judgment came from the evidence.

### 3. It found the destructive step and the guards

`account:3`, deleting the account, returned `destructive: 0.98` and `guarded: 0.93`.
`api-signup:1` returned `guarded: 0.97` for the session check. The guards are in
`src/session.js`, a *different file* from the steps that apply them, and that file
scored 0.08 at triage and was correctly excluded as not user-reachable itself.

### 4. The triage separation was clean

Every reachable file scored 0.93 to 0.97. Every internal file scored 0.04 to 0.08.
Nothing landed between 0.08 and 0.93, so any threshold in that range gives the same
answer here. The naive path heuristic selected 2 of the 5 correct files.

A gap that clean on a 10-file synthetic app is not evidence of accuracy on a real
one. It is a sanity check that the question means what it says.

## What the run did not resolve

Four steps came back in an uncertain band and are labeled `unverified`, including
`signup:0`, "open the signup screen". That is honest: demo-app has no router, so
nothing in the source actually establishes how a visitor arrives at the signup
screen. A real run escalates those to the agent for a full-file read. This example
stops before stage 4 so the raw bands stay visible.

`FLOWS.md` also headlines one flow as `verified, 1 gap, 2 dead ends`. Every step
in it passed its checks, and it is still broken for a user. Those are different
claims and the document keeps them apart.
