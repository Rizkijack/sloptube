/**
 * Static server for verifying the UI without a Cloudflare runtime.
 *
 * `/api/*` intentionally returns 503 so the client exercises its seed.json
 * fallback — that is the path a first-run visitor takes before any agent has
 * published anything.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', 'ui');
const PORT = Number(process.env.PORT ?? 5173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.m4s': 'video/iso.segment',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname.startsWith('/api/')) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'no_backend', message: 'static dev server' } }));
    return;
  }

  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel.endsWith('/')) rel += 'index.html';

  const target = join(ROOT, normalize(rel).replace(/^([/\\])+/, ''));
  if (!target.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'content-length': body.byteLength,
      'cache-control': 'no-store',
    });
    res.end(body);
    return;
  } catch {
    // Single-page fallback: the Worker router serves /watch, /channel/* and
    // /results from the one shell, so a non-file path must not 404 here.
    if (extname(target)) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
  }

  try {
    const shell = await readFile(join(ROOT, 'index.html'));
    res.writeHead(200, {
      'content-type': TYPES['.html'],
      'content-length': shell.byteLength,
      'cache-control': 'no-store',
    });
    res.end(shell);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`sloptube ui → http://127.0.0.1:${PORT}/`);
});
