// flowmap eval: measure the triage judgment against a hand-labeled corpus.
// Until this has run, every threshold the tool ships is an invented default.

import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chunkFiles, makeHead, pathHeuristic, validateAnswer, callJev, denyPath, estimateCostUsd } from './flowmap.mjs';

const flag = (argv, name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

/** Best split point, chosen by accuracy and then by the width of the gap it sits in. */
export function bestThreshold(scored) {
  const usable = scored.filter((s) => typeof s.reach === 'number');
  if (usable.length === 0) return null;
  const sorted = [...usable].sort((a, b) => a.reach - b.reach);
  let best = null;
  for (let i = 0; i <= sorted.length; i++) {
    const lo = i === 0 ? 0 : sorted[i - 1].reach;
    const hi = i === sorted.length ? 1 : sorted[i].reach;
    if (hi < lo) continue;
    const t = (lo + hi) / 2;
    const correct = usable.filter((s) => (s.reach >= t) === s.expected).length;
    const candidate = { threshold: Number(t.toFixed(4)), correct, total: usable.length, gap: Number((hi - lo).toFixed(4)) };
    if (!best || candidate.correct > best.correct || (candidate.correct === best.correct && candidate.gap > best.gap)) best = candidate;
  }
  return best;
}

const BANDS = [[0, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 1.0001]];

/**
 * Accuracy inside each probability band, not one overall number.
 * An overall figure hides the only thing you need: which share of the traffic
 * the model is sure about, and how right it is when it is sure.
 */
export function bands(scored) {
  const usable = scored.filter((s) => typeof s.reach === 'number');
  return BANDS.map(([lo, hi]) => {
    const inBand = usable.filter((s) => s.reach >= lo && s.reach < hi);
    const correct = inBand.filter((s) => (s.reach >= 0.5) === s.expected).length;
    return {
      band: `${lo.toFixed(1)}-${Math.min(hi, 1).toFixed(1)}`,
      count: inBand.length,
      share: usable.length ? Number((inBand.length / usable.length).toFixed(3)) : 0,
      accuracy: inBand.length ? Number((correct / inBand.length).toFixed(3)) : null,
    };
  });
}

/**
 * Two thresholds, not one, scaled to what a wrong answer costs.
 * Everything above `include` is acted on unattended, everything below `exclude`
 * is dropped unattended, and the band between them is the review pile. Returns
 * the share of traffic that still needs a person.
 */
export function twoThresholds(scored, targetAccuracy = 0.95) {
  const usable = scored.filter((s) => typeof s.reach === 'number');
  if (!usable.length) return null;
  const points = [...new Set([0, 1, ...usable.map((s) => s.reach)])].sort((a, b) => a - b);

  let exclude = 0;
  for (const t of points) {
    const below = usable.filter((s) => s.reach < t);
    if (!below.length) continue;
    if (below.filter((s) => !s.expected).length / below.length >= targetAccuracy) exclude = t;
  }
  let include = 1;
  for (const t of [...points].reverse()) {
    const above = usable.filter((s) => s.reach >= t);
    if (!above.length) continue;
    if (above.filter((s) => s.expected).length / above.length >= targetAccuracy) include = t;
  }
  const review = usable.filter((s) => s.reach >= exclude && s.reach < include);
  const reviewShare = Number((review.length / usable.length).toFixed(3));
  return {
    targetAccuracy,
    exclude: Number(exclude.toFixed(3)),
    include: Number(include.toFixed(3)),
    reviewShare,
    unattendedShare: Number((1 - reviewShare).toFixed(3)),
    // Everything needing review means no band of this signal is trustworthy at
    // the target. That is a question problem, not a threshold problem.
    ...(reviewShare >= 0.999
      ? { note: 'No part of this distribution reaches the target accuracy. Fix the question or the criteria; no threshold will help.' }
      : {}),
  };
}

export function summarize(scored, threshold) {
  const usable = scored.filter((s) => typeof s.reach === 'number');
  const misses = usable.filter((s) => (s.reach >= threshold) !== s.expected)
    .map((s) => ({ path: s.path, expected: s.expected, reach: Number(s.reach.toFixed(3)) }))
    .sort((a, b) => b.reach - a.reach);
  const heuristicCorrect = scored.filter((s) => pathHeuristic(s.path) === s.expected).length;
  const highConfidenceMisses = misses.filter((m) => (m.expected ? m.reach < 0.2 : m.reach > 0.8)).length;
  return {
    threshold,
    evaluated: usable.length,
    unevaluated: scored.length - usable.length,
    correct: usable.length - misses.length,
    accuracy: usable.length ? Number(((usable.length - misses.length) / usable.length).toFixed(3)) : null,
    heuristicAccuracy: scored.length ? Number((heuristicCorrect / scored.length).toFixed(3)) : null,
    misses,
    highConfidenceMisses,
    diagnosis: highConfidenceMisses > misses.length / 2 && misses.length > 0
      ? 'Most misses are confident. Suspect the question wording or the criteria, not the threshold.'
      : 'Misses cluster near the boundary. A threshold change is the right lever.',
  };
}

async function scoreCorpus(rows, root, batchSize, { apiKey, questions, log }) {
  const entries = [];
  for (const [index, row] of rows.entries()) {
    if (denyPath(row.path)) { log(`skipping inadmissible path ${row.path}`); continue; }
    let content;
    try { content = await readFile(resolve(root, row.path), 'utf8'); } catch { log(`missing ${row.path}`); continue; }
    const head = makeHead(content, questions.policy.headBytes);
    entries.push({
      index, path: row.path, expected: Boolean(row.userReachable),
      bytes: Buffer.byteLength(content),
      head: head.text + (head.symbols.length ? `\n\n[exported symbols: ${head.symbols.join(', ')}]` : ''),
    });
  }

  const chunks = chunkFiles(entries, { stateBudgetBytes: questions.policy.stateBudgetBytes, batchSize });
  const usage = { requests: 0, inputTokens: 0 };
  const reach = new Map();

  for (const chunk of chunks) {
    const q = {};
    chunk.forEach((entry, i) => {
      q[`reach_${entry.index}`] = {
        type: 'noul',
        instructions: questions.guard + questions.triage.instructions.replaceAll('{{index}}', String(i)),
        criteria: questions.triage.criteria,
      };
    });
    const result = await callJev({
      model: questions.model,
      state: { repo: { name: root.split('/').pop(), fileCount: entries.length }, files: chunk.map((e, i) => ({ index: i, path: e.path, bytes: e.bytes, head: e.head })) },
      questions: q,
    }, { apiKey });
    usage.requests += 1;
    if (!result.ok) { log(`batch failed: ${result.reason}`); continue; }
    usage.inputTokens += result.data.usage?.input_tokens ?? 0;
    for (const entry of chunk) {
      const checked = validateAnswer(result.data.answers?.[`reach_${entry.index}`], questions.triage);
      if (checked.ok) reach.set(entry.index, checked.value);
    }
  }

  return {
    scored: entries.map((e) => ({ path: e.path, expected: e.expected, reach: reach.get(e.index) ?? null })),
    usage: { ...usage, estimatedCostUsd: estimateCostUsd(usage.inputTokens) },
  };
}

export async function runEval(args, { apiKey, questions, log }) {
  const corpusPath = args[0];
  if (!corpusPath) throw new Error('Usage: flowmap eval <labeled.jsonl> --root <repo> [--batch 1,10,30]');
  const root = resolve(flag(args, 'root', '.'));
  const batchSizes = flag(args, 'batch', '1,10,30').split(',').map(Number);
  const rows = (await readFile(corpusPath, 'utf8')).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  log(`corpus: ${rows.length} labeled files, root ${root}`);

  const report = { corpus: corpusPath, root, rows: rows.length, model: questions.model, runs: [] };
  for (const batchSize of batchSizes) {
    const { scored, usage } = await scoreCorpus(rows, root, batchSize, { apiKey, questions, log });
    const shipped = summarize(scored, questions.policy.reach.include);
    const best = bestThreshold(scored);
    const banded = bands(scored);
    const gates = twoThresholds(scored);
    report.runs.push({ batchSize, usage, atShippedThreshold: shipped, best,
      atBestThreshold: best ? summarize(scored, best.threshold) : null, bands: banded, gates });
    log(`batch ${batchSize}: accuracy ${shipped.accuracy} at shipped ${shipped.threshold}, best ${best?.threshold}, heuristic ${shipped.heuristicAccuracy}`);
    for (const b of banded) log(`   band ${b.band}  n=${String(b.count).padStart(3)}  share=${b.share}  accuracy=${b.accuracy ?? 'n/a'}`);
    if (gates?.include != null) log(`   gates: drop below ${gates.exclude}, accept above ${gates.include}, ${Math.round(gates.reviewShare * 100)}% needs review at ${gates.targetAccuracy} target`);
    else if (gates) log(`   ${gates.note}`);
  }

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  log('');
  log('Read the bands before the overall accuracy. One number hides which share');
  log('of the traffic the model is sure about, which is the only shippable fact.');
  log('');
  log('A threshold measured on a Noul does not transfer to a Choice. A Choice asks');
  log('which option wins and is relative; a Noul asks whether one statement is true');
  log('and is absolute. Different distribution, new table.');
  log('');
  log('50 labeled files is enough to find defects and set a first threshold.');
  log('It is not enough to claim calibration. Do not let any output say otherwise.');
  return report;
}
