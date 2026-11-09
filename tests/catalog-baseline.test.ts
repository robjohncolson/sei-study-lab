import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {parseBaselineCatalog, readBaselineCatalog} from './catalog-baseline';

const bytes = readFileSync(new URL('./fixtures/catalog-d8a13245637fd75113ef63fbd314b3190de24bfb.json', import.meta.url));

describe('portable historical catalog integrity', () => {
  it('loads the exact checked-in baseline without Git history', () => {
    expect(readBaselineCatalog()).toEqual(JSON.parse(bytes.toString('utf8')));
  });

  it('rejects altered valid JSON and byte-only whitespace changes', () => {
    const altered = JSON.parse(bytes.toString('utf8'));
    altered.schemaVersion = 2;
    expect(() => parseBaselineCatalog(Buffer.from(JSON.stringify(altered)))).toThrow('Baseline catalog integrity verification failed');
    expect(() => parseBaselineCatalog(Buffer.concat([bytes, Buffer.from('\n')]))).toThrow('Baseline catalog integrity verification failed');
  });

  it('checks integrity before parsing malformed JSON', () => {
    expect(() => parseBaselineCatalog(Buffer.from('{'))).toThrow('Baseline catalog integrity verification failed');
  });
});
