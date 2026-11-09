// Проверка скрытых кейсов (tools/fixes.mjs, HIDDEN_CASES).
//
// Скрытие обязано работать на обоих путях, которыми Framer рисует списки:
// при прямом заходе (готовый HTML) и при переходе по ссылке внутри сайта
// (браузер рисует список заново из данных CMS). Второй путь обычным `goto` не
// проверить — поэтому здесь отдельно делается клик. Плюс: страница самого кейса
// по прямой ссылке должна открываться и нести запрет индексации.
//
// И третье: первая порция постраничных списков должна быть полной. Списки
// отдают проекты порциями (главная — 4, «Проекты» — 10), и пока скрытый кейс
// только прятался стилем, он занимал в порции место: 2×2 превращалось в 2 + 1.
// Теперь он исключён из самого запроса (tools/hide-queries.mjs), и это здесь
// проверяется числом карточек.
import { chromium } from 'playwright';
import { launchOpts } from './lib.mjs';
import { HIDDEN_CASES } from './hidden.mjs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173';
const HIDDEN = process.env.HIDDEN ? process.env.HIDDEN.split(',') : HIDDEN_CASES;
// Размер первой порции постраничных списков — из pageSize в коде страниц.
const FULL = { '/': 4, '/en/': 4, '/projects': 10, '/en/projects': 10 };
const LISTS = ['/', '/projects', '/categories/3d', '/projects/performance-okko',
  '/en/', '/en/projects', '/en/categories/3d', '/en/projects/performance-okko'];

const browser = await chromium.launch(launchOpts({
  args: ['--disable-features=PostQuantumKyber,EncryptedClientHello,TLS13EarlyData', '--ssl-version-max=tls1.2'],
}));
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
let failed = 0;

/** Видимые ссылки на скрытые кейсы и число видимых карточек проектов. */
const inspect = (page) => page.evaluate((hidden) => {
  const visible = (a) => {
    const r = a.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(a).visibility !== 'hidden';
  };
  const links = [...document.querySelectorAll('a[href]')];
  return {
    leaks: links.filter((a) => hidden.some((s) => a.getAttribute('href').endsWith(`/${s}`)) && visible(a)).map((a) => a.getAttribute('href')),
    cards: new Set(links.filter((a) => /\/projects\/[^/#?]+$/.test(a.getAttribute('href')) && visible(a)).map((a) => a.getAttribute('href').split('/').pop())).size,
  };
}, HIDDEN);

console.log(`сервер ${BASE}, скрытые: ${HIDDEN.join(', ')}\n`);
console.log('прямой заход:');
for (const path of LISTS) {
  const page = await ctx.newPage();
  await page.goto(BASE + path, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(2500);
  const r = await inspect(page);
  const full = FULL[path] === undefined || r.cards === FULL[path];
  const ok = r.leaks.length === 0 && full;
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${path.padEnd(32)} видимых карточек ${String(r.cards).padStart(2)}${FULL[path] ? ` из ${FULL[path]}` : ''}${r.leaks.length ? `, ВИДНО: ${r.leaks.join(' ')}` : ''}${full ? '' : ', ПОРЦИЯ НЕПОЛНАЯ'}`);
  await page.close();
}

// Клиентский переход: стартуем со страницы, где списка нет, и кликаем в список.
console.log('\nпереход по ссылке внутри сайта:');
for (const [from, to] of [['/ai', '/projects'], ['/en/ai', '/en/projects'], ['/projects/tribute', '/projects']]) {
  const page = await ctx.newPage();
  await page.goto(BASE + from, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(2500);
  const target = await page.evaluate((t) => {
    const a = [...document.querySelectorAll('a[href]')].find((x) => new URL(x.getAttribute('href'), location.href).pathname === t && x.getClientRects().length);
    if (!a) return false;
    a.setAttribute('data-go', '1');
    return true;
  }, to);
  if (!target) { console.log(`  ? ${from} → ${to}: ссылки нет на странице`); await page.close(); continue; }
  await page.click('[data-go="1"]');
  await page.waitForTimeout(4500);
  const r = await inspect(page);
  const ok = r.leaks.length === 0 && new URL(page.url()).pathname === to && (FULL[to] === undefined || r.cards === FULL[to]);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${from} → ${to.padEnd(14)} видимых карточек ${String(r.cards).padStart(2)}${r.leaks.length ? `, ВИДНО: ${r.leaks.join(' ')}` : ''}`);
  await page.close();
}

console.log('\nстраница самого кейса по прямой ссылке:');
for (const slug of HIDDEN) {
  for (const prefix of ['', '/en']) {
    const page = await ctx.newPage();
    const res = await page.goto(`${BASE}${prefix}/projects/${slug}`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(1500);
    const robots = await page.evaluate(() => [...document.querySelectorAll('meta[name=robots]')].map((m) => m.content));
    const h1 = await page.evaluate(() => document.querySelector('h1')?.innerText.replace(/\s+/g, ' ').slice(0, 40));
    const ok = res.status() === 200 && robots.includes('noindex') && Boolean(h1);
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : '✗'} ${prefix}/projects/${slug}: ${res.status()}, robots=[${robots.join(' | ')}], «${h1}»`);
    await page.close();
  }
}

await browser.close();
console.log(failed ? `\n✗ провалено: ${failed}` : '\n✓ кейс скрыт везде, страница доступна по прямой ссылке');
process.exit(failed ? 1 : 0);
