import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type {Catalog} from '../packages/shared/src/index.js';

// Exact Git blob bytes from the authorized clean base. Runtime tests require no Git.
// Historical fixtures are test input only and must never seed the application.
export const SLICE_BASE_SHA256 = 'eeae4827136d2b5b9cb840da2e72535d6f043eb8a1f4cd7c2ae2c483758f1bda';
export const SLICE_CONTRACT_SHA256 = '1c71a567059d8d6e0d4755300a99b8d3b26793c6d33ad1423375426825be2d62';

export function parseSliceBaseline(bytes: Uint8Array): Catalog {
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== SLICE_BASE_SHA256) throw new Error(`Slice baseline integrity verification failed: ${digest}`);
  return JSON.parse(Buffer.from(bytes).toString('utf8')) as Catalog;
}

export function readSliceBaseline(): Catalog {
  return parseSliceBaseline(readFileSync(new URL('./fixtures/catalog-d8e0dd883457cc01fd6a394e3d5c4fc35993f506.json', import.meta.url)));
}

export function verifySliceContractFixture(): void {
  const bytes = readFileSync(new URL('./fixtures/coverage-contract-d8e0dd883457cc01fd6a394e3d5c4fc35993f506.ts', import.meta.url));
  if (createHash('sha256').update(bytes).digest('hex') !== SLICE_CONTRACT_SHA256) {
    throw new Error('Slice contract integrity verification failed');
  }
}
