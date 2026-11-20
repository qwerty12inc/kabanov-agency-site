// Проверка списков проектов: что видно сразу (готовая разметка) и что после загрузки
// скриптов (список, собранный из данных) — одно и то же, и новый кейс в них первым.
//
// Зачем. Список на странице рисуется дважды: сервер Framer заранее вписал карточки в
// HTML, а после загрузки скриптов список строится заново — на главной и в «Проектах» из
// файлов CMS (запрос там изменён, см. tools/hide-queries.mjs), в категориях — из блока
// данных страницы. Если две версии расходятся, посетитель видит, как список
// перестраивается через секунду после открытия. После добавления кейса
// (tools/add-project.py) правятся обе — здесь проверяется, что они сошлись.
//
// Сравниваются видимые карточки по порядку (по слагам), а не HTML: карточки после
// загрузки получают другие атрибуты анимации, это нормально.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { launchOpts } from './lib.mjs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173';
const projects = JSON.parse(await readFile('tools/projects.json', 'utf8'));
const newest = Object.keys(projects)[0];
const PAGES = process.env.PAGES ? process.env.PAGES.split(',') : ['/', '/projects', '/categories/ai', '/categories/motion', '/en/', '/en/projects', '/en/categories/ai', '/en/categories/motion'];
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };

const browser = await chromium.launch(launchOpts());
let failed = 0;

const visibleSlugs = (page) => page.evaluate(() => {
  const out = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const m = a.getAttribute('href').match(/projects\/([^/#?]+)$/);
    if (!m || !a.querySelector('img')) continue; // карточка — ссылка на кейс с обложкой
    const r = a.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && getComputedStyle(a).visibility !== 'hidden') out.push({ slug: m[1], x: Math.round(r.x), y: Math.round(r.y + scrollY) });
  }
  // порядок чтения: сверху вниз, слева направо (в категориях карточки в колонках)
  out.sort((a, b) => a.y - b.y || a.x - b.x);
  return out.map((c) => c.slug);
});

console.log(`сервер ${BASE}, новый кейс ${newest}\n`);
for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
  for (const path of PAGES) {
    // «Как есть в HTML»: скрипты сайта не загружаются, остаётся готовая разметка
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    await page.route(/\.m?js(\?|$)/, (r) => r.abort());
    await page.goto(BASE + path, { waitUntil: 'load', timeout: 60000 });
    // без скриптов карточки скрыты анимацией появления (opacity:0) — делаем видимыми, порядок от этого не меняется
    await page.addStyleTag({ content: '*{opacity:1!important;transform:none!important}' });
    const ssr = await visibleSlugs(page);
    await ctx.close();

    const ctx2 = await browser.newContext({ viewport });
    const page2 = await ctx2.newPage();
    const errors = [];
    page2.on('pageerror', (e) => errors.push(e.message.slice(0, 120)));
    await page2.goto(BASE + path, { waitUntil: 'load', timeout: 60000 });
    await page2.waitForTimeout(3500);
    await page2.addStyleTag({ content: '*{opacity:1!important;transform:none!important}' });
    const live = await visibleSlugs(page2);
    await ctx2.close();

    const same = JSON.stringify(ssr) === JSON.stringify(live);
    const first = live[0] === newest;
    const ok = same && first && errors.length === 0 && live.length > 0;
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : '✗'} ${vpName.padEnd(7)} ${path.padEnd(18)} карточек ${String(live.length).padStart(2)}, первая ${live[0]}` +
      (same ? '' : `\n      РАЗМЕТКА: ${ssr.join(' ')}\n      ПОСЛЕ:    ${live.join(' ')}`) +
      (first ? '' : ', НОВЫЙ КЕЙС НЕ ПЕРВЫЙ') + (errors.length ? `\n      ОШИБКИ: ${errors.join(' | ')}` : ''));
  }
}

await browser.close();
console.log(failed ? `\n✗ провалено: ${failed}` : '\n✓ списки сразу такие, какими остаются после загрузки, новый кейс первым');
process.exit(failed ? 1 : 0);
