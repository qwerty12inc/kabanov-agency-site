// Готовит миниатюры страниц для визуального индекса: PNG-скриншоты уменьшаются
// через canvas в браузере и отдаются как data:URI, чтобы страница-отчёт была
// самодостаточной (внешние запросы из неё запрещены политикой безопасности).
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { chromium } from 'playwright';

const WIDTH = Number(process.env.WIDTH || 320);
const QUALITY = Number(process.env.QUALITY || 0.55);
const PORT = 4199;

const slug = (p) => (p === '/' ? 'home' : p.replace(/^\//, '').replace(/\//g, '_'));

// Мини-сервер только для того, чтобы браузер мог грузить PNG по URL:
// читать многомегабайтные файлы в data:URI на входе было бы заметно дороже.
// Корневой ответ нужен, чтобы страница-обработчик жила на том же происхождении:
// с about:blank подгрузка по HTTP блокируется, а canvas считался бы «испорченным».
const server = createServer((req, res) => {
  const path = decodeURIComponent((req.url || '').split('?')[0]);
  if (path === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end('<!doctype html><title>thumbs</title>');
  }
  const file = `shots${path}`;
  if (!existsSync(file)) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'image/png' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const manifest = JSON.parse(await readFile('.work/manifest.json', 'utf8'));
const shots = JSON.parse(await readFile('.work/shots-report.json', 'utf8'));
const percentOf = new Map(shots.rows.map((r) => [r.path, r.percent]));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${PORT}/`);

async function thumb(url) {
  return page.evaluate(
    async ([src, w, q]) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const h = Math.round((img.naturalHeight / img.naturalWidth) * w);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);
      return { data: c.toDataURL('image/jpeg', q), w, h: h };
    },
    [url, WIDTH, QUALITY],
  );
}

const out = [];
let bytes = 0;
for (const [i, p] of manifest.pages.entries()) {
  const name = slug(p.urlPath);
  const base = `http://127.0.0.1:${PORT}`;
  try {
    const local = await thumb(`${base}/local/${name}.png`);
    const live = await thumb(`${base}/live/${name}.png`);
    bytes += local.data.length + live.data.length;
    out.push({
      path: p.urlPath,
      locale: p.urlPath.startsWith('/en') ? 'en' : 'ru',
      percent: percentOf.get(p.urlPath) ?? null,
      w: local.w,
      h: local.h,
      local: local.data,
      live: live.data,
    });
  } catch (err) {
    console.log(`  ✗ ${p.urlPath}: ${err.message.split('\n')[0]}`);
  }
  if ((i + 1) % 20 === 0) console.log(`  …${i + 1}/${manifest.pages.length}`);
}

await browser.close();
server.close();

await writeFile('.work/thumbs.json', JSON.stringify(out));
console.log(`миниатюр: ${out.length}, ширина ${WIDTH}px, качество ${QUALITY}`);
console.log(`суммарный вес data:URI: ${(bytes / 1e6).toFixed(1)} МБ`);
