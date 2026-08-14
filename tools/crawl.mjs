// Шаг 1-2: разбор sitemap, скачивание всех страниц + краулинг внутренних ссылок.
// Сырой HTML складываем в .work/pages/ — переписывание путей идёт отдельным шагом.
import { writeFile, mkdir } from 'node:fs/promises';
import { ORIGIN, fetchRetry, pool, normalizePageUrl, pathToFile, writeFileDeep } from './lib.mjs';

const RAW = '.work/pages';

async function sitemapUrls() {
  const index = await fetchRetry(`${ORIGIN}/sitemap.xml`);
  const children = [...index.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const urls = new Set();
  const perLocale = {};
  for (const child of children) {
    const locale = child.match(/sitemap_([a-z]+)\.xml/)?.[1] ?? 'root';
    const res = await fetchRetry(child);
    const locs = [...res.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    perLocale[locale] = locs.length;
    for (const loc of locs) {
      const n = normalizePageUrl(loc);
      if (n) urls.add(n);
    }
    await writeFileDeep(`.work/${child.split('/').pop()}`, res.body);
  }
  await writeFileDeep('.work/sitemap.xml', index.body);
  return { urls: [...urls], perLocale };
}

function extractLinks(html) {
  const out = new Set();
  for (const m of html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["']/gi)) {
    const n = normalizePageUrl(m[1]);
    if (n) out.add(n);
  }
  // Framer держит карту маршрутов в инлайновых данных — вытаскиваем и оттуда.
  for (const m of html.matchAll(/["'](\/(?:en\/)?[a-z0-9\-/]*)["']/gi)) {
    const p = m[1];
    if (p.length > 1 && !p.includes('.') && !p.startsWith('//')) {
      const n = normalizePageUrl(p);
      if (n) out.add(n);
    }
  }
  return [...out];
}

async function main() {
  await mkdir(RAW, { recursive: true });
  const { urls: seed, perLocale } = await sitemapUrls();
  console.log('sitemap:', JSON.stringify(perLocale), '→ уникальных URL:', seed.length);

  const seen = new Set(seed);
  const pages = new Map(); // url -> { status, file, html }
  let frontier = [...seed];
  let wave = 0;

  while (frontier.length) {
    wave++;
    console.log(`волна ${wave}: ${frontier.length} URL`);
    const discovered = new Set();

    await pool(frontier, 6, async (url) => {
      const res = await fetchRetry(url);
      const urlPath = new URL(url).pathname;
      const file = pathToFile(urlPath);
      pages.set(url, { status: res.status, file, urlPath });
      await writeFileDeep(`${RAW}/${file}`, res.body);
      if (res.status !== 200) return;
      for (const link of extractLinks(res.body)) {
        if (!seen.has(link)) {
          seen.add(link);
          discovered.add(link);
        }
      }
    });

    // Найденные вне sitemap проверяем — часть «маршрутов» из JS может быть мусором.
    frontier = [];
    for (const url of discovered) {
      const head = await fetchRetry(url);
      if (head.status === 200 && /text\/html/.test(head.contentType)) {
        frontier.push(url);
      } else {
        console.log(`  пропуск (${head.status}): ${new URL(url).pathname}`);
        seen.delete(url);
      }
    }
    if (wave > 6) break; // страховка от бесконечного обхода
  }

  // Страница 404: запрашиваем заведомо несуществующий путь.
  const notFound = await fetchRetry(`${ORIGIN}/__offline_copy_probe_404__`);
  await writeFileDeep(`${RAW}/404.html`, notFound.body);
  console.log(`404-страница: HTTP ${notFound.status}, ${notFound.body.length} байт`);

  // robots.txt — пригодится для нового хостинга.
  const robots = await fetchRetry(`${ORIGIN}/robots.txt`);
  await writeFileDeep('.work/robots.txt', robots.body);

  const manifest = {
    origin: ORIGIN,
    fetchedAt: new Date().toISOString(),
    sitemapCounts: perLocale,
    notFoundStatus: notFound.status,
    pages: [...pages.entries()]
      .map(([url, v]) => ({ url, ...v }))
      .sort((a, b) => a.urlPath.localeCompare(b.urlPath)),
  };
  await writeFile('.work/manifest.json', JSON.stringify(manifest, null, 2));

  const fromSitemap = new Set(seed);
  const extra = manifest.pages.filter((p) => !fromSitemap.has(p.url));
  console.log(`\nвсего страниц: ${manifest.pages.length} (sitemap: ${seed.length}, найдено краулингом: ${extra.length})`);
  for (const p of extra) console.log(`  + ${p.urlPath}`);
  const bad = manifest.pages.filter((p) => p.status !== 200);
  if (bad.length) console.log('НЕ 200:', bad.map((p) => `${p.urlPath} (${p.status})`).join(', '));
}

main();
