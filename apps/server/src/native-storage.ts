import type { NativeQueue, NativeReceipt } from '../../../packages/shared/src/native-fsrs.js';
import type { NativeEvent, NativeProjection } from './native-store.js';

/** The bounded native flashcard surface; reviews never supply learning evidence. */
export interface NativeStoragePort {
  initialize(): Promise<{ initialized: number }>;
  queue(limit?: number): Promise<NativeQueue>;
  review(raw: unknown): Promise<NativeReceipt>;
  control(raw: unknown): Promise<NativeReceipt>;
  history(cardId?: string): Promise<NativeEvent[]>;
  rebuild(): Promise<NativeProjection[]>;
}
