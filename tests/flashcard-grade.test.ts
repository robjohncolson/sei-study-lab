import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  exactRecallMatch, expectedRecallMs, FLASHCARD_AI_PRIVACY_NOTICE, formatElapsed,
  isBlankRecall, normalizeRecall, ratingFromCloseness, recallSpeed,
} from '../packages/shared/src/flashcard-grade.js';

describe('recall normalization and exact matching', () => {
  it('normalizes case, all whitespace, NFC and trailing sentence punctuation only', () => {
    expect(normalizeRecall(' \tCAFÉ\n  Learning\u00a0Works.!?;:\r\n')).toBe('café learning works');
    expect(normalizeRecall('Cafe\u0301')).toBe('café');
    expect(normalizeRecall('A.B? C,D-')).toBe('a.b? c,d-');
    expect(normalizeRecall('A. B...')).toBe('a. b');
  });
  it('requires nonempty normalized equality', () => {
    expect(exactRecallMatch('  CAFE\u0301\n LEARNING! ', 'Café learning.')).toBe(true);
    expect(exactRecallMatch('Chapter 71', 'Chapter 71A')).toBe(false);
    expect(exactRecallMatch('', '')).toBe(false);
    expect(exactRecallMatch('!?', ':')).toBe(false);
  });
  it.each(['', ' \t\r\n\u00a0', '...!?;:'])('detects a blank normalized response %j', response => {
    expect(isBlankRecall(response)).toBe(true);
  });
  it('retains nonblank punctuation and words', () => {
    expect(isBlankRecall('hello')).toBe(false);
    expect(isBlankRecall(',')).toBe(false);
  });
});

describe('length-based timing and scheduling rating', () => {
  const back = 'one two three four five'; // 8 seconds expected
  const rating = (closeness: 'correct' | 'close' | 'incorrect' | 'empty', elapsedMs = 8000, assistance: string[] = [], hintCount = 0) =>
    ratingFromCloseness({ closeness, elapsedMs, back, assistance, hintCount });

  it('clamps both ends and counts only nonempty whitespace-separated words', () => {
    expect(expectedRecallMs('')).toBe(6000);
    expect(expectedRecallMs('one')).toBe(6000);
    expect(expectedRecallMs('one two')).toBe(6000);
    expect(expectedRecallMs(' one\t two\nthree ')).toBe(6400);
    expect(expectedRecallMs('word '.repeat(45))).toBe(40000);
    expect(expectedRecallMs('word '.repeat(100))).toBe(40000);
  });
  it.each([
    [0, 'fast'], [6000, 'fast'], [6001, 'typical'], [15999, 'typical'],
    [16000, 'slow'], [20000, 'slow'], [-1, 'typical'], [NaN, 'typical'],
  ] as const)('classifies %s ms as %s including exact boundaries', (elapsed, speed) => {
    expect(recallSpeed(elapsed, back)).toBe(speed);
  });
  it('maps every closeness and correct pace', () => {
    expect(rating('empty').rating).toBe(1);
    expect(rating('incorrect').rating).toBe(1);
    expect(rating('close').rating).toBe(2);
    expect(rating('close', 0).rating).toBe(2);
    expect(rating('correct', 16000)).toEqual({ rating: 2, speed: 'slow', expectedMs: 8000, capped: false });
    expect(rating('correct')).toEqual({ rating: 3, speed: 'typical', expectedMs: 8000, capped: false });
    expect(rating('correct', 6000)).toEqual({ rating: 4, speed: 'fast', expectedMs: 8000, capped: false });
  });
  it.each(['pasted_text', 'consulted_materials', 'study_hint'])('caps both Easy and Good with %s', flag => {
    for (const elapsed of [1000, 8000]) expect(rating('correct', elapsed, [flag])).toMatchObject({ rating: 2, capped: true });
    for (const closeness of ['empty', 'incorrect'] as const) expect(rating(closeness, 0, [flag])).toMatchObject({ rating: 1, capped: false });
    expect(rating('close', 0, [flag])).toMatchObject({ rating: 2, capped: false });
    expect(rating('correct', 16000, [flag])).toMatchObject({ rating: 2, capped: false });
  });
  it('caps both Easy and Good for hints, never raising Again', () => {
    for (const elapsed of [1000, 8000]) expect(rating('correct', elapsed, [], 1)).toMatchObject({ rating: 2, capped: true });
    for (const closeness of ['empty', 'incorrect'] as const) expect(rating(closeness, 0, [], 2)).toMatchObject({ rating: 1, capped: false });
    expect(rating('correct', 0, ['other'])).toMatchObject({ rating: 4, capped: false });
  });
});

describe('elapsed display and privacy boundary', () => {
  it.each([
    [12400, '12.4 seconds'], [0, '0.0 seconds'], [-1000, '0.0 seconds'],
    [NaN, '0.0 seconds'], [Infinity, '0.0 seconds'], [59900, '59.9 seconds'],
    [60000, '1 min 00.0 s'], [65200, '1 min 05.2 s'], [120000, '2 min 00.0 s'],
  ] as const)('formats %s as %s', (ms, formatted) => expect(formatElapsed(ms)).toBe(formatted));
  it('uses the required privacy notice verbatim', () => {
    expect(FLASHCARD_AI_PRIVACY_NOTICE).toBe("Sends this card's prompt, its target answer and your typed recall to DeepSeek. DeepSeek (Hangzhou DeepSeek AI Co.) states that it processes and stores data in the People's Republic of China. Do not include names or student information.");
  });
  it('keeps provider configuration, credential prefixes and provider URLs out of web source', () => {
    const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
      entry.isDirectory() ? walk(resolve(directory, entry.name)) : [resolve(directory, entry.name)]);
    for (const path of walk(resolve('apps/web/src'))) expect(readFileSync(path, 'utf8'), path).not.toMatch(/DEEPSEEK|\bsk-|https?:\/\/(?:[^/]*\.)?deepseek\.[^\s'"<>]+/);
  });
});
