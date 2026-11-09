import { describe, expect, it } from 'vitest';
import { readHostedConfig, readStorageMode } from '../apps/server/src/hosted-config.js';
import { hostedPoolOptions } from '../apps/server/src/postgres/transaction.js';

const environment = (): NodeJS.ProcessEnv => ({
  SEI_DATABASE_URL: 'postgresql://sei_app:synthetic-password@db.example.test:6543/synthetic',
  SUPABASE_URL: 'https://synthetic.example.test',
  OWNER_USER_ID: '05bce282-b04e-4fc6-8ddc-f3c3b271e131',
  APP_ORIGINS: 'https://study.example.test',
  APP_HOSTS: 'study.example.test',
});

describe('hosted configuration, without network or database connections', () => {
  it('keeps the absent storage setting local and rejects unsupported modes', () => {
    expect(readStorageMode({})).toBe('sqlite');
    expect(readStorageMode({ STORAGE_MODE: 'sqlite' })).toBe('sqlite');
    expect(readStorageMode({ STORAGE_MODE: 'postgres' })).toBe('postgres');
    for (const STORAGE_MODE of ['', 'POSTGRES', 'memory', ' postgres']) {
      expect(() => readStorageMode({ STORAGE_MODE })).toThrow('STORAGE_MODE');
    }
  });
  it.each(['SEI_DATABASE_URL', 'SUPABASE_URL', 'OWNER_USER_ID', 'APP_ORIGINS', 'APP_HOSTS'])('requires %s with a secret-free message', name => {
    const env = environment();
    delete env[name];
    expect(() => readHostedConfig(env)).toThrow(name);
    expect(() => readHostedConfig({ ...environment(), [name]: ' ' })).toThrow(name);
  });
  it.each([
    ['SEI_DATABASE_URL', 'not-a-url-containing-secret'],
    ['SEI_DATABASE_URL', 'postgresql://postgres:secret@db.example.test/db'],
    ['SEI_DATABASE_URL', 'postgresql://service_role:secret@db.example.test/db'],
    ['SEI_DATABASE_URL', 'postgresql://sei_app:secret@db.example.test/db?sslmode=disable'],
    ['SEI_DATABASE_URL', 'postgresql://sei_app:secret@db.example.test/db?options=anything'],
    ['SUPABASE_URL', 'http://remote.example.test'],
    ['SUPABASE_URL', 'https://synthetic.example.test/auth/v1'],
    ['SUPABASE_URL', 'https://user:secret@synthetic.example.test'],
    ['OWNER_USER_ID', 'not-a-uuid'],
    ['APP_ORIGINS', 'https://study.example.test/'],
    ['APP_ORIGINS', 'https://study.example.test/path'],
    ['APP_ORIGINS', '*'],
    ['APP_ORIGINS', 'null'],
    ['APP_ORIGINS', 'https://study.example.test,'],
    ['APP_HOSTS', 'https://study.example.test'],
    ['APP_HOSTS', '*'],
    ['APP_HOSTS', 'study.example.test/path'],
    ['APP_HOSTS', 'user:secret@study.example.test'],
    ['SEI_DATABASE_POOL_MAX', '0'],
    ['SEI_DATABASE_POOL_MAX', '6'],
    ['SEI_DATABASE_POOL_MAX', '1.5'],
    ['SEI_DATABASE_CA_PEM', 'secret-invalid-certificate'],
  ])('rejects invalid %s without echoing the value', (name, value) => {
    let message = '';
    try { readHostedConfig({ ...environment(), [name]: value }); }
    catch (error) { message = (error as Error).message; }
    expect(message).toContain(name);
    expect(message).not.toContain(value);
  });
  it('defaults to one pooled connection and requires verified TLS for remote hosts', () => {
    const config = readHostedConfig(environment());
    expect(config.poolMax).toBe(1);
    expect(config.issuer).toBe('https://synthetic.example.test/auth/v1');
    const pool = hostedPoolOptions(config);
    expect(pool.ssl).toEqual({ rejectUnauthorized: true });
    expect(pool.max).toBe(1);
    expect(pool.idleTimeoutMillis).toBe(5_000);
    expect(pool).not.toHaveProperty('connectionString');
  });
  it('supports the transaction pooler username, exact allowlists, CA text, and bounded pool size', () => {
    const ca = '-----BEGIN CERTIFICATE-----\nsynthetic-test-only\n-----END CERTIFICATE-----';
    const config = readHostedConfig({ ...environment(),
      SEI_DATABASE_URL: 'postgresql://sei_app.syntheticref:synthetic-password@pooler.example.test:6543/postgres',
      APP_ORIGINS: 'https://study.example.test, https://preview.example.test',
      APP_HOSTS: 'study.example.test, preview.example.test',
      SEI_DATABASE_CA_PEM: ca, SEI_DATABASE_POOL_MAX: '5',
    });
    expect(config.origins.has('https://preview.example.test')).toBe(true);
    expect(config.hosts.has('preview.example.test')).toBe(true);
    expect(hostedPoolOptions(config)).toMatchObject({ user: 'sei_app.syntheticref', max: 5,
      ssl: { rejectUnauthorized: true, ca } });
  });
  it('preserves explicit default ports in exact Host allowlists', () => {
    const config = readHostedConfig({ ...environment(), APP_HOSTS: 'study.example.test:443' });
    expect(config.hosts.has('study.example.test:443')).toBe(true);
    expect(config.hosts.has('study.example.test')).toBe(false);
  });
  it.each(['localhost', '127.0.0.1'])('allows plain TCP only for explicit %s tests', host => {
    const config = readHostedConfig({ ...environment(),
      SEI_DATABASE_URL: `postgresql://sei_app:synthetic-password@${host}:5432/synthetic`,
      SUPABASE_URL: `http://${host}:54321`, APP_ORIGINS: `http://${host}:4317`, APP_HOSTS: `${host}:4317`,
    });
    expect(hostedPoolOptions(config).ssl).toBe(false);
  });
  it('does not treat lookalike loopback names or IPs as local', () => {
    for (const host of ['localhost.example.test', '127.0.0.2', '127.0.0.1.example.test', '[::1]']) {
      const config = readHostedConfig({ ...environment(), SEI_DATABASE_URL: `postgresql://sei_app:synthetic-password@${host}/synthetic` });
      expect(hostedPoolOptions(config).ssl).toEqual({ rejectUnauthorized: true });
    }
  });
});
