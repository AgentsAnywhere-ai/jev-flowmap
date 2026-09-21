import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  looksLikeRuleLine, labelFor, scanSource, findCallSites, classify,
  applyVolumes, columnTotals, skewWarning, render, loadQuestions, loadRates,
} from '../skills/operations-audit/scripts/opaudit.mjs';

const questions = await loadQuestions();
const policy = questions.policy;

describe('rule detection', () => {
  test('flags a condition testing several string literals', () => {
    assert.equal(looksLikeRuleLine(`  if (text.includes('urgent') || text.includes('asap') || text.includes('critical')) {`), true);
  });

  test('does not count single-character literals as rule evidence', () => {
    // `? 'a' : 'b'` is a two-way pick, not a rubric. Counting it would flag
    // every ternary in the repository.
    assert.equal(looksLikeRuleLine(`  return r.text.includes('alpha') ? 'a' : 'b';`), false);
  });

  test('a named keyword constant is caught by the pattern list, not this counter', () => {
    assert.equal(looksLikeRuleLine(`  return TERMS.some((t) => body.includes(t));`), false);
    const rows = scanSource('src/a.js', ['export function f(b) {', '  return URGENT_TERMS.some((t) => b.includes(t));', '}'].join('\n'), policy);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'rule');
  });

  test('does not flag ordinary conditions', () => {
    for (const line of ['  if (user.isAdmin) {', '  if (count > 10) return null;', '  const name = "alpha";']) {
      assert.equal(looksLikeRuleLine(line), false, line);
    }
  });

  test('does not flag a two-branch string comparison', () => {
    assert.equal(looksLikeRuleLine(`  return tier === 'fast' ? 'a' : 'b';`), false);
  });
});

describe('labelling', () => {
  const lines = [
    'import x from "y";',
    'export async function relevanceCheck(passage) {',
    '  const r = await anthropic.messages.create({});',
    '  return r;',
    '}',
  ];

  test('names an operation after its enclosing function', () => {
    assert.deepEqual(labelFor(lines, 2), { label: 'relevanceCheck', named: true });
  });

  test('reports when nothing named was found', () => {
    const orphan = ["const URGENT = ['a', 'b', 'c'];"];
    assert.equal(labelFor(orphan, 0).named, false);
  });

  test('never names an operation after a keyword', () => {
    const inside = ['function outer() {', '  if (a) {', '    llm.invoke();'];
    assert.equal(labelFor(inside, 2).label, 'outer');
  });
});

describe('scanning', () => {
  const src = [
    "const URGENT_KEYWORDS = ['asap', 'urgent', 'now'];",
    '',
    'export function isUrgent(t) {',
    "  return URGENT_KEYWORDS.some((w) => t.includes(w));",
    '}',
    '',
    'export async function pickWorker(state) {',
    '  const r = await anthropic.messages.create({ model: "m" });',
    "  if (r.text.includes('alpha') || r.text.includes('beta') || r.text.includes('gamma')) return 'a';",
    "  return 'b';",
    '}',
  ].join('\n');

  const rows = scanSource('src/a.js', src, policy);

  test('finds both a rule and a model call', () => {
    assert.deepEqual(rows.map((r) => r.label).sort(), ['isUrgent', 'pickWorker']);
  });

  test('collapses a model call and a rule line in one function to one row', () => {
    const worker = rows.find((r) => r.label === 'pickWorker');
    assert.equal(worker.kind, 'model_call', 'the model call is the truer description');
    assert.ok(worker.matches >= 2);
  });

  test('drops a bare keyword declaration when the function using it is a row', () => {
    assert.ok(!rows.some((r) => r.label.includes('URGENT_KEYWORDS')));
  });

  test('keeps an orphan declaration when the file has no named operation', () => {
    const orphan = scanSource('src/k.js', "const BAD_WORDS = ['a', 'b', 'c'];", policy);
    assert.equal(orphan.length, 1);
    assert.equal(orphan[0].named, false);
  });

  test('carries an evidence window, not just the matching line', () => {
    assert.ok(rows.every((r) => r.evidence.includes('\n')));
  });
});

describe('call sites', () => {
  const sources = new Map([
    ['src/a.js', ['export function isUrgent(t) {', '  return true;', '}']],
    ['src/turn.js', ['import { isUrgent } from "./a.js";', 'if (isUrgent(ticket)) {', '  state.priority = "high";', '}']],
  ]);

  test('finds where the result is consumed, not where it is defined', () => {
    const sites = findCallSites('isUrgent', sources, 'src/a.js');
    assert.equal(sites.length, 1);
    assert.equal(sites[0].path, 'src/turn.js');
    assert.ok(sites[0].text.includes('state.priority'), 'the branch is inside the window');
  });

  test('returns nothing for an operation called nowhere', () => {
    assert.deepEqual(findCallSites('neverCalled', sources, 'src/a.js'), []);
  });

  test('a name with regex characters does not break the search', () => {
    assert.doesNotThrow(() => findCallSites('a.b[c]', sources, 'src/a.js'));
  });
});

// ------------------------------------------------------------------- policy

const candidate = (over = {}) => ({ path: 'src/a.js', label: 'op', kind: 'model_call', matches: 1, matchLine: 3, named: true, ...over });

describe('classification policy', () => {
  test('a confident judgment survives a conflicting flag, as a caution', () => {
    const r = classify(candidate(), {
      column: 'jev', columnConfidence: 0.98, primitive: 'score',
      fit: { arithmetic: 0.73 },
    }, policy);
    assert.equal(r.column, 'jev', 'policy does not overrule a confident call');
    assert.equal(r.overriddenFrom, null);
    assert.ok(r.notes.some((n) => n.includes('counting or dates')));
  });

  test('an unconfident judgment is corrected by the flag', () => {
    const r = classify(candidate(), {
      column: 'jev', columnConfidence: 0.4, primitive: 'noul',
      fit: { arithmetic: 0.9 },
    }, policy);
    assert.equal(r.column, 'code');
    assert.equal(r.overriddenFrom, 'jev');
  });

  test('a keyword rule that approximates judgment is moved out of code', () => {
    const r = classify(candidate({ kind: 'rule' }), {
      column: 'code', columnConfidence: 0.4, fit: { rule_approximates: 0.9 },
    }, policy);
    assert.equal(r.column, 'jev');
    assert.ok(r.notes.some((n) => n.includes('standing in for judgment')));
  });

  test('a rule sorted straight to jev still says why', () => {
    const r = classify(candidate({ kind: 'rule' }), {
      column: 'jev', columnConfidence: 0.9, primitive: 'choice', fit: { rule_approximates: 0.9 },
    }, policy);
    assert.ok(r.notes.some((n) => n.includes('standing in for judgment')));
  });

  test('the compound and artifact flags produce their annotations', () => {
    const r = classify(candidate(), {
      column: 'jev', columnConfidence: 0.9, primitive: 'noul',
      fit: { compound: 0.8, checks_own_output: 0.8 },
    }, policy);
    assert.ok(r.notes.some((n) => n.includes('split into separate Nouls')));
    assert.ok(r.notes.some((n) => n.includes('check the artifact')));
  });

  test('a weak listable_answers is reported as the hard part', () => {
    const r = classify(candidate(), { column: 'jev', columnConfidence: 0.9, fit: { listable_answers: 0.1 } }, policy);
    assert.ok(r.notes.some((n) => n.includes('not listable')));
  });

  test('a primitive is only carried for jev rows', () => {
    assert.equal(classify(candidate(), { column: 'llm', columnConfidence: 0.9, primitive: 'noul', fit: {} }, policy).primitive, null);
    assert.equal(classify(candidate(), { column: 'jev', columnConfidence: 0.9, primitive: 'noul', fit: {} }, policy).primitive, 'noul');
  });

  test('a failed classification is left unclassified rather than guessed', () => {
    const r = classify(candidate(), { fit: {} }, policy);
    assert.equal(r.column, null);
    assert.equal(r.confident, false);
  });
});

// --------------------------------------------------------------------- cost

describe('cost arithmetic', () => {
  const rates = { jevModel: 'jev-1.13.0', rates: { 'jev-1.13.0': { inputPerM: 0.042, outputPerM: 0 } } };
  const rows = [
    { label: 'relevanceCheck', column: 'jev' },
    { label: 'writeBriefing', column: 'llm' },
    { label: 'noVolume', column: 'jev' },
  ];
  const volumes = [
    { operation: 'relevanceCheck', callsPerDay: 480, avgInputTokens: 6000, costPerCallUsd: 0.0306 },
    { operation: 'writeBriefing', callsPerDay: 10, avgInputTokens: 12000, costPerCallUsd: 0.112 },
    { operation: 'ghost', callsPerDay: 5, costPerCallUsd: 0.01 },
  ];
  const { rows: priced, totals } = applyVolumes(rows, volumes, rates, policy);

  test('monthly cost is calls times cost times the stated month', () => {
    assert.equal(priced[0].volume.monthlyUsd, Number((0.0306 * 480 * 30).toFixed(4)));
  });

  test('shares sum to one across priced rows', () => {
    const sum = priced.filter((r) => r.volume?.shareOfBill).reduce((n, r) => n + r.volume.shareOfBill, 0);
    assert.ok(Math.abs(sum - 1) < 0.01);
  });

  test('a projection is offered only for jev rows', () => {
    assert.ok(priced[0].volume.projectedMonthlyUsd > 0);
    assert.equal(priced[1].volume.projectedMonthlyUsd, null, 'prose is not moved to a classifier');
  });

  test('an operation with no volume is carried, not dropped or estimated', () => {
    assert.equal(priced[2].volume, null);
    assert.equal(priced.length, 3);
  });

  test('volumes naming an operation the scan never found are reported back', () => {
    assert.deepEqual(totals.unmatchedVolumeRows, ['ghost']);
  });

  test('a row with neither a direct cost nor a known model stays unpriced', () => {
    const { rows: r } = applyVolumes([{ label: 'x', column: 'jev' }], [{ operation: 'x', callsPerDay: 10, model: 'unknown-model' }], rates, policy);
    assert.equal(r[0].volume.costPerCallUsd, null);
    assert.equal(r[0].volume.unpriced, true);
  });
});

describe('skew check', () => {
  test('an all-jev split is reported as a broken question', () => {
    const w = skewWarning({ code: 0, llm: 0, jev: 12, not_an_operation: 0, unclassified: 0 });
    assert.match(w, /sorting question is wrong/);
  });

  test('a mixed split passes without comment', () => {
    assert.equal(skewWarning({ code: 3, llm: 4, jev: 9, not_an_operation: 0, unclassified: 0 }), null);
  });

  test('too few rows to judge says nothing rather than guessing', () => {
    assert.equal(skewWarning({ code: 0, llm: 0, jev: 3, not_an_operation: 0, unclassified: 0 }), null);
  });
});

describe('totals', () => {
  test('counts every column including the ones that are not operations', () => {
    const t = columnTotals([
      { column: 'code' }, { column: 'llm' }, { column: 'jev' }, { column: 'jev' },
      { column: 'not_an_operation' }, { column: null },
    ]);
    assert.deepEqual(t, { code: 1, llm: 1, jev: 2, not_an_operation: 1, unclassified: 1 });
  });
});

// ------------------------------------------------------------------- render

const doc = (over = {}) => ({
  generatedAt: '2026-09-21T00:00:00.000Z', treeHash: 'a'.repeat(64),
  model: 'jev-1.13.0', policyVersion: 'operations-audit-v1+abc', calibrated: false,
  coverage: { filesEnumerated: 10, filesScanned: 9, filesNotSource: 1, filesGitignored: 0, filesExcluded: 0, filesDenied: 0, filesBinary: 0, candidatesFound: 2, candidatesClassified: 2, candidatesDropped: 0 },
  totals: { columns: { code: 1, llm: 0, jev: 1, not_an_operation: 0, unclassified: 0 } },
  skewWarning: null,
  rows: [
    { label: 'sure', path: 'src/a.js', matchLine: 3, column: 'jev', primitive: 'noul', confident: true, notes: [], columnProbabilities: { jev: 0.9, code: 0.1 }, volume: null },
    { label: 'shaky', path: 'src/b.js', matchLine: 7, column: 'code', primitive: null, confident: false, notes: [], columnProbabilities: { code: 0.45, llm: 0.4, jev: 0.15 }, volume: null },
  ],
  cost: null,
  usage: { requests: 2, inputTokens: 100, estimatedCostUsd: 0.000004 },
  limitations: ['limit one', 'limit two'],
  ...over,
});

describe('render', () => {
  test('a confident row and a guess do not look the same', () => {
    const md = render(doc());
    assert.match(md, /\| sure \|.*\*\*X\*\*/);
    assert.match(md, /\| shaky \|.*\*\*\?\*\*/);
  });

  test('a guess names its runner-up', () => {
    assert.match(render(doc()), /not a confident call: code 0\.45 against llm 0\.40/);
  });

  test('guesses are counted and named under the totals', () => {
    const md = render(doc());
    assert.match(md, /1 row\(s\) are marked/);
    assert.ok(md.includes('Read those yourself before acting on them: shaky'));
  });

  test('coverage comes before the table', () => {
    const md = render(doc());
    assert.ok(md.indexOf('## Coverage') < md.indexOf('## The three columns'));
  });

  test('no volumes means no cost section and an explanation instead', () => {
    const md = render(doc());
    assert.ok(!md.includes('% |'), 'no share column without volumes');
    assert.match(md, /No volumes were supplied/);
    assert.match(md, /would be a guess presented as a finding/);
  });

  test('an uncalibrated run says so above the table', () => {
    const md = render(doc());
    assert.ok(md.indexOf('policy defaults, not measured values') < md.indexOf('## The three columns'));
  });

  test('a skew warning is rendered in bold when present', () => {
    assert.match(render(doc({ skewWarning: 'everything landed in one column' })), /\*\*everything landed in one column\*\*/);
  });

  test('every limitation is rendered', () => {
    const md = render(doc());
    for (const l of doc().limitations) assert.ok(md.includes(l));
  });
});

describe('rates file', () => {
  test('ships only the rate this plugin can cite', async () => {
    const rates = await loadRates();
    assert.deepEqual(Object.keys(rates.rates), ['jev-1.13.0']);
    assert.ok(rates.checkedOn, 'the rate is dated');
    assert.match(rates.note, /pricing page/);
  });
});
