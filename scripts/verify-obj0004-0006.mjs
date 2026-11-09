// Dependency-free curriculum checks. No network, Git runtime, or learner files.
// Run: node --experimental-strip-types scripts/verify-obj0004-0006.mjs
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {resolve, sep} from 'node:path';
import {test} from 'node:test';
import {COVERAGE_CONTRACT_VERSION, SOURCE_COVERAGE_CONTRACT} from '../packages/shared/src/coverage-contract.ts';
import {SOURCE_COVERAGE_CONTRACT as baselineContract} from '../tests/fixtures/coverage-contract-189d52fd001240b7fb5f18eaeea47e50ba1de575.ts';
import {parseObjectives456Baseline, readObjectives456Baseline, verifyObjectives456ContractFixture} from '../tests/obj0004-0006-baseline.ts';

const read = name => JSON.parse(readFileSync(name, 'utf8'));
const catalog = read('content/catalog.json');
const baseline = readObjectives456Baseline();
const module = read('content/obj0004-0006-module.json');
const packet = read('content/obj0004-0006-sources.json');
const reviews = read('content/obj0004-0006-review.json').reviewEvents;
const checks = module.tasks.filter(t => t.kind === 'mc');
const cases = module.tasks.filter(t => t.kind === 'case');
const bindings = SOURCE_COVERAGE_CONTRACT.slice(baselineContract.length, baselineContract.length + 24);
const task = suffix => module.tasks.find(t => t.id === `task.${suffix}`);
const source = n => packet.sources.find(s => s.id === `source.obj0004-0006.s${n}.2026-11-08`);
const canonical = value => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const fingerprint = lesson => {
  const text = JSON.stringify([lesson.title, lesson.body, [...lesson.skillIds].sort(), [...lesson.sourceRefs].sort()]);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
};
const comparedKeys = {
  'obj0004.sound-or-part': 'b', 'obj0004.argument-forms': 'd', 'obj0004.audience-register': 'a',
  'obj0004.cognate-resource': 'c', 'obj0004.false-friend': 'b',
  'obj0005.domain-profile': 'd', 'obj0005.pld-boundary': 'a', 'obj0005.non-linear': 'c',
  'obj0005.risk-and-rigor': 'b', 'obj0006.word-sequence': 'd', 'obj0006.content-talk': 'a',
  'obj0006.polysemy': 'c', 'obj0005.sci-esl': 'b',
};

test('189d52f fixture digests and every prior entity preserve exact content and ordering', () => {
  verifyObjectives456ContractFixture();
  const bytes = readFileSync(new URL('../tests/fixtures/catalog-189d52fd001240b7fb5f18eaeea47e50ba1de575.json', import.meta.url));
  // Both byte streams use the same exact pretty serialization. Combined with
  // ordered entity serialization below, this also pins literal text/whitespace.
  assert.deepEqual(bytes, Buffer.from(JSON.stringify(baseline, null, 2) + '\n'));
  assert.deepEqual(readFileSync('content/catalog.json'), Buffer.from(JSON.stringify(catalog, null, 2) + '\n'));
  for (const changed of [Buffer.concat([bytes, Buffer.from('\n')]), Buffer.from(JSON.stringify(baseline)), Buffer.from('{')]) {
    assert.throws(() => parseObjectives456Baseline(changed), /integrity/);
  }
  for (const [key, rows] of Object.entries(baseline)) {
    const prefix = Array.isArray(rows) ? catalog[key].slice(0, rows.length) : catalog[key];
    assert.equal(JSON.stringify(prefix), JSON.stringify(rows), key);
  }
  const additions = {...module, sources: packet.sources, reviewEvents: reviews};
  for (const key of Object.keys(baseline)) {
    if (key in additions) {
      const rows = additions[key];
      assert.deepEqual(catalog[key].slice(baseline[key].length, baseline[key].length + rows.length), rows, key);
      assert.equal(catalog[key].slice(0, baseline[key].length + rows.length).length, baseline[key].length + rows.length, key);
    } else assert.deepEqual(catalog[key], baseline[key], key);
  }
  assert.deepEqual(SOURCE_COVERAGE_CONTRACT.slice(0, baselineContract.length), baselineContract);
  assert.equal(COVERAGE_CONTRACT_VERSION, 3);
});

test('three scaffolded lessons, thirteen distinct decisions, three manual cases and six recall cards', () => {
  assert.deepEqual(module.lessons.map(l => l.id), [
    'lesson.obj0004.forms-transfer.v1', 'lesson.obj0005.profiles-environments.v1', 'lesson.obj0006.vocabulary-talk.v1',
  ]);
  assert.equal(checks.length, 13);
  assert.equal(new Set(checks.map(t => t.familyId)).size, 13);
  assert.equal(cases.length, 3);
  assert.equal(module.tasks.length, 16);
  assert.equal(module.cards.length, 6);
  for (const lesson of module.lessons) {
    assert.ok(lesson.sourceRefs.every(id => packet.sources.some(s => s.id === id)));
    assert.ok(!lesson.sourceRefs.includes(source(8).id), 'S8 supplies no teaching excerpt');
    assert.match(lesson.body, /original.*unofficial|unofficial.*original/i);
    assert.match(lesson.body, /content goal/i);
    assert.match(lesson.body, /language goal/i);
    assert.ok((lesson.body.match(/WORKED EXAMPLE/g) ?? []).length >= 2);
    assert.ok((lesson.body.match(/GUIDED/g) ?? []).length >= 2);
    assert.match(lesson.body, /assisted/i);
    assert.match(lesson.body, /no (?:responses?, )?attempts?/i);
    assert.match(lesson.body, /no independent evidence|no attempts or (?:independent )?evidence/i);
    assert.ok(lesson.body.length > 4000);
  }
  for (const item of module.tasks) {
    assert.equal(item.reviewState, 'source_checked');
    assert.ok(module.lessons.some(l => l.id === item.lessonId));
    assert.ok(item.skillIds.every(id => baseline.skills.some(s => s.id === id)));
    assert.ok(item.sourceRefs.every(id => packet.sources.some(s => s.id === id)));
    assert.ok(!item.sourceRefs.includes(source(8).id), 'S8 has no supplied substantive excerpt');
  }
});

test('model comparisons bind all final sources, lessons, tasks and cards with explicit limits', () => {
  const groups = {source: packet.sources, lesson: module.lessons, task: module.tasks, card: module.cards};
  const entities = Object.entries(groups).flatMap(([kind, rows]) => rows.map(row => ({kind, row})));
  assert.equal(reviews.length, entities.length);
  assert.equal(new Set(reviews.map(r => r.entityId)).size, entities.length);
  for (const {kind, row} of entities) {
    const review = reviews.find(r => r.entityId === row.id);
    assert.equal(review?.entityType, kind, row.id);
    assert.equal(review.reviewerKind, 'model', row.id);
    assert.equal(review.payloadSha256, digest(row), row.id);
    assert.match(JSON.stringify(review), /supplied.*packet|packet.*supplied/i);
    assert.match(JSON.stringify(review), /not human review/i);
    assert.ok(Number.isFinite(Date.parse(review.createdAt)));
  }
  assert.equal(module.tasks.some(t => t.reviewState === 'human_reviewed'), false);
});

test('S1–S10 exact URLs, snapshot dates, supplied hashes and unsupported-source gaps', () => {
  for (const name of ['module', 'sources', 'review']) {
    assert.doesNotMatch(readFileSync(`content/obj0004-0006-${name}.json`, 'utf8'), /\uFFFD|â€|â€“/, `${name}: invalid text encoding`);
  }
  const urls = [
    'https://www.mtel.nesinc.com/Content/StudyGuide/MA_SG_OBJ_56.htm',
    'https://wida.wisc.edu/sites/default/files/resource/WIDA-ELD-Standards-Framework-2020.pdf',
    'https://wida.wisc.edu/sites/default/files/resource/Guiding-Principles-of-Language-Development.pdf',
    'https://wida.wisc.edu/sites/default/files/resource/Can-Do-Descriptors-Key-Uses-K-12-FAQs.pdf',
    'https://ies.ed.gov/ncee/wwc/Docs/PracticeGuide/english_learners_pg_040114.pdf',
    'https://ies.ed.gov/ncee/wwc/Docs/ReferenceResources/WWC_ELs_tips_2022.pdf',
    'https://www.doe.mass.edu/ele/guidance/sei/sei.docx',
    'https://www.doe.mass.edu/ele/guidance/sei/appendices.docx',
    'https://www.doe.mass.edu/ele/programs/sei.html',
    'https://wida.wisc.edu/teach/can-do/descriptors',
  ];
  const hashes = {
    2: '0d92701e7cc5015fb1b98619561f2b22e5b813ddc476c0b799bfc94534b9fba7',
    3: 'c53f8e011cfe2928dd9f34fba598f167ae9878947027d199bf25c6d49761b11e',
    4: 'a67a28b34fea3bf6586945e8a7c914f2f2ff710fd494d01de32c904e1c95a4eb',
    5: '6f39b0f96514344b3773b21ff6f53b7cc2503407ce0e325d7525463115893596',
    6: '7019d7bbeeef366d6e2ca0c9ce0320da7ff8a5e3acb3926de44117534224e8dc',
    7: '99df99b285a23eafc727bb3eed13839f4489e6525216eb7a74eb568f756e584a',
    8: '27b1a325797238d0728d17652a74f21ea013d6f38ad72e1dd4f5349837b8f19f',
  };
  assert.equal(packet.sources.length, 10);
  for (let n = 1; n <= 10; n++) {
    const s = source(n);
    assert.equal(s.url, urls[n - 1]);
    assert.equal(s.sha256, hashes[n] ?? null);
    assert.equal(s.retrievedAt, '2026-11-08');
    assert.equal(s.retrievalTimezone, 'America/New_York');
    assert.equal(s.reviewState, 'source_compared');
    assert.ok(s.documentVersion.length > 5);
    assert.match(s.provenance, /supplied/i);
    assert.match(s.provenance, /did not (?:fetch|retrieve)/i);
  }
  assert.match(JSON.stringify(source(8)), /no .*excerpt|not .*supplied|inventory.only/i);
  assert.match(JSON.stringify(source(10)), /not yet.*updated|have not.*updated/i);
  assert.match(JSON.stringify(source(5)), /K.?8|elementary and middle/i);
  assert.match(JSON.stringify(source(2)), /not.*(?:straightforward|linear)|not a straightforward linear/i);
  assert.match(JSON.stringify(source(2)), /cognitive ability/i);
  assert.match(JSON.stringify(source(3)), /valuable resources/i);
  assert.match(JSON.stringify(source(9)), /facilitates.*academic language development in English/i);
  for (const statement of baseline.statements.filter(s => /^mtel56\.obj\.000[456]\./.test(s.id))) {
    assert.ok(source(1).excerpt.includes(statement.text), statement.id);
  }
});

test('all finite keys and distractors explain their own supplied source decision', () => {
  assert.deepEqual(checks.map(t => t.id).sort(), Object.keys(comparedKeys).map(id => `task.${id}`).sort());
  for (const [suffix, key] of Object.entries(comparedKeys)) assert.deepEqual(task(suffix).answerKey.accepted, [key]);
  for (const item of checks) {
    assert.equal(item.options.length, 4);
    assert.equal(new Set(item.options.map(o => o.id)).size, 4);
    assert.equal(item.noveltyKind, 'familiar');
    const wrong = item.options.filter(o => !item.answerKey.accepted.includes(o.id));
    assert.deepEqual(Object.keys(item.answerKey.wrongFeedback).sort(), wrong.map(o => o.id).sort());
    const explanations = [item.answerKey.feedback, ...Object.values(item.answerKey.wrongFeedback)];
    assert.equal(new Set(explanations).size, 4);
    for (const explanation of explanations) {
      assert.ok(explanation.length > 70);
      assert.ok(item.sourceRefs.some(ref => explanation.includes(ref)), `${item.id}: missing source rationale`);
    }
  }
});

test('PLD decisions reject deficit inferences and preserve non-linear domain-specific planning', () => {
  const profile = task('obj0005.domain-profile');
  const misuse = task('obj0005.pld-boundary');
  const selected = item => item.options.find(o => item.answerKey.accepted.includes(o.id)).text;
  assert.match(selected(profile), /writing|written/i);
  assert.match(selected(profile), /grade.level|complex|rigor/i);
  assert.match(selected(misuse), /not|reject|refuse|cannot|insufficient|no /i);
  assert.match(misuse.answerKey.feedback, /cognitive|ability/i);
  assert.match(misuse.answerKey.feedback, /sole|only|alone|single/i);
  const text = module.lessons.map(l => l.body).join('\n');
  assert.match(text, /non.linear/i);
  assert.match(text, /topic.*audience.*situation/i);
  assert.match(text, /interdependence|dual.iceberg/i);
  assert.match(text, /not all languages/i);
  assert.match(text, /none alone determines outcomes/i);
  assert.match(text, /no causal ranking/i);
  assert.match(text, /Calibrate feedback to purpose:.*during a first.*meaning.*during a later.*form explicit/i);
  assert.match(text, /Neither constant interruption nor .*never correct anything.* follows/i);
  assert.match(text, /Can Do Descriptors/i);
  for (const level of ['entering', 'emerging', 'developing', 'expanding', 'bridging', 'reaching']) {
    assert.match(text, new RegExp(`\\b${level}\\b`, 'i'));
  }
  assert.match(text, /supplement/i);
  assert.match(text, /not yet.*2020|not.*updated.*2020/i);
  assert.match(text, /Strong/);
  assert.match(text, /K.?8/);
  assert.match(text, /three tiers|three.tier/i);
  assert.match(text, /Beck/);
  assert.match(text, /no tier membership rules/i);
  assert.match(text, /content.acquisition measures/i);
  assert.match(text, /[Pp]re-K and high.school.*scope caveat/);
  assert.doesNotMatch(text, /(?:BICS|CALP) (?:takes?|requires?|develops? in) \d/i);
  // Affirmative auto-inference templates are forbidden in feedback, including wrong feedback.
  // Distractors can contain traps; their explanations must reject, never enact, the inference.
  const feedback = checks.flatMap(t => [t.answerKey.feedback, ...Object.values(t.answerKey.wrongFeedback)]).join('\n');
  for (const unsupported of [
    /therefore (?:the (?:student|learner) )?(?:has|must have) (?:low ability|a disability|trauma)/i,
    /(?:nationality|language background) (?:proves|determines|reveals) (?:ability|disability|trauma|personality)/i,
    /(?:all|every) (?:Spanish|Chinese|Arabic|Portuguese)[- ]speaking (?:students?|learners?) (?:are|have|prefer)/i,
    /(?:Entering|PL1|PL2) (?:means|proves|indicates) (?:low intelligence|low cognitive ability|a disability)/i,
    /(?:BICS|CALP) (?:takes?|requires?|develops? in) \d/i,
    /(?:visual|auditory|kinesthetic) learners? (?:must|always|should only)/i,
  ]) assert.doesNotMatch(feedback, unsupported);
});

test('unfamiliar cases demand plans, uncertainty and reasoning without a finite or keyword key', () => {
  assert.deepEqual(cases.map(t => t.id), [
    'task.obj0004.audience-argument-case', 'task.obj0005.museum-profile-case', 'task.obj0006.civic-vocabulary-case',
  ]);
  assert.equal(new Set(cases.map(t => t.familyId)).size, 3);
  for (const item of cases) {
    assert.equal(item.noveltyKind, 'unfamiliar');
    assert.equal(item.answerKey, undefined);
    assert.equal(item.options, undefined);
    assert.match(item.prompt, /uncertain|uncertainty/i);
    assert.match(item.prompt, /justif/i);
    assert.match(item.prompt, /provisional.*manual|manual.*provisional/i);
    assert.match(item.prompt, /keyword/i);
    assert.match(item.prompt, /synthetic/i);
    assert.match(item.prompt, /unfamiliar.*(?:alone|does not|not proof|neither)/i);
  }
  assert.match(cases[0].prompt, /audience/i);
  assert.match(cases[1].prompt, /speaking|oral/i);
  assert.match(cases[1].prompt, /writing|written/i);
  assert.match(cases[2].prompt, /cognate/i);
  assert.match(cases[2].prompt, /morphology|word[- ]parts?/i);
  assert.match(cases[2].prompt, /multiple.meaning|polysem/i);
});

test('native recall cards retain source binding, exact shape, standard tags and no evidence payload', () => {
  const support = [
    ['obj0004.language-dimensions', 2, /Discourse.*overall meaning.*sentence.*grammatical complexity.*word\/phrase.*precision/i],
    ['obj0004.cognate-check', 5, /not all languages.*false cognate/i],
    ['obj0005.domain-snapshot', 2, /snapshot.*domains.*does not categorize.*cognitive ability/i],
    ['obj0005.academic-interdependence', 9, /native language facilitates.*English.*English also informs/i],
    ['obj0006.intensive-vocabulary', 5, /several days.*varied.*Recommendation 1.*Strong/i],
    ['obj0006.content-language', 5, /oral and written.*content.area.*Recommendation 2.*Strong.*content.acquisition measures/i],
  ];
  assert.deepEqual(module.cards.map(c => c.id), support.map(([suffix]) => `card.${suffix}.v1`));
  for (const [suffix, n, claim] of support) {
    const card = module.cards.find(c => c.id === `card.${suffix}.v1`);
    assert.equal(card.source, source(n).id);
    assert.match(card.back, claim);
  }
  for (const objective of ['0004', '0005', '0006']) {
    assert.equal(module.cards.filter(c => c.tags.includes(`objective::${objective}`)).length, 2);
  }
  for (const card of module.cards) {
    assert.deepEqual(Object.keys(card).sort(), ['back', 'front', 'id', 'source', 'tags']);
    assert.ok(card.front.length > 15 && card.back.length > 35);
    const s = packet.sources.find(s => s.id === card.source);
    assert.ok(s && s.id !== source(8).id && s.excerpt.length > 20);
    assert.ok(card.tags.includes('version::1') && card.tags.includes('sei-study-lab'));
    const skillTag = card.tags.find(tag => tag.startsWith('skill::'));
    assert.ok(baseline.skills.some(s => s.id === `sei.skill.${skillTag?.slice(7)}`));
    const review = reviews.find(r => r.entityId === card.id);
    assert.ok(review.comparedSourceIds.includes(card.source));
  }
  for (const key of ['attempts', 'judgments', 'evidenceEvents', 'drafts']) assert.equal(key in module, false);
});

test('new bindings preserve sixteen official statements and narrow each task claim', () => {
  const official = baseline.statements.filter(s => /^mtel56\.obj\.000[456]\./.test(s.id));
  assert.equal(official.length, 16);
  for (const [objective, count] of [['0004', 4], ['0005', 6], ['0006', 6]]) {
    assert.equal(official.filter(s => s.objectiveId === `mtel56.obj.${objective}`).length, count);
  }
  assert.deepEqual([...new Set(bindings.map(b => b.statementId))].sort(), official.map(s => s.id).sort());
  const expected = {
    '0004.ds.01': ['obj0004.sound-or-part'],
    '0004.ds.02': ['obj0004.cognate-resource', 'obj0004.false-friend'],
    '0004.ds.03': ['obj0004.audience-register', 'obj0004.audience-argument-case'],
    '0004.ds.04': ['obj0004.argument-forms', 'obj0004.audience-argument-case'],
    '0005.ds.01': [],
    '0005.ds.02': ['obj0005.domain-profile', 'obj0005.pld-boundary', 'obj0005.non-linear', 'obj0005.museum-profile-case'],
    '0005.ds.03': [],
    '0005.ds.04': ['obj0005.risk-and-rigor'],
    '0005.ds.05': [],
    '0005.ds.06': ['obj0005.sci-esl'],
    '0006.ds.01': ['obj0006.content-talk'],
    '0006.ds.02': [],
    '0006.ds.03': ['obj0006.civic-vocabulary-case'],
    '0006.ds.04': ['obj0006.civic-vocabulary-case'],
    '0006.ds.05': ['obj0006.word-sequence', 'obj0006.polysemy', 'obj0006.civic-vocabulary-case'],
    '0006.ds.06': [],
  };
  for (const [suffix, ids] of Object.entries(expected)) {
    assert.deepEqual(bindings.filter(b => b.statementId === `mtel56.obj.${suffix}`).flatMap(b => b.tasks.map(t => t.taskId)).sort(),
      ids.map(id => `task.${id}`).sort(), suffix);
  }
  for (const b of bindings) {
    const statement = official.find(s => s.id === b.statementId);
    assert.ok(statement);
    assert.equal(b.statementVersion, statement.version);
    assert.equal(b.sourceVersionId, statement.sourceVersionId);
    assert.equal(b.sourceVersion, '2026-11-08');
    assert.ok(b.scope.length > 40 && b.remainingGap.length > 40);
    for (const ref of b.lessons) assert.equal(ref.fingerprint, fingerprint(module.lessons.find(l => l.id === ref.lessonId)));
    for (const ref of b.tasks) {
      const item = module.tasks.find(t => t.id === ref.taskId);
      assert.ok(item && item.skillIds.includes(ref.skillId));
      assert.equal(ref.taskVersion, item.version);
      assert.ok(item.id.includes(b.statementId.slice(11, 15)), `${item.id} bound to different objective`);
    }
  }
  for (const item of module.tasks) assert.ok(bindings.some(b => b.tasks.some(t => t.taskId === item.id)), item.id);
  for (const item of checks) assert.equal(bindings.filter(b => b.tasks.some(t => t.taskId === item.id)).length, 1, item.id);
});

test('equivalent starter rules keep exposure families rather than resetting independence', () => {
  const correlated = [
    ['obj0005.domain-profile', 'task.uneven-profile'],
    ['obj0005.pld-boundary', 'task.obj0001.language-disability'],
    ['obj0005.risk-and-rigor', 'task.preserve-demand'],
    ['obj0006.content-talk', 'task.rehearsal-bridge'],
    ['obj0005.sci-esl', 'task.shared-plan'],
  ];
  for (const [suffix, oldId] of correlated) assert.equal(task(suffix).familyId, baseline.tasks.find(t => t.id === oldId).familyId);
});

test('offline append recipe is idempotent and rejects stale reviews and existing-version conflicts before writing', () => {
  const root = realpathSync('tests');
  const dir = mkdtempSync(resolve(root, '.authoring-456-'));
  if (!realpathSync(dir).startsWith(root + sep)) throw new Error('Unsafe source-only cleanup target');
  try {
    const names = ['author-seed.ts', ...['obj0001', 'obj0002-0003', 'obj0004-0006', 'obj0007-0009'].flatMap(prefix => [`${prefix}-sources.json`, `${prefix}-module.json`, `${prefix}-review.json`])];
    for (const name of names) copyFileSync(resolve('content', name), resolve(dir, name));
    const path = resolve(dir, 'catalog.json');
    writeFileSync(path, JSON.stringify(baseline, null, 2) + '\n');
    const run = () => execFileSync(process.execPath, ['--experimental-strip-types', resolve(dir, 'author-seed.ts')], {cwd: dir, stdio: 'pipe'});
    run();
    const first = readFileSync(path);
    assert.deepEqual(JSON.parse(first.toString('utf8')), catalog);
    run();
    assert.deepEqual(readFileSync(path), first);
    for (const [kind, id] of [['tasks', checks[0].id], ['sources', source(2).id], ['cards', module.cards[0].id], ['lessons', module.lessons[0].id], ['reviewEvents', reviews[0].id]]) {
      const conflict = structuredClone(catalog);
      conflict[kind].find(row => row.id === id).unexpectedConflict = true;
      const bytes = JSON.stringify(conflict);
      writeFileSync(path, bytes);
      assert.throws(run, /Immutable catalog conflict/);
      assert.equal(readFileSync(path, 'utf8'), bytes);
    }
    for (const kind of ['tasks', 'cards', 'lessons']) {
      writeFileSync(path, first);
      const changed = structuredClone(module);
      changed[kind][0][kind === 'tasks' ? 'prompt' : kind === 'cards' ? 'back' : 'body'] += ' Unreviewed mutation.';
      writeFileSync(resolve(dir, 'obj0004-0006-module.json'), JSON.stringify(changed));
      assert.throws(run, /Missing or stale model comparison/);
      assert.deepEqual(readFileSync(path), first);
    }
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
