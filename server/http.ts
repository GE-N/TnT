import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { createRunner } from './runner.js';

export function createApiHandler(runner: ReturnType<typeof createRunner>, artifactDirectory: string,
  fallback?: (request: IncomingMessage, response: ServerResponse) => void) {
  const token = randomBytes(32).toString('hex');
  let launching = false;
  return async (request: IncomingMessage, response: ServerResponse) => {
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(JSON.stringify(value));
    };
    const port = request.socket.localPort;
    const host = request.headers.host;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return json(403, { error: 'Only the local workbench host is allowed.' });
    if (request.headers.origin && request.headers.origin !== `http://${host}`) return json(403, { error: 'This origin cannot access the local runner.' });
    if (request.headers['sec-fetch-site'] === 'cross-site') return json(403, { error: 'Cross-site requests are not allowed.' });
    let url: URL;
    try { url = new URL(request.url ?? '/', `http://${host}`); }
    catch { return json(400, { error: 'Invalid request URL.' }); }
    if (!url.pathname.startsWith('/api/')) {
      if (fallback) return fallback(request, response);
      return json(404, { error: 'Not found.' });
    }
    try {
      if (request.method === 'GET' && url.pathname === '/api/status') {
        try { return json(200, { ready: true, devices: await runner.devices(), token, tool: 'Xcode simctl', node: process.version }); }
        catch (error) { return json(200, { ready: false, devices: [], token, tool: 'Xcode simctl', error: message(error) }); }
      }
      if (request.headers['x-tnt-token'] !== token) return json(403, { error: 'Refresh the workbench to establish a runner session.' });
      if (request.method === 'POST' && request.headers.origin !== `http://${host}`) return json(403, { error: 'A same-origin workbench request is required.' });
      if (request.method === 'POST' && !request.headers['content-type']?.startsWith('application/json')) return json(415, { error: 'Send JSON.' });
      if (request.method === 'POST' && url.pathname === '/api/launches') {
        if (launching) return json(409, { error: 'A launch is already in progress. Wait before launching again.' });
        launching = true;
        try {
          let body = '';
          for await (const chunk of request) {
            body += chunk.toString();
            if (Buffer.byteLength(body) > 2048) return json(413, { error: 'Launch request is too large.' });
          }
          const input: unknown = JSON.parse(body);
          if (!input || typeof input !== 'object' || !('deviceId' in input) || !('bundleId' in input) || typeof input.deviceId !== 'string' || typeof input.bundleId !== 'string') return json(400, { error: 'Provide a device and valid bundle identifier.' });
          return json(200, await runner.launch({ deviceId: input.deviceId, bundleId: input.bundleId }));
        } finally { launching = false; }
      }
      const match = /^\/api\/launches\/([0-9a-f-]{36})(?:\/(screen|confirm))?$/.exec(url.pathname);
      if (match) {
        const [, id, action] = match;
        if (request.method === 'POST' && action === 'confirm') return json(200, await runner.confirm(id));
        if (request.method === 'GET' && !action) return json(200, await runner.result(id));
        if (request.method === 'GET' && action === 'screen') {
          const result = await runner.result(id);
          if (!result.screenshot) return json(404, { error: 'No screenshot was captured.' });
          const screen = await readFile(join(artifactDirectory, id, 'screen.png'));
          response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          return response.end(screen);
        }
      }
      return json(404, { error: 'Unknown runner operation.' });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return json(code === 'ENOENT' ? 404 : 400, { error: message(error) });
    }
  };
}

function message(error: unknown) { return error instanceof Error ? error.message : 'Runner operation failed.'; }
