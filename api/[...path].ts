import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHostedHandler } from '../apps/server/src/hosted-app.js';
import { readStorageMode } from '../apps/server/src/hosted-config.js';

// Vercel's api/*.ts functions use the Node runtime. No environment parsing, pool,
// connection, listener or application instance is created by importing this module.
let cachedHandler: ReturnType<typeof createHostedHandler> | undefined;

export default async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    if (!cachedHandler) {
      if (readStorageMode() !== 'postgres') throw new Error('Vercel requires postgres storage');
      cachedHandler = createHostedHandler().catch(error => {
        cachedHandler = undefined;
        throw error;
      });
    }
    (await cachedHandler)(request, response);
  } catch {
    // Configuration and database errors can contain secrets; never echo them.
    response.statusCode = 503;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.end(JSON.stringify({ error: 'The hosted app is not configured or is temporarily unavailable' }));
  }
}
