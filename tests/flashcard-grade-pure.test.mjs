// Dependency-free: node --experimental-strip-types --test tests/flashcard-grade-pure.test.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  exactRecallMatch, expectedRecallMs, formatElapsed, isBlankRecall,
  normalizeRecall, ratingFromCloseness, recallSpeed,
} from '../packages/shared/src/flashcard-grade.ts';
import { decodeFlashcardDraftFile, freshFlashcardDraft } from '../apps/web/src/native-flashcard-draft.ts';

test('normalized recall accepts harmless formatting but not missing terms or blanks', () => {
  assert.equal(normalizeRecall(' CAFE\u0301\n learning!?: '), 'café learning');
  assert.equal(exactRecallMatch(' CAFE\u0301\n learning! ', 'Café learning'), true);
  assert.equal(exactRecallMatch('Chapter 71', 'Chapter 71A'), false);
  assert.equal(exactRecallMatch('...', ' '), false);
  assert.equal(isBlankRecall(' \n!?;:'), true);
});

test('timing boundaries and assistance only lower recall ratings', () => {
  const back = 'one two three four five';
  assert.equal(expectedRecallMs(''), 6000);
  assert.equal(expectedRecallMs('word '.repeat(100)), 40000);
  assert.equal(expectedRecallMs(back), 8000);
  for (const [elapsedMs, speed] of [[6000, 'fast'], [6001, 'typical'], [16000, 'slow'], [-1, 'typical'], [NaN, 'typical']]) {
    assert.equal(recallSpeed(elapsedMs, back), speed);
  }
  const grade = (closeness, elapsedMs, assistance = [], hintCount = 0) => ratingFromCloseness({ closeness, elapsedMs, back, assistance, hintCount });
  assert.equal(grade('correct', 6000).rating, 4);
  assert.equal(grade('correct', 8000).rating, 3);
  assert.equal(grade('correct', 16000).rating, 2);
  assert.equal(grade('close', 0).rating, 2);
  for (const assistance of [['pasted_text'], ['consulted_materials'], ['study_hint']]) {
    assert.equal(grade('correct', 0, assistance).rating, 2);
    assert.equal(grade('correct', 8000, assistance).rating, 2);
    assert.equal(grade('incorrect', 0, assistance).rating, 1);
  }
  assert.equal(grade('correct', 0, [], 1).rating, 2);
  assert.equal(grade('empty', 0, [], 1).rating, 1);
});

test('elapsed time is readable and never negative', () => {
  assert.equal(formatElapsed(12400), '12.4 seconds');
  assert.equal(formatElapsed(65200), '1 min 05.2 s');
  assert.equal(formatElapsed(-1), '0.0 seconds');
  assert.equal(formatElapsed(NaN), '0.0 seconds');
});

test('version-1 draft recovery preserves checked recall and accepts old revealed drafts', () => {
  const now = '2026-11-09T12:00:00.000Z';
  const draft = freshFlashcardDraft({ card: { id: 'synthetic', front: 'Prompt', back: 'Target', source: 'Derived', tags: [] },
    cardFingerprint: 'a'.repeat(64), version: 1 }, 'draft', now);
  draft.response = '  Original\nrecall.  ';
  draft.revealedAt = '2026-11-09T12:00:12.000Z';
  const envelope = { schemaVersion: 1, active: draft, recovery: [] };
  assert.deepEqual(decodeFlashcardDraftFile(JSON.stringify(envelope)), envelope);
  for (const check of [
    { closeness: 'close', source: 'ai', explanation: 'You named part of the target.', suggestedRating: 2 },
    { fallback: true, reason: 'The check was interrupted. Choose a rating yourself.' },
  ]) {
    const checked = { ...envelope, active: { ...draft, check } };
    assert.deepEqual(decodeFlashcardDraftFile(JSON.stringify(checked)), checked);
  }
});

test('draft recovery rejects malformed check fields without accepting coerced values', () => {
  const draft = freshFlashcardDraft({ card: { id: 'synthetic', front: 'Prompt', back: 'Target', source: 'Derived', tags: [] },
    cardFingerprint: 'a'.repeat(64), version: 1 }, 'draft', '2026-11-09T12:00:00.000Z');
  draft.revealedAt = draft.startedAt;
  const valid = { closeness: 'correct', source: 'exact', explanation: null, suggestedRating: 4 };
  for (const check of [
    { ...valid, closeness: ['correct'] }, { ...valid, source: ['exact'] },
    { ...valid, suggestedRating: 5 }, { ...valid, extra: true },
    { fallback: true, reason: '' }, { fallback: true, reason: 'Unavailable', suggestedRating: 1 },
  ]) {
    assert.throws(() => decodeFlashcardDraftFile(JSON.stringify({ schemaVersion: 1, active: { ...draft, check }, recovery: [] })));
  }
});

test('browser source contains no provider settings, credential prefixes or provider URL', () => {
  const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(resolve(directory, entry.name)) : [resolve(directory, entry.name)]);
  for (const path of walk(fileURLToPath(new URL('../apps/web/src', import.meta.url)))) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), /DEEPSEEK|\bsk-|https?:\/\/(?:[^/]*\.)?deepseek\.[^\s'"<>]+/, path);
  }
});
