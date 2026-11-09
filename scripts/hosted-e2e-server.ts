import {randomBytes, randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {createServer} from 'vite';
import {createPostgresHarness} from '../apps/server/postgres/harness.js';
import {createHostedSeiServer} from '../apps/server/src/hosted-app.js';

// This harness refuses existing sei_app roles and needs a disposable PG cluster.
// All account credentials and connection details remain in process memory.
const apiPort = 4320, webPort = 5176;
const harness = await createPostgresHarness().catch(() => { throw new Error('Could not open the disposable hosted browser database'); });
let backend: Awaited<ReturnType<typeof createHostedSeiServer>> | undefined;
let web: Awaited<ReturnType<typeof createServer>> | undefined;
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  try { await web?.close(); await backend?.close(); }
  finally { await harness.dispose(); }
}
try {
  backend = await createHostedSeiServer({pool: harness.pool, env: {
    STORAGE_MODE: 'postgres', HOSTED_AUTH_MODE: 'password', PUBLIC_OWNER_ID: randomUUID(),
    SEI_DATABASE_URL: harness.appUrl, SEI_SESSION_SECRET: randomBytes(32).toString('base64url'),
    APP_HOSTS: `127.0.0.1:${apiPort},127.0.0.1:${webPort}`,
    APP_ORIGINS: `http://127.0.0.1:${webPort}`, AUTH_ALLOW_SIGNUP: 'false',
  }, ai: {env: {}}});
  await backend.listen({host: '127.0.0.1', port: apiPort});
  web = await createServer({configFile: resolve('apps/web/vite.config.ts'), server: {
    host: '127.0.0.1', port: webPort, strictPort: true,
    proxy: {'/api': {target: `http://127.0.0.1:${apiPort}`, changeOrigin: true}},
  }});
  await web.listen();
} catch {
  await shutdown();
  throw new Error('Could not start the hosted browser test server');
}
process.on('SIGINT', () => { void shutdown().then(() => process.exit(0)); });
process.on('SIGTERM', () => { void shutdown().then(() => process.exit(0)); });
