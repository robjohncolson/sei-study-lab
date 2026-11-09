// Dependency-free supplied-packet checks; no Git, network or learner files.
// node --experimental-strip-types --test-reporter=tap scripts/verify-obj0007-0009.mjs
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {resolve, sep} from 'node:path';
import {test} from 'node:test';
import {COVERAGE_CONTRACT_VERSION, SOURCE_COVERAGE_CONTRACT} from '../packages/shared/src/coverage-contract.ts';
import {SOURCE_COVERAGE_CONTRACT as baselineContract} from '../tests/fixtures/coverage-contract-79040cd08ded4db75bca10ee18cb6016107b39c1.ts';
import {parseObjectives789Baseline, readObjectives789Baseline, verifyObjectives789ContractFixture} from '../tests/obj0007-0009-baseline.ts';

const read = name => JSON.parse(readFileSync(name, 'utf8'));
const catalog = read('content/catalog.json');
const baseline = readObjectives789Baseline();
const module = read('content/obj0007-0009-module.json');
const packet = read('content/obj0007-0009-sources.json');
const reviewFile = read('content/obj0007-0009-review.json');
const reviews = reviewFile.reviewEvents;
const checks = module.tasks.filter(t => t.kind === 'mc');
const cases = module.tasks.filter(t => t.kind === 'case');
const bindings = SOURCE_COVERAGE_CONTRACT.slice(baselineContract.length);
const task = suffix => module.tasks.find(t => t.id === `task.${suffix}`);
const selected = item => item.options.find(o => item.answerKey.accepted.includes(o.id)).text;
const sourceIds = {
  S1: 'source.obj0007-0009.s1.2026-11-08', S2: 'source.obj0004-0006.s2.2026-11-08',
  S3: 'source.obj0004-0006.s3.2026-11-08', S4: 'source.obj0004-0006.s7.2026-11-08',
  S5: 'source.obj0004-0006.s5.2026-11-08', S6: 'source.obj0004-0006.s6.2026-11-08',
  S7: 'source.obj0001.s9.2026-11-08', S8: 'source.obj0001.s7.2026-11-08',
  S9: 'source.obj0007-0009.s9.2026-11-08', S10: 'source.obj0007-0009.s10.2026-11-08',
};
const canonical = value => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const fingerprint = lesson => {
  const text = JSON.stringify([lesson.title, lesson.body, [...lesson.skillIds].sort(), [...lesson.sourceRefs].sort()]);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
};

test('79040cd fixtures pin exact prior catalog entity bytes, order and coverage scopes', () => {
  verifyObjectives789ContractFixture();
  const bytes = readFileSync(new URL('../tests/fixtures/catalog-79040cd08ded4db75bca10ee18cb6016107b39c1.json', import.meta.url));
  assert.deepEqual(bytes, Buffer.from(JSON.stringify(baseline, null, 2) + '\n'));
  assert.deepEqual(readFileSync('content/catalog.json'), Buffer.from(JSON.stringify(catalog, null, 2) + '\n'));
  for (const changed of [Buffer.concat([bytes, Buffer.from('\n')]), Buffer.from(JSON.stringify(baseline)), Buffer.from('{')]) {
    assert.throws(() => parseObjectives789Baseline(changed), /integrity/);
  }
  const additions = {...module, sources: packet.sources, reviewEvents: reviews};
  for (const [key, rows] of Object.entries(baseline)) {
    assert.equal(JSON.stringify(Array.isArray(rows) ? catalog[key].slice(0, rows.length) : catalog[key]), JSON.stringify(rows), key);
    if (key in additions) {
      assert.deepEqual(catalog[key].slice(rows.length), additions[key], key);
      assert.equal(catalog[key].length, rows.length + additions[key].length, key);
    } else assert.deepEqual(catalog[key], rows, key);
  }
  assert.deepEqual(SOURCE_COVERAGE_CONTRACT.slice(0, baselineContract.length), baselineContract);
  assert.equal(COVERAGE_CONTRACT_VERSION, 3);
});

test('three substantive scaffolded lessons, thirteen decisions, three manual cases, six cards and no seeded evidence', () => {
  assert.deepEqual(module.lessons.map(l => l.id), [
    'lesson.obj0007.sheltered-planning.v1', 'lesson.obj0008.academic-discourse.v1', 'lesson.obj0009.assessment-decisions.v1',
  ]);
  assert.equal(checks.length, 13);
  assert.equal(cases.length, 3);
  assert.equal(module.tasks.length, 16);
  assert.equal(module.cards.length, 6);
  for (const lesson of module.lessons) {
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
  for (const row of [...module.lessons, ...module.tasks]) {
    assert.ok(row.sourceRefs.length && row.sourceRefs.every(id => Object.values(sourceIds).includes(id)));
    assert.ok(!row.sourceRefs.includes(sourceIds.S8), 'S8 is context only, not a new teaching excerpt');
    assert.ok(row.skillIds.length && row.skillIds.every(id => baseline.skills.some(s => s.id === id)));
  }
  for (const item of module.tasks) {
    assert.equal(item.reviewState, 'source_checked');
    assert.ok(module.lessons.some(l => l.id === item.lessonId));
  }
  for (const key of ['attempts', 'judgments', 'evidenceEvents', 'drafts']) assert.equal(key in module, false);
});

test('separate model comparisons hash final payloads and explicitly stop short of human review', () => {
  const groups = {source: packet.sources, lesson: module.lessons, task: module.tasks, card: module.cards};
  const entities = Object.entries(groups).flatMap(([kind, rows]) => rows.map(row => ({kind, row})));
  assert.equal(reviews.length, entities.length);
  assert.equal(new Set(reviews.map(r => r.entityId)).size, entities.length);
  assert.equal(reviewFile.packetPayloadSha256, digest(packet));
  for (const {kind, row} of entities) {
    const r = reviews.find(e => e.entityId === row.id);
    assert.equal(r?.entityType, kind, row.id);
    assert.equal(r.reviewerKind, 'model');
    assert.equal(r.payloadSha256, digest(row), row.id);
    assert.match(JSON.stringify(r), /supplied.*packet|packet.*supplied/i);
    assert.match(JSON.stringify(r), /not human review/i);
    assert.ok(Number.isFinite(Date.parse(r.createdAt)));
    assert.ok(r.comparedSourceIds.length && r.comparedSourceIds.every(id => catalog.sources.some(s => s.id === id)));
  }
  assert.equal(module.tasks.some(t => t.reviewState === 'human_reviewed'), false);
});

test('source snapshots reuse only exact full URL/hash matches and retain supplied provenance', () => {
  const expected = [
    ['S1', 'https://www.mtel.nesinc.com/Content/StudyGuide/MA_SG_OBJ_56.htm', null],
    ['S2', 'https://wida.wisc.edu/sites/default/files/resource/WIDA-ELD-Standards-Framework-2020.pdf', '0d92701e7cc5015fb1b98619561f2b22e5b813ddc476c0b799bfc94534b9fba7'],
    ['S3', 'https://wida.wisc.edu/sites/default/files/resource/Guiding-Principles-of-Language-Development.pdf', 'c53f8e011cfe2928dd9f34fba598f167ae9878947027d199bf25c6d49761b11e'],
    ['S4', 'https://www.doe.mass.edu/ele/guidance/sei/sei.docx', '99df99b285a23eafc727bb3eed13839f4489e6525216eb7a74eb568f756e584a'],
    ['S5', 'https://ies.ed.gov/ncee/wwc/Docs/PracticeGuide/english_learners_pg_040114.pdf', '6f39b0f96514344b3773b21ff6f53b7cc2503407ce0e325d7525463115893596'],
    ['S6', 'https://ies.ed.gov/ncee/wwc/Docs/ReferenceResources/WWC_ELs_tips_2022.pdf', '7019d7bbeeef366d6e2ca0c9ce0320da7ff8a5e3acb3926de44117534224e8dc'],
    ['S7', 'https://www.doe.mass.edu/ele/guidance/disabilities.docx', 'e5ee4b9dcb28aad2cab8261d5bbb72ad7a9493fdb3e91225f8ee8c1abc0751ee'],
    ['S8', 'https://www.doe.mass.edu/ele/guidance/services-programming.docx', '127e17d03df6ef48c7a8ed691f4a1596dcb8183942e86bfb423bd6ed8842ef95'],
    ['S9', 'https://wida.wisc.edu/sites/default/files/resource/Interpretive-Guide.pdf', '83593228d956c615f52b2fe80ef11679969c856bb82e55c65f78774b744eeb55'],
    ['S10', 'https://www.doe.mass.edu/mcas/accessibility/manual.pdf', '8763f2ca8bba85f29c3f90b637d1475d3357fc5a1a8d96f997a62da1cb6db4ff'],
  ];
  assert.equal(packet.sources.length, 3);
  assert.deepEqual(packet.sources.map(s => s.id), [sourceIds.S1, sourceIds.S9, sourceIds.S10]);
  assert.deepEqual(packet.packetBindings.map(b => b.packetSource), Object.keys(sourceIds));
  for (const [label, url, hash] of expected) {
    const s = catalog.sources.find(s => s.id === sourceIds[label]);
    const b = packet.packetBindings.find(b => b.packetSource === label);
    assert.ok(s && b, label);
    assert.equal(s.url, url);
    assert.equal(s.sha256, hash);
    assert.equal(b.sourceId, s.id);
    assert.equal(b.url, url);
    assert.equal(b.sha256, hash);
    assert.equal(b.retrievedAt, '2026-11-08');
    assert.equal(b.retrievalTimezone, 'America/New_York');
    assert.match(b.provenance, /supplied/i);
    if (!['S1', 'S9', 'S10'].includes(label)) assert.deepEqual(s, baseline.sources.find(old => old.id === s.id));
    if (label !== 'S8') assert.ok(b.supportingExcerpts.length, label);
  }
  for (const s of packet.sources) {
    assert.equal(s.retrievedAt, '2026-11-08');
    assert.equal(s.retrievalTimezone, 'America/New_York');
    assert.equal(s.reviewState, 'source_compared');
    assert.match(s.provenance, /supplied/i);
    assert.match(s.provenance, /did not (?:fetch|retrieve)/i);
    assert.ok(!baseline.sources.some(old => old.id === s.id));
  }
  for (const statement of baseline.statements.filter(s => /^mtel56\.obj\.000[789]\./.test(s.id))) {
    assert.ok(packet.sources[0].excerpt.includes(statement.text), statement.id);
  }
  for (const name of ['module', 'sources', 'review']) assert.doesNotMatch(readFileSync(`content/obj0007-0009-${name}.json`, 'utf8'), /\uFFFD|â€|Ã©/, name);
});

test('all keys and every distractor carry a distinct source-specific decision rationale', () => {
  // Keys are pinned after the separate wording/source comparison, not derived from grading code.
  const keys = {
    'obj0007.dual-objectives': 'b', 'obj0007.scaffold-up': 'd', 'obj0007.fade-support': 'a',
    'obj0007.sci-esl': 'c', 'obj0007.co-planning': 'b', 'obj0008.social-academic': 'd',
    'obj0008.text-demands': 'a', 'obj0009.domain-content': 'c', 'obj0009.domain-composite': 'b',
    'obj0009.formative-load': 'd', 'obj0009.accommodation': 'a', 'obj0009.timely-evaluation': 'c', 'obj0009.score-uncertainty': 'b',
  };
  assert.deepEqual(checks.map(t => t.id).sort(), Object.keys(keys).map(id => `task.${id}`).sort());
  for (const [suffix, key] of Object.entries(keys)) assert.deepEqual(task(suffix).answerKey.accepted, [key], suffix);
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

test('ACCESS interpretation, access, disability and feedback enforce the supplied accuracy boundaries', () => {
  const text = module.lessons.map(l => l.body).join('\n');
  assert.match(text, /word\/phrase|word.*sentence.*discourse/i);
  assert.match(text, /social.*academic/i);
  assert.match(text, /content goal/i);
  assert.match(text, /language goal/i);
  assert.match(text, /co.plan/i);
  assert.match(text, /scaffold.*up/i);
  assert.match(text, /dedicated ESL/i);
  assert.match(text, /fade|fading/i);
  assert.match(text, /Standard Error of Measurement|SEM/);
  assert.match(text, /confidence band/i);
  assert.match(text, /triangulat/i);
  assert.match(text, /not.*across domains/i);
  assert.match(text, /2025.?2026.*baseline|baseline.*2025.?2026/i);
  assert.match(text, /routine|routinely/i);
  assert.match(text, /annual/i);
  assert.match(text, /(?:not|nor|neither).*(?:delay|postpone|wait)/i);
  assert.match(selected(task('obj0007.scaffold-up')), /grade.level|same.*(?:target|strategies)|retain/i);
  assert.match(selected(task('obj0009.domain-content')), /content|reasoning/i);
  assert.match(task('obj0009.domain-content').answerKey.feedback, /not|cannot|doesn.t/i);
  assert.match(selected(task('obj0009.domain-composite')), /domain|writing|literacy/i);
  assert.match(selected(task('obj0009.formative-load')), /diagram|oral/i);
  assert.match(task('obj0009.accommodation').prompt + selected(task('obj0009.accommodation')), /practis|practic|routin/i);
  assert.match(selected(task('obj0009.timely-evaluation')), /evaluat|refer/i);
  assert.match(selected(task('obj0009.score-uncertainty')), /band|uncertain|triangulat/i);
  const feedback = checks.flatMap(t => [t.answerKey.feedback, ...Object.values(t.answerKey.wrongFeedback)]).join('\n');
  for (const unsupported of [
    /therefore (?:the (?:student|learner) )?(?:has|must have) (?:low ability|a disability|trauma)/i,
    /(?:nationality|language background) (?:proves|determines|reveals) (?:ability|disability|trauma|personality|cultural traits)/i,
    /(?:all|every) (?:Spanish|Chinese|Arabic|Portuguese)[- ]speaking (?:students?|learners?) (?:are|have|prefer)/i,
    /(?:Entering|PL1|PL2) (?:means|proves|indicates) (?:low intelligence|low cognitive ability|a disability)/i,
    /(?:BICS|CALP) (?:takes?|requires?|develops? in) \d/i,
  ]) assert.doesNotMatch(feedback, unsupported);
  const instruction = text + module.cards.map(c => c.back).join('\n') + feedback;
  assert.doesNotMatch(instruction, /(?:exit|reclassif\w*) (?:at|requires?|threshold(?: is)?|cut[ -]?score(?: is)?)\s*\d/i);
  assert.doesNotMatch(instruction, /(?:\b\d+ (?:SIOP features|months to fluency)|effect size of \d)/i);
});

test('three unfamiliar non-math cases require different reasoning and stay manual without keyword grading', () => {
  assert.deepEqual(cases.map(t => t.id), [
    'task.obj0007.exhibition-plan-case', 'task.obj0008.archive-discourse-case', 'task.obj0009.garden-profile-case',
  ]);
  assert.equal(new Set(cases.map(t => t.familyId)).size, 3);
  for (const item of cases) {
    assert.equal(item.noveltyKind, 'unfamiliar');
    assert.equal(item.answerKey, undefined);
    assert.equal(item.options, undefined);
    assert.match(item.prompt, /uncertain|uncertainty/i);
    assert.match(item.prompt, /justif|explain/i);
    assert.match(item.prompt, /provisional.*manual|manual.*provisional/i);
    assert.match(item.prompt, /keyword/i);
    assert.match(item.prompt, /synthetic/i);
    assert.match(item.prompt, /unfamiliar.*(?:alone|does not|not proof|neither)/i);
  }
  assert.match(cases[0].prompt, /co.plan/i);
  assert.match(cases[0].prompt, /fad/i);
  assert.match(cases[1].prompt, /sentence|clause/i);
  assert.match(cases[1].prompt, /discourse/i);
  assert.match(cases[2].prompt, /ACCESS/);
  assert.match(cases[2].prompt, /glossary/i);
  assert.match(cases[2].prompt, /state.test support|accommodation/i);
  assert.match(cases[2].prompt, /referr|evaluat/i);
  assert.match(cases[2].prompt, /monitor/i);
});

test('recall cards have exact native shape, objective/skill tags and packet-backed source bindings', () => {
  const support = [
    ['obj0007.dual-standards', 'S4', /content|subject/i, /language|WIDA/i, /tandem/i],
    ['obj0007.core-esl', 'S4', /dedicated|focus/i, /core/i, /(?:not|alone).*enough|core.*ESL/i],
    ['obj0008.language-dimensions', 'S2', /discourse/i, /sentence/i, /word\/phrase/i],
    ['obj0008.frames-purpose', 'S1', /frame/i, /argument|evidence|discourse/i, /sentence frames/i],
    ['obj0009.domain-composite', 'S9', /domain/i, /composite|Overall/i, /composite.*domain|domain.*composite/i],
    ['obj0009.routine-accommodations', 'S10', /routine|test day|solely|classroom|only for testing/i, /annual/i, /solely for testing/i],
  ];
  assert.deepEqual(module.cards.map(c => c.id), support.map(([suffix]) => `card.${suffix}.v1`));
  for (const [suffix, label, firstClaim, secondClaim, excerptClaim] of support) {
    const card = module.cards.find(c => c.id === `card.${suffix}.v1`);
    assert.equal(card.source, sourceIds[label]);
    assert.match(card.back, firstClaim);
    assert.match(card.back, secondClaim);
    const b = packet.packetBindings.find(b => b.packetSource === label);
    assert.match(b.supportingExcerpts.map(e => e.text).join(' '), excerptClaim);
  }
  for (const objective of ['0007', '0008', '0009']) assert.equal(module.cards.filter(c => c.tags.includes(`objective::${objective}`)).length, 2);
  for (const card of module.cards) {
    assert.deepEqual(Object.keys(card).sort(), ['back', 'front', 'id', 'source', 'tags']);
    assert.ok(card.front.length > 15 && card.back.length > 35);
    const s = catalog.sources.find(s => s.id === card.source);
    assert.ok(s && s.excerpt.length > 20);
    assert.ok(card.tags.includes('version::1') && card.tags.includes('sei-study-lab'));
    const skillTag = card.tags.find(tag => tag.startsWith('skill::'));
    assert.ok(baseline.skills.some(s => s.id === `sei.skill.${skillTag?.slice(7)}`));
    assert.ok(reviews.find(r => r.entityId === card.id).comparedSourceIds.includes(card.source));
    assert.doesNotMatch(card.back, /(?:MCAS.*\b(?:EL|A)\d+|(?:exit|reclassif\w*).{0,20}\d\.\d)/i);
  }
});

test('narrow bindings preserve fifteen exact statements and leave remaining gaps for every scope', () => {
  const official = baseline.statements.filter(s => /^mtel56\.obj\.000[789]\./.test(s.id));
  assert.equal(official.length, 15);
  assert.equal(bindings.length, 24);
  assert.deepEqual([...new Set(bindings.map(b => b.statementId))].sort(), official.map(s => s.id).sort());
  const expected = {
    '0007.ds.01': ['obj0007.sci-esl'],
    '0007.ds.02': ['obj0007.dual-objectives', 'obj0007.exhibition-plan-case'],
    '0007.ds.03': ['obj0007.scaffold-up', 'obj0007.fade-support', 'obj0007.exhibition-plan-case'],
    '0007.ds.04': [],
    '0007.ds.05': ['obj0007.co-planning', 'obj0007.exhibition-plan-case'],
    '0008.ds.01': ['obj0008.social-academic'],
    '0008.ds.02': [],
    '0008.ds.03': ['obj0008.archive-discourse-case'],
    '0008.ds.04': ['obj0008.text-demands', 'obj0008.archive-discourse-case'],
    '0008.ds.05': ['obj0008.archive-discourse-case'],
    '0009.ds.01': ['obj0009.timely-evaluation', 'obj0009.garden-profile-case'],
    '0009.ds.02': ['obj0009.score-uncertainty'],
    '0009.ds.03': ['obj0009.formative-load'],
    '0009.ds.04': ['obj0009.domain-content', 'obj0009.domain-composite', 'obj0009.garden-profile-case'],
    '0009.ds.05': ['obj0009.accommodation', 'obj0009.garden-profile-case'],
  };
  for (const [suffix, ids] of Object.entries(expected)) {
    assert.deepEqual(bindings.filter(b => b.statementId === `mtel56.obj.${suffix}`).flatMap(b => b.tasks.map(t => t.taskId)).sort(), ids.map(id => `task.${id}`).sort(), suffix);
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
      assert.ok(item.id.includes(b.statementId.slice(11, 15)), `${item.id}: different objective`);
    }
  }
  for (const item of module.tasks) assert.ok(bindings.some(b => b.tasks.some(t => t.taskId === item.id)), item.id);
  for (const item of checks) assert.equal(bindings.filter(b => b.tasks.some(t => t.taskId === item.id)).length, 1, item.id);
  assert.match(bindings.map(b => b.remainingGap).join('\n'), /SIOP/);
  assert.match(bindings.map(b => b.remainingGap).join('\n'), /reclassification|exit/i);
});

test('equivalent earlier decisions retain family exposure rather than inventing independence', () => {
  for (const [suffix, oldId] of [
    ['obj0007.scaffold-up', 'task.preserve-demand'], ['obj0007.fade-support', 'task.fade-support'],
    ['obj0007.sci-esl', 'task.obj0005.sci-esl'], ['obj0008.social-academic', 'task.social-academic'],
    ['obj0008.text-demands', 'task.language-levels'], ['obj0009.domain-composite', 'task.uneven-profile'],
    ['obj0009.timely-evaluation', 'task.obj0001.language-disability'],
    ['obj0007.co-planning', 'task.team-evidence'], ['obj0009.domain-content', 'task.grammar-content'],
    ['obj0009.formative-load', 'task.formative-use'], ['obj0009.accommodation', 'task.preserve-demand'],
  ]) assert.equal(task(suffix).familyId, baseline.tasks.find(t => t.id === oldId).familyId, suffix);
});

test('offline append recipe is idempotent and refuses stale reviews and same-key conflicts before writing', () => {
  const root = realpathSync('tests');
  const dir = mkdtempSync(resolve(root, '.authoring-789-'));
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
    for (const [kind, id] of [['tasks', checks[0].id], ['sources', packet.sources[0].id], ['cards', module.cards[0].id], ['lessons', module.lessons[0].id], ['reviewEvents', reviews[0].id]]) {
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
      writeFileSync(resolve(dir, 'obj0007-0009-module.json'), JSON.stringify(changed));
      assert.throws(run, /Missing or stale model comparison/);
      assert.deepEqual(readFileSync(path), first);
    }
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
