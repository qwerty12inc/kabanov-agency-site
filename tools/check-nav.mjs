// Проверка клиентской навигации — того пути, который обычный аудит не задевает.
//
// Аудит ходит по страницам через goto, то есть каждый раз перезагружает документ.
// Framer же при клике по внутренней ссылке никуда не перезагружается, а дотягивает
// данные CMS отдельными запросами. Именно там пряталась ошибка «Unexpected response
// length»: загрузчик просит куски файла query-параметром `?range=`, который понимает
// только CDN Framer, а статический сервер отдаёт файл целиком.
//
// Сравниваем результат перехода с прямой загрузкой той же страницы: содержимое
// должно совпасть, консоль — молчать.
import { chromium } from 'playwright';
import { PROFILE, profileOpts, ownHosts, launchOpts } from './lib.mjs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173';
const OWN_HOSTS = ownHosts(BASE);

// Откуда начинаем переход. Ссылку ищем в самой странице, а не по заранее
// записанному селектору: разметка Framer строит href относительными и они
// отличаются от страницы к странице.
const STARTS = ['/', '/projects', '/categories/ui', '/ai', '/en/', '/en/projects', '/en/categories/ui', '/en/ai'];

/** Первая внутренняя ссылка на другую страницу: её индекс среди всех a[href]. */
const pickLink = (page) =>
  page.evaluate(() => {
    const here = location.pathname.replace(/\/$/, '');
    const all = [...document.querySelectorAll('a[href]')];
    for (let i = 0; i < all.length; i++) {
      const href = all[i].getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('mailto:')) continue;
      let u;
      try {
        u = new URL(href, location.href);
      } catch {
        continue;
      }
      if (u.origin !== location.origin) continue;
      if (u.hash) continue;
      if (u.pathname.replace(/\/$/, '') === here) continue;
      return { index: i, path: u.pathname };
    }
    return null;
  });

const snapshot = (page) =>
  page.evaluate(() => ({
    path: location.pathname,
    h1: document.querySelector('h1')?.innerText?.trim().slice(0, 60) ?? null,
    links: document.querySelectorAll('a[href]').length,
  }));

async function main() {
  const browser = await chromium.launch(launchOpts({
    args: ['--disable-features=PostQuantumKyber,EncryptedClientHello,TLS13EarlyData', '--ssl-version-max=tls1.2'],
  }));
  const ctx = await browser.newContext(profileOpts());

  let failed = 0;
  console.log(`профиль ${PROFILE}, сервер ${BASE}\n`);

  for (const from of STARTS) {
    const page = await ctx.newPage();
    // Считаем только настоящие сбои копии: исключения в скриптах и 4xx/5xx со
    // своего же сервера. Строка «Failed to load resource» без этого прилетала бы
    // от приватных роликов Vimeo, которые отдают 401 и на живом сайте.
    const errors = [];
    page.on('console', (m) => {
      const t = m.text();
      if (m.type() === 'error' && !/Failed to load resource/.test(t)) {
        errors.push(t.slice(0, 100).replace(/\n/g, ' '));
      }
    });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 100)}`));
    page.on('response', (r) => {
      const u = new URL(r.url());
      if (OWN_HOSTS.has(u.hostname) && r.status() >= 400) {
        errors.push(`${r.status()} ${u.pathname}`);
      }
    });

    try {
      await page.goto(`${BASE}${from}`, { waitUntil: 'load', timeout: 45000 });
      await page.waitForTimeout(3000);
      const target = await pickLink(page);
      if (!target) throw new Error('внутренних ссылок на странице нет');

      const anchors = await page.$$('a[href]');
      await anchors[target.index].click();
      await page.waitForTimeout(4500);
      const after = await snapshot(page);

      // Эталон: та же страница, загруженная напрямую.
      await page.goto(`${BASE}${target.path}`, { waitUntil: 'load', timeout: 45000 });
      await page.waitForTimeout(3000);
      const direct = await snapshot(page);

      const pathOk = after.path.replace(/\/$/, '') === target.path.replace(/\/$/, '');
      const contentOk = after.h1 === direct.h1 && after.links === direct.links;
      const quiet = errors.length === 0;
      const verdict = pathOk && contentOk && quiet;
      if (!verdict) failed++;
      console.log(
        `  ${verdict ? '✓' : '✗'} ${from.padEnd(20)} → ${target.path.padEnd(26)} ` +
          `путь ${pathOk ? 'ок' : `«${after.path}»`}, содержимое ${contentOk ? 'совпало' : `«${after.h1}» ≠ «${direct.h1}»`}` +
          (quiet ? '' : `, ОШИБКИ: ${[...new Set(errors)][0]}`),
      );
    } catch (err) {
      failed++;
      console.log(`  ✗ ${from}: ${err.message.split('\n')[0]}`);
    }
    await page.close();
  }

  await browser.close();
  console.log(failed === 0 ? '\n✓ клиентская навигация работает' : `\n✗ провалено переходов: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
