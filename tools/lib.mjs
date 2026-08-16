// Общие утилиты для всех шагов снятия копии.
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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

/**
 * Профили просмотра. Framer раскладывает страницу по CSS-брейкпоинтам ширины и
 * на узком экране подставляет другие компоненты и другие варианты картинок,
 * поэтому мобильную версию нужно проверять отдельным прогоном.
 * User-agent не подменяем: чужой UA на Chromium включал бы посторонние ветки
 * кода, а брейкпоинты и так считаются от ширины.
 */
export const PROFILES = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
};

export const PROFILE = process.env.PROFILE || 'desktop';

export function profileOpts() {
  const p = PROFILES[PROFILE];
  if (!p) throw new Error(`неизвестный профиль «${PROFILE}», ожидался один из: ${Object.keys(PROFILES).join(', ')}`);
  return p;
}

/**
 * Хосты, которые для аудита считаются «своими» — то есть тем сервером, который
 * отдаёт копию. Локальная проверка и проверка боевого адреса здесь равноправны:
 * при `BASE_URL=https://kabanov.agency` без этого весь сайт попал бы в графу
 * «неожиданные внешние запросы», а счётчик 4xx/5xx остался бы вечным нулём —
 * проверка отчиталась бы «ошибок нет» даже если каждая страница отдаёт 500.
 */
export function ownHosts(base) {
  const hosts = new Set(['127.0.0.1', 'localhost']);
  try {
    hosts.add(new URL(base).hostname);
  } catch {
    throw new Error(`BASE_URL не разбирается как адрес: «${base}»`);
  }
  return hosts;
}

/**
 * Параметры запуска Chromium. И путь к браузеру, и прокси — свойства машины, а
 * не проекта: в песочнице, где снималась копия, Chromium лежал в /opt, а наружу
 * можно было только через HTTPS_PROXY; на обычной машине нет ни того, ни другого,
 * и Playwright находит свой браузер сам. Поэтому подставляем оба параметра, только
 * если они действительно есть, — иначе запуск падает на несуществующем файле или
 * на `proxy.server: undefined`.
 */
export function launchOpts(extra = {}) {
  const opts = { ...extra };
  const chrome = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
  if (existsSync(chrome)) opts.executablePath = chrome;
  if (process.env.HTTPS_PROXY) {
    opts.proxy = { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' };
  }
  return opts;
}

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
