/** Recall scheduling helpers. These ratings never establish learning evidence. */
export type Closeness = 'correct' | 'close' | 'incorrect';
export type RatingSource = 'exact' | 'ai' | 'empty' | 'dont_know' | 'manual';
export type RecallSpeed = 'fast' | 'typical' | 'slow';

export const FLASHCARD_AI_PRIVACY_NOTICE = "Sends this card's prompt, its target answer and your typed recall to DeepSeek. DeepSeek (Hangzhou DeepSeek AI Co.) states that it processes and stores data in the People's Republic of China. Do not include names or student information.";

export function normalizeRecall(text: string): string {
  return text.normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US').replace(/[.!?;:]+$/u, '');
}

export function exactRecallMatch(response: string, back: string): boolean {
  const normalized = normalizeRecall(response);
  return normalized.length > 0 && normalized === normalizeRecall(back);
}

export function isBlankRecall(response: string): boolean {
  return normalizeRecall(response).length === 0;
}

export function expectedRecallMs(back: string): number {
  const words = back.split(/\s+/u).filter(Boolean).length;
  return Math.max(6000, Math.min(4000 + words * 800, 40000));
}

export function recallSpeed(elapsedMs: number, back: string): RecallSpeed {
  if (Number.isNaN(elapsedMs) || elapsedMs < 0) return 'typical';
  const expected = expectedRecallMs(back);
  if (elapsedMs <= 0.75 * expected) return 'fast';
  if (elapsedMs >= 2 * expected) return 'slow';
  return 'typical';
}

export function ratingFromCloseness(input: {
  closeness: Closeness | 'empty'; elapsedMs: number; back: string; assistance: string[]; hintCount: number;
}): { rating: 1 | 2 | 3 | 4; speed: RecallSpeed; expectedMs: number; capped: boolean } {
  const speed = recallSpeed(input.elapsedMs, input.back);
  const expectedMs = expectedRecallMs(input.back);
  const initial = input.closeness === 'incorrect' || input.closeness === 'empty' ? 1
    : input.closeness === 'close' || speed === 'slow' ? 2
      : speed === 'fast' ? 4 : 3;
  const assisted = input.hintCount > 0 || input.assistance.some(flag =>
    ['pasted_text', 'consulted_materials', 'study_hint'].includes(flag));
  const capped = assisted && initial > 2;
  return { rating: capped ? 2 : initial, speed, expectedMs, capped };
}

export function formatElapsed(ms: number): string {
  // Round once so 59.96 seconds and minute boundaries cannot render as "60.0 s".
  const tenths = Math.round((Number.isFinite(ms) ? Math.max(0, ms) : 0) / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)} seconds`;
  const minutes = Math.floor(tenths / 600);
  const seconds = ((tenths % 600) / 10).toFixed(1).padStart(4, '0');
  return `${minutes} min ${seconds} s`;
}
