#!/usr/bin/env node
// flowmap: derive user flows from a repository using Jev typed judgments.
// Code owns the workflow, every threshold and every number. Jev answers only
// bounded yes/no and multiple-choice questions. Nothing here executes the
// repository it reads: no build, no install, no test run, no browser.

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ENDPOINT, USD_PER_INPUT_TOKEN, sha256, policyVersion, denyPath, compileIgnore,
  ignored, looksBinary, makeHead, chunkFiles, validateAnswer, estimateCostUsd,
  pool, callJev, enumerate, treeHashOf, loadQuestions as loadQuestionsAt,
} from '../../../lib/jev.mjs';

export {
  ENDPOINT, USD_PER_INPUT_TOKEN, sha256, policyVersion, denyPath, compileIgnore,
  ignored, looksBinary, makeHead, chunkFiles, validateAnswer, estimateCostUsd,
  callJev, enumerate, treeHashOf,
} from '../../../lib/jev.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const loadQuestions = (path = join(HERE, '..', 'references', 'questions.json')) => loadQuestionsAt(path);

export function pathHeuristic(rel) {
  return /(^|\/)(routes?|pages?|views?|screens?|handlers?|controllers?|endpoints?|api|cli|commands?|tools?)(\/|\.)/i.test(rel)
    || /\.(page|route|view|screen|handler|controller)\.[jt]sx?$/i.test(rel)
    || /\.(vue|svelte|astro)$/i.test(rel);
}

// ---------------------------------------------------------------- policy

export const labelTriage = (reach, policy) =>
  typeof reach !== 'number' ? 'unevaluated' : reach >= policy.reach.include ? 'include' : 'omit';

/**
 * Map five raw probabilities onto a step label plus what needs a second look.
 * Probabilities are never multiplied into an overall correctness number.
 */
export function labelStep(judgments, policy) {
  const escalate = [];
  const j = judgments;
  let label;

  if (typeof j.supported !== 'number') label = 'unevaluated';
  else if (j.supported >= policy.supported.verified) label = 'verified';
  else if (j.supported < policy.supported.contradicted) label = 'contradicted';
  else { label = 'unverified'; escalate.push('supported'); }

  let edge = 'keep';
  if (typeof j.reachable !== 'number') edge = 'unevaluated';
  else if (j.reachable >= policy.reachable.keep) edge = 'keep';
  else if (j.reachable < policy.reachable.gap) edge = 'gap';
  else { edge = 'uncertain'; escalate.push('reachable'); }

  return {
    label,
    edge,
    escalate,
    guarded: typeof j.guarded === 'number' && j.guarded >= policy.guarded.flag,
    deadEnd: typeof j.terminal_failure === 'number' && j.terminal_failure >= policy.terminal_failure.flag,
    destructive: typeof j.destructive === 'number' && j.destructive >= policy.destructive.flag,
  };
}

/**
 * Coverage arithmetic, asserted rather than assumed. A hidden omission is the
 * specific failure this tool exists to prevent.
 */
export function checkCoverage(coverage) {
  const problems = [];
  const { filesEnumerated, filesDenied, filesBinary, filesScreened, filesIncluded, omissions } = coverage;
  const skipped = filesDenied + filesBinary + (coverage.filesTooLarge ?? 0) + (coverage.filesGitignored ?? 0) + (coverage.filesExcluded ?? 0);
  if (filesEnumerated !== filesScreened + skipped) problems.push('enumerated != screened + denied + binary + too_large + gitignored + excluded');
  const belowThreshold = omissions.filter((o) => o.reason === 'below_threshold').length;
  if (filesScreened !== filesIncluded + belowThreshold + (coverage.filesUnevaluated ?? 0)) {
    problems.push('screened != included + below_threshold + unevaluated');
  }
  if (omissions.length !== skipped + belowThreshold) problems.push('omission ledger incomplete');
  return problems;
}

// ---------------------------------------------------------------- stage 1

export async function triage(root, { apiKey, questions, batchSize, exclude = [], fetchImpl = fetch, log = () => {} }) {
  const policy = questions.policy;
  const { files, omissions, ignoreRules, ignoreFiles, unsupportedIgnores } = await enumerate(root, { exclude });
  const readable = [];
  for (const file of files) {
    const info = await stat(file.abs);
    if (info.size > policy.maxFileBytes) { omissions.push({ path: file.path, reason: 'too_large' }); continue; }
    const buf = await readFile(file.abs);
    if (looksBinary(buf)) { omissions.push({ path: file.path, reason: 'binary' }); continue; }
    const content = buf.toString('utf8');
    readable.push({ path: file.path, bytes: buf.length, sha256: sha256(content), head: makeHead(content, policy.headBytes) });
  }

  const entries = readable.map((f, index) => ({
    index, path: f.path, bytes: f.bytes,
    head: f.head.text + (f.head.symbols.length ? `\n\n[exported symbols: ${f.head.symbols.join(', ')}]` : ''),
  }));
  const chunks = chunkFiles(entries, { stateBudgetBytes: policy.stateBudgetBytes, batchSize });
  log(`screening ${entries.length} files in ${chunks.length} requests`);

  const usage = { requests: 0, inputTokens: 0, outputTokens: 0, failures: [] };
  const reachByIndex = new Map();

  await pool(chunks, policy.concurrency, async (chunk) => {
    const q = {};
    for (const entry of chunk) {
      q[`reach_${entry.index}`] = {
        type: 'noul',
        instructions: questions.guard + questions.triage.instructions.replaceAll('{{index}}', String(chunk.indexOf(entry))),
        criteria: questions.triage.criteria,
      };
    }
    const body = {
      model: questions.model,
      state: { repo: { name: root.split('/').pop(), fileCount: entries.length }, files: chunk.map((e, i) => ({ index: i, path: e.path, bytes: e.bytes, head: e.head })) },
      questions: q,
    };
    const result = await callJev(body, { apiKey, fetchImpl });
    usage.requests += 1;
    if (!result.ok) { usage.failures.push({ reason: result.reason, files: chunk.map((e) => e.path) }); return; }
    usage.inputTokens += result.data.usage?.input_tokens ?? 0;
    usage.outputTokens += result.data.usage?.output_tokens ?? 0;
    for (const entry of chunk) {
      const checked = validateAnswer(result.data.answers?.[`reach_${entry.index}`], questions.triage);
      if (checked.ok) reachByIndex.set(entry.index, checked.value);
      else usage.failures.push({ reason: checked.reason, files: [entry.path] });
    }
  });

  const scored = readable.map((f, index) => {
    const reach = reachByIndex.get(index);
    const verdict = labelTriage(reach, policy);
    return {
      path: f.path, sha256: f.sha256, bytes: f.bytes,
      reach: reach ?? null,
      heuristic: pathHeuristic(f.path),
      truncated: !f.head.complete,
      included: verdict === 'include',
      verdict,
    };
  });

  for (const f of scored) if (f.verdict === 'omit') omissions.push({ path: f.path, reason: 'below_threshold', reach: f.reach });

  const coverage = {
    filesEnumerated: files.length + omissions.filter((o) => o.reason === 'denied' && !files.some((f) => f.path === o.path)).length,
    filesDenied: omissions.filter((o) => o.reason === 'denied').length,
    filesBinary: omissions.filter((o) => o.reason === 'binary').length,
    filesTooLarge: omissions.filter((o) => o.reason === 'too_large').length,
    filesGitignored: omissions.filter((o) => o.reason === 'gitignored').length,
    filesExcluded: omissions.filter((o) => o.reason === 'excluded').length,
    excludePatterns: exclude,
    ignoreRules, ignoreFiles, unsupportedIgnores,
    filesScreened: readable.length,
    filesIncluded: scored.filter((f) => f.included).length,
    filesUnevaluated: scored.filter((f) => f.verdict === 'unevaluated').length,
    filesTruncated: scored.filter((f) => f.included && f.truncated).length,
    omissions: omissions.sort((a, b) => a.path.localeCompare(b.path)),
  };
  coverage.filesEnumerated = readable.length + coverage.filesDenied + coverage.filesBinary + coverage.filesTooLarge + coverage.filesGitignored + coverage.filesExcluded;

  const shadow = {
    heuristicSelected: scored.filter((f) => f.heuristic).length,
    jevSelected: coverage.filesIncluded,
    agreed: scored.filter((f) => f.heuristic === f.included).length,
    jevOnly: scored.filter((f) => f.included && !f.heuristic).map((f) => f.path),
    heuristicOnly: scored.filter((f) => !f.included && f.heuristic).map((f) => f.path),
  };

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    root, treeHash: treeHashOf(scored),
    model: questions.model, policyVersion: policyVersion(questions), calibrated: questions.calibrated,
    coverage, shadow, files: scored,
    usage: { ...usage, estimatedCostUsd: estimateCostUsd(usage.inputTokens) },
  };
}

// ---------------------------------------------------------------- stage 3

async function evidenceText(root, evidence) {
  const out = [];
  for (const cite of evidence) {
    if (denyPath(cite.path)) continue;
    let content;
    try { content = await readFile(resolve(root, cite.path), 'utf8'); } catch { continue; }
    const lines = content.split('\n');
    const start = Math.max(1, cite.startLine ?? 1);
    const end = Math.min(lines.length, cite.endLine ?? lines.length);
    out.push({ path: cite.path, startLine: start, endLine: end, sha256: sha256(content), text: lines.slice(start - 1, end).join('\n') });
  }
  return out;
}

export async function verify(root, proposal, { apiKey, questions, fetchImpl = fetch, log = () => {} }) {
  const usage = { requests: 0, inputTokens: 0, outputTokens: 0, failures: [] };
  const verdicts = {};
  const jobs = [];
  for (const flow of proposal.flows ?? []) {
    for (const step of flow.steps ?? []) jobs.push({ flow, step });
  }
  log(`verifying ${jobs.length} steps`);

  await pool(jobs, questions.policy.concurrency, async ({ flow, step }) => {
    const evidence = await evidenceText(root, step.evidence ?? []);
    const prior = (flow.steps ?? []).find((s) => s.index === step.index - 1) ?? null;
    const q = {};
    for (const [id, spec] of Object.entries(questions.step)) {
      q[id] = { type: spec.type, instructions: questions.guard + spec.instructions, criteria: spec.criteria };
    }
    const body = {
      model: questions.model,
      state: {
        goal: proposal.goal ?? 'Map the user flows this repository supports.',
        flow: { id: flow.id, title: flow.title },
        priorStep: prior ? { action: prior.action, effect: prior.effect } : null,
        step: { index: step.index, actor: step.actor, action: step.action, precondition: step.precondition, effect: step.effect },
        evidence,
      },
      questions: q,
    };
    const result = await callJev(body, { apiKey, fetchImpl });
    usage.requests += 1;
    const key = `${flow.id}:${step.index}`;
    if (!result.ok) { usage.failures.push({ reason: result.reason, step: key }); verdicts[key] = { judgments: {}, ...labelStep({}, questions.policy), evidence }; return; }
    usage.inputTokens += result.data.usage?.input_tokens ?? 0;
    usage.outputTokens += result.data.usage?.output_tokens ?? 0;
    const judgments = {};
    for (const [id, spec] of Object.entries(questions.step)) {
      const checked = validateAnswer(result.data.answers?.[id], spec);
      if (checked.ok) judgments[id] = checked.value;
      else usage.failures.push({ reason: checked.reason, step: key, question: id });
    }
    verdicts[key] = { judgments, ...labelStep(judgments, questions.policy), evidence: evidence.map(({ text, ...rest }) => rest) };
  });

  return {
    schemaVersion: 1, generatedAt: new Date().toISOString(),
    model: questions.model, policyVersion: policyVersion(questions),
    verdicts, usage: { ...usage, estimatedCostUsd: estimateCostUsd(usage.inputTokens) },
  };
}

// ---------------------------------------------------------------- assemble

export function assemble(triageDoc, proposal, verifyDoc, questions) {
  const flows = [];
  const unsupportedClaims = [];
  let escalationsUsed = 0;

  for (const flow of proposal.flows ?? []) {
    const steps = [];
    const gaps = [];
    const deadEnds = [];
    for (const step of (flow.steps ?? []).slice().sort((a, b) => a.index - b.index)) {
      const v = verifyDoc.verdicts[`${flow.id}:${step.index}`] ?? { judgments: {}, label: 'unevaluated', edge: 'unevaluated', escalate: [], evidence: [] };
      if (v.label === 'contradicted') {
        unsupportedClaims.push({ flowId: flow.id, index: step.index, action: step.action, supported: v.judgments.supported ?? null });
        continue;
      }
      if (v.edge === 'gap') gaps.push({ afterStep: step.index - 1, reason: `no path from the prior step to "${step.action}"` });
      if (v.deadEnd) deadEnds.push({ atStep: step.index, reason: 'the evidence shows no message, retry or way back from this step' });
      escalationsUsed += v.escalate.length;
      steps.push({
        index: step.index, actor: step.actor, action: step.action,
        precondition: step.precondition, effect: step.effect,
        evidence: v.evidence, judgments: v.judgments, label: v.label,
        escalated: Boolean(step.escalated), guarded: v.guarded, destructive: v.destructive,
        guards: step.guards ?? [], notes: step.notes ?? '',
      });
    }
    flows.push({
      id: flow.id, title: flow.title, surface: flow.surface ?? 'unclassified',
      label: steps.length && steps.every((s) => s.label === 'verified') ? 'verified' : 'partial',
      entryPoint: flow.entryPoint ?? null, steps, gaps, deadEnds,
    });
  }

  const usage = {
    requests: (triageDoc.usage?.requests ?? 0) + (verifyDoc.usage?.requests ?? 0),
    inputTokens: (triageDoc.usage?.inputTokens ?? 0) + (verifyDoc.usage?.inputTokens ?? 0),
    outputTokens: (triageDoc.usage?.outputTokens ?? 0) + (verifyDoc.usage?.outputTokens ?? 0),
  };
  usage.estimatedCostUsd = estimateCostUsd(usage.inputTokens);

  const surfaces = [...new Set(flows.map((f) => f.surface))].map((kind) => ({
    kind, entryPoints: flows.filter((f) => f.surface === kind).length,
  }));

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repoRoot: triageDoc.root, treeHash: triageDoc.treeHash,
    model: questions.model, policyVersion: policyVersion(questions), calibrated: questions.calibrated,
    coverage: triageDoc.coverage, shadow: triageDoc.shadow,
    surfaces, flows, unsupportedClaims,
    escalations: { used: escalationsUsed, budget: questions.policy.escalationBudget,
      exhausted: escalationsUsed > questions.policy.escalationBudget },
    usage,
    limitations: LIMITATIONS(questions),
  };
}

const LIMITATIONS = (q) => [
  'A `verified` label means the named checks passed against the supplied source. It does not mean the flow works, that it is complete, or that it was executed.',
  q.calibrated
    ? 'Thresholds were measured against a labeled corpus; see the eval report for the sample and its limits.'
    : 'Thresholds are policy defaults, not calibrated values. No labeled evaluation has set them.',
  'Nothing in this repository was run, built or opened in a browser.',
  'Judgments rest on excerpts. Truncated files are named in the coverage section.',
  'Probabilities are per-claim. They are never combined into an overall chance that this map is correct.',
];

// ---------------------------------------------------------------- render

const pct = (v) => (typeof v === 'number' ? v.toFixed(2) : 'n/a');

export function render(doc) {
  const c = doc.coverage;
  const L = [];
  L.push('# User flows', '');
  L.push(`Generated ${doc.generatedAt} by jev-flowmap against tree \`${doc.treeHash.slice(0, 12)}\`, model \`${doc.model}\`, policy \`${doc.policyVersion}\`.`, '');

  L.push('## Coverage', '');
  L.push(`Enumerated ${c.filesEnumerated} files. Denied ${c.filesDenied}, binary ${c.filesBinary}, over size limit ${c.filesTooLarge ?? 0}, gitignored ${c.filesGitignored ?? 0}, excluded ${c.filesExcluded ?? 0}.`);
  L.push(`Screened ${c.filesScreened}, included ${c.filesIncluded}, truncated ${c.filesTruncated}, unevaluated ${c.filesUnevaluated ?? 0}.`);
  const below = c.omissions.filter((o) => o.reason === 'below_threshold').length;
  L.push(`${below} files were omitted below the reach threshold and are listed in the omission ledger.`);
  L.push('This map covers the included files only.', '');
  if (c.unsupportedIgnores?.length) {
    L.push(`> ${c.unsupportedIgnores.length} gitignore negation rule(s) were not applied: ${c.unsupportedIgnores.join(', ')}. Files they re-include were skipped.`, '');
  }
  if (!doc.calibrated) L.push('> Thresholds in this run are policy defaults, not measured values.', '');

  if (doc.shadow) {
    L.push('### Shadow comparison', '');
    L.push(`The naive path heuristic selected ${doc.shadow.heuristicSelected} files; Jev selected ${doc.shadow.jevSelected}. They agreed on ${doc.shadow.agreed} of ${c.filesScreened}.`, '');
  }

  for (const surface of doc.surfaces) {
    L.push(`## Surface: ${surface.kind}`, '');
    for (const flow of doc.flows.filter((f) => f.surface === surface.kind)) {
      // A flow can have every step verified and still be broken for a user.
      // Say so in the heading rather than letting "verified" stand alone.
      const findings = [
        flow.gaps.length ? `${flow.gaps.length} gap${flow.gaps.length > 1 ? 's' : ''}` : null,
        flow.deadEnds.length ? `${flow.deadEnds.length} dead end${flow.deadEnds.length > 1 ? 's' : ''}` : null,
      ].filter(Boolean);
      L.push(`### ${flow.title} (${[flow.label, ...findings].join(', ')})`, '');
      if (flow.entryPoint) L.push(`Entry point: \`${flow.entryPoint.path}\``, '');
      L.push('| # | Actor | Action | Evidence | Label | Notes |', '|---|---|---|---|---|---|');
      for (const s of flow.steps) {
        const cites = s.evidence.map((e) => `\`${e.path}:${e.startLine}-${e.endLine}\``).join('<br>') || 'none';
        const notes = [s.guarded ? 'guarded' : null, s.destructive ? 'destructive' : null, s.escalated ? 'escalated' : null]
          .filter(Boolean).join(', ');
        L.push(`| ${s.index} | ${s.actor} | ${s.action} | ${cites} | ${s.label} | ${notes || ''} |`);
      }
      L.push('');
      for (const g of flow.gaps) L.push(`- Gap after step ${g.afterStep}: ${g.reason}`);
      for (const d of flow.deadEnds) L.push(`- Dead end at step ${d.atStep}: ${d.reason}`);
      if (flow.gaps.length || flow.deadEnds.length) L.push('');
    }
  }

  if (doc.unsupportedClaims.length) {
    L.push('## Claims the source does not support', '');
    L.push('These steps were proposed and then removed, because the evidence did not establish them.', '');
    for (const u of doc.unsupportedClaims) L.push(`- ${u.flowId} step ${u.index}: "${u.action}" (supported ${pct(u.supported)})`);
    L.push('');
  }

  L.push('## Omission ledger', '');
  L.push('| Path | Reason | Reach |', '|---|---|---|');
  for (const o of c.omissions) L.push(`| \`${o.path}\` | ${o.reason} | ${pct(o.reach)} |`);
  L.push('');

  if (doc.escalations?.exhausted) {
    L.push(`> The escalation budget of ${doc.escalations.budget} was exhausted (${doc.escalations.used} requested). Remaining uncertain judgments are labeled \`unverified\`.`, '');
  }

  L.push('## Limitations', '');
  for (const line of doc.limitations) L.push(`- ${line}`);
  L.push('');
  L.push('## Usage', '');
  L.push(`${doc.usage.requests} requests, ${doc.usage.inputTokens} input tokens, ${doc.usage.outputTokens} output tokens. Estimated Jev charge $${doc.usage.estimatedCostUsd.toFixed(4)}. This is the Jev charge only.`, '');
  return L.join('\n');
}

// ---------------------------------------------------------------- cli

const flag = (argv, name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

async function main(argv) {
  const [command, ...rest] = argv;
  const questions = await loadQuestions();
  const outDir = flag(rest, 'out', '.flows');
  const apiKey = process.env.TYPESAFE_API_KEY;
  const log = (m) => process.stderr.write(`${m}\n`);

  const needsKey = ['triage', 'verify', 'eval'].includes(command);
  if (needsKey && !apiKey) {
    log('TYPESAFE_API_KEY is not set. flowmap does not guess flows without verification.');
    process.exit(2);
  }

  if (command === 'triage') {
    const root = resolve(rest[0] ?? '.');
    const batchSize = Number(flag(rest, 'batch', questions.policy.batchSize));
    const exclude = flag(rest, 'exclude', '').split(',').map((x) => x.trim()).filter(Boolean);
    const doc = await triage(root, { apiKey, questions, batchSize, exclude, log });
    const problems = checkCoverage(doc.coverage);
    if (problems.length) log(`coverage accounting problems: ${problems.join('; ')}`);
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, 'triage.json'), JSON.stringify(doc, null, 2));
    log(`wrote ${join(outDir, 'triage.json')}: ${doc.coverage.filesIncluded} of ${doc.coverage.filesScreened} included, $${doc.usage.estimatedCostUsd.toFixed(4)}`);
    return;
  }

  if (command === 'verify') {
    const proposal = JSON.parse(await readFile(rest[0], 'utf8'));
    const triageDoc = JSON.parse(await readFile(join(outDir, 'triage.json'), 'utf8'));
    const doc = await verify(triageDoc.root, proposal, { apiKey, questions, log });
    await writeFile(join(outDir, 'verdicts.json'), JSON.stringify(doc, null, 2));
    log(`wrote ${join(outDir, 'verdicts.json')}: ${Object.keys(doc.verdicts).length} steps, $${doc.usage.estimatedCostUsd.toFixed(4)}`);
    return;
  }

  if (command === 'render') {
    const triageDoc = JSON.parse(await readFile(join(outDir, 'triage.json'), 'utf8'));
    const proposal = JSON.parse(await readFile(join(outDir, 'steps.json'), 'utf8'));
    const verifyDoc = JSON.parse(await readFile(join(outDir, 'verdicts.json'), 'utf8'));
    const doc = assemble(triageDoc, proposal, verifyDoc, questions);
    await writeFile(join(outDir, 'flows.json'), JSON.stringify(doc, null, 2));
    const target = flag(rest, 'md', 'FLOWS.md');
    await writeFile(target, render(doc));
    log(`wrote ${join(outDir, 'flows.json')} and ${target}`);
    return;
  }

  if (command === 'eval') {
    const { runEval } = await import('./eval.mjs');
    await runEval(rest, { apiKey, questions, log });
    return;
  }

  log('Commands: triage <root> [--out .flows] [--batch N] [--exclude vendor/,examples/] | verify <steps.json> [--out .flows] | render [--out .flows] [--md FLOWS.md] | eval <labeled.jsonl> [--batch 1,10,30]');
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
