// Shared plumbing for every skill in this plugin: the provider call, answer
// validation, filesystem admission and the arithmetic. Nothing here knows what
// question is being asked, which is why both skills can sit on top of it.

import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

export const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const bytes = (text) => Buffer.byteLength(text, 'utf8');

export async function loadQuestions(path) {
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

export const estimateCostUsd = (inputTokens) => Number((inputTokens * USD_PER_INPUT_TOKEN).toFixed(6));

// ---------------------------------------------------------------- provider

export async function pool(items, limit, worker) {
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
