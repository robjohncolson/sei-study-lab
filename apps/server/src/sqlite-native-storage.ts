import type { NativeStore } from './native-store.js';
import type { NativeStoragePort } from './native-storage.js';

/** An async boundary around the existing, unchanged local implementation. */
export class SQLiteNativeStorage implements NativeStoragePort {
  constructor(readonly native: NativeStore) {}
  async initialize() { return this.native.initialize(); }
  async queue(limit?: number) { return this.native.queue(limit); }
  async review(raw: unknown) { return this.native.review(raw); }
  async control(raw: unknown) { return this.native.control(raw); }
  async history(cardId?: string) { return this.native.history(cardId); }
  async rebuild() { return this.native.rebuild(); }
}
