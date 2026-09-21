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
    report.runs.push({ batchSize, usage, atShippedThreshold: shipped, best, atBestThreshold: best ? summarize(scored, best.threshold) : null });
    log(`batch ${batchSize}: accuracy ${shipped.accuracy} at shipped ${shipped.threshold}, best ${best?.threshold} at ${best ? (best.correct / best.total).toFixed(3) : 'n/a'}, heuristic ${shipped.heuristicAccuracy}`);
  }

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  log('');
  log('50 labeled files is enough to find defects and set a first threshold.');
  log('It is not enough to claim calibration. Do not let any output say otherwise.');
  return report;
}
