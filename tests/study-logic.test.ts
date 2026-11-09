import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CatalogSchema, type Catalog } from '../packages/shared/src/index.js';
import { SeiStore } from '../apps/server/src/store.js';
import { deriveStudyEvidence, lookupTask, prepareStudyAttempt, scoreStudyAttempt, shapeStudyDraft, shapeStudyState, StudyValidationError, validateStudyDraft } from '../apps/server/src/study-logic.js';
import type { Json } from '../apps/server/src/types.js';

const catalog = CatalogSchema.parse(JSON.parse(readFileSync('content/catalog.json', 'utf8')));
const mc = catalog.tasks.find(task => task.kind === 'mc')!;
const short = catalog.tasks.find(task => task.kind === 'short' && task.familyId === mc.familyId)!;
const writing = catalog.tasks.find(task => task.kind === 'writing')!;
const stores: SeiStore[] = [];
const open = () => { const store = new SeiStore(structuredClone(catalog), ':memory:'); stores.push(store); return store; };
afterEach(() => { vi.useRealTimers(); stores.splice(0).forEach(store => store.close()); });

describe('shared study logic and SQLite parity', () => {
  it('preserves answer scoring, assistance exclusions, exposure context and delayed retests', () => {
    vi.useFakeTimers();
    const store = open();
    const correct = mc.answerKey!.accepted[0];
    const incorrect = mc.options!.find(option => option.id !== correct)!.id;
    const sequence = [
      { at: '2026-01-01T12:00:00Z', task: mc, answer: incorrect, hintCount: 0, assistance: [], eligible: true, status: 'incorrect' },
      { at: '2026-01-01T12:01:00Z', task: mc, answer: correct, hintCount: 0, assistance: [], eligible: false, status: 'correct' },
      { at: '2026-01-01T12:02:00Z', task: short, answer: short.answerKey!.accepted[0], hintCount: 0, assistance: [], eligible: false, status: 'correct' },
      { at: '2026-01-03T12:00:00Z', task: mc, answer: correct, hintCount: 1, assistance: [], eligible: false, status: 'correct' },
      { at: '2026-01-05T12:00:00Z', task: mc, answer: correct, hintCount: 0, assistance: ['worked example'], eligible: false, status: 'correct' },
      { at: '2026-01-07T12:00:00Z', task: mc, answer: correct, hintCount: 0, assistance: [], eligible: true, status: 'correct' },
      { at: '2026-01-09T12:00:00Z', task: short, answer: 'a different explanation', hintCount: 0, assistance: [], eligible: false, status: 'needs_review' },
    ];
    for (const item of sequence) {
      vi.setSystemTime(item.at);
      const before = store.state();
      const body = { taskId: item.task.id, taskVersion: item.task.version, answer: item.answer, hintCount: item.hintCount, assistance: item.assistance };
      const result = store.submit(body, 'server-owned-session');
      const attempt = prepareStudyAttempt(body, result.attempt.sessionId,
        { catalog, taskVersions: before.taskVersions, attempts: before.attempts }, result.attempt.submittedAt, result.attempt.id);
      const judgment = scoreStudyAttempt(item.task, attempt, catalog.sources, result.judgment.id);
      const evidenceEvents = deriveStudyEvidence(item.task, attempt, judgment, before.attempts, result.evidenceEvents.map(event => event.id));
      expect({ attempt, judgment, evidenceEvents }).toEqual(result);
      expect(judgment.result.status).toBe(item.status);
      expect(evidenceEvents.every(event => event.eligible === item.eligible)).toBe(true);
      expect(evidenceEvents[0].eligibilityPolicyVersion).toBe(2);
      expect(evidenceEvents[0].eligibilityContextAttemptIds).toEqual(before.attempts.map(prior => prior.id).sort());
      // Session labels are descriptive only; changing one cannot create independent evidence.
      expect(deriveStudyEvidence(item.task, { ...attempt, sessionId: 'client-picked' }, judgment, before.attempts,
        result.evidenceEvents.map(event => event.id))).toEqual(evidenceEvents);
    }
  });

  it('retains exact writing identity and all five parts without promoting human review', () => {
    const store = open();
    const mentor = catalog.mentorTexts.find(item => item.id === writing.mentorTextId)!;
    const answer = { mentorTextId: mentor.id, mentorTextVersion: mentor.version, mentorTextHash: mentor.sha256,
      rubricVersionId: writing.rubricVersionId!, parts: Object.fromEntries(writing.parts!.map(part => [part.id, `Original ${part.id} prose`])) };
    const body = { taskId: writing.id, taskVersion: writing.version, answer, hintCount: 0 };
    const result = store.submit(body, 'writing-session');
    expect(result.attempt.originalAnswer).toEqual(answer);
    expect(result.judgment.result).toMatchObject({ status: 'needs_review', provisional: true });
    expect(result.evidenceEvents.every(event => !event.eligible && event.evidenceKind === 'pending')).toBe(true);
    const snapshot = { catalog, taskVersions: catalog.tasks, attempts: [] };
    const invalid = [
      { answer: { ...answer, mentorTextHash: 'other-text' }, message: 'exact mentor text identity' },
      { answer: { ...answer, parts: {} }, message: 'five derived parts' },
      { answer: { ...answer, rubricVersionId: 'other-rubric' }, message: 'rubric version mismatch' },
    ];
    for (const item of invalid) {
      expect(() => store.submit({ ...body, answer: item.answer }, 'writing-session')).toThrow(item.message);
      expect(() => prepareStudyAttempt({ ...body, answer: item.answer }, 'writing-session', snapshot,
        new Date().toISOString(), randomUUID())).toThrow(StudyValidationError);
    }
    expect(store.state().attempts).toHaveLength(1);
  });

  it('preserves draft/state shape and archived task lookup without treating drafts as attempts', () => {
    const store = open();
    const answer: Json = { response: 'Preserve the original draft', hintCount: 1 };
    const saved = store.saveDraft(mc.id, mc.version, answer);
    const row = { taskVersion: String(mc.version), answer, updatedAt: saved.updatedAt };
    expect(store.draft(mc.id)).toEqual(shapeStudyDraft(mc, [row]));
    expect(validateStudyDraft(catalog, mc.id, mc.version, answer)).toEqual(mc);
    const state = store.state();
    expect(JSON.parse(JSON.stringify(state))).toEqual(shapeStudyState({ attempts: [], judgments: [], evidenceEvents: [],
      taskVersions: catalog.tasks, drafts: [{ taskId: mc.id, ...row }] }));
    const newer: Catalog = { ...catalog, tasks: catalog.tasks.map(task => task.id === mc.id ? { ...task, version: 2, prompt: 'New prompt' } : task) };
    expect(lookupTask(newer, catalog.tasks, mc.id, 1)).toEqual(mc);
    expect(lookupTask(newer, catalog.tasks, mc.id).version).toBe(2);
    expect(shapeStudyDraft(newer.tasks.find(task => task.id === mc.id)!, [row])).toMatchObject({ answer: null,
      taskVersion: '2', currentTaskVersion: '2', olderDrafts: [row] });
    expect(() => validateStudyDraft(newer, mc.id, 1, answer)).toThrow('Draft task version changed');
    expect(() => store.saveDraft(mc.id, 'missing', answer)).toThrow('Draft task version changed');
  });

  it('keeps historical policy v1 import verification and rejects invalid submission references', () => {
    const store = open();
    const body = { taskId: mc.id, taskVersion: mc.version, answer: mc.answerKey!.accepted[0], hintCount: 1 };
    const result = store.submit(body, 'session');
    const expected = store.deriveEvidence(result.attempt, result.judgment, [], 1);
    expect(deriveStudyEvidence(mc, result.attempt, result.judgment, [], expected.map(event => event.id), 1)).toEqual(expected);
    expect(expected[0]).not.toHaveProperty('eligibilityPolicyVersion');
    expect(expected[0].exclusionReason).toBe('Hints or assistance recorded');
    const snapshot = { catalog, taskVersions: catalog.tasks, attempts: [] };
    const now = new Date().toISOString();
    for (const invalid of [{ ...body, parentAttemptId: randomUUID() }, { ...body, answer: 'not-an-option' },
      { ...body, startedAt: '9999-01-01T00:00:00.000Z' }, { ...body, taskVersion: 'missing' }]) {
      expect(() => prepareStudyAttempt(invalid, 'session', snapshot, now, randomUUID())).toThrow(StudyValidationError);
      expect(() => store.submit(invalid, 'session')).toThrow(StudyValidationError);
    }
    expect(store.state().attempts).toHaveLength(1);
  });
});
