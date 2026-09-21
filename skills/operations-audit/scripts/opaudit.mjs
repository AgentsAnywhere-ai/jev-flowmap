#!/usr/bin/env node
// opaudit: sort the operations in a codebase into three columns.
//   produces text a person reads -> llm
//   has one exact answer         -> code
//   picks, scores or judges      -> jev
// Code finds the candidates and does every calculation. Jev answers the sorting
// question and the fit test. Nothing here executes the repository it reads.

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  sha256, policyVersion, denyPath, looksBinary, chunkFiles, validateAnswer,
  estimateCostUsd, pool, callJev, enumerate, treeHashOf, loadQuestions as loadQuestionsAt,
} from '../../../lib/jev.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const loadQuestions = (path = join(HERE, '..', 'references', 'questions.json')) => loadQuestionsAt(path);
export const loadRates = async (path = join(HERE, '..', 'references', 'rates.json')) =>
  JSON.parse(await readFile(path, 'utf8'));

// ------------------------------------------------------------------ scanning

/**
 * Two kinds of candidate, because two kinds of operation get missed.
 * A model call is obvious once you look. Judgment written as a keyword list is
 * not, and it is usually the one nobody knew was a decision at all.
 */
export const PATTERNS = [
  // model call sites, across the SDKs people actually use
  { kind: 'model_call', re: /\.(messages|responses|completions)\.(create|stream)\b/ },
  { kind: 'model_call', re: /\.chat\.completions\.(create|stream)\b/ },
  { kind: 'model_call', re: /\b(generateText|generateObject|streamText|streamObject|embedMany)\s*\(/ },
  { kind: 'model_call', re: /\b(ChatOpenAI|ChatAnthropic|ChatGoogleGenerativeAI|ChatBedrock|ChatOllama)\s*\(/ },
  { kind: 'model_call', re: /\b(invoke_model|converse|GenerativeModel|ChatCompletion)\b/ },
  { kind: 'model_call', re: /\b(llm|model|client|ai)\.(invoke|predict|generate|complete|respond)\s*\(/ },
  { kind: 'model_call', re: /\bollama\.(chat|generate)\b|\bcohere\.(chat|classify)\b|\bmistral\.chat\b/ },

  // judgment written as rules
  { kind: 'rule', re: /\b[A-Z][A-Z0-9_]{2,}(KEYWORDS|WORDS|TERMS|PATTERNS|RULES|TRIGGERS|SIGNALS)\b/ },
  { kind: 'rule', re: /\b(keywords|triggerWords|urgentWords|routingRules|badWords|stopWords)\b/i },
];

/** A condition that tests three or more string literals is a rubric in disguise. */
export function looksLikeRuleLine(line) {
  if (!/\b(if|elif|elsif|when|case|while)\b|\?\s*$|=>\s*$/.test(line) && !/\.(includes|some|test|match|search)\s*\(/.test(line)) return false;
  const literals = (line.match(/(['"`])(?:(?!\1)[^\\]|\\.){2,}?\1/g) || []).length;
  const alternations = (line.match(/\|/g) || []).length;
  return literals >= 3 || (alternations >= 3 && /\/.*\|.*\//.test(line));
}

const NAME_RE = /(?:export\s+)?(?:async\s+)?(?:function|def|fn|func|sub)\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function)|([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?\(/;

/**
 * Nearest named function or binding above the match. Names the operation.
 * `named` is false when nothing was found and the raw line stood in, which the
 * caller uses to drop declarations that are not operations in their own right.
 */
export function labelFor(lines, index, lookback = 40) {
  for (let i = index; i >= Math.max(0, index - lookback); i--) {
    const m = NAME_RE.exec(lines[i]);
    if (m) {
      const name = m[1] || m[2] || m[3];
      if (name && !/^(if|for|while|switch|catch|return|try)$/.test(name)) return { label: name, named: true };
    }
  }
  return { label: lines[index].trim().slice(0, 60) || `line ${index + 1}`, named: false };
}

/** Candidates in one file, collapsed to one row per named operation. */
export function scanSource(path, content, policy) {
  const lines = content.split('\n');
  const found = new Map();
  for (const [i, line] of lines.entries()) {
    if (line.length > 400) continue;
    let kind = null;
    for (const p of PATTERNS) if (p.re.test(line)) { kind = p.kind; break; }
    if (!kind && looksLikeRuleLine(line)) kind = 'rule';
    if (!kind) continue;

    const { label, named } = labelFor(lines, i);
    // One row per named operation, not per matching line. A model call and a
    // rule-shaped line inside the same function are one operation; the model
    // call is the truer description of it.
    const existing = found.get(label);
    if (existing) {
      existing.matches += 1;
      if (kind === 'model_call' && existing.kind === 'rule') existing.kind = 'model_call';
      existing.endLine = Math.min(lines.length, i + 1 + policy.windowAfter);
      continue;
    }
    found.set(label, {
      path, label, kind, named, matches: 1,
      startLine: Math.max(1, i + 1 - policy.windowBefore),
      endLine: Math.min(lines.length, i + 1 + policy.windowAfter),
      matchLine: i + 1,
    });
  }
  const rows = [...found.values()];
  // A bare keyword-list declaration is not an operation; the function that
  // consults it is, and that function is already a row. Keep the declaration
  // only when nothing named was found in this file at all.
  const anyNamed = rows.some((r) => r.named);
  return rows
    .filter((r) => r.named || !anyNamed)
    .map((c) => ({ ...c, evidence: lines.slice(c.startLine - 1, c.endLine).join('\n') }));
}

const SOURCE_EXT = /\.(m?[jt]sx?|py|rb|go|rs|java|kt|swift|cs|php|ex|exs|scala|dart|c|cc|cpp|h|hpp)$/i;

/**
 * Where else the operation is used. Without this the classifier is asked
 * whether code branches on a result while looking only at the definition that
 * returns it, and it correctly answers no every time.
 */
export function findCallSites(label, sources, definedIn, limit = 3) {
  const re = new RegExp(`\\b${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`);
  const sites = [];
  for (const [path, lines] of sources) {
    for (const [i, line] of lines.entries()) {
      if (!re.test(line)) continue;
      if (/\b(function|def|const|let|var|export)\b/.test(line) && path === definedIn) continue;
      sites.push({ path, line: i + 1, text: lines.slice(Math.max(0, i - 1), i + 2).join('\n') });
      if (sites.length >= limit) return sites;
    }
  }
  return sites;
}

export async function findCandidates(root, { policy, exclude = [], log = () => {} }) {
  const { files, omissions, ignoreRules, ignoreFiles, unsupportedIgnores } = await enumerate(root, { exclude });
  const candidates = [];
  const sources = new Map();
  let scanned = 0;
  for (const file of files) {
    if (!SOURCE_EXT.test(file.path)) { omissions.push({ path: file.path, reason: 'not_source' }); continue; }
    const info = await stat(file.abs);
    if (info.size > policy.maxFileBytes) { omissions.push({ path: file.path, reason: 'too_large' }); continue; }
    const buf = await readFile(file.abs);
    if (looksBinary(buf)) { omissions.push({ path: file.path, reason: 'binary' }); continue; }
    scanned += 1;
    const text = buf.toString('utf8');
    sources.set(file.path, text.split('\n'));
    candidates.push(...scanSource(file.path, text, policy));
  }
  for (const c of candidates) {
    c.callSites = c.named ? findCallSites(c.label, sources, c.path) : [];
  }
  candidates.sort((a, b) => b.matches - a.matches || a.path.localeCompare(b.path) || a.matchLine - b.matchLine);
  const kept = candidates.slice(0, policy.maxCandidates);
  const dropped = candidates.length - kept.length;
  log(`scanned ${scanned} source files, found ${candidates.length} candidate operations${dropped ? `, keeping the first ${kept.length}` : ''}`);
  return {
    candidates: kept, omissions, scanned,
    coverage: {
      filesEnumerated: files.length + omissions.filter((o) => ['denied', 'binary', 'gitignored', 'excluded'].includes(o.reason)).length,
      filesScanned: scanned,
      filesNotSource: omissions.filter((o) => o.reason === 'not_source').length,
      filesGitignored: omissions.filter((o) => o.reason === 'gitignored').length,
      filesExcluded: omissions.filter((o) => o.reason === 'excluded').length,
      filesDenied: omissions.filter((o) => o.reason === 'denied').length,
      filesBinary: omissions.filter((o) => o.reason === 'binary').length,
      candidatesFound: candidates.length,
      candidatesClassified: kept.length,
      candidatesDropped: dropped,
      ignoreRules, ignoreFiles, unsupportedIgnores,
    },
  };
}

// ------------------------------------------------------------------ policy

/**
 * Turn eight raw judgments into one column and its annotations.
 * The overrides live here, not in the model: a row that depends on arithmetic
 * belongs in code no matter how confidently it was sorted elsewhere.
 */
export function classify(candidate, answers, policy) {
  const f = answers.fit ?? {};
  const notes = [];
  const at = (k) => (typeof f[k] === 'number' ? f[k] : null);
  const high = (k) => at(k) !== null && at(k) >= policy.flag;
  const low = (k) => at(k) !== null && at(k) < policy.weak;

  let column = answers.column ?? null;
  let overridden = null;
  const confident = (answers.columnConfidence ?? 0) >= policy.column.confident;

  // An override is policy correcting an uncertain call. Against a confident one
  // it is policy overruling the evidence, so the conflict is surfaced to the
  // reader instead of resolved silently.
  const conflicts = [
    { when: column === 'jev' && high('arithmetic'), to: 'code',
      fix: 'depends on counting or dates, so it belongs in code',
      caution: 'flagged as depending on counting or dates; check that before treating it as a judgment' },
    { when: column === 'jev' && high('needs_reasoning'), to: 'llm',
      fix: 'needs step-by-step reasoning, so a single judgment will not settle it',
      caution: 'flagged as needing step-by-step reasoning; a single judgment may not settle it' },
    { when: column === 'code' && candidate.kind === 'rule' && high('rule_approximates'), to: 'jev',
      fix: 'a rule standing in for judgment, not computing an exact answer',
      caution: 'this rule approximates a judgment rather than computing an answer' },
  ].filter((c) => c.when);

  for (const c of conflicts) {
    if (confident) { notes.push(c.caution); continue; }
    overridden = column; column = c.to; notes.push(c.fix);
    break;
  }

  let primitive = column === 'jev' ? (answers.primitive ?? null) : null;
  if (primitive === 'not_applicable') primitive = null;

  if (column === 'code') notes.push(candidate.kind === 'rule' ? 'a rule that genuinely computes its answer' : 'one exact answer');
  if (column === 'llm') notes.push('a person reads the output');
  if (column === 'jev') {
    if (candidate.kind === 'rule' && high('rule_approximates') && !notes.length) {
      notes.push('a rule standing in for judgment, not computing an exact answer');
    }
    if (high('compound')) notes.push('compound: split into separate Nouls before asking it');
    if (high('checks_own_output')) notes.push('check the artifact, not the answer');
    if (low('listable_answers')) notes.push('answers are not listable in advance, which is the hard part');
    if (low('code_branches')) notes.push('nothing branches on the result yet');
  }

  return {
    ...candidate,
    column,
    primitive,
    overriddenFrom: overridden,
    confident,
    columnConfidence: answers.columnConfidence ?? null,
    columnProbabilities: answers.columnProbabilities ?? null,
    fit: f,
    notes,
  };
}

// ------------------------------------------------------------------ cost

/** Every multiplication happens here. The model is documented as bad at this. */
export function applyVolumes(rows, volumes, rates, policy) {
  const byLabel = new Map(volumes.map((v) => [String(v.operation).toLowerCase(), v]));
  const jevRate = rates.rates?.[rates.jevModel]?.inputPerM ?? null;
  const priced = [];
  const unmatched = volumes.filter((v) => !rows.some((r) => r.label.toLowerCase() === String(v.operation).toLowerCase()))
    .map((v) => v.operation);

  for (const row of rows) {
    const v = byLabel.get(row.label.toLowerCase());
    if (!v) { priced.push({ ...row, volume: null }); continue; }
    const rate = v.model ? rates.rates?.[v.model] : null;
    const perCall = typeof v.costPerCallUsd === 'number'
      ? v.costPerCallUsd
      : rate
        ? ((v.avgInputTokens ?? 0) * (rate.inputPerM ?? 0) + (v.avgOutputTokens ?? 0) * (rate.outputPerM ?? 0)) / 1_000_000
        : null;
    if (perCall === null) {
      priced.push({ ...row, volume: { ...v, costPerCallUsd: null, unpriced: true } });
      continue;
    }
    const monthlyUsd = Number((perCall * v.callsPerDay * policy.monthDays).toFixed(4));
    const projected = row.column === 'jev' && jevRate !== null && typeof v.avgInputTokens === 'number'
      ? Number(((v.avgInputTokens * jevRate / 1_000_000) * v.callsPerDay * policy.monthDays).toFixed(4))
      : null;
    priced.push({
      ...row,
      volume: {
        callsPerDay: v.callsPerDay, model: v.model ?? null,
        avgInputTokens: v.avgInputTokens ?? null, costPerCallUsd: Number(perCall.toFixed(8)),
        monthlyUsd, projectedMonthlyUsd: projected,
        savingMonthlyUsd: projected === null ? null : Number((monthlyUsd - projected).toFixed(4)),
      },
    });
  }

  const total = priced.reduce((n, r) => n + (r.volume?.monthlyUsd ?? 0), 0);
  for (const r of priced) {
    if (r.volume?.monthlyUsd) r.volume.shareOfBill = Number((r.volume.monthlyUsd / total).toFixed(4));
  }
  return {
    rows: priced,
    totals: {
      monthlyUsd: Number(total.toFixed(2)),
      pricedOperations: priced.filter((r) => r.volume?.monthlyUsd).length,
      unpricedOperations: priced.filter((r) => r.volume && !r.volume.monthlyUsd).length,
      projectedSavingUsd: Number(priced.reduce((n, r) => n + (r.volume?.savingMonthlyUsd ?? 0), 0).toFixed(2)),
      monthDays: policy.monthDays,
      unmatchedVolumeRows: unmatched,
    },
  };
}

export const columnTotals = (rows) => ({
  code: rows.filter((r) => r.column === 'code').length,
  llm: rows.filter((r) => r.column === 'llm').length,
  jev: rows.filter((r) => r.column === 'jev').length,
  not_an_operation: rows.filter((r) => r.column === 'not_an_operation').length,
  unclassified: rows.filter((r) => !r.column).length,
});

/**
 * A tool built on Jev that puts everything in the Jev column is not reporting a
 * finding, it is reporting a broken question. Say so in the artifact.
 */
export function skewWarning(totals) {
  const sorted = totals.code + totals.llm + totals.jev;
  if (sorted < 5) return null;
  const share = totals.jev / sorted;
  if (share >= 0.9) {
    return `${totals.jev} of ${sorted} sorted operations landed in the Jev column. A split that lopsided usually means the sorting question is wrong, not that the codebase is. Treat this run as suspect and check the column criteria before acting on it.`;
  }
  return null;
}

// ------------------------------------------------------------------ classify

export async function classifyAll(candidates, { apiKey, questions, fetchImpl = fetch, log = () => {} }) {
  const policy = questions.policy;
  const usage = { requests: 0, inputTokens: 0, outputTokens: 0, failures: [] };
  const out = new Array(candidates.length);
  log(`classifying ${candidates.length} operations`);

  await pool(candidates, policy.concurrency, async (candidate, i) => {
    const q = {
      column: { type: 'choice', instructions: questions.guard + questions.column.instructions, criteria: questions.column.criteria },
      primitive: { type: 'choice', instructions: questions.guard + questions.primitive.instructions, criteria: questions.primitive.criteria },
    };
    for (const [id, spec] of Object.entries(questions.fit)) {
      q[`fit_${id}`] = { type: spec.type, instructions: questions.guard + spec.instructions, criteria: spec.criteria };
    }
    const body = {
      model: questions.model,
      state: {
        operation: { name: candidate.label, foundAs: candidate.kind === 'rule' ? 'a rule written in code' : 'a model call', occurrences: candidate.matches },
        location: { path: candidate.path, startLine: candidate.startLine, endLine: candidate.endLine },
        definition: candidate.evidence,
        usedAt: (candidate.callSites ?? []).length
          ? candidate.callSites.map((s) => ({ path: s.path, line: s.line, code: s.text }))
          : 'No call site was found in the scanned files.',
      },
      questions: q,
    };
    const result = await callJev(body, { apiKey, fetchImpl });
    usage.requests += 1;
    if (!result.ok) { usage.failures.push({ reason: result.reason, operation: candidate.label }); out[i] = { fit: {} }; return; }
    usage.inputTokens += result.data.usage?.input_tokens ?? 0;
    usage.outputTokens += result.data.usage?.output_tokens ?? 0;

    const answers = { fit: {} };
    const col = validateAnswer(result.data.answers?.column, questions.column);
    if (col.ok) { answers.column = col.value; answers.columnConfidence = col.confidence; answers.columnProbabilities = col.probabilities; }
    else usage.failures.push({ reason: col.reason, operation: candidate.label, question: 'column' });
    const prim = validateAnswer(result.data.answers?.primitive, questions.primitive);
    if (prim.ok) answers.primitive = prim.value;
    for (const [id, spec] of Object.entries(questions.fit)) {
      const checked = validateAnswer(result.data.answers?.[`fit_${id}`], spec);
      if (checked.ok) answers.fit[id] = checked.value;
    }
    out[i] = answers;
  });

  return {
    rows: candidates.map((c, i) => classify(c, out[i] ?? { fit: {} }, policy)),
    usage: { ...usage, estimatedCostUsd: estimateCostUsd(usage.inputTokens) },
  };
}

// ------------------------------------------------------------------ render

const ORDER = { code: 0, llm: 1, jev: 2, not_an_operation: 3 };
// A confident call and a coin flip must not look the same on the page.
const mark = (on, confident) => (on ? (confident ? '**X**' : '**?**') : ' ');
const runnerUp = (r) => {
  const p = r.columnProbabilities;
  if (!p) return null;
  const sorted = Object.entries(p).sort((a, b) => b[1] - a[1]);
  return sorted[1] ? `${sorted[0][0]} ${sorted[0][1].toFixed(2)} against ${sorted[1][0]} ${sorted[1][1].toFixed(2)}` : null;
};

export function render(doc) {
  const c = doc.coverage;
  const t = doc.totals;
  const L = [];
  L.push('# Operations audit', '');
  L.push(`Generated ${doc.generatedAt} by jev-flowmap against tree \`${doc.treeHash.slice(0, 12)}\`, model \`${doc.model}\`, policy \`${doc.policyVersion}\`.`, '');

  L.push('## Coverage', '');
  L.push(`Enumerated ${c.filesEnumerated} files. Scanned ${c.filesScanned} source files; skipped ${c.filesNotSource} non-source, ${c.filesGitignored} gitignored, ${c.filesExcluded} excluded, ${c.filesDenied} denied, ${c.filesBinary} binary.`);
  L.push(`Found ${c.candidatesFound} candidate operations and classified ${c.candidatesClassified}${c.candidatesDropped ? `, dropping ${c.candidatesDropped} over the cap` : ''}.`);
  L.push('This audit covers what the scanner could find. An operation expressed in a way the patterns do not match is not in this table.', '');
  if (!doc.calibrated) L.push('> Thresholds in this run are policy defaults, not measured values.', '');
  if (doc.skewWarning) L.push(`> **${doc.skewWarning}**`, '');

  L.push('## The three columns', '');
  L.push('**X** is a confident call, **?** is not.', '');
  L.push('| Operation | Where | code | LLM | Jev | Why |', '|---|---|:--:|:--:|:--:|---|');
  for (const r of [...doc.rows].sort((a, b) => (ORDER[a.column] ?? 9) - (ORDER[b.column] ?? 9) || a.label.localeCompare(b.label))) {
    if (r.column === 'not_an_operation') continue;
    const uncertain = r.column && !r.confident ? `not a confident call: ${runnerUp(r) ?? 'low confidence'}` : null;
    const why = [r.primitive ? r.primitive.charAt(0).toUpperCase() + r.primitive.slice(1) : null, ...r.notes, uncertain].filter(Boolean).join('; ');
    const share = r.volume?.shareOfBill ? ` (${(r.volume.shareOfBill * 100).toFixed(1)}% of the bill)` : '';
    L.push(`| ${r.label} | \`${r.path}:${r.matchLine}\` | ${mark(r.column === 'code', r.confident)} | ${mark(r.column === 'llm', r.confident)} | ${mark(r.column === 'jev', r.confident)} | ${why}${share} |`);
  }
  L.push('');
  L.push(`**Column total: code ${t.columns.code} · LLM ${t.columns.llm} · Jev ${t.columns.jev}**`);
  const shaky = doc.rows.filter((r) => r.column && r.column !== 'not_an_operation' && !r.confident);
  if (shaky.length) {
    L.push('');
    L.push(`${shaky.length} row(s) are marked **?** rather than **X**: the distribution was spread, so the column is a guess. Read those yourself before acting on them: ${shaky.map((r) => r.label).join(', ')}.`);
  }
  if (t.columns.not_an_operation) L.push(`${t.columns.not_an_operation} candidate(s) were not operations at all and are listed below.`);
  if (t.columns.unclassified) L.push(`${t.columns.unclassified} candidate(s) could not be classified; see the failures in \`operations.json\`.`);
  L.push('');

  if (doc.cost) {
    L.push('## What it costs today', '');
    L.push(`Assuming a ${doc.cost.monthDays}-day month and the volumes supplied. ${doc.cost.pricedOperations} of ${doc.rows.length} operations had volumes; the rest are absent from this section entirely rather than estimated.`, '');
    L.push('| Operation | Column | Calls/day | Monthly | Share | If moved to Jev |', '|---|---|--:|--:|--:|--:|');
    const ranked = doc.rows.filter((r) => r.volume?.monthlyUsd).sort((a, b) => b.volume.monthlyUsd - a.volume.monthlyUsd);
    for (const r of ranked) {
      const v = r.volume;
      L.push(`| ${r.label} | ${r.column} | ${v.callsPerDay} | $${v.monthlyUsd.toFixed(2)} | ${(v.shareOfBill * 100).toFixed(1)}% | ${v.projectedMonthlyUsd === null ? 'n/a' : `$${v.projectedMonthlyUsd.toFixed(2)}`} |`);
    }
    L.push('');
    L.push(`Total across priced operations: **$${doc.cost.monthlyUsd.toFixed(2)} per month.**`);
    if (doc.cost.projectedSavingUsd > 0) {
      L.push(`Moving only the Jev-column rows, at the same call volumes and input sizes, projects **$${doc.cost.projectedSavingUsd.toFixed(2)} per month**. That is arithmetic on your numbers, not a measurement, and it assumes the replacement answers as well as what it replaces. Nothing here establishes that it does.`);
    }
    if (doc.cost.unmatchedVolumeRows.length) {
      L.push('', `Volumes supplied for operations this scan did not find: ${doc.cost.unmatchedVolumeRows.map((x) => `\`${x}\``).join(', ')}.`);
    }
    L.push('');
  } else {
    L.push('## What it costs today', '');
    L.push('No volumes were supplied, so there is no cost section. Call counts cannot be read out of source code, and a ranking without them would be a guess presented as a finding.', '');
    L.push('Supply a volumes file to get one. See the skill for the format.', '');
  }

  const notOps = doc.rows.filter((r) => r.column === 'not_an_operation');
  if (notOps.length) {
    L.push('## Candidates that were not operations', '');
    for (const r of notOps) L.push(`- \`${r.path}:${r.matchLine}\` ${r.label}`);
    L.push('');
  }

  L.push('## Limitations', '');
  for (const line of doc.limitations) L.push(`- ${line}`);
  L.push('');
  L.push('## Usage', '');
  L.push(`${doc.usage.requests} requests, ${doc.usage.inputTokens} input tokens. Estimated charge for this audit $${doc.usage.estimatedCostUsd.toFixed(4)}.`, '');
  return L.join('\n');
}

export const LIMITATIONS = (q, hasVolumes) => [
  'A column is a suggestion about where an operation belongs, not a migration plan. Nothing here has been changed, tested or measured.',
  q.calibrated
    ? 'Thresholds were measured against a labeled corpus; see the eval report for the sample and its limits.'
    : 'Thresholds are policy defaults. No labeled evaluation has set them, so do not read a probability here as an accuracy.',
  'The scanner finds model calls and judgment written as keyword or pattern rules. An operation expressed some other way is missing from this table, and a missing row is invisible by definition.',
  hasVolumes
    ? 'Cost figures are arithmetic on the volumes and rates you supplied, over an assumed month. They are only as good as those inputs.'
    : 'No cost figures appear anywhere in this run, because no volumes were supplied.',
  'Moving an operation to a cheaper model is a change in behavior. This audit says nothing about whether the cheaper answer is as good; that needs a labeled set of your own cases.',
  'A row marked ? is a column the model was not confident about. It is shown because hiding it would be worse, not because it is settled.',
  'The code column holds operations that currently cost a model call, or are written as an approximating rule, whose answer is actually exact. Exact rules already written as exact rules are not candidates and are not scanned for, so an empty code column is common and is not a finding.',
  'Nothing in this repository was run, built or opened.',
];

// ------------------------------------------------------------------ cli

const flag = (argv, name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

async function readVolumes(path) {
  const raw = await readFile(path, 'utf8');
  if (path.endsWith('.jsonl')) return raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : parsed.operations ?? [];
}

async function main(argv) {
  const [command, ...rest] = argv;
  const questions = await loadQuestions();
  const outDir = flag(rest, 'out', '.flows');
  const log = (m) => process.stderr.write(`${m}\n`);

  if (command === 'scan') {
    const root = resolve(rest[0] ?? '.');
    const exclude = flag(rest, 'exclude', '').split(',').map((x) => x.trim()).filter(Boolean);
    const found = await findCandidates(root, { policy: questions.policy, exclude, log });
    await mkdir(outDir, { recursive: true });
    const doc = { schemaVersion: 1, generatedAt: new Date().toISOString(), root, ...found };
    await writeFile(join(outDir, 'candidates.json'), JSON.stringify(doc, null, 2));
    log(`wrote ${join(outDir, 'candidates.json')}`);
    return;
  }

  if (command === 'classify') {
    const apiKey = process.env.TYPESAFE_API_KEY;
    if (!apiKey) { log('TYPESAFE_API_KEY is not set. opaudit does not sort operations without asking.'); process.exit(2); }
    const scan = JSON.parse(await readFile(join(outDir, 'candidates.json'), 'utf8'));
    const { rows, usage } = await classifyAll(scan.candidates, { apiKey, questions, log });

    const volumesPath = flag(rest, 'volumes', null);
    let cost = null;
    let finalRows = rows;
    if (volumesPath) {
      const rates = await loadRates();
      const { rows: priced, totals } = applyVolumes(rows, await readVolumes(volumesPath), rates, questions.policy);
      finalRows = priced;
      cost = totals;
    }

    const columns = columnTotals(finalRows);
    const doc = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      repoRoot: scan.root,
      treeHash: sha256(scan.candidates.map((c) => `${c.path}:${c.matchLine}:${c.label}`).sort().join('\n')),
      model: questions.model, policyVersion: policyVersion(questions), calibrated: questions.calibrated,
      coverage: scan.coverage,
      totals: { columns },
      skewWarning: skewWarning(columns),
      rows: finalRows,
      cost,
      usage,
      limitations: LIMITATIONS(questions, Boolean(cost)),
    };
    await writeFile(join(outDir, 'operations.json'), JSON.stringify(doc, null, 2));
    await writeFile(flag(rest, 'md', 'OPERATIONS.md'), render(doc));
    log(`wrote ${join(outDir, 'operations.json')} and OPERATIONS.md`);
    log(`code ${columns.code}  llm ${columns.llm}  jev ${columns.jev}  (audit cost $${usage.estimatedCostUsd.toFixed(4)})`);
    if (doc.skewWarning) log(`WARNING: ${doc.skewWarning}`);
    return;
  }

  log('Commands: scan <root> [--out .flows] [--exclude vendor/,examples/] | classify [--out .flows] [--volumes volumes.jsonl] [--md OPERATIONS.md]');
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
