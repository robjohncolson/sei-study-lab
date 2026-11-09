import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type {Catalog} from '../packages/shared/src/index.js';

// Exact source bytes from verified clean base 79040cd. No learner data or Git runtime.
export const OBJECTIVES_789_BASE_SHA256 = 'cf03554c2d21454bc67f72bb66b40892b6b044b11228eceb5674ab7db88be420';
export const OBJECTIVES_789_CONTRACT_SHA256 = '2960c439664b73659598ad91c2d9190e01587ce846fbf6bc43402201348819dd';

export function parseObjectives789Baseline(bytes: Uint8Array): Catalog {
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== OBJECTIVES_789_BASE_SHA256) throw new Error(`Objectives 0007-0009 baseline integrity verification failed: ${digest}`);
  return JSON.parse(Buffer.from(bytes).toString('utf8')) as Catalog;
}

export function readObjectives789Baseline(): Catalog {
  return parseObjectives789Baseline(readFileSync(new URL('./fixtures/catalog-79040cd08ded4db75bca10ee18cb6016107b39c1.json', import.meta.url)));
}

export function verifyObjectives789ContractFixture(): void {
  const bytes = readFileSync(new URL('./fixtures/coverage-contract-79040cd08ded4db75bca10ee18cb6016107b39c1.ts', import.meta.url));
  if (createHash('sha256').update(bytes).digest('hex') !== OBJECTIVES_789_CONTRACT_SHA256) {
    throw new Error('Objectives 0007-0009 contract integrity verification failed');
  }
}
