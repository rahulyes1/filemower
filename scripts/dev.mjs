// Local dev server: serves public/ and runs the same api/*.js handlers Vercel
// runs, with storage in a temp folder. Usage: node scripts/dev.mjs
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const PORT = Number(process.env.PORT) || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');

  const api = pathname.match(/^\/api\/([a-z]+)$/);
  if (api) {
    const fn = path.join(root, 'api', `${api[1]}.js`);
    if (!(await fs.stat(fn).catch(() => null))) {
      res.statusCode = 404;
      return res.end('not found');
    }
    return require(fn)(req, res);
  }

  const file = path.join(publicDir, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(publicDir)) {
    res.statusCode = 403;
    return res.end();
  }
  try {
    const body = await fs.readFile(file);
    res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
});

server.listen(PORT, () => console.log(`File Mover dev server: http://localhost:${PORT}`));
