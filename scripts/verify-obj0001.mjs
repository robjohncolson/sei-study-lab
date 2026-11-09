// Read-only, offline structural checks. These do not replace Zod, Vitest or browsers.
// Run: node --experimental-strip-types scripts/verify-obj0001.mjs
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {COVERAGE_CONTRACT_VERSION, SOURCE_COVERAGE_CONTRACT} from '../packages/shared/src/coverage-contract.ts';
import {readBaselineCatalog} from '../tests/catalog-baseline.ts';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const catalog = read('content/catalog.json');
const base = readBaselineCatalog();
const packet = read('content/obj0001-sources.json');
const module = read('content/obj0001-module.json');
const reviews = read('content/obj0001-review.json').reviewEvents;
const canonical = value => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const checks = module.tasks.filter(t => ['mc', 'short'].includes(t.kind));

test('all installed records and exact official inventories survive unchanged', () => {
  for (const [key, value] of Object.entries(base)) {
    if (!Array.isArray(value)) { assert.deepEqual(catalog[key], value); continue; }
    assert.deepEqual(catalog[key].slice(0, value.length), value, key);
  }
  for (const key of ['objectives', 'statements', 'competencies', 'indicators', 'skills', 'alignments', 'prerequisites', 'cards', 'mentorTexts', 'rubrics']) {
    assert.deepEqual(catalog[key], base[key], key);
  }
  assert.equal(catalog.objectives.length, 13);
  assert.equal(catalog.statements.length, 60);
  assert.equal(catalog.statements.filter(s => s.id.includes('.ds.')).length, 59);
  assert.equal(catalog.competencies.length, 11);
  assert.equal(catalog.indicators.length, 5);
});

test('the reviewed slice is exactly additive and contains seven checks plus one open case', () => {
  for (const [key, rows] of Object.entries({...module, sources: packet.sources, reviewEvents: reviews})) {
    assert.deepEqual(catalog[key].slice(base[key].length), rows, key);
  }
  assert.equal(module.lessons.length, 1);
  assert.equal(checks.length, 7);
  assert.equal(new Set(checks.map(t => t.familyId)).size, 7);
  assert.equal(checks.filter(t => t.kind === 'mc').length, 6);
  const cases = module.tasks.filter(t => t.kind === 'case');
  assert.equal(cases.length, 1);
  assert.equal(cases[0].noveltyKind, 'unfamiliar');
  assert.equal(cases[0].answerKey, undefined);
  assert.match(cases[0].prompt, /history\/civics/);
  assert.match(cases[0].prompt, /pending review/);
  assert.ok(module.tasks.every(t => t.lessonId === module.lessons[0].id && t.reviewState === 'source_checked'));
});

test('all compared payloads match recorded MODEL review hashes', () => {
  assert.equal(reviews.length, 18);
  for (const row of [...packet.sources, ...module.lessons, ...module.tasks]) {
    const review = reviews.find(e => e.entityId === row.id);
    assert.equal(review?.reviewerKind, 'model', row.id);
    assert.equal(review.payloadSha256, createHash('sha256').update(canonical(row)).digest('hex'), row.id);
    assert.match(review.checks.join(' '), /not human review/);
    assert.match(review.reviewerLabel, /separate wording-to-supplied-packet/);
  }
  assert.equal(catalog.tasks.filter(t => t.reviewState === 'human_reviewed').length, 0);
});

test('source snapshots preserve supplied dates, versions, excerpts and binary hashes', () => {
  const hashes = [null, null, null, null,
    '6720f402f61ab4cb158eebbede7cfa5e9354edda2ddb1da46a6deddfe7403854',
    'fbfdadd7d8c8ae2c684aae27d17e8204b34760a0dcb3e5339f3777f3d421cbbd',
    '127e17d03df6ef48c7a8ed691f4a1596dcb8183942e86bfb423bd6ed8842ef95',
    '3ef15cc97628b3b9c33e23632c4239b687014d14232170955ab5a2ce7096cc98',
    'e5ee4b9dcb28aad2cab8261d5bbb72ad7a9493fdb3e91225f8ee8c1abc0751ee'];
  assert.equal(packet.sources.length, 9);
  packet.sources.forEach((s, i) => {
    assert.equal(s.id, `source.obj0001.s${i + 1}.2026-11-08`);
    assert.equal(s.retrievedAt, '2026-11-08');
    assert.equal(s.retrievalTimezone, 'America/New_York');
    assert.equal(s.sha256, hashes[i]);
    assert.equal(s.reviewState, 'source_compared');
    assert.equal(s.excerpt, s.supportingExcerpts.map(e => e.text).join('\n\n'));
    assert.match(s.provenance, /Codex did not fetch/);
    assert.ok(s.derivedClaimRationale && s.documentVersion && s.version);
  });
  assert.equal(packet.sources[4].documentVersion, 'June 2025');
  assert.equal(packet.sources[6].documentVersion, 'January 2026');
  assert.match(packet.sources[8].documentVersion, /February 2019/);
});

test('finite keys and all distractor rationales retain the reviewed distinctions', () => {
  const keys = {'evidence-chain': 'c', 'family-access': 'a', 'shared-services': 'b', 'notice-record': 'd', 'fel-support': 'c', 'language-disability': 'a'};
  for (const [suffix, correct] of Object.entries(keys)) {
    const t = checks.find(t => t.id === `task.obj0001.${suffix}`);
    assert.deepEqual(t.answerKey.accepted, [correct]);
    assert.equal(t.options.length, 4);
    const wrong = t.options.filter(o => o.id !== correct).map(o => o.id);
    assert.deepEqual(Object.keys(t.answerKey.wrongFeedback).sort(), wrong.sort());
    for (const explanation of [t.answerKey.feedback, ...Object.values(t.answerKey.wrongFeedback)]) {
      assert.ok(t.sourceRefs.some(ref => explanation.includes(ref)), t.id);
    }
  }
  assert.deepEqual(checks.find(t => t.kind === 'short').answerKey.accepted, ['EL', 'English learner', 'an English learner']);
});

test('equivalent older starter tasks retain their exact exposure families', () => {
  for (const [suffix, oldId] of [['evidence-chain', 'survey-purpose'], ['family-access', 'translation-preference'], ['shared-services', 'shared-plan'], ['fel-support', 'former-support']]) {
    assert.equal(checks.find(t => t.id === `task.obj0001.${suffix}`).familyId, base.tasks.find(t => t.id === `task.${oldId}`).familyId);
  }
});

test('coverage v2 explicitly binds the new module with valid lesson fingerprints', () => {
  assert.equal(COVERAGE_CONTRACT_VERSION, 2);
  assert.equal(SOURCE_COVERAGE_CONTRACT.length, 11);
  assert.equal(new Set(SOURCE_COVERAGE_CONTRACT.map(b => b.statementId)).size, 9);
  assert.ok(SOURCE_COVERAGE_CONTRACT.every(b => b.remainingGap.length > 0));
  assert.equal(SOURCE_COVERAGE_CONTRACT.some(b => b.statementId === 'mtel56.obj.0001.ds.02'), false);
  for (const b of SOURCE_COVERAGE_CONTRACT) {
    for (const ref of b.lessons) {
      const l = catalog.lessons.find(l => l.id === ref.lessonId);
      const text = JSON.stringify([l.title, l.body, [...l.skillIds].sort(), [...l.sourceRefs].sort()]);
      let hash = 2166136261;
      for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
      assert.equal((hash >>> 0).toString(16).padStart(8, '0'), ref.fingerprint, l.id);
    }
    for (const ref of b.tasks) {
      assert.ok(catalog.tasks.some(t => t.id === ref.taskId && t.version === ref.taskVersion && t.skillIds.includes(ref.skillId)), ref.taskId);
    }
  }
  for (const t of module.tasks) assert.ok(SOURCE_COVERAGE_CONTRACT.some(b => b.tasks.some(r => r.taskId === t.id)));
  for (const id of ['mtel56.obj.0001.ds.01', 'mtel56.obj.0001.ds.03']) {
    assert.ok(SOURCE_COVERAGE_CONTRACT.some(b => b.statementId === id && b.lessons.some(l => l.lessonId === module.lessons[0].id)));
  }
});

test('source-only instruction is bounded and contains no seeded learner evidence', () => {
  const body = module.lessons[0].body;
  assert.equal((body.match(/WORKED EXAMPLE/g) ?? []).length, 2);
  assert.equal((body.match(/GUIDED PAUSE/g) ?? []).length, 3);
  assert.match(body, /ASSISTED; NOT AN INDEPENDENT ATTEMPT/);
  assert.match(body, /January 2026/);
  assert.match(body, /2026-11-08/);
  assert.match(body, /February 2019/);
  assert.doesNotMatch(JSON.stringify(module), /(?:within|no later than)\s+(?:10|20|30|ten|twenty|thirty)\s+(?:school\s+)?days/i);
  for (const key of ['attempts', 'judgments', 'evidenceEvents', 'drafts']) assert.equal(catalog[key], undefined);
  for (const row of [...catalog.lessons, ...catalog.tasks]) {
    assert.ok(row.sourceRefs.every(id => catalog.sources.some(s => s.id === id)), row.id);
    assert.ok(row.skillIds.every(id => catalog.skills.some(s => s.id === id)), row.id);
  }
});
