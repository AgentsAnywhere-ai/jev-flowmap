# What the operations audit produced for demo-agent

Real artifacts from a real run against [`../demo-agent/`](../demo-agent/). Sixteen
operations sorted in **0.6 seconds for $0.0015**.

```sh
export TYPESAFE_API_KEY=...
node ../../skills/operations-audit/scripts/opaudit.mjs scan ../demo-agent
node ../../skills/operations-audit/scripts/opaudit.mjs classify --volumes volumes.jsonl
```

`volumes.jsonl` here is invented, because a synthetic agent has no real traffic. It is
in the shape a real one would be, and the arithmetic performed on it is the same
arithmetic that would run on yours.

## What the run found

**Column total: code 1 · LLM 5 · Jev 10.**

The largest single line is `relevanceCheck` at **39.8% of the bill**: one yes-or-no
question, 480 calls a day, answered by a frontier model that tokenizes a sentence and
throws it away so an `if` statement can read a boolean.

Six annotations came out of the fit checks rather than the column, and they are the
part worth reading:

| Operation | What the audit said | Why it matters |
|---|---|---|
| `isDraftReadyForReview` | compound: split into separate Nouls | Four conditions asked as one. When it fails you cannot tell which condition failed. |
| `areWeDone` | check the artifact, not the answer | It asks the model whether the goal is met instead of looking at what was produced. |
| `pickNextWorker` | answers are not listable in advance | The honest caution. If the options cannot be written down first, no classifier fixes this. |
| `routeTicket`, `isUrgent` | a rule standing in for judgment | Keyword lists doing a judgment's job. Written as a condition, and still not one. |
| `timeSensitivity` | Score | A rating on a described scale, not arithmetic, and not a yes-or-no. |
| `extractInvoiceNumber` | one exact answer | A frontier model being paid $118.80 a month to do a regex's job. |

## The row that is not an X

`extractDueDate` is marked **?**, not **X**, with `llm 0.57 against code 0.37`.

That is the model saying it does not know, and the renderer showing it. An earlier
version of this tool displayed that row identically to a confident one, which is
precisely the failure the whole plugin exists to prevent. A coin flip and a call must
not look the same on the page.

## What this run does not tell you

The projected saving at the bottom of `OPERATIONS.md` is arithmetic on the supplied
volumes at the same call sizes. It assumes the replacement answers as well as what it
replaces, and **nothing here establishes that.** Settling it needs a labeled set of
your own cases, run against both, with the accuracy compared per confidence band.

That is the next piece of work every time. It is not this one.
