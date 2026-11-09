import type { Pool, PoolClient } from 'pg';
import { AuthError } from './core.js';
import type { AuthIdentity, AuthStore } from './service.js';

/** Auth functions run as sei_app without an owner claim, including on pooled connections. */
export async function withAuthTransaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN');
    const role = await client.query<{ role: string }>(
      "SELECT current_user AS role, pg_catalog.set_config('request.jwt.claims', '{}', true), pg_catalog.set_config('request.jwt.claim.sub', '', true)");
    if (role.rows[0]?.role !== 'sei_app') throw new Error('Unexpected database role');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { discard = true; }
    throw error;
  } finally { client.release(discard); }
}

export class PostgresAuthStore implements AuthStore {
  constructor(private readonly pool: Pool) {}

  async register(username: string, passwordHash: string, firstOwner: string, allowOpen: boolean, now: Date): Promise<string> {
    try {
      return await withAuthTransaction(this.pool, async client => {
        const result = await client.query<{ owner: string }>('SELECT sei.auth_register($1,$2,$3,$4,$5) AS owner', [username, passwordHash, firstOwner, allowOpen, now]);
        return result.rows[0].owner;
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'P0001') throw new AuthError(403, 'Sign-up is closed');
      if (code === '23505') throw new AuthError(409, 'Username is already taken');
      throw error;
    }
  }

  async loginLookup(username: string, now: Date) {
    return withAuthTransaction(this.pool, async client => {
      const result = await client.query<{ ownerId: string; passwordHash: string; locked: boolean }>(
        'SELECT owner_id AS "ownerId", password_hash AS "passwordHash", locked FROM sei.auth_login_lookup($1,$2)', [username, now]);
      return result.rows[0] ?? null;
    });
  }
  async loginResult(ownerId: string, success: boolean, now: Date): Promise<void> {
    await withAuthTransaction(this.pool, client => client.query('SELECT sei.auth_login_result($1,$2,$3)', [ownerId, success, now]));
  }
  async createSession(tokenHash: string, ownerId: string, now: Date, expires: Date): Promise<void> {
    await withAuthTransaction(this.pool, client => client.query('SELECT sei.auth_session_create($1,$2,$3,$4)', [tokenHash, ownerId, now, expires]));
  }
  async sessionOwner(tokenHash: string, now: Date): Promise<AuthIdentity | null> {
    return withAuthTransaction(this.pool, async client => {
      const result = await client.query<AuthIdentity>(
        'SELECT owner_id AS "ownerId", username FROM sei.auth_session_owner($1,$2)', [tokenHash, now]);
      return result.rows[0] ?? null;
    });
  }
  async revokeSession(tokenHash: string, now: Date): Promise<void> {
    await withAuthTransaction(this.pool, client => client.query('SELECT sei.auth_session_revoke($1,$2)', [tokenHash, now]));
  }
  async signupOpen(allowOpen: boolean): Promise<boolean> {
    return withAuthTransaction(this.pool, async client => {
      const result = await client.query<{ open: boolean }>('SELECT sei.auth_signup_open($1) AS open', [allowOpen]);
      return result.rows[0].open;
    });
  }
}
