// Offline source assertions, including temporary source-only copies under tests/.
// No dependencies, network, Git history, protected paths or learner database writes.
// Run: node --experimental-strip-types scripts/verify-obj0002-0003.mjs
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {resolve, sep} from 'node:path';
import {test} from 'node:test';
import {COVERAGE_CONTRACT_VERSION, SOURCE_COVERAGE_CONTRACT} from '../packages/shared/src/coverage-contract.ts';
import {SOURCE_COVERAGE_CONTRACT as baselineContract} from '../tests/fixtures/coverage-contract-d8e0dd883457cc01fd6a394e3d5c4fc35993f506.ts';
import {parseSliceBaseline, readSliceBaseline, verifySliceContractFixture} from '../tests/obj0002-0003-baseline.ts';

const read = name => JSON.parse(readFileSync(name, 'utf8'));
const catalog = read('content/catalog.json');
const baseline = readSliceBaseline();
const module = read('content/obj0002-0003-module.json');
const packet = read('content/obj0002-0003-sources.json');
const reviews = read('content/obj0002-0003-review.json').reviewEvents;
const checks = module.tasks.filter(t => t.kind === 'mc');
const cases = module.tasks.filter(t => t.kind === 'case');
const canonical = value => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const fingerprint = lesson => {
  const text = JSON.stringify([lesson.title, lesson.body, [...lesson.skillIds].sort(), [...lesson.sourceRefs].sort()]);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
};

test('portable base and legacy contract are digest-pinned; all prior entities remain exact', () => {
  verifySliceContractFixture();
  const bytes = readFileSync(new URL('../tests/fixtures/catalog-d8e0dd883457cc01fd6a394e3d5c4fc35993f506.json', import.meta.url));
  assert.throws(() => parseSliceBaseline(Buffer.concat([bytes, Buffer.from('\n')])), /integrity/);
  assert.throws(() => parseSliceBaseline(Buffer.from(JSON.stringify(baseline))), /integrity/);
  assert.throws(() => parseSliceBaseline(Buffer.from('{')), /integrity/);
  for (const [key, rows] of Object.entries(baseline)) {
    assert.deepEqual(Array.isArray(rows) ? catalog[key].slice(0, rows.length) : catalog[key], rows, key);
  }
  for (const key of ['objectives', 'statements', 'competencies', 'indicators', 'skills', 'alignments', 'prerequisites', 'mentorTexts', 'rubrics', 'cards']) {
    assert.deepEqual(key === 'cards' ? catalog.cards.slice(0, baseline.cards.length) : catalog[key], baseline[key], key);
  }
  assert.deepEqual(SOURCE_COVERAGE_CONTRACT.slice(0, baselineContract.length), baselineContract);
});

test('exactly two lessons, twelve conceptual checks and two distinct manual cases are appended', () => {
  for (const [key, rows] of Object.entries({...module, sources: packet.sources, reviewEvents: reviews})) {
    assert.deepEqual(catalog[key].slice(baseline[key].length, baseline[key].length + rows.length), rows, key);
  }
  assert.equal(module.lessons.length, 2);
  assert.equal(checks.length, 12);
  assert.equal(new Set(checks.map(t => t.familyId)).size, 11);
  assert.equal(checks.find(t => t.id === 'task.obj0002.slife-criteria').familyId, checks.find(t => t.id === 'task.obj0002.slife-characteristics').familyId);
  assert.equal(cases.length, 2);
  assert.equal(module.tasks.length, 14);
  assert.equal(new Set(cases.map(t => t.familyId)).size, 2);
  for (const task of module.tasks) {
    assert.equal(task.reviewState, 'source_checked');
    assert.ok(module.lessons.some(l => l.id === task.lessonId));
    assert.ok(task.skillIds.every(id => baseline.skills.some(s => s.id === id)));
    assert.ok(task.sourceRefs.every(id => catalog.sources.some(s => s.id === id)));
  }
});

test('separate model comparison binds each final payload without human review claims', () => {
  const entities = [...packet.sources, ...module.lessons, ...module.tasks];
  assert.equal(reviews.length, entities.length);
  for (const entity of entities) {
    const review = reviews.find(r => r.entityId === entity.id);
    assert.equal(review?.reviewerKind, 'model', entity.id);
    assert.equal(review.payloadSha256, digest(entity), entity.id);
    assert.match(JSON.stringify(review), /supplied.*packet|packet.*supplied/i);
    assert.match(JSON.stringify(review), /not human review|no human review/i);
  }
  assert.equal(catalog.tasks.some(t => t.reviewState === 'human_reviewed'), false);
});

test('supplied source dates and binary hashes retain their exact bounded provenance', () => {
  const hashes = {
    4: 'ec354921b1ed96a59f15ed32be73213df132d791de3fe13f8883736cfcbefd5b',
    5: '2e4f4d00b2a94c20236f4460e91b33cc11df5e29491d0e0d01b16e1cbbad8595',
    6: '9861c45ab952d2d926304b58f487c60bdbf5e47171f8c2bb8bfc1225e5fc2673',
    7: '7d9380242addf428def85445f1f7bf4a17dc9d40722e838c1987f4ec560fabab',
    8: 'ed27e44982c0de465f5b3cce294ed7942733a6b20389fa5fce57bb2c1b627ce9',
    9: 'edb483ae8abb80b9df647b6cf224de44a02db42795d3cf3b4ea4988d129105a8',
  };
  assert.equal(packet.sources.length, 8);
  for (const source of packet.sources) {
    const n = Number(source.id.match(/\.s(\d+)\./)[1]);
    assert.equal(source.sha256, hashes[n] ?? null, source.id);
    assert.equal(source.retrievedAt, '2026-11-08');
    assert.equal(source.retrievalTimezone, 'America/New_York');
    assert.equal(source.reviewState, 'source_compared');
    assert.match(source.provenance, /Codex did not (?:fetch|retrieve)/);
    assert.equal(source.excerpt, source.supportingExcerpts.map(e => e.text).join('\n\n'));
    assert.ok(source.documentVersion && source.derivedClaimRationale);
  }
  assert.equal(packet.sources.some(s => s.url.includes('colleague-el-201501.pdf')), false);
});

test('every wrong option has a distinct source-specific explanatory rationale', () => {
  const comparedKeys = {'obj0002.label-overlap': 'c', 'obj0002.slife-criteria': 'b', 'obj0002.slife-characteristics': 'd',
    'obj0002.ltel-access': 'a', 'obj0002.profile-planning': 'c', 'obj0002.privacy-support': 'b', 'obj0002.learning-expectations': 'd',
    'obj0003.culture-inquiry': 'a', 'obj0003.language-resources': 'b', 'obj0003.family-participation': 'd',
    'obj0003.competent-interpretation': 'a', 'obj0003.preference-status': 'c'};
  for (const [suffix, key] of Object.entries(comparedKeys)) assert.deepEqual(checks.find(t => t.id === `task.${suffix}`).answerKey.accepted, [key]);
  for (const task of checks) {
    assert.equal(task.noveltyKind, 'familiar');
    assert.equal(task.options.length, 4);
    assert.equal(task.answerKey.accepted.length, 1);
    assert.ok(task.options.some(o => o.id === task.answerKey.accepted[0]));
    const wrong = task.options.filter(o => !task.answerKey.accepted.includes(o.id));
    assert.deepEqual(Object.keys(task.answerKey.wrongFeedback).sort(), wrong.map(o => o.id).sort());
    const explanations = [task.answerKey.feedback, ...Object.values(task.answerKey.wrongFeedback)];
    assert.equal(new Set(explanations).size, 4, task.id);
    for (const explanation of explanations) {
      assert.ok(explanation.length > 70, task.id);
      assert.ok(task.sourceRefs.some(id => explanation.includes(id)), `${task.id}: source-specific feedback`);
    }
  }
});

test('primary criteria, dated terminology and non-assumptive feedback retain the packet distinctions', () => {
  const source = n => packet.sources.find(s => s.id === `source.obj0002-0003.s${n}.2026-11-08`);
  const excerpt = (n, id) => source(n).supportingExcerpts.find(e => e.id === id).text;
  const task = suffix => checks.find(t => t.id === `task.${suffix}`);
  assert.deepEqual(source(1).supportingExcerpts, baseline.statements.filter(s => /^mtel56\.obj\.000[23]\./.test(s.id)).map(s => ({id: s.id, text: s.text})));
  assert.equal(source(4).documentVersion, 'June 2024');
  assert.equal(excerpt(4, 'exhibit-1-all'), 'To be identified as SLIFE in Massachusetts, a student must meet all the following criteria:');
  assert.equal(excerpt(4, 'exhibit-1-el'), 'The DOE025 SIMS field indicates the student is an English learner.');
  assert.equal(excerpt(4, 'exhibit-1-age'), 'The student is 8 to 21 years old.');
  assert.equal(excerpt(4, 'exhibit-1-enrollment'), 'The student enrolled in a school in the United States after grade 2 or exited the U.S. for 6 months or more and did not attend school during this time.');
  assert.equal(excerpt(4, 'exhibit-1-schooling'), 'Prior exposure to formal schooling is characterized by one of the following: No formal schooling; Significant interruptions in formal schooling; Consistent but limited formal schooling (e.g., school days were significantly shorter)');
  assert.match(excerpt(4, 'holistic-support'), /holistic approach.*significant support beyond/);
  assert.match(task('obj0002.slife-criteria').answerKey.wrongFeedback.c, /Exhibit 2 MAY characteristics, not as a required Exhibit 1/);
  assert.match(task('obj0002.slife-characteristics').answerKey.feedback, /Exhibit 2 uses MAY; Exhibit 1 supplies the required conditions/);
  assert.equal(source(8).documentVersion, 'June 2023');
  assert.match(excerpt(8, 'publisher-definition'), /^For the purposes of this toolkit,.*last three years/);
  assert.match(source(9).documentVersion, /November 2024/);
  assert.equal(source(10).documentVersion, 'February 2, 2026');
  assert.match(task('obj0002.ltel-access').answerKey.feedback, /not defined in ESEA/);
  assert.match(task('obj0002.ltel-access').answerKey.feedback, /no standardized criteria/);
  assert.match(task('obj0002.privacy-support').answerKey.feedback, /neither diagnoses trauma nor rules needs out/);
  assert.match(task('obj0002.learning-expectations').answerKey.feedback, /does not justify assigning a fixed learning style from nationality/);
  assert.equal(source(7).documentVersion, 'August 2018');
  assert.equal(excerpt(6, 'joint-guidance-competence'), 'schools must provide translation or interpretation from appropriate and competent individuals and may not rely on or ask students, siblings, friends, or untrained school staff to translate or interpret for parents');
  assert.match(excerpt(6, 'bilingual-not-qualification'), /does not necessarily produce the skills or knowledge/);
});

test('assisted staged instruction is substantial and creates no seeded learning records', () => {
  for (const lesson of module.lessons) {
    assert.match(lesson.body, /unofficial/i);
    assert.match(lesson.body, /content goal/i);
    assert.match(lesson.body, /language goal/i);
    assert.ok((lesson.body.match(/WORKED EXAMPLE/g) ?? []).length >= 2, lesson.id);
    assert.ok((lesson.body.match(/GUIDED/g) ?? []).length >= 2, lesson.id);
    assert.match(lesson.body, /assisted/i);
    assert.match(lesson.body, /creates? no attempts? or (?:independent )?(?:evidence|successes)/i);
    assert.ok(lesson.body.length > 4000, lesson.id);
  }
  for (const key of ['attempts', 'judgments', 'evidenceEvents', 'drafts']) assert.equal(catalog[key], undefined);
  assert.deepEqual(catalog.tasks.filter(t => t.kind === 'writing'), baseline.tasks.filter(t => t.kind === 'writing'));
});

test('the original eight statements have narrow explicit v3 scopes and remaining gaps', () => {
  assert.equal(COVERAGE_CONTRACT_VERSION, 3);
  const bindings = SOURCE_COVERAGE_CONTRACT.slice(baselineContract.length, baselineContract.length + 14);
  const originalStatements = baseline.statements.filter(s => /^mtel56\.obj\.000[23]\./.test(s.id));
  assert.equal(originalStatements.length, 8);
  assert.deepEqual([...new Set(bindings.map(b => b.statementId))].sort(), originalStatements.map(s => s.id).sort());
  assert.equal(bindings.length, 14);
  for (const binding of bindings) {
    const statement = originalStatements.find(s => s.id === binding.statementId);
    assert.equal(binding.statementVersion, statement.version);
    assert.equal(binding.sourceVersionId, statement.sourceVersionId);
    assert.ok(binding.scope.length > 40 && binding.remainingGap.length > 40);
    assert.equal(new Set(binding.tasks.map(t => t.taskId)).size, 1, 'One cognitive task per narrow claim');
    for (const ref of binding.lessons) {
      assert.equal(ref.fingerprint, fingerprint(module.lessons.find(l => l.id === ref.lessonId)));
    }
    for (const ref of binding.tasks) {
      assert.ok(module.tasks.some(t => t.id === ref.taskId && t.version === ref.taskVersion && t.skillIds.includes(ref.skillId)));
    }
  }
  for (const statement of originalStatements) assert.ok(bindings.some(b => b.statementId === statement.id && b.lessons.length > 0));
  for (const task of module.tasks) assert.ok(bindings.some(b => b.tasks.some(r => r.taskId === task.id)));
});

test('equivalent concepts retain prior exposure groups and unfamiliarity has no scoring key', () => {
  for (const [id, oldId] of [['task.obj0002.profile-planning', 'task.preserve-demand'], ['task.obj0003.preference-status', 'task.translation-preference']]) {
    assert.equal(module.tasks.find(t => t.id === id).familyId, baseline.tasks.find(t => t.id === oldId).familyId);
  }
  for (const task of cases) {
    assert.equal(task.noveltyKind, 'unfamiliar');
    assert.equal(task.answerKey, undefined);
    assert.match(task.prompt, /uncertain|uncertainty/i);
    assert.match(task.prompt, /justif/i);
    assert.match(task.prompt, /pending|provisional/i);
    assert.match(task.prompt, /keyword/i);
    assert.match(task.prompt, /synthetic/i);
  }
  assert.notEqual(cases[0].prompt, cases[1].prompt);
  assert.match(cases[0].prompt, /theater sound investigation/);
  assert.match(cases[0].prompt, /fair follow-up observation/);
  assert.match(cases[1].prompt, /media club/);
  assert.match(cases[1].prompt, /Compare the two launch plans/);
  assert.match(cases[0].prompt, /Do not infer a diagnosis/);
  assert.match(cases[1].prompt, /must not infer national learning styles, ability, trauma, immigration status, disability or EL status from family preferences or participation/);
});

test('portable recipe appends idempotently and rejects same-version conflicts or stale review before writing', () => {
  const workspace = realpathSync('.'), testRoot = realpathSync('tests');
  assert.ok(testRoot.startsWith(workspace + sep), 'Temporary fixture root must remain inside this repository');
  const dir = mkdtempSync(resolve(testRoot, '.authoring-check-'));
  try {
    const names = ['author-seed.ts', ...['obj0001', 'obj0002-0003', 'obj0004-0006', 'obj0007-0009'].flatMap(prefix => [`${prefix}-sources.json`, `${prefix}-module.json`, `${prefix}-review.json`])];
    for (const name of names) copyFileSync(resolve('content', name), resolve(dir, name));
    const path = resolve(dir, 'catalog.json');
    writeFileSync(path, JSON.stringify(baseline, null, 2) + '\n');
    const run = () => execFileSync(process.execPath, ['--experimental-strip-types', resolve(dir, 'author-seed.ts')], {cwd: dir, stdio: 'pipe'});
    run();
    const installed = readFileSync(path);
    assert.deepEqual(JSON.parse(installed.toString('utf8')), catalog);
    run();
    assert.deepEqual(readFileSync(path), installed, 'Second recipe run must be byte-idempotent');
    for (const [kind, id] of [['tasks', checks[0].id], ['sources', packet.sources[0].id], ['lessons', module.lessons[0].id], ['reviewEvents', reviews[0].id]]) {
      const conflicting = structuredClone(catalog);
      conflicting[kind].find(row => row.id === id).unexpectedConflict = true;
      const bytes = JSON.stringify(conflicting);
      writeFileSync(path, bytes);
      assert.throws(run, /Immutable catalog conflict/);
      assert.equal(readFileSync(path, 'utf8'), bytes, `${kind}: rejection must not partially write`);
    }
    writeFileSync(path, installed);
    const unreviewed = structuredClone(module);
    unreviewed.tasks[0].prompt += ' Unreviewed mutation.';
    writeFileSync(resolve(dir, 'obj0002-0003-module.json'), JSON.stringify(unreviewed));
    assert.throws(run, /Missing or stale model comparison/);
    assert.deepEqual(readFileSync(path), installed, 'Stale review rejection must not write');
  } finally {
    const cleanup = realpathSync(dir);
    assert.ok(cleanup.startsWith(testRoot + sep), 'Cleanup must remain inside the repository tests directory');
    rmSync(cleanup, {recursive: true, force: true});
  }
});
