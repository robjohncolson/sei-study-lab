import Fastify, { type FastifyRequest } from 'fastify';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import type { JWTVerifyGetKey } from 'jose';
import type { Pool } from 'pg';
import { z } from 'zod';
import { CatalogSchema, validateCatalog, type Catalog } from '../../../packages/shared/src/index.js';
import { createOwnerVerifier, HostedAuthError, type VerifiedOwnerClaims } from './hosted-auth.js';
import { readHostedConfig, type HostedConfig } from './hosted-config.js';
import { NativeStoreError } from './native-store.js';
import type { NativeStoragePort } from './native-storage.js';
import { PostgresNativeStore } from './postgres/native-store.js';
import { createHostedPool, withOwnerTransaction } from './postgres/transaction.js';

export type HostedServerOptions = {
  config?: HostedConfig;
  env?: NodeJS.ProcessEnv;
  pool?: Pool;
  key?: JWTVerifyGetKey;
  catalog?: Catalog;
  clock?: () => Date;
};

/** Hosted routes are isolated from the local store, cookies, CSRF sessions, and runtime files. */
export async function createHostedSeiServer(options: HostedServerOptions = {}) {
  const config = options.config ?? readHostedConfig(options.env);
  const catalog = CatalogSchema.parse(options.catalog ?? JSON.parse(readFileSync(resolve('content/catalog.json'), 'utf8')));
  if (validateCatalog(catalog).length) throw new Error('Invalid content catalog');
  const verifyOwner = createOwnerVerifier(config, options.key);
  const pool = options.pool ?? createHostedPool(config);
  const app = Fastify({ logger: false, bodyLimit: 2_000_000, requestTimeout: 15_000, connectionTimeout: 10_000, trustProxy: false });
  const identities = new WeakMap<FastifyRequest, VerifiedOwnerClaims>();
  if (!options.pool) app.addHook('onClose', async () => { await pool.end(); });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer')
      .header('X-Frame-Options', 'DENY').header('Cache-Control', 'no-store')
      .header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    if (!config.hosts.has(request.headers.host ?? '')) return reply.code(403).send({ error: 'Untrusted Host' });
    const origin = request.headers.origin;
    if ((origin !== undefined && !config.origins.has(origin)) ||
        (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && origin === undefined)) {
      return reply.code(403).send({ error: 'A trusted Origin is required' });
    }
  });
  app.addHook('preHandler', async request => {
    identities.set(request, await verifyOwner(request.headers.authorization));
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HostedAuthError || error instanceof NativeStoreError) {
      return reply.code(error.statusCode).send({ error: error.message });
    }
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid data schema' });
    const code = (error as { code?: string }).code;
    if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(413).send({ error: 'Request exceeds the 2 MB limit' });
    if (code === '23505' || code === '40001' || code === '40P01') {
      return reply.code(409).send({ error: 'Card state changed. Preserve the pending response and recover it explicitly.' });
    }
    // Database and verifier internals can contain sensitive information; never echo them.
    return reply.code(500).send({ error: 'The hosted operation could not be completed' });
  });
  function claimsFor(request: FastifyRequest) {
    const claims = identities.get(request);
    if (!claims) throw new HostedAuthError(401);
    return claims;
  }
  function native<T>(request: FastifyRequest, operation: (store: NativeStoragePort) => Promise<T>) {
    const claims = claimsFor(request);
    return withOwnerTransaction(pool, claims, client => operation(new PostgresNativeStore(client, claims.sub, catalog, options.clock)));
  }
  const identity = async (request: FastifyRequest) => {
    const claims = claimsFor(request);
    return withOwnerTransaction(pool, claims, async client => {
      const result = await client.query<{ role: string }>('SELECT current_user AS role');
      if (result.rows[0]?.role !== 'sei_app') throw new Error('Unexpected database role');
      return { status: 'ok', storageMode: 'postgres', ownerId: claims.sub, databaseRole: result.rows[0].role };
    });
  };
  app.get('/api/health', identity);
  app.get('/api/identity', identity);
  app.get('/api/native-flashcards', request => native(request, store => store.queue()));
  app.post('/api/native-flashcards/initialize', request => native(request, store => store.initialize()));
  app.post('/api/native-flashcards/reviews', request => native(request, store => store.review(request.body)));
  app.post('/api/native-flashcards/controls', request => native(request, store => store.control(request.body)));
  app.get<{ Querystring: { cardId?: string } }>('/api/native-flashcards/history', request => {
    const query = z.object({ cardId: z.string().min(1).max(200).optional() }).strict().parse(request.query);
    return native(request, store => store.history(query.cardId));
  });
  app.all('/*', async (_request, reply) => reply.code(501).send({ error: 'Not yet available in hosted mode' }));
  await app.ready();
  return app;
}

/** Adapter for a later Node hosting entry point; creates no listener or deployment config. */
export async function createHostedHandler(options: HostedServerOptions = {}) {
  const app = await createHostedSeiServer(options);
  return Object.assign((request: IncomingMessage, response: ServerResponse) => {
    app.server.emit('request', request, response);
  }, { close: () => app.close() });
}
