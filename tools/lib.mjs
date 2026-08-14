// Общие утилиты для всех шагов снятия копии.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const ORIGIN = 'https://kabanov.agency';

// Домены, ресурсы с которых мы забираем к себе.
export const VENDOR_HOSTS = new Set([
  'framerusercontent.com',
  'fonts.gstatic.com',
  'fonts.googleapis.com',
  'app.framerstatic.com',
  'unpkg.com', // Framer тянет отсюда lenis.css для плавного скролла
]);

// Домены, обращения к которым мы вырезаем целиком (аналитика/телеметрия).
export const TRACKER_HOSTS = new Set([
  'events.framer.com',
  'www.googletagmanager.com',
  'googletagmanager.com',
  'www.google-analytics.com',
  'google-analytics.com',
]);

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** fetch с ретраями и экспоненциальной паузой — сеть до framerusercontent бывает капризной. */
export async function fetchRetry(url, { tries = 5, asBuffer = false } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, 'accept-language': 'ru,en;q=0.9' },
        redirect: 'follow',
      });
      // 404 — это ответ, а не сбой сети: возвращаем как есть.
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
      const body = asBuffer
        ? Buffer.from(await res.arrayBuffer())
        : await res.text();
      return {
        ok: res.ok,
        status: res.status,
        body,
        contentType: res.headers.get('content-type') || '',
        finalUrl: res.url,
      };
    } catch (err) {
      lastErr = err;
      if (i < tries - 1) await sleep(500 * 2 ** i);
    }
  }
  throw new Error(`не удалось скачать ${url}: ${lastErr?.message}`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Пул с ограничением параллелизма — чтобы не словить рейт-лимит. */
export async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function writeFileDeep(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

/**
 * URL-путь → путь файла на диске.
 * `/`               → `index.html`
 * `/projects`       → `projects/index.html`
 * `/en/projects/w24`→ `en/projects/w24/index.html`
 */
export function pathToFile(urlPath) {
  const clean = urlPath.replace(/^\/+/, '').replace(/\/+$/, '');
  return clean === '' ? 'index.html' : `${clean}/index.html`;
}

/** Нормализуем URL страницы: убираем хеш, query и хвостовой слэш (кроме корня). */
export function normalizePageUrl(href, base = ORIGIN) {
  let u;
  try {
    u = new URL(href, base);
  } catch {
    return null;
  }
  if (u.origin !== ORIGIN) return null;
  if (!/^https?:$/.test(u.protocol)) return null;
  u.hash = '';
  u.search = '';
  // Отсекаем файлы — нас интересуют только HTML-маршруты.
  if (/\.(xml|txt|json|png|jpe?g|svg|webp|gif|ico|mp4|webm|css|m?js|woff2?)$/i.test(u.pathname)) {
    return null;
  }
  if (u.pathname !== '/' && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.slice(0, -1);
  }
  return u.toString();
}

/** Глубина пути — сколько `../` нужно, чтобы дойти до корня сайта. */
export function relPrefix(urlPath) {
  const depth = urlPath.replace(/^\/+/, '').replace(/\/+$/, '').split('/').filter(Boolean).length;
  return depth === 0 ? './' : '../'.repeat(depth);
}
