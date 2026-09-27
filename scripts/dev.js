// Local dev server: serves the static app and routes /api/sync to the same
// handler Vercel runs. Reads settings from .env.local if present.
// Usage: npm run dev  (then open http://localhost:3000)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const f of ['.env.local', '.env']) {
  if (fs.existsSync(path.join(root, f))) process.loadEnvFile(path.join(root, f));
}
const api = await import('../api/sync.js');
const port = Number(process.env.PORT) || 3000;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/sync') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(url, {
      method: req.method,
      headers: Object.entries(req.headers).filter(([, v]) => typeof v === 'string'),
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
    });
    const handler = api[req.method];
    const response = handler ? await handler(request) : new Response('Method not allowed', { status: 405 });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
    return;
  }
  const file = path.join(root, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
  if (!file.startsWith(root) || !TYPES[path.extname(file)] || !fs.existsSync(file)) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`TIME/DIFF dev server on http://localhost:${port}`));
