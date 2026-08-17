// Шаг 3-4: сбор внешних ресурсов в /assets, переписывание путей, отвязка от Framer.
//
// Пути переписываются в корне-абсолютные (`/assets/...`), а не в `../../assets/...`.
// Причина: Framer — SPA с client-side роутингом. После pushState-навигации базовый URL
// документа меняется, и document-relative путь, вставленный React'ом уже после перехода,
// разрешился бы неправильно. Корне-абсолютный путь стабилен на любой глубине.
// Для деплоя в подпапку задайте BASE=/subdir.
import { readFile, rm, mkdir, cp } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, basename } from 'node:path';
import {
  VENDOR_HOSTS, TRACKER_HOSTS, fetchRetry, pool, writeFileDeep,
} from './lib.mjs';

const BASE = (process.env.BASE || '').replace(/\/+$/, '');
const OUT = 'site';
const RAW = '.work/pages';
// og:image должен быть абсолютным URL — соцсети не понимают относительные пути.
// По умолчанию og/twitter-теги не трогаем (требование «сохранить без изменений»).
// OG_LOCAL=1 переписывает их на https://kabanov.agency/assets/... — нужно, если
// framerusercontent.com перестанет отдавать файлы после отключения подписки.
const OG_LOCAL = process.env.OG_LOCAL === '1';

const TEXT_EXT = new Set(['.mjs', '.js', '.css', '.json', '.map']);
const FONT_EXT = new Set(['.woff2', '.woff', '.ttf', '.otf', '.eot']);
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif', '.ico']);
const MEDIA_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogg', '.mp3', '.wav']);

const short = (s, n = 8) => createHash('sha1').update(s).digest('hex').slice(0, n);
const decodeEntities = (s) =>
  s.replace(/&amp;/g, '&').replace(/&#38;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'");

/** URL внешнего ресурса → путь внутри site/. */
function localPath(rawUrl) {
  const u = new URL(rawUrl);
  const host = u.hostname;
  const ext = (extname(u.pathname) || '').toLowerCase();
  const stem = basename(u.pathname, ext) || 'file';

  // Варианты одной картинки из CDN-ресайза различаются только query — разводим их суффиксом.
  let suffix = '';
  if (u.search) {
    const scale = u.searchParams.get('scale-down-to');
    suffix = scale ? `~${scale}` : `~${short(u.search, 6)}`;
  }

  if (host === 'fonts.gstatic.com') {
    const family = u.pathname.split('/')[2] || 'font';
    return `assets/fonts/gstatic-${family}-${stem}${ext}`;
  }
  if (host === 'unpkg.com') {
    const pkg = (u.pathname.split('/')[1] || 'pkg').replace(/[@/]/g, '-');
    return `assets/vendor/${pkg}/${stem}${ext}`;
  }
  if (host === 'framerusercontent.com' && u.pathname.startsWith('/third-party-assets/')) {
    return `assets/fonts/fontshare-${stem}${ext}`;
  }
  // Модули CMS и их данные адресуются друг через друга относительно, а рантайм
  // получает путь к данным подменой `/modules/` → `/cms/` в готовом URL. Поэтому
  // структуру каталогов у этих двух веток сохраняем один в один — тогда та же
  // подмена продолжает работать и на локальных путях.
  if (host === 'framerusercontent.com' && u.pathname.startsWith('/modules/')) {
    return `assets/modules${u.pathname.slice('/modules'.length)}`;
  }
  if (host === 'framerusercontent.com' && u.pathname.startsWith('/cms/')) {
    return `assets/cms${u.pathname.slice('/cms'.length)}`;
  }
  if (host === 'framerusercontent.com' && u.pathname.startsWith('/sites/')) {
    // Чанки держим плоско: они импортируют друг друга через ./name.mjs.
    if (ext === '.mjs' || ext === '.js') return `assets/js/${stem}${ext}`;
    if (ext === '.css') return `assets/css/${stem}${ext}`;
    if (ext === '.json') return `assets/data/${stem}${ext}`;
  }
  if (FONT_EXT.has(ext)) return `assets/fonts/${stem}${suffix}${ext}`;
  if (IMG_EXT.has(ext)) return `assets/images/${stem}${suffix}${ext}`;
  if (MEDIA_EXT.has(ext)) return `assets/media/${stem}${suffix}${ext}`;
  if (ext === '.css') return `assets/css/${stem}${suffix}${ext}`;
  if (ext === '.mjs' || ext === '.js') return `assets/js/${stem}${suffix}${ext}`;
  if (ext === '.json') return `assets/data/${stem}${suffix}${ext}`;
  return `assets/files/${stem}${suffix}${ext || '.bin'}`;
}

const VENDOR_RE = new RegExp(
  `https?://(?:${[...VENDOR_HOSTS].map((h) => h.replace(/\./g, '\\.')).join('|')})/[^\\s"'\`)\\\\<>\\]]+`,
  'g',
);

/**
 * Ссылка на конкретный файл, а не префикс-литерал?
 *
 * В чанках Framer встречаются строки вроде `https://fonts.gstatic.com/s/`, по которым
 * код КЛАССИФИЦИРУЕТ шрифт (`url.startsWith(...) ? 'google' : 'custom'`), а не грузит его.
 * Такие строки нельзя ни скачивать, ни подменять как обычный URL — иначе ломается логика.
 * Отличаем по наличию расширения у последнего сегмента пути.
 */
function isConcreteAsset(url) {
  try {
    const { pathname } = new URL(url);
    return /\/[^/]+\.[a-z0-9]{2,12}$/i.test(pathname);
  } catch {
    return false;
  }
}

/** Все ссылки на вендорские домены в куске текста (HTML/CSS/JS). */
function findVendorUrls(text) {
  const out = new Set();
  for (const m of decodeEntities(text).matchAll(VENDOR_RE)) {
    // Хвостовая пунктуация ловится жадным классом — подрезаем.
    const url = m[0].replace(/[.,;:'")\]}]+$/, '');
    if (isConcreteAsset(url)) out.add(url);
  }
  return out;
}

/**
 * Относительные ссылки внутри чанка (`import("./x.mjs")`, `new URL("./y.cmsdata", …)`).
 * Часть чанков подключается ТОЛЬКО так — по абсолютным URL их не найти.
 * Резолвим относительно собственного адреса чанка.
 */
function findRelativeRefs(text, baseUrl) {
  const out = new Set();
  const explicit = new Set(); // ссылки с базой, заданной прямо в коде

  const collect = (rel, base) => {
    let resolved;
    try {
      resolved = new URL(rel, base);
    } catch {
      return;
    }
    if (!VENDOR_HOSTS.has(resolved.hostname)) return;
    // Данные CMS лежат не рядом с модулем, а в зеркальной ветке /cms/ —
    // рантайм делает ровно эту подмену перед запросом.
    if (resolved.pathname.endsWith('.cmsdata')) {
      resolved.pathname = resolved.pathname.replace('/modules/', '/cms/');
    }
    out.add(resolved.toString());
  };

  // 1) `new URL("./x", "https://…/y.js")` — база указана явно, она и верна.
  //    Резолвить такие от адреса самого чанка нельзя: он лежит в другой ветке.
  for (const m of text.matchAll(
    /new URL\(\s*(['"`])(\.\/[^'"`\s]+)\1\s*,\s*(['"`])(https?:\/\/[^'"`\s]+)\3\s*\)/g,
  )) {
    explicit.add(m[2]);
    collect(m[2], m[4]);
  }

  // 2) Остальные относительные ссылки — от адреса самого чанка.
  for (const m of text.matchAll(/(['"`])(\.\/[^'"`\s]+\.[A-Za-z0-9]{2,12})\1/g)) {
    if (explicit.has(m[2])) continue;
    collect(m[2], baseUrl);
  }
  return out;
}

/**
 * Префиксы-литералы правим точечно. Схема имён в /assets/fonts кодирует источник
 * шрифта (`gstatic-…`, `fontshare-…`), поэтому проверки startsWith продолжают
 * работать и классификация остаётся прежней.
 */
const PREFIX_PATCHES = [
  ['https://fonts.gstatic.com/s/', `${BASE}/assets/fonts/gstatic-`],
  ['https://framerusercontent.com/third-party-assets/fontshare/', `${BASE}/assets/fonts/fontshare-`],
  // Панель редактирования Framer подгружается динамическим import(). Ветка закрыта
  // localStorage-флагом, но сам URL остаётся в чанке — подменяем на локальную заглушку,
  // чтобы в копии не было ни одной ссылки на инфраструктуру Framer.
  ['https://framer.com/edit/init.mjs', `${BASE}/assets/js/editor-bar-stub.mjs`],
];

// Вызывающий код: `let {createEditorBar:e} = await import(…); return {default: e()}`
// — то есть результат createEditorBar() рендерится как ленивый React-компонент.
// Вернуть отсюда обычный объект нельзя: React падает с ошибкой #130
// («element type is invalid… got: object») и роняет гидратацию всей страницы.
// Отдаём компонент, который ничего не рисует.
const EDITOR_BAR_STUB =
  '// Заглушка панели редактирования Framer: в автономной копии редактор не нужен.\n' +
  '// Должна возвращать именно React-компонент — результат рендерится как ленивый.\n' +
  'export const createEditorBar = () => () => null;\n' +
  'export default { createEditorBar };\n';

function patchPrefixLiterals(text) {
  let out = text;
  for (const [from, to] of PREFIX_PATCHES) out = out.split(from).join(to);
  return out;
}

/**
 * `new URL("./x", "https://framerusercontent.com/…/y.js")` после переписывания
 * получает относительную базу — а конструктор URL требует абсолютную и падает
 * с «Invalid base URL», роняя гидратацию всей страницы.
 * Достраиваем базу до абсолютной в рантайме через location.origin.
 * Шаблон узкий: оба аргумента — строковые литералы, второй начинается с /assets/.
 */
const BASE_RE = BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NEW_URL_BASE_RE = new RegExp(
  String.raw`new URL\((\x60[^\x60]*\x60|"[^"]*"|'[^']*'),\s*(\x60${BASE_RE}/assets/[^\x60]*\x60|"${BASE_RE}/assets/[^"]*"|'${BASE_RE}/assets/[^']*')\)`,
  'g',
);

function patchUrlBases(text) {
  return text.replace(NEW_URL_BASE_RE, (_m, rel, base) => `new URL(${rel},new URL(${base},location.origin))`);
}

/**
 * `new URL(x)` без базы. Раньше x был абсолютным адресом CDN, после переписывания
 * стал путём `/assets/…`, и конструктор падает с «Invalid URL», выключая
 * интерактивность страницы (наблюдалось на /ai и /en/ai).
 * Дописываем базу: для абсолютного адреса она игнорируется, для относительного —
 * резолвит верно, так что правка безопасна во всех случаях. Двухаргументные
 * вызовы под шаблон не попадают: после аргумента требуется закрывающая скобка.
 */
const NEW_URL_SINGLE_RE = /new URL\(([A-Za-z_$][A-Za-z0-9_$]*(?:\??\.[A-Za-z0-9_$]+)*)\)/g;

function patchSingleArgUrls(text) {
  return text.replace(NEW_URL_SINGLE_RE, (_m, arg) => `new URL(${arg},location.origin)`);
}

/**
 * Загрузчик данных CMS просит у сервера куски файла query-параметром
 * `?range=0-768,900-1200`. CDN Framer режет файл на своей стороне и отдаёт 200
 * с одной лишь запрошенной склейкой; любой статический сервер query игнорирует
 * и возвращает файл целиком, после чего проверка длины падает с
 * «Request failed: Unexpected response length» и страница теряет
 * интерактивность. Проявляется только при клиентской навигации, поэтому обычная
 * загрузка страниц этот путь не задевает.
 *
 * Заменяем функцию целиком: качаем файл целиком и нарезаем на клиенте.
 * Файлы по 35–42 КБ и кэшируются навсегда, так что цена невелика.
 */
function patchCmsRangeLoader(text) {
  const anchor = text.indexOf('Unexpected response length');
  if (anchor === -1) return { text, patched: false };

  const start = text.lastIndexOf('async function ', anchor);
  if (start === -1) return { text, patched: false };
  let depth = 0;
  let end = -1;
  for (let i = text.indexOf('{', start); i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  if (end === -1) return { text, patched: false };

  const fn = text.slice(start, end);
  // Имена в сборке минифицированы, поэтому вытаскиваем их из самой функции.
  const head = fn.match(/^async function (\w+)\((\w+),(\w+)\)\{let (\w+)=(\w+)\(\3\)/);
  const fetcher = fn.match(/await (\w+)\(\w+\);if\(/)?.[1];
  const buffer = fn.match(/new (\w+),\w+=0/)?.[1];
  if (!head || !fetcher || !buffer) return { text, patched: false };

  const [, name, urlArg, keysArg, , segmentsOf] = head;
  const replacement =
    `async function ${name}(${urlArg},${keysArg}){` +
    `let segs=${segmentsOf}(${keysArg});` +
    `let res=await ${fetcher}(new URL(${urlArg}));` +
    'if(res.status!==200)throw Error(`Request failed: ${res.status} ${res.statusText}`);' +
    `let full=new Uint8Array(await res.arrayBuffer());` +
    `let buf=new ${buffer};` +
    `for(let s of segs)buf.write(s.from,full.subarray(s.from,s.to));` +
    `return ${keysArg}.map(k=>buf.read(k.from,k.to-k.from))}`;

  return { text: text.slice(0, start) + replacement + text.slice(end), patched: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Скачивание с рекурсивным обходом: из .mjs/.css вылезают новые ссылки.
// ─────────────────────────────────────────────────────────────────────────────
const mapping = new Map(); // absolute url -> local path
const failures = [];
const bytes = new Map();

// Кэш: скачанное однажды лежит в .work/raw-assets и переиспользуется, поэтому
// повторная сборка не тянет 77 МБ заново. Удалите каталог, чтобы забрать свежее.
const CACHE_MAP = '.work/asset-map.json';
const cachedMap = existsSync(CACHE_MAP)
  ? new Map(Object.entries(JSON.parse(readFileSync(CACHE_MAP, 'utf8'))))
  : new Map();
let reused = 0;

async function harvest(seedUrls) {
  let frontier = [...seedUrls];
  let round = 0;
  while (frontier.length) {
    round++;
    const batch = frontier.filter((u) => !mapping.has(u));
    if (!batch.length) break;
    console.log(`  ресурсы, круг ${round}: ${batch.length}`);
    const nested = new Set();

    await pool(batch, 10, async (url) => {
      if (mapping.has(url)) return;
      const ext = (extname(new URL(url).pathname) || '').toLowerCase();
      const isText = TEXT_EXT.has(ext);
      const local = localPath(url);
      const cachedFile = `.work/raw-assets/${local}`;

      let body;
      if (cachedMap.get(url) === local && existsSync(cachedFile)) {
        body = isText ? await readFile(cachedFile, 'utf8') : await readFile(cachedFile);
        reused++;
      } else {
        let res;
        try {
          res = await fetchRetry(url, { asBuffer: !isText });
        } catch (err) {
          failures.push({ url, error: err.message });
          return;
        }
        if (!res.ok) {
          failures.push({ url, error: `HTTP ${res.status}` });
          return;
        }
        body = res.body;
        await writeFileDeep(cachedFile, body);
      }

      mapping.set(url, local);
      bytes.set(local, isText ? Buffer.byteLength(body) : body.length);
      if (isText) {
        for (const u of findVendorUrls(body)) if (!mapping.has(u)) nested.add(u);
        for (const u of findRelativeRefs(body, url)) if (!mapping.has(u)) nested.add(u);
      }
    });

    frontier = [...nested];
    if (round > 8) break;
  }
}

/** Замена вендорских URL на локальные пути внутри текстового ресурса. */
function rewriteText(text) {
  const replaced = text.replace(VENDOR_RE, (m) => {
    const clean = m.replace(/[.,;:'")\]}]+$/, '');
    const tail = m.slice(clean.length);
    const local = mapping.get(clean) ?? mapping.get(decodeEntities(clean));
    return local ? `${BASE}/${local}${tail}` : m;
  });
  return patchSingleArgUrls(patchUrlBases(patchPrefixLiterals(replaced)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Обработка HTML: вырезаем трекеры, переписываем ресурсы, бережём SEO-мета.
// ─────────────────────────────────────────────────────────────────────────────
const SEO_RE =
  /<link\b[^>]*\brel=["'](?:canonical|alternate)["'][^>]*>|<meta\b[^>]*\bproperty=["']og:[^"']*["'][^>]*>|<meta\b[^>]*\bname=["']twitter:[^"']*["'][^>]*>/gi;

function stripFramer(html) {
  let out = html;
  const removed = [];

  // Хук панели редактирования Framer — тянет framer.com/edit/init.mjs.
  out = out.replace(/<script>try\{if\(localStorage\.getItem\("__framer_force_showing_editorbar_since"\)[\s\S]*?<\/script>/gi, () => {
    removed.push('editorbar');
    return '';
  });

  // Телеметрия: и внешние <script src>, и инлайновые бутстрапы (gtag, GTM-контейнер).
  // Кастомный обработчик кликов сайта сюда не попадает: он не упоминает хосты трекеров
  // и сам проверяет наличие gtag/dataLayer, поэтому без аналитики просто ничего не делает.
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (tag) => {
    const src = tag.match(/\bsrc=["']https?:\/\/([^/"']+)/)?.[1];
    if (src && TRACKER_HOSTS.has(src)) {
      removed.push(`script-src:${src}`);
      return '';
    }
    // Инлайновый скрипт, который сам конструирует запрос к трекеру.
    if (!src && /googletagmanager\.com|google-analytics\.com|events\.framer\.com/i.test(tag)) {
      removed.push('script-inline:tracker');
      return '';
    }
    // Бутстрап gtag() без внешнего скрипта — оставлять смысла нет.
    if (!src && /window\.dataLayer\s*=\s*window\.dataLayer\s*\|\|/.test(tag) && /gtag\(/.test(tag)) {
      removed.push('script-inline:gtag');
      return '';
    }
    return tag;
  });

  // <noscript> с iframe GTM.
  out = out.replace(/<noscript>\s*<iframe[^>]*googletagmanager[\s\S]*?<\/noscript>/gi, () => {
    removed.push('noscript:gtm');
    return '';
  });

  // Preconnect/dns-prefetch на трекеры и вендоров: ресурсы теперь локальные.
  out = out.replace(/<link\b[^>]*\brel=["'](?:preconnect|dns-prefetch)["'][^>]*>/gi, (m) => {
    const host = m.match(/href=["']https?:\/\/([^/"']+)/)?.[1];
    if (host && (TRACKER_HOSTS.has(host) || VENDOR_HOSTS.has(host))) {
      removed.push(`preconnect:${host}`);
      return '';
    }
    return m;
  });

  return { html: out, removed };
}

function processHtml(html) {
  const { html: stripped, removed } = stripFramer(html);

  // SEO-теги выносим за скобки, чтобы глобальная замена их не задела.
  const seo = [];
  let out = stripped.replace(SEO_RE, (m) => {
    seo.push(m);
    return `\u0000SEO${seo.length - 1}\u0000`;
  });

  out = rewriteText(out);

  out = out.replace(/\u0000SEO(\d+)\u0000/g, (_, i) => {
    const tag = seo[Number(i)];
    if (!OG_LOCAL) return tag;
    // og:image/twitter:image → абсолютный URL на собственный домен.
    return tag.replace(VENDOR_RE, (m) => {
      const local = mapping.get(decodeEntities(m));
      return local ? `https://kabanov.agency${BASE}/${local}` : m;
    });
  });

  return { html: out, removed };
}

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const manifest = JSON.parse(await readFile('.work/manifest.json', 'utf8'));
  const files = [...manifest.pages.map((p) => p.file), '404.html'];

  console.log('1) поиск внешних ресурсов по страницам…');
  const seeds = new Set();
  const rawHtml = new Map();
  for (const f of files) {
    const html = await readFile(`${RAW}/${f}`, 'utf8');
    rawHtml.set(f, html);
    for (const u of findVendorUrls(html)) seeds.add(u);
  }
  console.log(`   уникальных URL на страницах: ${seeds.size}`);

  console.log('2) скачивание (с рекурсией по .mjs/.css)…');
  await harvest([...seeds]);
  console.log(`   всего ресурсов: ${mapping.size} (из кэша ${reused}, скачано ${mapping.size - reused}), ошибок: ${failures.length}`);
  await writeFileDeep(CACHE_MAP, JSON.stringify(Object.fromEntries(mapping), null, 0));

  console.log('3) переписывание путей внутри ресурсов…');
  let cmsPatched = 0;
  let cmsAnchors = 0;
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  let rewrittenAssets = 0;
  for (const [url, local] of mapping) {
    const ext = extname(local).toLowerCase();
    const src = `.work/raw-assets/${local}`;
    if (TEXT_EXT.has(ext)) {
      const text = await readFile(src, 'utf8');
      let next = rewriteText(text);
      // Одна и та же функция вкомпилирована в несколько чанков под разными
      // минифицированными именами, поэтому патчим каждый, где она встретилась.
      if (next.includes('Unexpected response length')) cmsAnchors++;
      const cms = patchCmsRangeLoader(next);
      if (cms.patched) {
        next = cms.text;
        cmsPatched++;
      }
      if (next !== text) rewrittenAssets++;
      await writeFileDeep(`${OUT}/${local}`, next);
    } else {
      await writeFileDeep(`${OUT}/${local}`, await readFile(src));
    }
    void url;
  }
  console.log(`   ресурсов записано: ${mapping.size}, из них с правкой ссылок: ${rewrittenAssets}`);
  // Без этой правки клиентская навигация по страницам с CMS ломается наглухо,
  // поэтому молча пропустить её нельзя: лучше не собрать копию вовсе.
  if (cmsAnchors === 0 || cmsPatched !== cmsAnchors) {
    throw new Error(
      `загрузчик диапазонов CMS: найден в ${cmsAnchors} чанках, пропатчен в ${cmsPatched} — ` +
        'разметка изменилась, проверьте patchCmsRangeLoader',
    );
  }
  console.log(`   загрузчик диапазонов CMS переписан на клиентскую нарезку (${cmsPatched} чанка)`);

  await writeFileDeep(`${OUT}/assets/js/editor-bar-stub.mjs`, EDITOR_BAR_STUB);

  console.log('4) переписывание страниц…');
  const removedTally = {};
  for (const f of files) {
    const { html, removed } = processHtml(rawHtml.get(f));
    for (const r of removed) removedTally[r] = (removedTally[r] || 0) + 1;
    await writeFileDeep(`${OUT}/${f}`, html);
  }
  console.log('   вырезано:', JSON.stringify(removedTally));

  // sitemap/robots переносим как есть — они описывают публичный домен.
  for (const f of ['sitemap.xml', 'sitemap_ru.xml', 'sitemap_en.xml', 'robots.txt']) {
    await cp(`.work/${f}`, `${OUT}/${f}`).catch(() => {});
  }

  const report = {
    generatedAt: new Date().toISOString(),
    base: BASE || '/',
    ogRewritten: OG_LOCAL,
    assets: mapping.size,
    totalBytes: [...bytes.values()].reduce((a, b) => a + b, 0),
    byKind: [...mapping.values()].reduce((acc, p) => {
      const k = p.split('/')[1];
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {}),
    strippedTrackers: removedTally,
    failures,
  };
  await writeFileDeep('.work/assets-report.json', JSON.stringify(report, null, 2));
  console.log('\nпо типам:', JSON.stringify(report.byKind));
  console.log('объём:', (report.totalBytes / 1e6).toFixed(1), 'МБ');
  if (failures.length) {
    console.log('НЕ СКАЧАНО:');
    for (const f of failures.slice(0, 20)) console.log('  ', f.url, '—', f.error);
  }
}

main();
