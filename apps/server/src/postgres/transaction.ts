import pg, { type Pool, type PoolClient, type PoolConfig } from 'pg';
import { databaseUsesTls, type HostedConfig } from '../hosted-config.js';
import type { VerifiedOwnerClaims } from '../hosted-auth.js';

/** Explicit fields prevent URL sslmode/options from overriding certificate verification. */
export function hostedPoolOptions(config: HostedConfig): PoolConfig {
  const database = new URL(config.databaseUrl);
  return {
    host: database.hostname,
    port: database.port ? Number(database.port) : 5432,
    user: decodeURIComponent(database.username),
    password: decodeURIComponent(database.password),
    database: decodeURIComponent(database.pathname.slice(1)),
    ssl: databaseUsesTls(config) ? { rejectUnauthorized: true,
      ...(config.databaseCaPem === undefined ? {} : { ca: config.databaseCaPem }) } : false,
    max: config.poolMax, idleTimeoutMillis: 5_000, connectionTimeoutMillis: 10_000,
    application_name: 'sei-hosted',
  };
}

export function createHostedPool(config: HostedConfig): Pool {
  const pool = new pg.Pool(hostedPoolOptions(config));
  // Idle-client errors must not crash the process or leak connection strings through logs.
  pool.on('error', () => {});
  return pool;
}

/** The callback owns all database work for one authenticated request. No session state survives. */
export async function withOwnerTransaction<T>(
  pool: Pool,
  claims: VerifiedOwnerClaims,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN');
    await client.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)",
      [JSON.stringify(claims), claims.sub]);
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); }
    catch { discard = true; }
    throw error;
  } finally { client.release(discard); }
}
