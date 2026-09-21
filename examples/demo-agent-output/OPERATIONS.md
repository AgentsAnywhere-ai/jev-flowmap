# Operations audit

Generated 2026-09-21T18:20:29.398Z by jev-flowmap against tree `a8a246ecafab`, model `jev-1.13.0`, policy `operations-audit-v1+29597668b1be`.

## Coverage

Enumerated 11 files. Scanned 10 source files; skipped 1 non-source, 0 gitignored, 0 excluded, 0 denied, 0 binary.
Found 16 candidate operations and classified 16.
This audit covers what the scanner could find. An operation expressed in a way the patterns do not match is not in this table.

> Thresholds in this run are policy defaults, not measured values.

## The three columns

**X** is a confident call, **?** is not.

| Operation | Where | code | LLM | Jev | Why |
|---|---|:--:|:--:|:--:|---|
| extractInvoiceNumber | `src/extract.js:6` | **X** |   |   | one exact answer (10.7% of the bill) |
| draftReply | `src/writing.js:14` |   | **X** |   | a person reads the output (3.3% of the bill) |
| extractDueDate | `src/extract.js:15` |   | **?** |   | a person reads the output; not a confident call: llm 0.57 against code 0.37 (10.7% of the bill) |
| summariseFindings | `src/writing.js:30` |   | **X** |   | a person reads the output (4.1% of the bill) |
| writeBriefing | `src/writing.js:6` |   | **X** |   | a person reads the output (3.0% of the bill) |
| writePatch | `src/writing.js:22` |   | **X** |   | a person reads the output (2.6% of the bill) |
| areWeDone | `src/loop.js:17` |   |   | **X** | Noul; check the artifact, not the answer (4.9% of the bill) |
| chooseModelTier | `src/loop.js:26` |   |   | **X** | Choice (0.4% of the bill) |
| isDraftReadyForReview | `src/review.js:6` |   |   | **X** | Noul; compound: split into separate Nouls before asking it; check the artifact, not the answer (7.7% of the bill) |
| isToolCallSafe | `src/review.js:15` |   |   | **X** | Noul (1.7% of the bill) |
| isUrgent | `src/routing.js:16` |   |   | **X** | Noul; a rule standing in for judgment, not computing an exact answer |
| needsHuman | `src/review.js:24` |   |   | **X** | Noul (1.1% of the bill) |
| pickNextWorker | `src/loop.js:8` |   |   | **X** | Choice; answers are not listable in advance, which is the hard part (9.5% of the bill) |
| relevanceCheck | `src/research.js:6` |   |   | **X** | Noul (39.8% of the bill) |
| routeTicket | `src/routing.js:9` |   |   | **X** | Choice; a rule standing in for judgment, not computing an exact answer |
| timeSensitivity | `src/research.js:16` |   |   | **X** | Score (0.5% of the bill) |

**Column total: code 1 · LLM 5 · Jev 10**

1 row(s) are marked **?** rather than **X**: the distribution was spread, so the column is a guess. Read those yourself before acting on them: extractDueDate.

## What it costs today

Assuming a 30-day month and the volumes supplied. 14 of 16 operations had volumes; the rest are absent from this section entirely rather than estimated.

| Operation | Column | Calls/day | Monthly | Share | If moved to Jev |
|---|---|--:|--:|--:|--:|
| relevanceCheck | jev | 480 | $440.64 | 39.8% | $3.63 |
| extractInvoiceNumber | code | 220 | $118.80 | 10.7% | n/a |
| extractDueDate | llm | 220 | $118.80 | 10.7% | n/a |
| pickNextWorker | jev | 40 | $105.00 | 9.5% | $0.71 |
| isDraftReadyForReview | jev | 40 | $85.44 | 7.7% | $0.55 |
| areWeDone | jev | 40 | $54.60 | 4.9% | $0.45 |
| summariseFindings | llm | 20 | $45.00 | 4.1% | n/a |
| draftReply | llm | 30 | $36.00 | 3.3% | n/a |
| writeBriefing | llm | 10 | $33.60 | 3.0% | n/a |
| writePatch | llm | 5 | $28.50 | 2.6% | n/a |
| isToolCallSafe | jev | 100 | $19.20 | 1.7% | $0.15 |
| needsHuman | jev | 40 | $12.24 | 1.1% | $0.10 |
| timeSensitivity | jev | 40 | $5.04 | 0.5% | $0.04 |
| chooseModelTier | jev | 40 | $4.56 | 0.4% | $0.04 |

Total across priced operations: **$1107.42 per month.**
Moving only the Jev-column rows, at the same call volumes and input sizes, projects **$721.05 per month**. That is arithmetic on your numbers, not a measurement, and it assumes the replacement answers as well as what it replaces. Nothing here establishes that it does.

## Limitations

- A column is a suggestion about where an operation belongs, not a migration plan. Nothing here has been changed, tested or measured.
- Thresholds are policy defaults. No labeled evaluation has set them, so do not read a probability here as an accuracy.
- The scanner finds model calls and judgment written as keyword or pattern rules. An operation expressed some other way is missing from this table, and a missing row is invisible by definition.
- Cost figures are arithmetic on the volumes and rates you supplied, over an assumed month. They are only as good as those inputs.
- Moving an operation to a cheaper model is a change in behavior. This audit says nothing about whether the cheaper answer is as good; that needs a labeled set of your own cases.
- A row marked ? is a column the model was not confident about. It is shown because hiding it would be worse, not because it is settled.
- The code column holds operations that currently cost a model call, or are written as an approximating rule, whose answer is actually exact. Exact rules already written as exact rules are not candidates and are not scanned for, so an empty code column is common and is not a finding.
- Nothing in this repository was run, built or opened.

## Usage

16 requests, 36376 input tokens. Estimated charge for this audit $0.0015.
