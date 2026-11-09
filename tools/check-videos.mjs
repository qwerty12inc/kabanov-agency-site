// Проверка роликов Vimeo в кейсах (tools/videos.json, tools/set-videos.py).
//
// Запись проекта страница берёт двумя путями, и проверяются оба:
//   • прямой заход — из блока данных внутри самой страницы;
//   • переход по ссылке внутри сайта — из двоичных файлов CMS (.cmsdata).
// Второй путь обычным goto не задеть, и именно там живут правки, которые легко
// сделать неверно: сдвинутое смещение записи в индексе даёт не ошибку, а чужую
// запись или пустую страницу. Поэтому здесь отдельный клик и сверка заголовка.
//
// «Ролик есть» — это iframe плеера с нужным номером. Сам ролик из этой проверки не
// играет: Vimeo закрывает плеер от автоматических браузеров защитой Cloudflare (401),
// у работающих роликов тоже. Поэтому проверяется не картинка, а то, что плеер создан
// для верного номера и страница при этом не выдала ошибок гидратации.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { launchOpts } from './lib.mjs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173';
const videos = JSON.parse(await readFile('tools/videos.json', 'utf8'));
const LISTS = ['/projects', '/categories/ui', '/categories/ai', '/categories/3d', '/categories/illustrations', '/categories/motion'];

const browser = await chromium.launch(launchOpts({
  args: ['--disable-features=PostQuantumKyber,EncryptedClientHello,TLS13EarlyData', '--ssl-version-max=tls1.2'],
}));
let failed = 0;
const idOf = (url) => url.match(/\/(\d+)$/)[1];

/** Страница проекта, на которой есть ссылка на кейс: просматриваем готовый HTML соседей по карте сайта. */
async function findReferrer(slug, prefix) {
  const xml = await (await fetch(`${BASE}/sitemap${prefix ? '_en' : '_ru'}.xml`)).text();
  const paths = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname).filter((p) => /\/projects\/[^/]+$/.test(p) && !p.endsWith(`/${slug}`));
  for (const p of paths) {
    const html = await (await fetch(BASE + p)).text();
    if (html.includes(`/${slug}"`)) return p;
  }
  return null;
}

/**
 * Ошибки, которые считаем сбоем: исключения и ошибки консоли, пришедшие от скриптов самого
 * сайта. Плееры Vimeo пишут в консоль страницы много своего — защита Cloudflare внутри
 * плеера, служебный вывод `%c%d` — но это чужие сообщения, их источник не наш адрес.
 * А ошибка гидратации React придёт именно из наших скриптов и будет поймана.
 */
function watch(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 140)}`));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() !== 'error' || /Failed to load resource/.test(t)) return;
    if (!m.location().url.startsWith(BASE)) return;
    errors.push(t.slice(0, 140));
  });
  return errors;
}

/**
 * Клик так, как кликает человек: колесом долистать до ссылки и нажать мышью в её центр.
 * Обычный `page.click(selector)` для этого не годится. Он сам докручивает до элемента, и
 * на коротких страницах это сталкивается с плавной прокруткой сайта: нажатие приходится
 * мимо ссылки, на пустой элемент. Страница с плеером короче страницы с картинкой, поэтому
 * сбой проявился именно после замены картинки на ролик — и был сбоем проверки, а не страницы.
 */
async function humanClick(page, selector) {
  await page.mouse.move(700, 400);
  for (let i = 0; i < 40; i++) {
    const r = await page.evaluate((sel) => {
      const b = document.querySelector(sel).getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2, inView: b.y > 60 && b.y + b.height < innerHeight - 60 };
    }, selector);
    if (r.inView) {
      await page.waitForTimeout(600); // дать плавной прокрутке доехать
      const again = await page.evaluate((sel) => {
        const b = document.querySelector(sel).getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      }, selector);
      return page.mouse.click(again.x, again.y);
    }
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(150);
  }
  throw new Error(`не удалось долистать до ${selector}`);
}

const state = (page, id) => page.evaluate((id) => ({
  path: location.pathname,
  h1: document.querySelector('h1')?.innerText.replace(/\s+/g, ' ').trim().slice(0, 50) ?? null,
  players: [...document.querySelectorAll('iframe')].map((f) => f.src.match(/video\/(\d+)/)?.[1]).filter(Boolean),
  heroImage: Boolean(document.querySelector('article [data-framer-name="Project Image"]')),
  hasWanted: [...document.querySelectorAll('iframe')].some((f) => f.src.includes(`/video/${id}`)),
}), id);

async function waitPlayer(page, id) {
  try {
    await page.waitForFunction((id) => [...document.querySelectorAll('iframe')].some((f) => f.src.includes(`/video/${id}`)), id, { timeout: 15000 });
  } catch { /* покажем по состоянию ниже */ }
}

const report = (ok, label, s, errors) => {
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}: плееры [${s.players.join(', ') || '—'}], картинка-обложка ${s.heroImage ? 'ЕСТЬ' : 'нет'}, заголовок «${s.h1}»${errors.length ? `\n      ОШИБКИ: ${errors.join(' | ')}` : ''}`);
};

for (const [slug, url] of Object.entries(videos)) {
  const id = idOf(url);
  console.log(`\n${slug} → ролик ${id}`);

  // 1. Прямой заход, обе локали.
  for (const prefix of ['', '/en']) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errors = watch(page);
    await page.goto(`${BASE}${prefix}/projects/${slug}`, { waitUntil: 'load', timeout: 60000 });
    await waitPlayer(page, id);
    await page.waitForTimeout(1500);
    const s = await state(page, id);
    report(s.hasWanted && s.players.length === 1 && !s.heroImage && errors.length === 0, `прямой заход ${prefix || '/ru'}`, s, errors);
    await ctx.close();
  }

  // 2. Переход по ссылке из списка: данные берутся из файлов CMS.
  for (const prefix of ['', '/en']) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errors = watch(page);
    let from = null;
    for (const list of LISTS) {
      await page.goto(`${BASE}${prefix}${list}`, { waitUntil: 'load', timeout: 60000 });
      await page.waitForTimeout(2500);
      for (let i = 0; i < 6; i++) {
        const found = await page.evaluate((slug) => {
          const a = [...document.querySelectorAll('a[href]')].find((x) => x.getAttribute('href').endsWith(`/${slug}`) && x.getClientRects().length);
          if (!a) return false;
          a.setAttribute('data-go', '1');
          return true;
        }, slug);
        if (found) { from = list; break; }
        const more = await page.evaluate(() => {
          const b = [...document.querySelectorAll('a,button,div')].find((e) => /^(Ещё|More|Load more)$/i.test(e.textContent.trim()) && e.getClientRects().length && e.children.length < 3);
          if (!b) return false;
          b.setAttribute('data-more', '1');
          return true;
        });
        if (!more) break;
        await humanClick(page, '[data-more="1"]');
        await page.waitForTimeout(2000);
        await page.evaluate(() => document.querySelector('[data-more="1"]')?.removeAttribute('data-more'));
      }
      if (from) break;
    }
    if (!from) {
      // В списках кейса нет (так у People Awards) — ищем страницу, которая ведёт на него
      // ссылкой «следующий проект», и кликаем оттуда.
      const referrer = await findReferrer(slug, prefix);
      if (referrer) {
        await page.goto(`${BASE}${referrer}`, { waitUntil: 'load', timeout: 60000 });
        await page.waitForTimeout(2500);
        const found = await page.evaluate((slug) => {
          const a = [...document.querySelectorAll('a[href]')].find((x) => x.getAttribute('href').endsWith(`/${slug}`) && x.getClientRects().length);
          if (!a) return false;
          a.setAttribute('data-go', '1');
          return true;
        }, slug);
        if (found) from = `${referrer} (следующий проект)`;
      }
    }
    if (!from) {
      failed++;
      console.log(`  ✗ переход ${prefix || '/ru'}: ссылки на кейс не нашлось ни в списках, ни на других страницах`);
      await ctx.close();
      continue;
    }
    await humanClick(page, '[data-go="1"]');
    await waitPlayer(page, id);
    await page.waitForTimeout(1500);
    const s = await state(page, id);
    const rightPage = s.path.endsWith(`/projects/${slug}`);
    report(rightPage && s.hasWanted && s.players.length === 1 && !s.heroImage && errors.length === 0, `переход из ${from} ${prefix || '/ru'} → ${s.path}`, s, errors);
    await ctx.close();
  }
}

await browser.close();
console.log(failed ? `\n✗ провалено: ${failed}` : '\n✓ ролики на месте: и при прямом заходе, и после перехода по ссылке');
process.exit(failed ? 1 : 0);
