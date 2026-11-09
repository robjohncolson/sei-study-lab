import type { IncomingMessage, ServerResponse } from 'node:http';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Any accidental pool creation fails before it can touch a database.
vi.mock('pg', () => ({ default: { Pool: vi.fn(() => { throw new Error('Unexpected database pool'); }) } }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('../apps/server/src/hosted-app.js');
  vi.clearAllMocks();
  vi.resetModules();
});

describe('Vercel Node entry', () => {
  it('imports without configuration, database connections or a listener', async () => {
    vi.stubEnv('STORAGE_MODE', 'invalid-on-purpose');
    vi.stubEnv('SEI_DATABASE_URL', 'invalid-on-purpose');
    vi.stubEnv('HOSTED_AUTH_MODE', 'invalid-on-purpose');
    const { default: handler, normalizeVercelUrl } = await import('../api/[...path].js');
    expect(typeof handler).toBe('function');
    expect(typeof normalizeVercelUrl).toBe('function');
    expect(pg.Pool).not.toHaveBeenCalled();
  });

  it.each([
    ['/api/session', '/api/session'],
    ['/api/native-flashcards/reviews?x=1', '/api/native-flashcards/reviews?x=1'],
    ['/api/drafts/task-1?x=1&path=ignored&...path=ignored', '/api/drafts/task-1?x=1'],
    ['/api/[...path]?path=native-flashcards/reviews&x=1', '/api/native-flashcards/reviews?x=1'],
    ['/api/[...path]?path=drafts/task-1', '/api/drafts/task-1'],
    ['/api/%5B...path%5D?path=native-flashcards%2Freviews&x=1', '/api/native-flashcards/reviews?x=1'],
    ['/api/%5b...path%5d?...path=drafts%2Ftask-1', '/api/drafts/task-1'],
    ['/api/[...path]?...path=native-flashcards/reviews&x=1', '/api/native-flashcards/reviews?x=1'],
    ['/api/[...path]?path=drafts/task-1&...path=%5B...path%5D', '/api/drafts/task-1'],
    ['/api/[...path]?...path=%5B...path%5D&path=drafts/task-1', '/api/drafts/task-1'],
    ['/api/[...path]?path=drafts/task.v1_~-%2541', '/api/drafts/task.v1_~-%41'],
    ['/api/[...path]?path=native-flashcards%252Freviews', '/api/native-flashcards%2Freviews'],
    ['/api/[...path]?path=anki.tsv', '/api/anki.tsv'],
    ['/api/[...path]??path=kept&path=anki.tsv', '/api/anki.tsv??path=kept'],
    ['/api/native-flashcards/history?path=ignored&cardId=card-1&...path=ignored', '/api/native-flashcards/history?cardId=card-1'],
    ['/api/session?path=first&...path=second&path=third', '/api/session'],
  ])('normalizes %s', async (url, expected) => {
    const { normalizeVercelUrl } = await import('../api/[...path].js');
    expect(normalizeVercelUrl(url)).toBe(expected);
  });

  it.each(['/api/native-flashcards/history', '/api/[...path]', '/api/%5B...path%5D'])(
    'preserves other query parameters verbatim and in order for %s', async pathname => {
      const { normalizeVercelUrl } = await import('../api/[...path].js');
      const query = 'x=first&path=native-flashcards/history&cardId=a%20b&...path=ignored&x=second&empty=&flag&encoded=%2f%7E&space=+&%70ath=ignored&%2E%2E%2Epath=ignored&?path=kept';
      expect(normalizeVercelUrl(`${pathname}?${query}`)).toBe(
        '/api/native-flashcards/history?x=first&cardId=a%20b&x=second&empty=&flag&encoded=%2f%7E&space=+&?path=kept',
      );
    },
  );

  it.each([
    '', '.', '..', '...', '../drafts', 'drafts/..', 'drafts/./task-1', 'drafts/.../task-1',
    '/drafts/task-1', 'drafts//task-1', 'drafts/task-1/', 'drafts\\task-1',
    'drafts/task?secret=never-echo', 'drafts/task#fragment', 'drafts/task value', 'drafts/task:value',
    '%2e%2e/drafts', 'drafts/%2E./task-1', 'drafts/%2f/task-1', 'drafts/%5ctask-1',
    'drafts/%3ftask-1', 'drafts/%23task-1', 'drafts/%00task-1', 'drafts/%',
  ])('rejects invalid captures without echoing %j or opening a pool', async capture => {
    const { default: handler, normalizeVercelUrl } = await import('../api/[...path].js');
    for (const name of ['path', '...path']) {
      const url = `/api/[...path]?${name}=${encodeURIComponent(capture)}`;
      expect(normalizeVercelUrl(url)).toBeUndefined();
      const request = { url } as IncomingMessage;
      const response = { statusCode: 200, setHeader: vi.fn(), end: vi.fn() };
      await handler(request, response as unknown as ServerResponse);
      expect(response.statusCode).toBe(400);
      expect(response.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json; charset=utf-8');
      expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
      expect(response.end).toHaveBeenCalledWith(JSON.stringify({ error: 'Invalid API route' }));
    }
    expect(pg.Pool).not.toHaveBeenCalled();
  });

  it.each(['/api/[...path]', '/api/%5B...path%5D?x=1'])(
    'rejects a destination without a capture: %s', async url => {
      const { normalizeVercelUrl } = await import('../api/[...path].js');
      expect(normalizeVercelUrl(url)).toBeUndefined();
    },
  );

  it('forwards normalized requests and still creates the hosted handler lazily once', async () => {
    vi.stubEnv('STORAGE_MODE', 'postgres');
    const forward = vi.fn();
    const createHostedHandler = vi.fn(async () => forward);
    vi.doMock('../apps/server/src/hosted-app.js', () => ({ createHostedHandler }));
    const { default: handler } = await import('../api/[...path].js');
    expect(createHostedHandler).not.toHaveBeenCalled();
    const response = {} as ServerResponse;
    for (const url of ['/api/[...path]?path=drafts/task-1&x=1', '/api/drafts/task-1?x=1&...path=ignored']) {
      const request = { url } as IncomingMessage;
      await handler(request, response);
      expect(request.url).toBe('/api/drafts/task-1?x=1');
      expect(forward).toHaveBeenLastCalledWith(request, response);
    }
    expect(createHostedHandler).toHaveBeenCalledTimes(1);
    expect(pg.Pool).not.toHaveBeenCalled();
  });
});
