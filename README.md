# jev-flowmap

**Two ways to look at a codebase before you change it: what a user can actually do
in it, and what your model calls are actually costing you.**

A Claude Code plugin with two skills. Both read your repository and cite what they
found. Neither one runs, builds or opens it.

| Skill | Ask it | It gives you |
|---|---|---|
| **user-flows** | "Map the user flows in this repo" | Every path a user or calling program can take, each step citing the lines it came from, with dead ends and guards marked |
| **operations-audit** | "Where is our LLM spend going?" | Every operation sorted into code / LLM / classifier, with the reason, and ranked by share of the bill |

[Install](#install) · [Map user flows](#skill-one-map-the-user-flows) · [Audit operations](#skill-two-audit-the-operations) · [Limits](#limits)

---

# Skill one: map the user flows

**Ask your coding agent how signup works in an unfamiliar repo, and it will tell you.
Confidently. Including the steps that do not exist.**

`user-flows` makes the agent show its work instead. It maps the paths a user or a
calling program can take through a codebase, and every step in the output cites the
lines it came from. Steps the source does not support are removed and listed
separately, so you can see what the agent tried to claim and could not back up.

### The problem it solves

An agent reading a codebase produces fluent prose about it. That prose mixes three
things a reader cannot tell apart: what the agent read in the source, what it inferred
from a filename, and what it pattern-matched from projects it saw in training.

The third kind is the expensive one. A flow map with one invented step in it is worse
than no flow map, because you will act on it.

The fix is not a better prompt. It is refusing to let a claim into the document
without the bytes that establish it.

### How it works

Four stages. Ordinary code owns the workflow, every threshold and every number. A
classifier model answers narrow yes-or-no questions. Your agent does the reasoning.
The model writes none of the prose, which is the whole reason it belongs here.

| Stage | Who | What happens |
|---|---|---|
| 1. Triage | model | One question per file: does this define behavior a user can reach? |
| 2. Extraction | your agent | Propose the flows and steps, each citing line ranges |
| 3. Verification | model | Five independent checks per step, against the cited lines only |
| 4. Escalation | your agent | Re-read the uncertain ones with full file context |
| Render | code | Assemble the graph, write the document |

The five checks on every step: does the evidence establish this action exists, can the
actor reach it from the previous step, is there a guard that can block it, does the
actor get stranded here with no way forward, and does it delete, spend or send
anything.

### See it work

[`examples/demo-app-output/`](examples/demo-app-output/) holds real artifacts from a
real run against [`examples/demo-app/`](examples/demo-app/), a small app with a
browser UI, an HTTP API, an agent tool surface, a CLI, a guard, a destructive action
and a deliberately broken path.

The proposed steps in that run include one the source does not support: a deletion
confirmation dialog that was never built. Verification scored it **0.02** and moved it
out of the graph into "claims the source does not support."

Unprompted, the same run found the dead end, a screen that empties itself on an
expired session with no message and no way back, and flagged the destructive delete.
The guard it attributed to those steps lives in a *different file*, one that triage had
already correctly excluded as not user-reachable on its own.

Sixteen requests. About 1.3 seconds. **$0.0010.**

### What it is for

Use it when:

- **You are new to a codebase** and need to know what a user can actually do, before
  you trust a summary of it.
- **Your docs have drifted** and you want a map built from the code rather than from
  the last person's memory of it.
- **You are reviewing reachability**: which screens sit behind which guard, where a
  path dead-ends, which actions are destructive.
- **You are inheriting or auditing** something nobody left notes on.
- **You want an agent's repo summary to be checkable** rather than taken on faith.

Do not use it when:

- **The repo is small enough to read.** Ten files do not need a pipeline. Read them.
- **You need the running app driven.** This is static. It never executes anything.
- **You want prose about architecture.** It maps what a user can reach, not how the
  system is built underneath.

# Skill two: audit the operations

**Every operation in your codebase gets one of three answers, and the answer decides
what should be running it.**

> Produces text a person reads → **LLM**.
> Has one exact, computable answer → **code**.
> Picks, scores or judges, and code acts on the result → **a classifier**.

The third column is the one nobody has counted. It fills up with full generative
calls being tokenized, sampled word by word, and parsed back into a boolean that an
`if` statement branches on.

`operations-audit` finds them. It scans for model call sites *and* for judgment
written as keyword rules, which is the kind nobody thinks of as an AI operation at
all. Then it sorts each one, names the question shape that would replace it, and
ranks by share of the bill when you supply call volumes.

It also reads where each result is **used**, not just where it is defined. Asked
whether code branches on a result while looking only at the function that returns it,
the honest answer is always no.

### What it catches beyond the column

The annotations are the useful part. From the worked example, unprompted:

- A review gate asking four conditions as one question, flagged **compound**, so a
  failure cannot say which condition failed.
- A completion check asking the model whether it finished, flagged **check the
  artifact, not the answer**.
- A keyword router and an urgency check, flagged as **rules standing in for
  judgment**. Written as conditions, and still not conditions.
- A frontier model being paid to run a regex over invoice numbers.
- A worker-selection step flagged **answers are not listable in advance**, which is
  the honest caution: if the options cannot be written down first, no classifier
  fixes that.

### See it work

[`examples/demo-agent-output/`](examples/demo-agent-output/) holds real artifacts from
a real run against [`examples/demo-agent/`](examples/demo-agent/), a small research
agent containing one of each case. Sixteen operations sorted in 0.6 seconds for
$0.0015. The biggest line came back at **39.8% of the bill**: one yes-or-no question
asked 480 times a day.

One row is marked **?** rather than **X**, with its runner-up shown. That is the model
saying it does not know, and the page refusing to hide it.

### Using it

```sh
node skills/operations-audit/scripts/opaudit.mjs scan ../your-repo
node skills/operations-audit/scripts/opaudit.mjs classify --volumes volumes.jsonl
```

Volumes are one JSON object per line, matched by operation name:

```json
{"operation": "relevanceCheck", "callsPerDay": 480, "avgInputTokens": 6000, "costPerCallUsd": 0.0306}
```

**Without volumes there is no cost section at all.** Call counts cannot be read out of
source code, and a ranking built on a guess would be the most quotable number in the
document.

---

## Install

```sh
claude plugin marketplace add AgentsAnywhere-ai/jev-flowmap
claude plugin install jev-flowmap@jev-flowmap
```

Then get a key from [TypeSafe](https://typesafe.ai) and put it in your environment. It
is read from there, never written to a file and never passed as an argument:

```sh
export TYPESAFE_API_KEY=...
```

Restart Claude Code. Requires Node 22 or newer. No other dependencies, ever.

## Using them

**In your agent**, just ask. Whichever skill fits activates on its own:

> Map the user flows in this repo
>
> Where does the checkout flow dead-end?
>
> Which of these screens are behind auth?
>
> Where is our LLM spend going?
>
> Which of our model calls could a classifier do?
>
> Audit this agent loop before we optimize it

Your agent runs the stages, does the proposing and escalating itself, and hands you
`FLOWS.md` or `OPERATIONS.md` plus the JSON behind it.

**By hand**, if you would rather drive the flow mapper yourself:

```sh
node skills/user-flows/scripts/flowmap.mjs triage ../your-repo --exclude 'vendor/,examples/'
# your agent writes .flows/steps.json here
node skills/user-flows/scripts/flowmap.mjs verify .flows/steps.json
node skills/user-flows/scripts/flowmap.mjs render
```

Each stage writes its own file, so you can read what was screened before paying for
verification.

## Reading the output

Both documents open with coverage, before any finding, because a partial result that
reads like a complete one is the exact failure this plugin exists to prevent:

> Enumerated 342 files. Denied 5, binary 3, over size limit 1, gitignored 10,
> excluded 0. Screened 327, included 62, truncated 48, unevaluated 0. 265 files were
> omitted below the reach threshold and are listed in the omission ledger. This map
> covers the included files only.

That is from a real 342-file project, not an illustration. Every omitted file is named
in the ledger with the number that omitted it. Nothing is summarized away.

A step marked `verified` means **the named checks passed against the supplied
source**. It does not mean the flow works, that it is complete, or that anything ran.
A flow can have every step verified and still be broken for a user, so the document
says `verified, 1 gap, 2 dead ends` rather than letting `verified` stand alone.

## Limits

Stated plainly, because a tool about not overclaiming should not overclaim.

- **The thresholds are not calibrated.** The numbers that decide what counts as
  verified are defaults chosen for a first run, not measured values. `flowmap eval`
  against a hand-labeled corpus is what replaces them, and it has not been run yet.
  Until it has, do not read a probability here as an accuracy.
  See [KNOWN-GAPS.md](KNOWN-GAPS.md).
- **Coverage is partial by construction.** A repository that declares its entry points
  somewhere the excerpt does not reach will be under-screened. The coverage block is
  how you find out, which is why it comes first.
- **Escalation buys context, not a better model.** Both reasoning stages are your same
  agent. Stage 4 re-reads the whole file instead of an excerpt. That is a real
  improvement and a weaker claim than two different models.
- **Gitignored files are skipped**, including via nested `.gitignore` files, and every
  skip is named. Negation rules (`!pattern`) are not applied and their files stay
  skipped, because reading a file the project asked you not to read is the worse
  error. Vendored trees that git *does* track need `--exclude`.
- **The model is text-only** and documented as weak at arithmetic, counting, dates and
  long irrelevant context. All counting here happens in code, state is kept short, and
  source text is treated as evidence rather than as instructions.
- **A column is not a migration.** The operations audit says where work looks like it
  belongs. Whether a cheaper answer is as good is a question only a labeled set of your
  own cases can settle, and this does not run one.
- **A missing row is invisible.** The scanner finds model calls and rule-shaped
  judgment. An operation expressed some other way is simply absent from the table, and
  the coverage block is the only place that shows it.

## Cost

$0.042 per million input tokens, and output is free. Triaging a 1,000-file repository
runs to a few cents. Verification adds one request per proposed step. Every run
reports its own usage and an estimate, labeled as the model charge only.

## Development

```sh
npm test    # node --test, 103 tests, no dependencies, no network
```

[docs/design.md](docs/design.md) is the full design: question wording, policy bands,
schema, failure handling and the evaluation plan. Read it before changing a question,
because changing one invalidates comparison with older runs by design.

---

## Who built this

[**Agents Anywhere**](https://agentsanywhere.ai) finds where AI and better software fit
in how a company actually runs, puts it in place, and stays accountable for it in
production.

This tool is that same discipline pointed at a codebase. Before we build anything for a
company, we map how that company actually works: not by interviewing whoever had a
calendar slot, but by asking every person what they really do, capturing the
spreadsheets and workarounds that never show up on an org chart, and measuring the work
before anything changes. Only what the map supports gets built, and what "done" means is
written down before anyone pays for it.

Most of what that finds is not a build. That is the point of looking first.

Three rules run both: cover everything rather than sample it, carry the evidence rather
than assert the conclusion, and refuse the claim you cannot support.

If the thing that needs mapping is your operation rather than your repository,
[that is what we do](https://agentsanywhere.ai).

---

MIT licensed. Issues and pull requests welcome.
