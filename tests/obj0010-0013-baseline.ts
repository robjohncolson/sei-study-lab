import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type {Catalog} from '../packages/shared/src/index.js';

// Exact bytes from verified clean base e4b8bab. These fixtures contain no learner data.
export const OBJECTIVES_1013_BASE_SHA256 = '96447befcf99d3c0323208f8fe93395f6ed853e58b18b23585a2f5bbe73ff7d0';
export const OBJECTIVES_1013_CONTRACT_SHA256 = 'd965f9454989dd423d484bf161c6734524c22b848ae864b36f743907485bfda5';

export function parseObjectives1013Baseline(bytes: Uint8Array): Catalog {
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== OBJECTIVES_1013_BASE_SHA256) throw new Error(`Objectives 0010-0013 baseline integrity verification failed: ${digest}`);
  return JSON.parse(Buffer.from(bytes).toString('utf8')) as Catalog;
}

export function readObjectives1013Baseline(): Catalog {
  return parseObjectives1013Baseline(readFileSync(new URL('./fixtures/catalog-e4b8bab7d0e2b15b563f99b9e3c9827f3c67381e.json', import.meta.url)));
}

export function verifyObjectives1013ContractFixture(): void {
  const bytes = readFileSync(new URL('./fixtures/coverage-contract-e4b8bab7d0e2b15b563f99b9e3c9827f3c67381e.ts', import.meta.url));
  if (createHash('sha256').update(bytes).digest('hex') !== OBJECTIVES_1013_CONTRACT_SHA256) {
    throw new Error('Objectives 0010-0013 contract integrity verification failed');
  }
}
