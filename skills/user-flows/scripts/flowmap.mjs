#!/usr/bin/env node
// flowmap: derive user flows from a repository using Jev typed judgments.
// Code owns the workflow, every threshold and every number. Jev answers only
// bounded yes/no and multiple-choice questions. Nothing here executes the
// repository it reads: no build, no install, no test run, no browser.

import { readFile, readdir, writeFile, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const bytes = (text) => Buffer.byteLength(text, 'utf8');

export async function loadQuestions(path = join(HERE, '..', 'references', 'questions.json')) {
  const raw = await readFile(path, 'utf8');
  return { ...JSON.parse(raw), sourceSha256: sha256(raw) };
}

export const policyVersion = (q) => `${q.version}+${q.sourceSha256.slice(0, 12)}`;

// ---------------------------------------------------------------- admission

const DENY_SEGMENT = /^(\.git|node_modules|dist|build|out|coverage|\.next|\.nuxt|\.open-next|\.svelte-kit|\.output|\.cache|\.parcel-cache|\.wrangler|\.turbo|vendor|__pycache__|\.venv)$/i;
const DENY_FILE = /(^\.env(\.|$)|^\.dev\.vars|\.(pem|key|p12|pfx|crt|keystore|secret|token|credentials)$|[-_.](secret|token|credentials)s?\.[a-z]+$|\.min\.(js|css)$|^(package|pnpm|yarn|bun)[-.]lock(\.(json|yaml))?$|^poetry\.lock$|^Cargo\.lock$)/i;
const BINARY_EXT = /\.(png|jpe?g|gif|webp|avif|ico|icns|bmp|tiff?|svgz|pdf|zip|gz|tgz|bz2|xz|7z|rar|mp[34]|m4a|wav|ogg|mov|mp4|avi|webm|woff2?|ttf|otf|eot|so|dylib|dll|exe|bin|wasm|class|jar|db|sqlite3?|parquet|ds_store)$/i;

/** Why this path may not be read, or null when it is admissible. */
export function denyPath(rel) {
  if (typeof rel !== 'string' || rel.length === 0) return 'denied';
  if (rel !== rel.normalize('NFC')) return 'denied';
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.includes('\\')) return 'denied';
  if (/[\x00-\x1f\x7f]/.test(rel)) return 'denied';
  const parts = rel.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) return 'denied';
  if (parts.slice(0, -1).some((p) => DENY_SEGMENT.test(p))) return 'denied';
  const name = parts[parts.length - 1];
  if (DENY_SEGMENT.test(name) || DENY_FILE.test(name)) return 'denied';
  if (BINARY_EXT.test(name)) return 'binary';
  return null;
}

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A deliberate subset of gitignore: comments, blank lines, `dir/`, `*.ext`,
 * `name`, and rooted `/name` paths. Negations are recorded as unsupported
 * rather than silently half-applied, because a half-applied negation would
 * read a file the project asked us not to read.
 */
export function compileIgnore(text) {
  const rules = [];
  const unsupported = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('!')) { unsupported.push(line); continue; }
    const dirOnly = line.endsWith('/');
    let pattern = line.replace(/\/+$/, '');
    const rooted = pattern.startsWith('/');
    if (rooted) pattern = pattern.slice(1);
    if (!pattern) continue;
    const regex = new RegExp('^' + pattern.split('*').map(escapeRe).join('[^/]*') + '$');
    rules.push({ regex, dirOnly, scoped: rooted || pattern.includes('/') });
  }
  return { rules, unsupported };
}

export function ignored(matcher, rel, isDir = false) {
  if (!matcher) return false;
  const segments = rel.split('/');
  for (const rule of matcher.rules) {
    if (rule.scoped) {
      if (rule.regex.test(rel) && (!rule.dirOnly || isDir)) return true;
      if (rule.dirOnly && segments.slice(0, -1).some((_, i) => rule.regex.test(segments.slice(0, i + 1).join('/')))) return true;
      continue;
    }
    if (rule.dirOnly) {
      if (segments.slice(0, isDir ? undefined : -1).some((s) => rule.regex.test(s))) return true;
      continue;
    }
    if (segments.some((s) => rule.regex.test(s))) return true;
  }
  return false;
}

/** A NUL byte in the first 8 KiB is the practical test; extensions lie. */
export function looksBinary(buf) {
  const head = buf.subarray(0, 8192);
  return head.includes(0);
}

/** The incumbent this tool is measured against: a naive path rule. */
export function pathHeuristic(rel) {
  return /(^|\/)(routes?|pages?|views?|screens?|handlers?|controllers?|endpoints?|api|cli|commands?|tools?)(\/|\.)/i.test(rel)
    || /\.(page|route|view|screen|handler|controller)\.[jt]sx?$/i.test(rel)
    || /\.(vue|svelte|astro)$/i.test(rel);
}

const EXPORTED = /^\s*(?:export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)|export\s*\{([^}]*)\}|(?:def|func|fn)\s+([A-Za-z_][\w]*)|(?:public|open)\s+(?:class|func)\s+([A-Za-z_][\w]*))/gm;

/** Head excerpt plus a cheap symbol scan. Not a parse; section 6.1 of the design. */
export function makeHead(content, limit = 600) {
  const buf = Buffer.from(content, 'utf8');
  const complete = buf.length <= limit;
  const text = complete ? content : new TextDecoder('utf8').decode(buf.subarray(0, limit));
  const names = new Set();
  for (const m of content.matchAll(EXPORTED)) {
    for (const g of [m[1], m[3], m[4]]) if (g) names.add(g);
    if (m[2]) for (const n of m[2].split(',')) { const t = n.trim().split(/\s+as\s+/)[0].trim(); if (t) names.add(t); }
    if (names.size >= 24) break;
  }
  const symbols = [...names].slice(0, 24);
  return { text, complete, symbols };
}

/** Greedy chunking that respects both the state byte budget and the batch cap. */
export function chunkFiles(entries, { stateBudgetBytes, batchSize }) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const entry of entries) {
    const cost = bytes(JSON.stringify(entry)) + 2;
    if (current.length && (current.length >= batchSize || size + cost > stateBudgetBytes)) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(entry);
    size += cost;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

// ---------------------------------------------------------------- validation

const finiteProbability = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

/** A returned answer is checked against the question that asked it. Never coerce. */
export function validateAnswer(answer, question) {
  if (!answer || typeof answer !== 'object') return { ok: false, reason: 'missing' };
  if (answer.type !== question.type) return { ok: false, reason: 'type_mismatch' };
  if (question.type === 'noul') {
    if (!finiteProbability(answer.noul)) return { ok: false, reason: 'bad_probability' };
    return { ok: true, value: answer.noul };
  }
  const keys = Object.keys(question.criteria).sort();
  const probabilities = answer.probabilities;
  if (!probabilities || typeof probabilities !== 'object') return { ok: false, reason: 'missing_distribution' };
  if (Object.keys(probabilities).sort().join() !== keys.join()) return { ok: false, reason: 'option_mismatch' };
  if (!keys.includes(answer.choice)) return { ok: false, reason: 'unknown_choice' };
  if (!finiteProbability(answer.confidence)) return { ok: false, reason: 'bad_confidence' };
  const values = Object.values(probabilities);
  if (!values.every(finiteProbability)) return { ok: false, reason: 'bad_probability' };
  if (Math.abs(values.reduce((a, b) => a + b, 0) - 1) > 0.01) return { ok: false, reason: 'distribution_sum' };
  if (probabilities[answer.choice] + 1e-8 < Math.max(...values)) return { ok: false, reason: 'choice_not_argmax' };
  return { ok: true, value: answer.choice, confidence: answer.confidence, probabilities };
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

export const estimateCostUsd = (inputTokens) => Number((inputTokens * USD_PER_INPUT_TOKEN).toFixed(6));

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

// ---------------------------------------------------------------- provider

async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One request. One backoff on 429. No other retry, and no silent recovery. */
export async function callJev(body, { apiKey, fetchImpl = fetch, endpoint = ENDPOINT } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (response.status === 429 && attempt === 0) { await sleep(1500); continue; }
    if (!response.ok) return { ok: false, reason: `http_${response.status}` };
    const data = await response.json();
    if (data?.model !== body.model) return { ok: false, reason: 'model_mismatch' };
    return { ok: true, data };
  }
  return { ok: false, reason: 'rate_limited' };
}

// ---------------------------------------------------------------- filesystem

export async function enumerate(root, { respectGitignore = true, exclude = [] } = {}) {
  const files = [];
  const omissions = [];
  const layers = [];
  const unsupportedIgnores = [];
  const loadIgnore = async (dir, base) => {
    if (!respectGitignore) return null;
    try {
      const matcher = compileIgnore(await readFile(join(dir, '.gitignore'), 'utf8'));
      unsupportedIgnores.push(...matcher.unsupported.map((r) => (base ? `${base}/${r}` : r)));
      const layer = { base, matcher };
      layers.push(layer);
      return layer;
    } catch { return null; }
  };
  // A path is ignored when any .gitignore at or above it says so, each tested
  // relative to its own directory, the way git itself scopes them.
  const isIgnored = (rel, isDir) => layers.some((layer) => {
    if (!layer.base) return ignored(layer.matcher, rel, isDir);
    if (!rel.startsWith(`${layer.base}/`)) return false;
    return ignored(layer.matcher, rel.slice(layer.base.length + 1), isDir);
  });
  // Vendored or third-party trees that git tracks but that are not this
  // project's own surface. Same syntax as a gitignore line.
  const excluded = exclude.length ? compileIgnore(exclude.join('\n')) : null;
  await loadIgnore(root, '');
  async function walk(dir) {
    let listing;
    try { listing = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const item of listing.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, item.name);
      const rel = relative(root, abs);
      if (item.isSymbolicLink()) { omissions.push({ path: rel, reason: 'denied' }); continue; }
      if (item.isDirectory()) {
        if (DENY_SEGMENT.test(item.name)) continue;
        if (isIgnored(rel, true)) { omissions.push({ path: `${rel}/`, reason: 'gitignored' }); continue; }
        if (ignored(excluded, rel, true)) { omissions.push({ path: `${rel}/`, reason: 'excluded' }); continue; }
        await loadIgnore(abs, rel);
        await walk(abs);
        continue;
      }
      if (!item.isFile()) continue;
      if (isIgnored(rel, false)) { omissions.push({ path: rel, reason: 'gitignored' }); continue; }
      if (ignored(excluded, rel, false)) { omissions.push({ path: rel, reason: 'excluded' }); continue; }
      const reason = denyPath(rel);
      if (reason) { omissions.push({ path: rel, reason }); continue; }
      files.push({ path: rel, abs });
    }
  }
  await walk(root);
  const ignoreRules = layers.reduce((n, l) => n + l.matcher.rules.length, 0);
  return { files, omissions, ignoreRules, ignoreFiles: layers.length, unsupportedIgnores };
}

export const treeHashOf = (files) =>
  sha256(files.map((f) => `${f.path}:${f.sha256}`).sort().join('\n'));

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
