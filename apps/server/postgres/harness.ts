import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client, Pool, type ClientConfig, type PoolConfig } from 'pg';

const migration = (name: string) => readFileSync(resolve('apps/server/src/postgres/migrations', name), 'utf8');

function connectionOptions(value: string): ClientConfig {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Test admin URL must use Postgres');
  // Explicit fields prevent URL SSL/options parameters overriding these settings.
  const local = ['127.0.0.1', 'localhost'].includes(url.hostname);
  return {
    host: url.hostname, port: url.port ? Number(url.port) : 5432,
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)), connectionTimeoutMillis: 10000,
    ssl: local ? false : { rejectUnauthorized: true,
      ...(process.env.SEI_DATABASE_CA_PEM ? { ca: process.env.SEI_DATABASE_CA_PEM } : {}) },
  };
}

/** Requires a dedicated, disposable test cluster: roles are cluster-wide. */
export async function createPostgresHarness() {
  const adminUrl = process.env.SEI_TEST_ADMIN_DATABASE_URL;
  if (!adminUrl) throw new Error('SEI_TEST_ADMIN_DATABASE_URL is required for test:postgres; this suite must not skip');
  const name = `sei_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Client(connectionOptions(adminUrl));
  let database: Client | undefined;
  let pool: Pool | undefined;
  let createdDatabase = false;
  let createdRole = false;
  let closed = false;
  const dispose = async () => {
    if (closed) return;
    closed = true;
    try {
      if (pool) await pool.end();
      if (database) await database.end();
      // name is generated here, never derived from supplied URLs or catalog data.
      if (createdDatabase) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      if (createdRole) await admin.query('DROP ROLE sei_app');
    } finally { await admin.end(); }
  };
  try {
    await admin.connect();
    const version = await admin.query<{ server_version_num: string }>('SHOW server_version_num');
    if (Number(version.rows[0].server_version_num) < 170000) throw new Error('Postgres 17 or newer is required for this integration suite');
    const existing = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'sei_app'");
    if (existing.rowCount) throw new Error('Use a dedicated test cluster without an existing sei_app role; this harness will not change an existing role');
    await admin.query(`CREATE DATABASE "${name}"`);
    createdDatabase = true;
    const databaseUrl = new URL(adminUrl);
    databaseUrl.pathname = `/${name}`;
    database = new Client(connectionOptions(databaseUrl.toString()));
    await database.connect();
    await database.query(`
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      CREATE TABLE public.answers(id integer PRIMARY KEY, payload text NOT NULL);
      INSERT INTO public.answers VALUES (1, 'synthetic neighbor answer');
      CREATE SCHEMA lesson_planning;
      CREATE TABLE lesson_planning.lessons(id integer PRIMARY KEY, payload text NOT NULL);
      INSERT INTO lesson_planning.lessons VALUES (1, 'synthetic neighbor lesson');
    `);
    await database.query(migration('000-sei-app-role.sql'));
    createdRole = true;
    await database.query(migration('000-sei-app-role.sql'));
    // Password is random, test-only, memory-only, and never printed or written.
    const password = randomBytes(32).toString('hex');
    await database.query(`ALTER ROLE sei_app LOGIN PASSWORD '${password}'`);
    await database.query('REVOKE ALL ON SCHEMA auth FROM PUBLIC; REVOKE ALL ON FUNCTION auth.uid() FROM PUBLIC; GRANT USAGE ON SCHEMA auth TO sei_app; GRANT EXECUTE ON FUNCTION auth.uid() TO sei_app;');
    for (let pass = 0; pass < 2; pass++) {
      await database.query(migration('001-sei-hosted.sql'));
      await database.query(migration('002-sei-study.sql'));
    }
    databaseUrl.username = 'sei_app';
    databaseUrl.password = password;
    const appUrl = databaseUrl.toString();
    const appConfig: PoolConfig = { ...connectionOptions(appUrl), max: 3, idleTimeoutMillis: 1000 };
    pool = new Pool(appConfig);
    const result = await pool.query<{ current_user: string }>('SELECT current_user');
    if (result.rows[0].current_user !== 'sei_app') throw new Error('Harness must connect as sei_app itself');
    return { pool, database, admin, name, appUrl, appConfig, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

export type PostgresHarness = Awaited<ReturnType<typeof createPostgresHarness>>;
