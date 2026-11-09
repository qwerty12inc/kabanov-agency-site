// Проверка подмены Hagrid → Hagrid Text (tools/fixes.mjs, правка 4).
//
// Для каждого сочетания «семейство + вес», которое встречается на странице,
// спрашиваем у браузера через DevTools, каким файлом шрифта он реально рисует
// текст (CSS.getPlatformFontsForNode). Сравнивать надо именно так: computed
// style покажет "Hagrid Medium" и после подмены — имя семейства мы сохранили
// нарочно, меняется только файл за ним.
//
// Проверяем оба пути отрисовки: прямой заход и переход по ссылке внутри сайта.
// Отдельно смотрим, не качает ли браузер старые файлы Hagrid впустую.
import { chromium } from 'playwright';
import { launchOpts } from './lib.mjs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173';
const PAGES = ['/', '/en/', '/projects', '/en/projects/yango-banners', '/projects/tribute', '/ai', '/en/categories/ui'];
const NAV = [['/en/ai', '/en/projects'], ['/ai', '/projects']];

const browser = await chromium.launch(launchOpts({
  args: ['--disable-features=PostQuantumKyber,EncryptedClientHello,TLS13EarlyData', '--ssl-version-max=tls1.2'],
}));
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const oldFiles = new Set();
const newFiles = new Set();
ctx.on('request', (r) => {
  const u = r.url();
  if (!/\/assets\/fonts\/.+\.woff2/.test(u)) return;
  (u.includes('/hagrid-text-') ? newFiles : oldFiles).add(new URL(u).pathname);
});

let failed = 0;
const seen = new Map(); // "семейство вес" → postScriptName

async function inspect(page, label) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  // По одному элементу на каждое сочетание семейство+вес, у которых есть свой текст.
  const combos = await page.evaluate(() => {
    document.querySelectorAll('[data-fp]').forEach((e) => e.removeAttribute('data-fp'));
    const out = {};
    let i = 0;
    for (const el of document.querySelectorAll('body *')) {
      if (!el.getClientRects().length) continue;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!own) continue;
      const cs = getComputedStyle(el);
      const fam = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim();
      if (!/^Hagrid/.test(fam)) continue;
      const key = `${fam} ${cs.fontWeight}`;
      if (out[key]) continue;
      el.setAttribute('data-fp', String(i));
      out[key] = String(i++);
    }
    return out;
  });
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
  const rows = [];
  for (const [key, id] of Object.entries(combos)) {
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `[data-fp="${id}"]` });
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    const names = fonts.map((f) => f.postScriptName);
    const ok = names.length > 0 && names.every((n) => n.startsWith('HagridText-'));
    if (!ok) failed++;
    seen.set(key, names.join('+'));
    rows.push(`${ok ? '✓' : '✗'} ${key} → ${names.join(' + ') || '(ничего)'}`);
  }
  console.log(`  ${label}: ${rows.length ? rows.join(' | ') : 'текста Hagrid нет'}`);
  await cdp.detach();
}

console.log(`сервер ${BASE}\n\nпрямой заход:`);
for (const path of PAGES) {
  const page = await ctx.newPage();
  await page.goto(BASE + path, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(3000);
  await inspect(page, path);
  await page.close();
}

console.log('\nпереход по ссылке внутри сайта:');
for (const [from, to] of NAV) {
  const page = await ctx.newPage();
  await page.goto(BASE + from, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(3000);
  await page.evaluate((t) => {
    const a = [...document.querySelectorAll('a[href]')].find((x) => new URL(x.getAttribute('href'), location.href).pathname === t && x.getClientRects().length);
    a.setAttribute('data-go', '1');
  }, to);
  await page.click('[data-go="1"]');
  await page.waitForTimeout(5000);
  await inspect(page, `${from} → ${to}`);
  await page.close();
}

await browser.close();
console.log(`\nфайлы Hagrid Text загружены: ${[...newFiles].map((f) => f.split('/').pop()).join(', ') || 'нет'}`);
console.log(`прочие шрифты загружены (не Hagrid Text, это нормально — Inter, DM Sans и т. п.): ${[...oldFiles].map((f) => f.split('/').pop()).join(', ') || 'нет'}`);
console.log(failed ? `\n✗ текст Hagrid рисуется не Hagrid Text: ${failed}` : '\n✓ весь текст Hagrid рисуется файлами Hagrid Text');
process.exit(failed ? 1 : 0);
