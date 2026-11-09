import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('Vercel Node entry', () => {
  it('imports without configuration, database connections or a listener', async () => {
    vi.stubEnv('STORAGE_MODE', 'invalid-on-purpose');
    vi.stubEnv('SEI_DATABASE_URL', 'invalid-on-purpose');
    vi.stubEnv('HOSTED_AUTH_MODE', 'invalid-on-purpose');
    const { default: handler } = await import('../api/[...path].js');
    expect(typeof handler).toBe('function');
  });
});
