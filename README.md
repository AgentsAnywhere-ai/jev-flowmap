# jev-flowmap

**v0.1.0 · thresholds uncalibrated · not yet evaluated against a labeled corpus**

A Claude Code plugin that maps the user flows of a repository by reading its source.
Jev screens which files carry user-reachable behavior and verifies each claimed step
against cited code. The plugin emits a `flows.json` graph and a rendered `FLOWS.md`
where every step cites the bytes it came from.

It never runs, builds or opens the project it reads.

## Why this shape

Writing up the user flows of an unfamiliar repository is slow, and the result is
usually unverifiable prose: a reader cannot tell which sentences came out of the
source and which were inferred from naming.

This splits the work. The cheap, high-volume parts are typed judgments with recorded
probabilities. The expensive part is the map itself, which stays with the agent.
Jev writes none of the prose, which is the whole reason a text model is appropriate
here at all.

```
stage 1  triage        Jev     one Noul per file: is this user-reachable?
stage 2  extraction    agent   propose candidate flows and steps, with citations
stage 3  verification  Jev     five independent Nouls per step, over cited evidence
stage 4  escalation    agent   re-read the uncertain ones with full-file context
         render        code    assemble the graph, write the document
```

## See it work

[`examples/demo-app-output/`](examples/demo-app-output/) holds the real artifacts
from a real run against [`examples/demo-app/`](examples/demo-app/), a synthetic app
with four surfaces, a guard, a destructive step and a deliberate dead end.

The proposed steps in that run deliberately include one the source does not support:
a deletion confirmation dialog that does not exist. Verification returned
`supported: 0.02` and moved it out of the graph into "claims the source does not
support". It also found the dead end (`terminal_failure: 0.96`) and the destructive
step (`destructive: 0.98`) on its own. 16 requests, about 1.3 seconds, $0.0010.

Measured on a real 342-file project: 327 files screened in 33 requests in 1.1
seconds for $0.0059, selecting 62 entry points where the naive path heuristic found
14. Those are two runs on two repositories, not a benchmark.

## Install

```sh
claude plugin marketplace add joshatbrndsh/agents-anywhere-marketplace
claude plugin install jev-flowmap@agents-anywhere
```

Then set a key from [TypeSafe](https://typesafe.ai). It stays in your environment
and is never written to a file or passed as an argument:

```sh
export TYPESAFE_API_KEY=...
```

Ask Claude to map the user flows of a repository and the skill activates. Or drive
the stages by hand:

```sh
node skills/user-flows/scripts/flowmap.mjs triage ../some-repo --exclude 'vendor/,examples/'
# write .flows/steps.json
node skills/user-flows/scripts/flowmap.mjs verify .flows/steps.json
node skills/user-flows/scripts/flowmap.mjs render
```

## What the output means

`FLOWS.md` opens with a coverage block, before any flow, because a partial map that
reads like a complete one is the specific failure this tool exists to prevent:

> Enumerated 342 files. Denied 5, binary 3, over size limit 1, gitignored 10,
> excluded 0. Screened 327, included 62, truncated 48, unevaluated 0. 265 files were
> omitted below the reach threshold and are listed in the omission ledger. This map
> covers the included files only.

That block is from the 342-file run above, not an illustration.

Every omitted file is named in the ledger with the probability that omitted it.
Nothing is summarized away.

A step labeled `verified` means **the named checks passed against the supplied
source**. It does not mean the flow works, that it is complete, or that anything was
executed. Steps the evidence contradicted are removed from the graph and listed
under "claims the source does not support," rather than quietly dropped.

## Honest limits

- **The thresholds are invented.** The bands in `references/questions.json` are
  policy defaults chosen for a first run, not measured values. `flowmap eval`
  against a hand-labeled corpus is what replaces them. Until that has run, do not
  read a probability here as an accuracy. See [KNOWN-GAPS.md](KNOWN-GAPS.md).
- **Escalation buys context, not a better model.** Both reasoning stages are the
  same agent. Stage 4 re-reads with the whole file rather than a head excerpt. That
  is a real cascade, and a weaker claim than one with two different models.
- **Coverage is partial by construction.** A repository whose entry points are
  declared somewhere the 600-byte head excerpt does not reach will be
  under-screened. The coverage block is how you find out.
- **Gitignored files are skipped**, including via nested `.gitignore` files, and
  every skip is named in the omission ledger. Gitignore negations (`!pattern`) are
  not applied; files they re-include stay skipped and the run says which rules it
  ignored. Vendored trees that git *does* track need `--exclude`.
- **Jev is text-only**, and documented as weak at arithmetic, counting, dates,
  indirect questions, long irrelevant context and adversarial input. All counting
  here happens in code, state is kept short, and source text is treated as evidence
  rather than instruction.
- **Static only.** Driving a running application is a different design with
  different safety gates, and is not this.

## Cost

Jev is $0.042 per million input tokens with free output. Triaging a 1,000-file
repository at roughly 500 tokens per file is about two cents. Verification adds one
request per proposed step. Every run reports its own usage and an estimate, and that
estimate is the Jev charge only.

## Development

```sh
npm test    # node --test, no dependencies, no network
```

The design document is [docs/design.md](docs/design.md). It is the onboarding
artifact: question wording, policy bands, schema, failure handling and the
evaluation plan all live there.

MIT. Built by [Agents Anywhere](https://agentsanywhere.ai).
