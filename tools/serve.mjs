// Локальный статический сервер с той же семантикой, что и продовый nginx:
// чистые URL без .html, 404-страница с корректным статусом, без SPA-фолбэка
// (у каждого маршрута есть реальный index.html).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const ROOT = process.env.ROOT || 'site';
const PORT = Number(process.env.PORT || 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

async function resolveFile(urlPath) {
  // normalize + отсечение ../ — защита от выхода за пределы корня.
  const clean = normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const candidates = extname(clean)
    ? [join(ROOT, clean)]
    : [join(ROOT, clean, 'index.html'), join(ROOT, `${clean}.html`)];
  for (const c of candidates) {
    try {
      const s = await stat(c);
      if (s.isFile()) return c;
    } catch {}
  }
  return null;
}

createServer(async (req, res) => {
  const file = await resolveFile(req.url || '/');
  if (!file) {
    const body = await readFile(join(ROOT, '404.html')).catch(() => Buffer.from('404'));
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(body);
  }
  const ext = extname(file).toLowerCase();
  const headers = { 'content-type': MIME[ext] || 'application/octet-stream' };
  // Иммутабельные ресурсы — с хешем в имени, страницы — без кеша.
  headers['cache-control'] = file.includes(`${ROOT}/assets/`)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
  res.writeHead(200, headers);
  res.end(await readFile(file));
}).listen(PORT, () => console.log(`http://127.0.0.1:${PORT} → ${ROOT}`));
