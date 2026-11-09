import Fastify, { type FastifyRequest } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { JWTVerifyGetKey } from 'jose';
import type { Pool } from 'pg';
import { z } from 'zod';
import { CatalogSchema, validateCatalog, type Catalog } from '../../../packages/shared/src/index.js';
import bundledCatalog from '../../../content/catalog.json' with { type: 'json' };
import { exportAnkiTsv } from './anki.js';
import { createOwnerVerifier, HostedAuthError, type VerifiedOwnerClaims } from './hosted-auth.js';
import { readHostedConfig, type HostedConfig } from './hosted-config.js';
import { NativeStoreError } from './native-store.js';
import type { NativeStoragePort } from './native-storage.js';
import { PostgresNativeStore } from './postgres/native-store.js';
import { PostgresStudyError, PostgresStudyStore } from './postgres/study-store.js';
import { createHostedPool, withOwnerTransaction } from './postgres/transaction.js';
import { StudyValidationError } from './study-logic.js';
import { JsonSchema } from './types.js';
import { readAiConfig } from './ai/ai-config.js';
import { registerAiRoutes, type AiServerOptions } from './ai/ai-routes.js';
import { PostgresAiStorage } from './ai/postgres-ai-storage.js';

// No secret or server session: the custom header plus exact Origin guard prevents
// browser cross-origin writes. The server never approves CORS preflights.
export const HOSTED_CSRF_TOKEN = 'hosted-origin-checked';

export type HostedServerOptions = {
  config?: HostedConfig;
  env?: NodeJS.ProcessEnv;
  pool?: Pool;
  key?: JWTVerifyGetKey;
  catalog?: Catalog;
  clock?: () => Date;
  ai?: AiServerOptions;
};

/** Hosted routes are isolated from the local store, cookies, CSRF sessions, and runtime files. */
export async function createHostedSeiServer(options: HostedServerOptions = {}) {
  const config = options.config ?? readHostedConfig(options.env);
  const aiConfig = readAiConfig(options.ai?.env ?? options.env);
  const catalog = CatalogSchema.parse(options.catalog ?? bundledCatalog);
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
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers['x-csrf-token'] !== HOSTED_CSRF_TOKEN) {
      return reply.code(403).send({ error: 'The hosted session CSRF token is required' });
    }
  });
  app.addHook('preValidation', async request => {
    const queue = [{ value: request.body, depth: 0 }];
    let count = 0;
    while (queue.length) {
      const { value, depth } = queue.pop()!;
      if (++count > 100000 || depth > 40) throw new StudyValidationError('JSON structure exceeds the safe nesting or item limit');
      if (value && typeof value === 'object') for (const child of Object.values(value)) queue.push({ value: child, depth: depth + 1 });
    }
  });
  app.addHook('preHandler', async request => {
    identities.set(request, await verifyOwner(request.headers.authorization));
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HostedAuthError || error instanceof NativeStoreError || error instanceof PostgresStudyError) {
      return reply.code(error.statusCode).send({ error: error.message });
    }
    if (error instanceof StudyValidationError) return reply.code(400).send({ error: error.message });
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
  function study<T>(request: FastifyRequest, operation: (store: PostgresStudyStore) => Promise<T>) {
    const claims = claimsFor(request);
    return withOwnerTransaction(pool, claims, client => operation(new PostgresStudyStore(client, claims.sub, catalog, options.clock)));
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
  app.get('/api/session', async () => ({ csrfToken: HOSTED_CSRF_TOKEN, storageMode: 'postgres', authMode: config.authMode }));
  app.get('/api/catalog', async () => catalog);
  app.get('/api/state', request => study(request, store => store.state()));
  app.post('/api/attempts', request => {
    // Server-derived UTC day is only a study-history label, never evidence authority.
    const sessionId = `hosted-${(options.clock?.() ?? new Date()).toISOString().slice(0, 10)}`;
    return study(request, store => store.submit(request.body, sessionId));
  });
  app.get<{ Params: { taskId: string } }>('/api/drafts/:taskId', request => study(request, store => store.draft(request.params.taskId)));
  app.put<{ Params: { taskId: string } }>('/api/drafts/:taskId', request => {
    const body = z.object({ taskVersion: z.union([z.string().min(1), z.number().int().positive()]), answer: JsonSchema }).strict().parse(request.body);
    return study(request, store => store.saveDraft(request.params.taskId, body.taskVersion, body.answer));
  });
  app.get('/api/anki.tsv', async (_request, reply) => reply.type('text/tab-separated-values; charset=utf-8')
    .header('Content-Disposition', 'attachment; filename="sei-study-lab-anki.tsv"').send(exportAnkiTsv(catalog)));
  app.get('/api/native-flashcards', request => native(request, store => store.queue()));
  app.post('/api/native-flashcards/initialize', request => native(request, store => store.initialize()));
  app.post('/api/native-flashcards/reviews', request => native(request, store => store.review(request.body)));
  app.post('/api/native-flashcards/controls', request => native(request, store => store.control(request.body)));
  app.get<{ Querystring: { cardId?: string } }>('/api/native-flashcards/history', request => {
    const query = z.object({ cardId: z.string().min(1).max(200).optional() }).strict().parse(request.query);
    return native(request, store => store.history(query.cardId));
  });
  registerAiRoutes(app, { config: aiConfig,
    storage: request => new PostgresAiStorage(pool, claimsFor(request), catalog, options.clock),
    local: false, fetch: options.ai?.fetch, clock: options.clock });
  app.all('/*', async (_request, reply) => reply.code(501).send({ error: 'Not yet available in hosted mode' }));
  await app.ready();
  return app;
}

/** Node hosting adapter: forwards requests without opening a listener. */
export async function createHostedHandler(options: HostedServerOptions = {}) {
  const app = await createHostedSeiServer(options);
  return Object.assign((request: IncomingMessage, response: ServerResponse) => {
    app.server.emit('request', request, response);
  }, { close: () => app.close() });
}
