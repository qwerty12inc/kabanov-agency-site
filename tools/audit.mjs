// Шаг 5: сетевой аудит локальной копии.
//
// Для каждой страницы: загрузка → прокрутка до конца (Framer подгружает картинки
// лениво, без прокрутки половина запросов не случится) → переход на страницу-двойник
// в другой локали. Логируются все запросы, ответы 4xx/5xx и ошибки консоли.
//
// Про «переключатель языков»: в вёрстке сайта его нет — ни одна ссылка не ведёт в
// соседнюю локаль, автоопределения языка тоже нет (проверено и на живом сайте).
// Единственный существующий переход между локалями — по URL из <link rel=alternate>,
// его и воспроизводим.
import { readFile, writeFile } from 'node:fs/promises';
import { appendFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

// stdout при перенаправлении в файл буферизуется поблочно, поэтому прогресс
// пишем отдельно синхронно — иначе за долгим прогоном нельзя следить.
const PROGRESS = '.work/audit-progress.log';
const note = (line) => {
  appendFileSync(PROGRESS, `${new Date().toISOString().slice(11, 19)}  ${line}\n`);
  console.log(line);
};

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173';
const CHROME = '/opt/pw-browsers/chromium';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

/** RU-путь ↔ EN-путь. RU живёт в корне, EN — под /en. Учитываем и `/en` без слэша. */
const alternateOf = (p) => {
  if (p === '/en' || p === '/en/') return '/';
  if (p.startsWith('/en/')) return p.slice(3);
  return p === '/' ? '/en/' : `/en${p}`;
};

/**
 * Прокрутка до конца, чтобы сработала ленивая подгрузка картинок.
 * Число шагов ограничено жёстко: прокрутка сама удлиняет страницу, и условие
 * вида `y < document.body.scrollHeight` с перечитыванием высоты не сходится.
 */
async function scrollThrough(page, maxSteps = 80) {
  await page.evaluate(async (limit) => {
    const step = Math.round(window.innerHeight * 0.8);
    let y = 0;
    for (let i = 0; i < limit; i++) {
      y += step;
      if (y > document.body.scrollHeight) break;
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((r) => setTimeout(r, 400));
    window.scrollTo(0, 0);
  }, maxSteps);
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
}

async function main() {
  const manifest = JSON.parse(await readFile('.work/manifest.json', 'utf8'));
  const paths = manifest.pages.map((p) => p.urlPath);

  writeFileSync(PROGRESS, '');
  const browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

  const external = [];   // запросы наружу — их быть не должно
  const broken = [];     // 4xx/5xx на локальном сервере — значит, ресурс не докачан
  const consoleErrors = [];
  let totalRequests = 0;
  const results = [];

  for (const [i, path] of paths.entries()) {
    const page = await ctx.newPage();
    const seen = [];

    page.on('request', (req) => {
      totalRequests++;
      const host = new URL(req.url()).hostname;
      seen.push(req.url());
      if (!LOCAL_HOSTS.has(host) && !req.url().startsWith('data:') && !req.url().startsWith('blob:')) {
        external.push({ page: path, url: req.url(), type: req.resourceType() });
      }
    });
    page.on('response', (res) => {
      if (res.status() >= 400 && LOCAL_HOSTS.has(new URL(res.url()).hostname)) {
        broken.push({ page: path, url: res.url(), status: res.status() });
      }
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push({ page: path, text: msg.text().slice(0, 200) });
    });
    page.on('pageerror', (err) => consoleErrors.push({ page: path, text: `pageerror: ${err.message.slice(0, 200)}` }));

    const started = Date.now();
    try {
      await page.goto(`${BASE}${path}`, { waitUntil: 'load', timeout: 45000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await scrollThrough(page);

      // Переход в соседнюю локаль — то, что делал бы переключатель языков.
      const alt = alternateOf(path);
      await page.goto(`${BASE}${alt}`, { waitUntil: 'load', timeout: 45000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      const lang = await page.evaluate(() => document.documentElement.lang);
      const expected = alt.startsWith('/en') ? 'en' : 'ru';
      results.push({ path, alt, lang, langOk: lang === expected, requests: seen.length });
      if (lang !== expected) note(`  ⚠ ${path} → ${alt}: lang=${lang}, ожидался ${expected}`);
    } catch (err) {
      results.push({ path, error: err.message.split('\n')[0] });
      note(`  ✗ ${path}: ${err.message.split('\n')[0]}`);
    }
    await page.close();
    note(`  [${i + 1}/${paths.length}] ${path} — ${seen.length} запр., ${Date.now() - started}мс`);
  }

  await browser.close();

  const report = { base: BASE, pages: paths.length, totalRequests, external, broken, consoleErrors, results };
  await writeFile('.work/audit-report.json', JSON.stringify(report, null, 2));

  console.log(`\nстраниц пройдено: ${paths.length} (+ переход в соседнюю локаль на каждой)`);
  console.log(`сетевых запросов всего: ${totalRequests}`);
  console.log(`смена локали корректна: ${results.filter((r) => r.langOk).length}/${paths.length}`);

  console.log(`\n=== ЗАПРОСЫ К ВНЕШНИМ ДОМЕНАМ: ${external.length} ===`);
  if (external.length) {
    const byHost = {};
    for (const e of external) {
      const h = new URL(e.url).hostname;
      (byHost[h] ||= []).push(e);
    }
    for (const [host, list] of Object.entries(byHost)) {
      console.log(`  ${host} — ${list.length} запр., напр.: ${list[0].url.slice(0, 100)} (${list[0].type}) на ${list[0].page}`);
    }
  } else {
    console.log('  список пуст');
  }

  console.log(`\n=== ОТВЕТЫ 4xx/5xx ЛОКАЛЬНО: ${broken.length} ===`);
  const uniqBroken = [...new Map(broken.map((b) => [b.url, b])).values()];
  for (const b of uniqBroken.slice(0, 25)) console.log(`  ${b.status} ${b.url.replace(BASE, '')} (напр. на ${b.page})`);
  if (uniqBroken.length > 25) console.log(`  …ещё ${uniqBroken.length - 25}`);

  console.log(`\n=== ОШИБКИ КОНСОЛИ: ${consoleErrors.length} ===`);
  const uniqErr = [...new Map(consoleErrors.map((e) => [e.text, e])).values()];
  for (const e of uniqErr.slice(0, 15)) console.log(`  ${e.text} (${e.page})`);

  process.exit(external.length === 0 && uniqBroken.length === 0 ? 0 : 1);
}

main();
