import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  denyPath, looksBinary, pathHeuristic, makeHead, chunkFiles, validateAnswer,
  labelTriage, labelStep, checkCoverage, estimateCostUsd, assemble, render,
  triage, loadQuestions, policyVersion, compileIgnore, ignored,
} from '../skills/user-flows/scripts/flowmap.mjs';
import { bestThreshold, summarize, bands, twoThresholds } from '../skills/user-flows/scripts/eval.mjs';

const questions = await loadQuestions();
const policy = questions.policy;

describe('path admission', () => {
  test('admits ordinary source paths', () => {
    assert.equal(denyPath('src/worker/app.ts'), null);
    assert.equal(denyPath('a.md'), null);
  });

  test('refuses traversal, absolute paths and backslashes', () => {
    for (const bad of ['../etc/passwd', 'a/../../b', '/etc/passwd', 'C:/x', 'a\\b', 'a//b', './a']) {
      assert.equal(denyPath(bad), 'denied', bad);
    }
  });

  test('refuses secrets and vendored trees', () => {
    for (const bad of ['.env', '.env.local', 'certs/server.pem', 'id.key', 'node_modules/x/index.js', '.git/config', 'package-lock.json']) {
      assert.equal(denyPath(bad), 'denied', bad);
    }
  });

  // Found by running against a real project: its ignored .local/ held tokens
  // and *.secret files that no extension rule covered.
  test('refuses the secret shapes a real repo actually uses', () => {
    for (const bad of ['.dev.vars', '.dev.vars.stripe', '.local/clerk-webhook-staging.secret',
                       '.local/local-owner-api.token', 'config/aws-credentials.json',
                       'deploy/prod.secret', 'x.credentials']) {
      assert.equal(denyPath(bad), 'denied', bad);
    }
  });

  test('does not over-deny ordinary files that merely mention a secret', () => {
    for (const ok of ['src/secrets-guide.md', 'docs/tokenizer.ts', 'src/credentialStore.ts']) {
      assert.equal(denyPath(ok), null, ok);
    }
  });

  test('marks binary extensions separately from denial', () => {
    assert.equal(denyPath('assets/logo.png'), 'binary');
    assert.equal(denyPath('fonts/x.woff2'), 'binary');
  });

  test('refuses control characters and rejects non-strings', () => {
    assert.equal(denyPath('a\u0000b'), 'denied');
    assert.equal(denyPath(''), 'denied');
    assert.equal(denyPath(null), 'denied');
  });

  test('detects binary content by NUL byte, not by extension alone', () => {
    assert.equal(looksBinary(Buffer.from('plain text')), false);
    assert.equal(looksBinary(Buffer.from([0x50, 0x00, 0x4b])), true);
  });
});

describe('gitignore', () => {
  const m = compileIgnore('# comment\n\nnode_modules/\n.local/\ndist/\n*.log\n/secret-root.txt\n!keep.log\n');

  test('ignores directories and everything under them', () => {
    assert.equal(ignored(m, '.local', true), true);
    assert.equal(ignored(m, '.local/proof.json'), true);
    assert.equal(ignored(m, 'dist/worker/index.js'), true);
  });

  test('ignores glob patterns at any depth', () => {
    assert.equal(ignored(m, 'build.log'), true);
    assert.equal(ignored(m, 'a/b/deploy.log'), true);
  });

  test('applies a rooted rule only at the root', () => {
    assert.equal(ignored(m, 'secret-root.txt'), true);
    assert.equal(ignored(m, 'nested/secret-root.txt'), false);
  });

  test('does not ignore ordinary source', () => {
    for (const ok of ['src/app.ts', 'README.md', 'localization/en.json', 'distribution.md']) {
      assert.equal(ignored(m, ok), false, ok);
    }
  });

  test('records negations as unsupported rather than half-applying them', () => {
    assert.deepEqual(m.unsupported, ['!keep.log']);
    assert.equal(ignored(m, 'keep.log'), true, 'a negated file stays skipped, never silently read');
  });

  test('no gitignore means nothing is ignored', () => {
    assert.equal(ignored(null, 'anything'), false);
  });

  // Found by running against a real project: minified build output under a
  // nested .gitignore was screened and would have been uploaded.
  test('a nested gitignore scopes to its own directory', async () => {
    const { enumerate } = await import('../skills/user-flows/scripts/flowmap.mjs');
    const root = await mkdtemp(join(tmpdir(), 'flowmap-nested-'));
    await mkdir(join(root, 'sub', 'generated'), { recursive: true });
    await writeFile(join(root, '.gitignore'), 'root-only.txt\n');
    await writeFile(join(root, 'sub', '.gitignore'), 'generated/\n');
    await writeFile(join(root, 'root-only.txt'), 'x');
    await writeFile(join(root, 'sub', 'generated', 'bundle.js'), 'x');
    await writeFile(join(root, 'sub', 'real.js'), 'x');
    await writeFile(join(root, 'generated', 'kept.js').replace('/generated/', '/'), 'x');

    const { files, omissions, ignoreFiles } = await enumerate(root);
    const paths = files.map((f) => f.path).sort();
    assert.equal(ignoreFiles, 2, 'both gitignore files are loaded');
    assert.ok(paths.includes('sub/real.js'));
    assert.ok(!paths.some((p) => p.includes('generated')), 'the nested rule hides its own directory');
    assert.ok(!paths.includes('root-only.txt'));
    assert.ok(omissions.some((o) => o.path.startsWith('sub/generated')));
  });
});

describe('head excerpt', () => {
  test('marks a short file complete and a long file incomplete', () => {
    assert.equal(makeHead('short', 600).complete, true);
    assert.equal(makeHead('x'.repeat(900), 600).complete, false);
    assert.equal(Buffer.byteLength(makeHead('x'.repeat(900), 600).text), 600);
  });

  test('collects exported symbol names as a cheap aid', () => {
    const head = makeHead('export function alpha() {}\nexport const beta = 1;\nexport { gamma as delta };', 600);
    assert.deepEqual(head.symbols.sort(), ['alpha', 'beta', 'gamma']);
  });

  test('caps the symbol list', () => {
    const src = Array.from({ length: 40 }, (_, i) => `export const s${i} = ${i};`).join('\n');
    assert.ok(makeHead(src, 5000).symbols.length <= 24);
  });
});

describe('chunker', () => {
  const entry = (i, size) => ({ index: i, path: `f${i}.ts`, head: 'x'.repeat(size) });

  test('never exceeds the batch cap', () => {
    const chunks = chunkFiles(Array.from({ length: 25 }, (_, i) => entry(i, 10)), { stateBudgetBytes: 1e6, batchSize: 10 });
    assert.deepEqual(chunks.map((c) => c.length), [10, 10, 5]);
  });

  test('never exceeds the state budget', () => {
    const chunks = chunkFiles(Array.from({ length: 10 }, (_, i) => entry(i, 400)), { stateBudgetBytes: 1000, batchSize: 100 });
    for (const chunk of chunks) {
      assert.ok(Buffer.byteLength(JSON.stringify(chunk)) <= 1200, 'chunk stays near the budget');
    }
    assert.ok(chunks.length > 1);
  });

  test('a single oversized entry still gets its own chunk rather than being dropped', () => {
    const chunks = chunkFiles([entry(0, 5000)], { stateBudgetBytes: 1000, batchSize: 10 });
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].length, 1);
  });

  test('loses no entries', () => {
    const input = Array.from({ length: 37 }, (_, i) => entry(i, 120));
    const chunks = chunkFiles(input, { stateBudgetBytes: 900, batchSize: 7 });
    assert.equal(chunks.flat().length, 37);
  });
});

describe('answer validation', () => {
  const noul = { type: 'noul' };
  const choice = { type: 'choice', criteria: { a: 'A', b: 'B' } };

  test('accepts a well-formed noul and choice', () => {
    assert.deepEqual(validateAnswer({ type: 'noul', noul: 0.9 }, noul), { ok: true, value: 0.9 });
    const ok = validateAnswer({ type: 'choice', choice: 'a', confidence: 0.7, probabilities: { a: 0.8, b: 0.2 } }, choice);
    assert.equal(ok.ok, true);
    assert.equal(ok.value, 'a');
  });

  test('rejects every malformed shape without coercing', () => {
    const cases = [
      [undefined, noul, 'missing'],
      [{ type: 'choice' }, noul, 'type_mismatch'],
      [{ type: 'noul', noul: 1.4 }, noul, 'bad_probability'],
      [{ type: 'noul', noul: NaN }, noul, 'bad_probability'],
      [{ type: 'noul', noul: '0.5' }, noul, 'bad_probability'],
      [{ type: 'choice', choice: 'a', confidence: 0.7 }, choice, 'missing_distribution'],
      [{ type: 'choice', choice: 'a', confidence: 0.7, probabilities: { a: 1 } }, choice, 'option_mismatch'],
      [{ type: 'choice', choice: 'z', confidence: 0.7, probabilities: { a: 0.8, b: 0.2 } }, choice, 'unknown_choice'],
      [{ type: 'choice', choice: 'a', confidence: 2, probabilities: { a: 0.8, b: 0.2 } }, choice, 'bad_confidence'],
      [{ type: 'choice', choice: 'a', confidence: 0.7, probabilities: { a: 0.8, b: 0.9 } }, choice, 'distribution_sum'],
      [{ type: 'choice', choice: 'a', confidence: 0.7, probabilities: { a: 0.2, b: 0.8 } }, choice, 'choice_not_argmax'],
    ];
    for (const [answer, question, reason] of cases) {
      const result = validateAnswer(answer, question);
      assert.equal(result.ok, false, JSON.stringify(answer));
      assert.equal(result.reason, reason, JSON.stringify(answer));
    }
  });
});

describe('policy bands', () => {
  test('triage boundary is inclusive at the threshold', () => {
    assert.equal(labelTriage(0.6, policy), 'include');
    assert.equal(labelTriage(0.5999, policy), 'omit');
    assert.equal(labelTriage(null, policy), 'unevaluated');
  });

  test('supported maps to verified, unverified and contradicted', () => {
    assert.equal(labelStep({ supported: 0.8 }, policy).label, 'verified');
    assert.equal(labelStep({ supported: 0.79 }, policy).label, 'unverified');
    assert.equal(labelStep({ supported: 0.4 }, policy).label, 'unverified');
    assert.equal(labelStep({ supported: 0.39 }, policy).label, 'contradicted');
    assert.equal(labelStep({}, policy).label, 'unevaluated');
  });

  test('an uncertain band requests escalation and a decided one does not', () => {
    assert.deepEqual(labelStep({ supported: 0.6, reachable: 0.5 }, policy).escalate.sort(), ['reachable', 'supported']);
    assert.deepEqual(labelStep({ supported: 0.95, reachable: 0.95 }, policy).escalate, []);
  });

  test('reachable maps to keep, uncertain and gap', () => {
    assert.equal(labelStep({ reachable: 0.7 }, policy).edge, 'keep');
    assert.equal(labelStep({ reachable: 0.5 }, policy).edge, 'uncertain');
    assert.equal(labelStep({ reachable: 0.29 }, policy).edge, 'gap');
  });

  test('flags are independent of the supported label', () => {
    const r = labelStep({ supported: 0.2, guarded: 0.9, terminal_failure: 0.7, destructive: 0.6 }, policy);
    assert.equal(r.label, 'contradicted');
    assert.equal(r.guarded, true);
    assert.equal(r.deadEnd, true);
    assert.equal(r.destructive, true);
  });
});

describe('coverage accounting', () => {
  const base = {
    filesEnumerated: 10, filesDenied: 2, filesBinary: 1, filesTooLarge: 0, filesGitignored: 0, filesExcluded: 0,
    filesScreened: 7, filesIncluded: 3, filesUnevaluated: 0,
    omissions: [
      { path: 'a', reason: 'denied' }, { path: 'b', reason: 'denied' }, { path: 'c', reason: 'binary' },
      { path: 'd', reason: 'below_threshold' }, { path: 'e', reason: 'below_threshold' },
      { path: 'f', reason: 'below_threshold' }, { path: 'g', reason: 'below_threshold' },
    ],
  };

  test('a consistent ledger reports no problems', () => {
    assert.deepEqual(checkCoverage(base), []);
  });

  test('a file that vanished between stages is caught', () => {
    assert.ok(checkCoverage({ ...base, filesIncluded: 2 }).length > 0);
  });

  test('a short omission ledger is caught', () => {
    assert.ok(checkCoverage({ ...base, omissions: base.omissions.slice(0, 5) }).length > 0);
  });
});

describe('cost', () => {
  test('one million input tokens costs the published rate', () => {
    assert.equal(estimateCostUsd(1_000_000), 0.042);
    assert.equal(estimateCostUsd(0), 0);
  });
});

// ------------------------------------------------------------------ assembly

const triageDoc = {
  root: '/repo', treeHash: 'a'.repeat(64),
  coverage: {
    filesEnumerated: 5, filesDenied: 1, filesBinary: 0, filesTooLarge: 0, filesGitignored: 0, filesExcluded: 0,
    filesScreened: 4, filesIncluded: 2, filesUnevaluated: 0, filesTruncated: 1,
    omissions: [{ path: 'x', reason: 'denied' }, { path: 'y', reason: 'below_threshold', reach: 0.1 }, { path: 'z', reason: 'below_threshold', reach: 0.2 }],
  },
  shadow: { heuristicSelected: 3, jevSelected: 2, agreed: 3, jevOnly: [], heuristicOnly: [] },
  usage: { requests: 1, inputTokens: 1000, outputTokens: 0 },
};

const proposal = {
  flows: [{
    id: 'signup', title: 'Sign up', surface: 'browser_ui',
    entryPoint: { path: 'src/web/Auth.tsx' },
    steps: [
      { index: 0, actor: 'visitor', action: 'open the signup form', precondition: 'signed out', effect: 'form visible', evidence: [] },
      { index: 1, actor: 'visitor', action: 'submit credentials', precondition: 'form visible', effect: 'account created', evidence: [] },
      { index: 2, actor: 'visitor', action: 'teleport to the dashboard', precondition: 'none', effect: 'none', evidence: [] },
    ],
  }],
};

const verifyDoc = {
  usage: { requests: 3, inputTokens: 500, outputTokens: 0 },
  verdicts: {
    'signup:0': { judgments: { supported: 0.95, reachable: 0.9 }, label: 'verified', edge: 'keep', escalate: [], guarded: false, deadEnd: false, destructive: false, evidence: [{ path: 'src/web/Auth.tsx', startLine: 1, endLine: 20 }] },
    'signup:1': { judgments: { supported: 0.6, reachable: 0.2, guarded: 0.9 }, label: 'unverified', edge: 'gap', escalate: ['supported'], guarded: true, deadEnd: false, destructive: false, evidence: [] },
    'signup:2': { judgments: { supported: 0.05 }, label: 'contradicted', edge: 'unevaluated', escalate: [], guarded: false, deadEnd: false, destructive: false, evidence: [] },
  },
};

describe('assembly', () => {
  const doc = assemble(triageDoc, proposal, verifyDoc, questions);

  test('a contradicted step leaves the graph and appears as an unsupported claim', () => {
    assert.equal(doc.flows[0].steps.length, 2);
    assert.equal(doc.unsupportedClaims.length, 1);
    assert.equal(doc.unsupportedClaims[0].action, 'teleport to the dashboard');
  });

  test('a low reachable probability becomes a recorded gap', () => {
    assert.deepEqual(doc.flows[0].gaps.map((g) => g.afterStep), [0]);
  });

  test('one unverified step makes the whole flow partial', () => {
    assert.equal(doc.flows[0].label, 'partial');
  });

  test('a flow whose every step is verified is labeled verified', () => {
    const allGood = assemble(triageDoc, { flows: [{ id: 'f', title: 'F', surface: 'cli', steps: [proposal.flows[0].steps[0]] }] },
      { usage: {}, verdicts: { 'f:0': verifyDoc.verdicts['signup:0'] } }, questions);
    assert.equal(allGood.flows[0].label, 'verified');
  });

  test('usage sums both stages and prices only input tokens', () => {
    assert.equal(doc.usage.inputTokens, 1500);
    assert.equal(doc.usage.estimatedCostUsd, estimateCostUsd(1500));
  });

  test('an uncalibrated run says so in its limitations', () => {
    assert.ok(doc.limitations.some((l) => l.includes('not calibrated values')));
  });
});

describe('render', () => {
  const doc = assemble(triageDoc, proposal, verifyDoc, questions);
  const md = render(doc);

  test('coverage appears before any flow', () => {
    assert.ok(md.indexOf('## Coverage') < md.indexOf('## Surface'));
  });

  test('the omission ledger is complete, not summarized', () => {
    for (const o of triageDoc.coverage.omissions) assert.ok(md.includes(`\`${o.path}\``), o.path);
  });

  test('every limitation is rendered', () => {
    for (const line of doc.limitations) assert.ok(md.includes(line));
  });

  test('an uncalibrated run is called out above the flows', () => {
    assert.ok(md.includes('policy defaults, not measured values'));
    assert.ok(md.indexOf('policy defaults, not measured values') < md.indexOf('## Surface'));
  });

  test('steps cite their evidence with line ranges', () => {
    assert.ok(md.includes('`src/web/Auth.tsx:1-20`'));
  });

  test('unsupported claims are shown rather than silently dropped', () => {
    assert.ok(md.includes('Claims the source does not support'));
    assert.ok(md.includes('teleport to the dashboard'));
  });

  test('the cost line marks itself as the Jev charge only', () => {
    assert.ok(md.includes('This is the Jev charge only'));
  });

  // A flow whose every step verified can still be broken for a user. The
  // heading must not let "verified" stand alone when findings exist.
  test('gaps and dead ends appear in the flow heading, not only below it', () => {
    const withFindings = assemble(triageDoc, {
      flows: [{ id: 'f', title: 'F', surface: 'cli', steps: [
        { index: 0, actor: 'a', action: 'x', evidence: [] },
        { index: 1, actor: 'a', action: 'y', evidence: [] },
      ] }],
    }, { usage: {}, verdicts: {
      'f:0': { judgments: { supported: 0.95, terminal_failure: 0.9 }, label: 'verified', edge: 'keep', escalate: [], guarded: false, deadEnd: true, destructive: false, evidence: [] },
      'f:1': { judgments: { supported: 0.95, reachable: 0.1 }, label: 'verified', edge: 'gap', escalate: [], guarded: false, deadEnd: false, destructive: false, evidence: [] },
    } }, questions);
    const heading = render(withFindings).split('\n').find((l) => l.startsWith('### F ('));
    assert.match(heading, /verified, 1 gap, 1 dead end/);
  });
});

// --------------------------------------------------------------- eval maths

describe('eval', () => {
  const clean = [
    { path: 'a', expected: true, reach: 0.9 }, { path: 'b', expected: true, reach: 0.85 },
    { path: 'c', expected: false, reach: 0.1 }, { path: 'd', expected: false, reach: 0.05 },
  ];

  test('finds a threshold inside the separating gap', () => {
    const best = bestThreshold(clean);
    assert.equal(best.correct, 4);
    assert.ok(best.threshold > 0.1 && best.threshold < 0.85);
  });

  test('reports perfect accuracy at that threshold', () => {
    assert.equal(summarize(clean, bestThreshold(clean).threshold).accuracy, 1);
  });

  test('diagnoses confident misses as a question problem, not a threshold problem', () => {
    const confused = [
      { path: 'a', expected: true, reach: 0.02 }, { path: 'b', expected: true, reach: 0.03 },
      { path: 'c', expected: false, reach: 0.97 },
    ];
    assert.match(summarize(confused, 0.6).diagnosis, /question wording or the criteria/);
  });

  test('diagnoses boundary misses as a threshold problem', () => {
    const near = [
      { path: 'a', expected: true, reach: 0.58 }, { path: 'b', expected: true, reach: 0.9 },
      { path: 'c', expected: false, reach: 0.1 },
    ];
    assert.match(summarize(near, 0.6).diagnosis, /threshold change is the right lever/);
  });

  test('bands report accuracy per band, not one overall number', () => {
    const mixed = [
      { path: 'a', expected: true, reach: 0.95 }, { path: 'b', expected: true, reach: 0.9 },
      { path: 'c', expected: false, reach: 0.05 }, { path: 'd', expected: false, reach: 0.1 },
      { path: 'e', expected: true, reach: 0.45 }, { path: 'f', expected: false, reach: 0.55 },
    ];
    const b = bands(mixed);
    assert.equal(b.length, 5);
    assert.equal(b.find((x) => x.band === '0.8-1.0').accuracy, 1, 'confident positives are right');
    assert.equal(b.find((x) => x.band === '0.0-0.2').accuracy, 1, 'confident negatives are right');
    assert.equal(b.find((x) => x.band === '0.4-0.6').accuracy, 0, 'the middle band is a coin flip and says so');
    assert.equal(b.reduce((n, x) => n + x.count, 0), 6, 'every scored item lands in exactly one band');
    assert.ok(Math.abs(b.reduce((n, x) => n + x.share, 0) - 1) < 0.01);
  });

  test('a cleanly separable signal needs no review pile', () => {
    const g = twoThresholds([
      { path: 'a', expected: true, reach: 0.95 }, { path: 'b', expected: true, reach: 0.92 },
      { path: 'c', expected: false, reach: 0.03 }, { path: 'd', expected: false, reach: 0.06 },
    ], 0.95);
    assert.equal(g.reviewShare, 0);
    assert.equal(g.unattendedShare, 1);
    assert.ok(g.exclude === g.include, 'one threshold is enough when the gap is clean');
  });

  test('an overlapping middle is sent to review rather than guessed at', () => {
    const g = twoThresholds([
      { path: 'a', expected: true, reach: 0.95 }, { path: 'b', expected: true, reach: 0.9 },
      { path: 'c', expected: false, reach: 0.05 }, { path: 'd', expected: false, reach: 0.08 },
      { path: 'e', expected: true, reach: 0.5 }, { path: 'f', expected: false, reach: 0.52 },
    ], 0.95);
    assert.ok(g.reviewShare > 0, 'the overlapping pair cannot run unattended');
    assert.ok(g.exclude <= 0.5 && g.include > 0.52, 'the gates sit outside the overlap');
  });

  test('says the question is wrong when nothing is trustworthy at the target', () => {
    const g = twoThresholds([
      { path: 'a', expected: true, reach: 0.5 }, { path: 'b', expected: false, reach: 0.5 },
      { path: 'c', expected: true, reach: 0.5 }, { path: 'd', expected: false, reach: 0.5 },
    ], 0.95);
    assert.equal(g.reviewShare, 1);
    assert.match(g.note, /Fix the question or the criteria/);
  });

  test('counts unevaluated files separately from wrong ones', () => {
    const s = summarize([{ path: 'a', expected: true, reach: null }, { path: 'b', expected: true, reach: 0.9 }], 0.6);
    assert.equal(s.unevaluated, 1);
    assert.equal(s.evaluated, 1);
    assert.equal(s.accuracy, 1);
  });
});

// -------------------------------------------------------------- integration

describe('triage against a fake provider', () => {
  test('screens a small tree, records every omission, and never reads a secret', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowmap-'));
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(root, 'src', 'routes.ts'), 'export function handler() { return new Response("ok"); }');
    await writeFile(join(root, 'src', 'types.ts'), 'export interface Thing { id: string }');
    await writeFile(join(root, '.env'), 'TYPESAFE_API_KEY=secret-should-never-be-read');
    await writeFile(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
    await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;');

    const seen = [];
    const fakeFetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      seen.push(body);
      const answers = {};
      for (const id of Object.keys(body.questions)) {
        const i = Number(id.split('_')[1]);
        answers[id] = { type: 'noul', noul: body.state.files[i]?.path.includes('routes') ? 0.93 : 0.08 };
      }
      return { ok: true, status: 200, json: async () => ({ model: body.model, answers, usage: { input_tokens: 120, output_tokens: 0 } }) };
    };

    const doc = await triage(root, { apiKey: 'test', questions, batchSize: 10, fetchImpl: fakeFetch });

    assert.deepEqual(checkCoverage(doc.coverage), []);
    assert.equal(doc.coverage.filesIncluded, 1);
    assert.equal(doc.files.find((f) => f.path === 'src/routes.ts').included, true);
    assert.equal(doc.files.find((f) => f.path === 'src/types.ts').included, false);

    const sent = JSON.stringify(seen);
    assert.ok(!sent.includes('secret-should-never-be-read'), 'a denied secret must never reach the provider');
    assert.ok(!sent.includes('node_modules'), 'a vendored tree must never reach the provider');

    assert.ok(doc.coverage.omissions.some((o) => o.path === '.env' && o.reason === 'denied'));
    assert.ok(doc.coverage.omissions.some((o) => o.path === 'logo.png' && o.reason === 'binary'));
    assert.ok(doc.coverage.omissions.some((o) => o.path === 'src/types.ts' && o.reason === 'below_threshold'));
    assert.equal(doc.usage.estimatedCostUsd, estimateCostUsd(doc.usage.inputTokens));
    assert.equal(doc.policyVersion, policyVersion(questions));
  });

  test('a provider failure marks files unevaluated rather than omitting them silently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowmap-'));
    await writeFile(join(root, 'app.ts'), 'export function main() {}');
    const failing = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const doc = await triage(root, { apiKey: 'test', questions, batchSize: 10, fetchImpl: failing });
    assert.equal(doc.coverage.filesUnevaluated, 1);
    assert.equal(doc.coverage.filesIncluded, 0);
    assert.equal(doc.usage.failures[0].reason, 'http_500');
  });

  test('a malformed answer is rejected rather than coerced into a score', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowmap-'));
    await writeFile(join(root, 'app.ts'), 'export function main() {}');
    const garbage = async (_url, init) => {
      const body = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ model: body.model, answers: { reach_0: { type: 'noul', noul: 7 } }, usage: { input_tokens: 1, output_tokens: 0 } }) };
    };
    const doc = await triage(root, { apiKey: 'test', questions, batchSize: 10, fetchImpl: garbage });
    assert.equal(doc.files[0].reach, null);
    assert.equal(doc.coverage.filesUnevaluated, 1);
    assert.equal(doc.usage.failures[0].reason, 'bad_probability');
  });
});

// Regression: the first live run classified this project's own source as binary,
// because an escape sequence in a regex was written to disk as a raw control byte.
// A source file carrying raw control bytes is invisible to its own triage.
describe('own sources', () => {
  test('carry no raw control bytes', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const root = new URL('..', import.meta.url).pathname;
    const suspect = [];
    async function walk(dir) {
      for (const item of await readdir(dir, { withFileTypes: true })) {
        if (item.name === '.git' || item.name === 'node_modules') continue;
        const path = join(dir, item.name);
        if (item.isDirectory()) { await walk(path); continue; }
        if (!/\.(mjs|js|json|md|ya?ml)$/.test(item.name)) continue;
        const buf = await readFile(path);
        for (const byte of buf) {
          if (byte < 9 || byte === 11 || byte === 12 || (byte > 13 && byte < 32) || byte === 127) {
            suspect.push(path);
            break;
          }
        }
      }
    }
    await walk(root);
    assert.deepEqual(suspect, [], 'write control characters as escape text, not as bytes');
  });
});
