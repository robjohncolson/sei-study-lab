import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type {Catalog} from '../packages/shared/src/index.js';

// Exact source bytes captured from the verified clean 189d52f base, not learner data.
// Portable tests consume these digest-pinned fixtures; Git is never needed at runtime.
export const OBJECTIVES_456_BASE_SHA256 = '6ae4d1b85099f216971bef1b9919fe2d7d74d791abfeac7892c6ff062bc67ccd';
export const OBJECTIVES_456_CONTRACT_SHA256 = 'c85f2f16a2d21bc1b182cfa0a9787136aeff415029f86c1c0f252d8f99fc9614';

export function parseObjectives456Baseline(bytes: Uint8Array): Catalog {
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== OBJECTIVES_456_BASE_SHA256) throw new Error(`Objectives 0004–0006 baseline integrity verification failed: ${digest}`);
  return JSON.parse(Buffer.from(bytes).toString('utf8')) as Catalog;
}

export function readObjectives456Baseline(): Catalog {
  return parseObjectives456Baseline(readFileSync(new URL('./fixtures/catalog-189d52fd001240b7fb5f18eaeea47e50ba1de575.json', import.meta.url)));
}

export function verifyObjectives456ContractFixture(): void {
  const bytes = readFileSync(new URL('./fixtures/coverage-contract-189d52fd001240b7fb5f18eaeea47e50ba1de575.ts', import.meta.url));
  if (createHash('sha256').update(bytes).digest('hex') !== OBJECTIVES_456_CONTRACT_SHA256) {
    throw new Error('Objectives 0004–0006 contract integrity verification failed');
  }
}
