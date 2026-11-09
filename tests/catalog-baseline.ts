import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type {Catalog} from '../packages/shared/src/index.js';

// Exact Git blob bytes from d8a13245637fd75113ef63fbd314b3190de24bfb:content/catalog.json.
// Test/verification input only; the application must not load this historical fixture.
export const BASELINE_CATALOG_SHA256 = 'fae70311e1e4c2eecd445e712ba5b140230863bde055bd4406b4e361d7a21bc9';

export function parseBaselineCatalog(bytes: Uint8Array): Catalog {
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== BASELINE_CATALOG_SHA256) {
    throw new Error(`Baseline catalog integrity verification failed: expected SHA256 ${BASELINE_CATALOG_SHA256}, got ${actual}`);
  }
  return JSON.parse(Buffer.from(bytes).toString('utf8')) as Catalog;
}

export function readBaselineCatalog(): Catalog {
  return parseBaselineCatalog(readFileSync(new URL('./fixtures/catalog-d8a13245637fd75113ef63fbd314b3190de24bfb.json', import.meta.url)));
}
