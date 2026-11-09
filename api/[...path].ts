import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHostedHandler } from '../apps/server/src/hosted-app.js';
import { readStorageMode } from '../apps/server/src/hosted-config.js';

// Vercel's api/*.ts functions use the Node runtime. No environment parsing, pool,
// connection, listener or application instance is created by importing this module.
let cachedHandler: ReturnType<typeof createHostedHandler> | undefined;

/** Accept original URLs and Vercel rewrite destinations without leaking route captures. */
export function normalizeVercelUrl(url: string): string | undefined {
  const queryIndex = url.indexOf('?');
  let pathname = queryIndex < 0 ? url : url.slice(0, queryIndex);
  const query = queryIndex < 0 ? '' : url.slice(queryIndex + 1);
  if (/^\/api\/(?:\[|%5[bB])\.\.\.path(?:\]|%5[dD])$/.test(pathname)) {
    const parameters = new URLSearchParams(`&${query}`);
    // The rewrite capture takes precedence over the single-segment function route.
    const capturedPath = parameters.get('path') ?? parameters.get('...path');
    if (capturedPath === null || !/^[A-Za-z0-9._~%/-]*$/.test(capturedPath)) return undefined;
    try {
      // Check the path as the router will decode it, including encoded separators.
      const decodedPath = decodeURIComponent(capturedPath);
      if (!/^[A-Za-z0-9._~%/-]*$/.test(decodedPath) ||
          decodedPath.split('/').some(segment => /^\.*$/.test(segment))) return undefined;
    } catch {
      return undefined;
    }
    pathname = `/api/${capturedPath}`;
  }
  // There are no application query parameters named path or ...path. Filter the
  // raw query to retain all other parameters' order, duplicates and encoding.
  const remainingQuery = query.split('&').filter(parameter => {
    // Prefix '&' so a query key beginning with '?' keeps that literal character.
    const name = new URLSearchParams(`&${parameter}`).keys().next().value;
    return name !== 'path' && name !== '...path';
  }).join('&');
  return pathname + (remainingQuery ? `?${remainingQuery}` : '');
}

export default async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const normalizedUrl = normalizeVercelUrl(request.url ?? '/');
  if (normalizedUrl === undefined) {
    response.statusCode = 400;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.end(JSON.stringify({ error: 'Invalid API route' }));
    return;
  }
  request.url = normalizedUrl;
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
