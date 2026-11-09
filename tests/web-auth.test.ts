import {randomBytes} from 'node:crypto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {api, initializeSession, onSignInRequired} from '../apps/web/src/api.js';

afterEach(() => { vi.unstubAllGlobals(); });

describe('browser password session boundary', () => {
  it('notifies the desk on a study 401, including AI and flashcard reads', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({error: 'Sign in required'}), {status: 401}));
    const required = vi.fn(), unsubscribe = onSignInRequired(required);
    try {
      for (const path of ['/state', '/native-flashcards', '/ai-feedback/status', '/drafts/synthetic']) {
        await expect(api(path)).rejects.toMatchObject({status: 401, message: 'Sign in required'});
      }
      expect(required).toHaveBeenCalledTimes(4);
      unsubscribe();
      await expect(api('/state')).rejects.toMatchObject({status: 401});
      expect(required).toHaveBeenCalledTimes(4);
    } finally { unsubscribe(); }
  });

  it('keeps incorrect credentials in the form and does not signal a study expiry', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({error: 'Invalid username or password'}), {status: 401}));
    const required = vi.fn(), unsubscribe = onSignInRequired(required);
    try {
      await expect(api('/auth/login', 'POST', {})).rejects.toMatchObject({status: 401});
      await expect(api('/session')).rejects.toMatchObject({status: 401});
      expect(required).not.toHaveBeenCalled();
    } finally { unsubscribe(); }
  });

  it('uses the newest session CSRF metadata when older reads finish late', async () => {
    const oldToken = randomBytes(24).toString('hex'), currentToken = randomBytes(24).toString('hex');
    let completeOld: ((response: Response) => void) | undefined;
    const old = new Promise<Response>(resolve => { completeOld = resolve; });
    let reads = 0, correctHeader = false;
    vi.stubGlobal('fetch', async (url: string, options: RequestInit) => {
      if (url === '/api/session') {
        if (++reads === 1) return old;
        return new Response(JSON.stringify({csrfToken: currentToken}));
      }
      correctHeader = new Headers(options.headers).get('x-csrf-token') === currentToken && options.credentials === 'same-origin';
      return new Response('{}');
    });
    const stale = initializeSession();
    await initializeSession();
    completeOld!(new Response(JSON.stringify({csrfToken: oldToken})));
    await stale;
    await api('/auth/logout', 'POST');
    // Compare booleans so a failing assertion never prints session material.
    expect(correctHeader).toBe(true);
  });
});
