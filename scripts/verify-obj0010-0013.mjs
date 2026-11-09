// Offline supplied-packet checks. No Git, dependencies, network or learner files.
// node --experimental-strip-types --test-reporter=tap scripts/verify-obj0010-0013.mjs
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {resolve, sep} from 'node:path';
import {test} from 'node:test';
import {COVERAGE_CONTRACT_VERSION, SOURCE_COVERAGE_CONTRACT} from '../packages/shared/src/coverage-contract.ts';
import {SOURCE_COVERAGE_CONTRACT as baselineContract} from '../tests/fixtures/coverage-contract-e4b8bab7d0e2b15b563f99b9e3c9827f3c67381e.ts';
import {parseObjectives1013Baseline, readObjectives1013Baseline, verifyObjectives1013ContractFixture} from '../tests/obj0010-0013-baseline.ts';

const read = name => JSON.parse(readFileSync(name, 'utf8'));
const catalog = read('content/catalog.json');
const baseline = readObjectives1013Baseline();
const module = read('content/obj0010-0013-module.json');
const packet = read('content/obj0010-0013-sources.json');
const reviewFile = read('content/obj0010-0013-review.json');
const reviews = reviewFile.reviewEvents;
const checks = module.tasks.filter(t => t.kind === 'mc');
const cases = module.tasks.filter(t => t.kind === 'case');
const writing = module.tasks.find(t => t.kind === 'writing');
const mentor = module.mentorTexts[0];
const bindings = SOURCE_COVERAGE_CONTRACT.slice(baselineContract.length);
const task = suffix => module.tasks.find(t => t.id === `task.${suffix}`);
const selected = item => item.options.find(o => item.answerKey.accepted.includes(o.id)).text;
const canonical = value => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const fingerprint = lesson => {
  const text = JSON.stringify([lesson.title, lesson.body, [...lesson.skillIds].sort(), [...lesson.sourceRefs].sort()]);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
};
const expectedSources = [
  ['S1', 'https://www.mtel.nesinc.com/Content/StudyGuide/MA_SG_OBJ_56.htm', '1e7192674b87161d80b9ef64b3d1af043c3a76679d615a4494b18aa264342ef2'],
  ['S2', 'https://www.mtel.nesinc.com/Content/StudyGuide/MA_SG_CRI_56.asp', '49de2c87e507644fe99c66234b81b3eba41400ab73bd0d3954309064ffe4c3fc'],
  ['S3', 'https://www.mtel.nesinc.com/content/Docs/MA_FLD056_PRACTICE_TEST.pdf', '314f4a449a7eebd0a6f2f80c5f7a9cdcf27e3b17e522cd858ecaa444dcaf1b73'],
  ['S4', 'https://www.mtel.nesinc.com/content/Docs/MA_FLD056_PT_appendix.pdf', 'b294e3704aff8e4b82679e271b0744cc11a5b5f7ae6535c6b4c413f380b63300'],
  ['S5', 'https://www.mtel.nesinc.com/TestView.aspx?f=HTML_FRAG/MA056_TestPage.html', 'c378d7ea840b4f8bade63fc547bbd04e43275add7fc2f9f27ed1ec97401dfbc2'],
  ['S7', 'https://www.doe.mass.edu/lawsregs/603cmr7.html?section=14', 'f45d76f981075d90ceaffe28ad2001eca73eea427c548891f341cd68485fbdfa'],
  ['S8', 'https://www.doe.mass.edu/lawsregs/603cmr7.html?section=08', 'aaac41c2524f742e40b777a3b325adf1d0645d208a2d7482fb98451e274db797'],
  ['S9', 'https://wida.wisc.edu/sites/default/files/resource/WIDA-ELD-Standards-Framework-2020.pdf', '0d92701e7cc5015fb1b98619561f2b22e5b813ddc476c0b799bfc94534b9fba7'],
  ['S10', 'https://wida.wisc.edu/sites/default/files/resource/Guiding-Principles-of-Language-Development.pdf', 'c53f8e011cfe2928dd9f34fba598f167ae9878947027d199bf25c6d49761b11e'],
  ['S11', 'https://ies.ed.gov/ncee/wwc/Docs/PracticeGuide/english_learners_pg_040114.pdf', '6f39b0f96514344b3773b21ff6f53b7cc2503407ce0e325d7525463115893596'],
  ['S12', 'https://ies.ed.gov/ncee/wwc/Docs/PracticeGuide/adlit_pg_082608.pdf', '893db948fe7bf4add870a2729da1cfb41c738de4b232e28da6cf116962a16bc0'],
  ['S13', 'https://www.doe.mass.edu/ele/guidance/sei/sei.docx', '99df99b285a23eafc727bb3eed13839f4489e6525216eb7a74eb568f756e584a'],
];

test('e4b8bab fixtures preserve every earlier entity byte, order and coverage scope', () => {
  verifyObjectives1013ContractFixture();
  const bytes = readFileSync(new URL('../tests/fixtures/catalog-e4b8bab7d0e2b15b563f99b9e3c9827f3c67381e.json', import.meta.url));
  assert.deepEqual(bytes, Buffer.from(JSON.stringify(baseline, null, 2) + '\n'));
  assert.deepEqual(readFileSync('content/catalog.json'), Buffer.from(JSON.stringify(catalog, null, 2) + '\n'));
  for (const changed of [Buffer.concat([bytes, Buffer.from('\n')]), Buffer.from(JSON.stringify(baseline)), Buffer.from('{')]) {
    assert.throws(() => parseObjectives1013Baseline(changed), /integrity/);
  }
  const additions = {...module, sources: packet.sources, reviewEvents: reviews};
  for (const [key, rows] of Object.entries(baseline)) {
    assert.equal(JSON.stringify(Array.isArray(rows) ? catalog[key].slice(0, rows.length) : catalog[key]), JSON.stringify(rows), key);
    if (key in additions) {
      assert.deepEqual(catalog[key].slice(rows.length), additions[key], key);
      assert.equal(catalog[key].length, rows.length + additions[key].length, key);
    } else assert.deepEqual(catalog[key], rows, key);
  }
  assert.deepEqual(catalog.tasks.filter(t => baseline.tasks.some(old => old.kind === 'writing' && old.id === t.id)), baseline.tasks.filter(t => t.kind === 'writing'));
  assert.deepEqual(SOURCE_COVERAGE_CONTRACT.slice(0, baselineContract.length), baselineContract);
  assert.equal(COVERAGE_CONTRACT_VERSION, 3);
});

test('four scaffolded lessons, fourteen decisions, three cases, eight cards and one mentor seed no evidence', () => {
  assert.deepEqual(module.lessons.map(l => l.id), [
    'lesson.obj0010.reading-diagnosis.v1', 'lesson.obj0011.writing-process.v1',
    'lesson.obj0012.content-language.v1', 'lesson.obj0013.integrated-analysis.v1',
  ]);
  assert.equal(checks.length, 14);
  assert.equal(cases.length, 3);
  assert.equal(module.tasks.length, 18);
  assert.equal(module.cards.length, 8);
  assert.equal(module.mentorTexts.length, 1);
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
  const sourceIds = packet.packetBindings.map(b => b.sourceId);
  for (const row of [...module.lessons, ...module.tasks]) {
    assert.ok(row.sourceRefs.length && row.sourceRefs.every(id => sourceIds.includes(id)));
    assert.ok(row.skillIds.length && row.skillIds.every(id => baseline.skills.some(s => s.id === id)));
  }
  for (const item of module.tasks) {
    assert.equal(item.reviewState, 'source_checked');
    assert.ok(module.lessons.some(l => l.id === item.lessonId));
  }
  for (const key of ['attempts', 'judgments', 'evidenceEvents', 'drafts', 'rubrics']) assert.equal(key in module, false);
});

test('source snapshots retain exact supplied URL and full hash identity with honest provenance', () => {
  assert.deepEqual(packet.packetBindings.map(b => b.packetSource), expectedSources.map(([label]) => label));
  for (const [label, url, hash] of expectedSources) {
    const b = packet.packetBindings.find(b => b.packetSource === label);
    const s = catalog.sources.find(s => s.id === b?.sourceId);
    assert.ok(s && b, label);
    assert.equal(s.url, url);
    assert.equal(s.sha256, hash);
    assert.equal(b.url, url);
    assert.equal(b.sha256, hash);
    assert.equal(b.retrievedAt, '2026-11-08');
    assert.equal(b.retrievalTimezone, 'America/New_York');
    assert.match(b.provenance, /supplied/i);
    const identical = baseline.sources.find(old => old.url === url && old.sha256 === hash);
    if (identical) assert.deepEqual(s, identical, `${label}: reuse exact existing snapshot`);
    else assert.ok(packet.sources.some(added => added.id === s.id));
  }
  assert.equal(packet.sources.length, expectedSources.filter(([, url, hash]) => !baseline.sources.some(s => s.url === url && s.sha256 === hash)).length);
  for (const s of packet.sources) {
    assert.equal(s.retrievedAt, '2026-11-08');
    assert.equal(s.retrievalTimezone, 'America/New_York');
    assert.equal(s.reviewState, 'source_compared');
    assert.match(s.provenance, /supplied/i);
    assert.match(s.provenance, /did not (?:fetch|retrieve)/i);
    assert.ok(!baseline.sources.some(old => old.id === s.id));
  }
  for (const name of ['module', 'sources', 'review']) assert.doesNotMatch(readFileSync(`content/obj0010-0013-${name}.json`, 'utf8'), /\uFFFD|Ã¢â‚¬|ÃƒÂ©/, name);
});

test('model comparisons bind final sources, lessons, tasks, cards and mentor without claiming human review', () => {
  const groups = {source: packet.sources, lesson: module.lessons, task: module.tasks, card: module.cards, mentorText: module.mentorTexts};
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

test('fourteen distinct synthetic decision families give source-specific reasons for every distractor', () => {
  // Pinned after a separate model comparison of every stem, key and distractor to the supplied packet.
  const keys = {
    'obj0010.decoding-language': 'b', 'obj0012.language-concept': 'd', 'obj0010.l1-transfer': 'a',
    'obj0010.initial-literacy': 'c', 'obj0010.genre-structure': 'b', 'obj0010.chunk-access': 'd',
    'obj0011.feedback-revision': 'a', 'obj0012.dual-evidence': 'c', 'obj0011.oral-entry': 'b',
    'obj0013.same-mentor': 'd', 'obj0013.holistic-feedback': 'a', 'obj0013.public-sample': 'c',
    'obj0013.endorsement-pathway': 'b', 'obj0011.writing-evidence': 'd',
  };
  assert.deepEqual(checks.map(t => t.id).sort(), Object.keys(keys).map(id => `task.${id}`).sort());
  for (const [suffix, key] of Object.entries(keys)) assert.deepEqual(task(suffix).answerKey.accepted, [key], suffix);
  assert.equal(new Set(checks.map(t => t.familyId)).size, 14);
  for (const item of checks) {
    assert.equal(item.options.length, 4);
    assert.equal(new Set(item.options.map(o => o.id)).size, 4);
    assert.equal(item.answerKey.accepted.length, 1);
    assert.equal(item.noveltyKind, 'familiar');
    assert.match(item.prompt, /synthetic|original/i);
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

test('unfamiliar non-math cases have no keyword keys and explicitly require manual review', () => {
  assert.deepEqual(cases.map(t => t.id), ['task.obj0010.harbor-reading-case', 'task.obj0011.museum-label-case', 'task.obj0012.wetland-content-case']);
  assert.equal(new Set(cases.map(t => t.familyId)).size, 3);
  for (const item of cases) {
    assert.equal(item.noveltyKind, 'unfamiliar');
    assert.equal(item.answerKey ?? null, null);
    assert.equal(item.options, undefined);
    assert.match(item.prompt, /synthetic|original/i);
    assert.match(item.prompt, /manual|human review/i);
    assert.match(item.prompt, /provisional|needs_review/i);
    assert.match(item.prompt, /evidence|quote/i);
  }
});

test('one original non-math mentor binds five same-text parts to the unchanged official holistic rubric', () => {
  assert.equal(module.tasks.filter(t => t.kind === 'writing').length, 1);
  assert.equal(writing.id, 'task.writing.mentor.community-archive');
  assert.equal(mentor.id, 'mentor.obj0013.community-archive');
  assert.deepEqual(Object.keys(mentor).sort(), ['id', 'version', 'title', 'discipline', 'originKind', 'text', 'sha256'].sort());
  assert.equal(mentor.originKind, 'authored_practice');
  assert.doesNotMatch(mentor.discipline, /math/i);
  assert.ok(mentor.text.length > 900);
  assert.equal(mentor.sha256, createHash('sha256').update(mentor.text).digest('hex'));
  assert.equal(writing.mentorTextId, mentor.id);
  assert.equal(writing.mentorTextVersion, mentor.version);
  assert.equal(writing.mentorTextSha256, mentor.sha256);
  assert.equal(writing.rubricVersionId, 'rubric.mtel56.public@1');
  assert.equal(writing.answerKey ?? null, null);
  assert.equal(writing.parts.length, 5);
  assert.deepEqual(writing.parts.map(p => p.id), ['analysis', 'oracy', 'reading', 'writing', 'assessment']);
  assert.match(writing.prompt, /original.*unofficial|unofficial.*original/i);
  assert.match(writing.prompt, /(?:not an?|no) official MTEL|not official MTEL/i);
  assert.match(writing.prompt, /public.*Part I.*only|Part I.*only.*public/i);
  assert.match(writing.prompt, /same.*mentor/i);
  for (const part of writing.parts) {
    assert.match(part.prompt, /quot/i);
    assert.match(part.prompt, /same.*mentor/i);
  }
  for (const part of writing.parts.slice(1)) assert.match(part.title + ' ' + part.prompt, /original,? unofficial practice/i);
  const first = writing.parts[0].prompt;
  for (const required of [/cluster/i, /content objective/i, /Tier One/i, /Tier Two/i, /Tier Three/i, /sentence.level/i, /discourse.level/i,
    /three (?:observable )?language objectives/i, /oracy/i, /reading comprehension/i, /written discourse/i]) assert.match(first, required);
  assert.doesNotMatch(mentor.text, /anemometer|wind vane/i);
});

test('official rubric remains verbatim and new content contains no numeric per-criterion scores', () => {
  assert.deepEqual(catalog.rubrics, baseline.rubrics);
  const rubric = catalog.rubrics.find(r => `${r.id}@${r.version}` === writing.rubricVersionId);
  assert.deepEqual(rubric.criteria.map(c => [c.title, c.text]), [
    ['Purpose', 'The extent to which the response achieves the purpose of the assignment.'],
    ['Subject Matter Knowledge', 'Accuracy and appropriateness in the application of subject matter knowledge.'],
    ['Support', 'Quality and relevance of supporting details.'],
    ['Rationale', 'Soundness of argument and degree of understanding of the subject matter.'],
  ]);
  assert.deepEqual(Object.keys(rubric.scale).sort(), ['1', '2', '3', '4', 'B', 'U']);
  const inspect = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (/score|weight|rating/i.test(key)) assert.notEqual(typeof child, 'number', key);
      inspect(child);
    }
  };
  for (const value of [module, packet, reviewFile]) inspect(value);
  assert.doesNotMatch(JSON.stringify([module, packet, reviewFile]), /(?:Purpose|Subject Matter Knowledge|Support|Rationale)\s*(?:score\s*)?(?:=|:)\s*\d/i);
  const text = module.lessons.at(-1).body + writing.prompt;
  assert.match(text, /U\/B|U and B|B and U/);
  assert.match(text, /before.*1.?4|gates first|gates.*before/i);
  assert.match(text, /holistic/i);
  assert.match(text, /provisional/i);
  assert.match(text, /criterion.*(?:comments|feedback)|(?:comments|feedback).*criterion/i);
});

test('instruction respects literacy, evidence, standards and endorsement limits without stereotyping', () => {
  const lessonText = module.lessons.map(l => l.body).join('\n');
  for (const pattern of [/decoding/i, /background knowledge/i, /first.language|\bL1\b/i, /not.*literate|initial literacy/i,
    /genre|text structure/i, /chunk/i, /grade.level/i, /reading.writing|reading and writing/i,
    /draft/i, /revis/i, /responsive feedback/i, /rhetoric/i, /Minimal/i, /2008/i, /not EL.specific/i,
    /WIDA/i, /Massachusetts/i, /authentic/i, /content understanding|content reasoning/i,
    /7\.14/, /7\.08/, /endorsements? .*not.*licenses?|do not constitute educator licenses/i]) assert.match(lessonText, pattern);
  assert.match(selected(task('obj0011.writing-evidence')), /Minimal/i);
  assert.match(selected(task('obj0013.public-sample')), /Part I/i);
  assert.match(selected(task('obj0013.same-mentor')), /same|retain/i);
  assert.match(selected(task('obj0013.holistic-feedback')), /holistic/i);
  assert.match(selected(task('obj0010.chunk-access')), /grade.level|original/i);
  const feedback = checks.flatMap(t => [t.answerKey.feedback, ...Object.values(t.answerKey.wrongFeedback)]).join('\n');
  for (const unsupported of [
    /therefore (?:the (?:student|learner) )?(?:has|must have) (?:low ability|a disability|trauma)/i,
    /(?:nationality|language background) (?:proves|determines|reveals) (?:ability|disability|trauma|personality|cultural traits)/i,
    /(?:all|every) (?:Spanish|Chinese|Arabic|Portuguese)[- ]speaking (?:students?|learners?) (?:are|have|prefer)/i,
    /(?:Entering|PL1|PL2) (?:means|proves|indicates) (?:low intelligence|low cognitive ability|a disability)/i,
  ]) assert.doesNotMatch(feedback, unsupported);
  assert.doesNotMatch(JSON.stringify(module), /\$166|effect size of \d|\b\d+ SIOP features/i);
});

test('two cards per objective retain native shape and exact source bindings', () => {
  for (const objective of ['0010', '0011', '0012', '0013']) assert.equal(module.cards.filter(c => c.tags.includes(`objective::${objective}`)).length, 2);
  for (const card of module.cards) {
    assert.deepEqual(Object.keys(card).sort(), ['back', 'front', 'id', 'source', 'tags']);
    assert.ok(card.front.length > 15 && card.back.length > 35);
    assert.ok(catalog.sources.some(s => s.id === card.source && s.excerpt.length > 20));
    assert.ok(card.tags.includes('version::1') && card.tags.includes('sei-study-lab'));
    const skillTag = card.tags.find(tag => tag.startsWith('skill::'));
    assert.ok(baseline.skills.some(s => s.id === `sei.skill.${skillTag?.slice(7)}`));
    assert.ok(reviews.find(r => r.entityId === card.id).comparedSourceIds.includes(card.source));
    assert.doesNotMatch(card.back, /\$\d|\b\d+ (?:hours?|minutes?)\b/i);
    if (/60.*multiple.choice|60.*MC/i.test(card.back)) assert.match(card.back, /2026-11-08/);
  }
});

test('bounded coverage preserves official wording, pins lesson fingerprints and leaves explicit gaps', () => {
  const official = baseline.statements.filter(s => /^mtel56\.obj\.001[0-3]\./.test(s.id));
  assert.equal(official.length, 18);
  assert.equal(bindings.length, 27);
  assert.deepEqual([...new Set(bindings.map(b => b.statementId))].sort(), official.map(s => s.id).sort());
  const expected = {
    '0010.ds.01': [],
    '0010.ds.02': ['obj0010.l1-transfer', 'obj0010.initial-literacy'],
    '0010.ds.03': ['obj0010.genre-structure'],
    '0010.ds.04': [],
    '0010.ds.05': ['obj0010.decoding-language', 'obj0010.chunk-access', 'obj0010.harbor-reading-case'],
    '0010.ds.06': [],
    '0011.ds.01': ['obj0011.oral-entry'],
    '0011.ds.02': ['obj0011.museum-label-case'],
    '0011.ds.03': [],
    '0011.ds.04': [],
    '0011.ds.05': ['obj0011.feedback-revision', 'obj0011.writing-evidence'],
    '0011.ds.06': ['obj0011.museum-label-case'],
    '0012.ds.01': [],
    '0012.ds.02': [],
    '0012.ds.03': ['obj0012.dual-evidence', 'obj0012.wetland-content-case'],
    '0012.ds.04': ['obj0012.language-concept'],
    '0012.ds.05': ['obj0012.wetland-content-case'],
    '0013.reference.0001-0012': ['obj0013.same-mentor', 'obj0013.holistic-feedback', 'obj0013.public-sample',
      'obj0013.endorsement-pathway', 'writing.mentor.community-archive'],
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
      if (item.kind !== 'writing') assert.ok(item.id.includes(b.statementId.slice(11, 15)), `${item.id}: different objective`);
    }
  }
  for (const item of module.tasks) assert.ok(bindings.some(b => b.tasks.some(t => t.taskId === item.id)), item.id);
  for (const item of checks) assert.equal(bindings.filter(b => b.tasks.some(t => t.taskId === item.id)).length, 1, item.id);
  const gaps = bindings.map(b => b.remainingGap).join('\n');
  assert.match(gaps, /Parts II|Parts 2|live parts/i);
  assert.match(gaps, /Standard 10|grade.band/i);
});

test('correlated existing decisions retain exposure families without inventing independence', () => {
  for (const [suffix, oldId] of [
    ['obj0012.language-concept', 'task.grammar-content'], ['obj0010.chunk-access', 'task.preserve-demand'],
    ['obj0012.dual-evidence', 'task.obj0007.dual-objectives'], ['obj0011.oral-entry', 'task.rehearsal-bridge'],
  ]) assert.equal(task(suffix).familyId, baseline.tasks.find(t => t.id === oldId).familyId, suffix);
});

test('append recipe preserves baseline, is idempotent and rejects mentor/task/review conflicts before writes', () => {
  const root = realpathSync('tests');
  const dir = mkdtempSync(resolve(root, '.authoring-1013-'));
  if (!realpathSync(dir).startsWith(root + sep)) throw new Error('Unsafe source-only cleanup target');
  try {
    const prefixes = ['obj0001', 'obj0002-0003', 'obj0004-0006', 'obj0007-0009', 'obj0010-0013'];
    const names = ['author-seed.ts', ...prefixes.flatMap(prefix => [`${prefix}-sources.json`, `${prefix}-module.json`, `${prefix}-review.json`])];
    for (const name of names) copyFileSync(resolve('content', name), resolve(dir, name));
    const path = resolve(dir, 'catalog.json');
    writeFileSync(path, JSON.stringify(baseline, null, 2) + '\n');
    const run = () => execFileSync(process.execPath, ['--experimental-strip-types', resolve(dir, 'author-seed.ts')], {cwd: dir, stdio: 'pipe'});
    run();
    const first = readFileSync(path);
    assert.deepEqual(JSON.parse(first.toString('utf8')), catalog);
    run();
    assert.deepEqual(readFileSync(path), first);
    for (const [kind, id] of [['tasks', checks[0].id], ['sources', packet.sources[0].id], ['cards', module.cards[0].id], ['lessons', module.lessons[0].id], ['mentorTexts', mentor.id], ['reviewEvents', reviews[0].id]]) {
      const conflict = structuredClone(catalog);
      conflict[kind].find(row => row.id === id).unexpectedConflict = true;
      const bytes = JSON.stringify(conflict);
      writeFileSync(path, bytes);
      assert.throws(run, /Immutable catalog conflict/);
      assert.equal(readFileSync(path, 'utf8'), bytes);
    }
    for (const [kind, field] of [['tasks', 'prompt'], ['cards', 'back'], ['lessons', 'body'], ['mentorTexts', 'text']]) {
      writeFileSync(path, first);
      const changed = structuredClone(module);
      changed[kind][0][field] += ' Unreviewed mutation.';
      writeFileSync(resolve(dir, 'obj0010-0013-module.json'), JSON.stringify(changed));
      assert.throws(run, /Missing or stale model comparison/);
      assert.deepEqual(readFileSync(path), first);
    }
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
