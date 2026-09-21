# demo-agent

A small synthetic research agent, not runnable and not a real product. It exists so
the operations audit has something to sort that anyone can inspect.

It deliberately contains one of each thing the audit is looking for:

- **Exact rules, correctly in code** (`src/limits.js`): an action cap, a spend
  refusal, an invoice regex. These are not candidates, because a rule already written
  as a rule is not paying anyone anything.
- **Prose for a person to read** (`src/writing.js`): a briefing, a reply, a patch, a
  summary. These belong on a generative model and should stay there.
- **Judgment paying frontier prices** (`src/loop.js`, `src/review.js`,
  `src/research.js`): pick the next worker, are we done, is this safe, is the draft
  ready, is this passage relevant. Every one ends as a boolean or a label that an
  `if` statement branches on.
- **Judgment written as keyword rules** (`src/routing.js`): a routing function and an
  urgency check built from word lists. Nobody calls these AI operations, which is
  why they never get audited.
- **A model doing a regex's job** (`src/extract.js`): pulling an invoice number and a
  due date out of a document with a frontier model.
- **One compound question** (`isDraftReadyForReview`): four conditions asked as one,
  so a failure cannot say which condition failed.
- **One check on the model's own word** (`areWeDone`): asks whether the goal is met
  rather than looking at the artifact.

`src/turn.js` is the orchestrator where every one of those results is actually
branched on. It matters to the audit: asked whether code branches on a result while
looking only at the function that returns it, the honest answer is always no.

The generated output is in [`../demo-agent-output/`](../demo-agent-output/).
