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
import { appendFileSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { PROFILE, profileOpts, ownHosts, launchOpts } from './lib.mjs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173';
const LOCAL_HOSTS = ownHosts(BASE);

// Файлы прогона помечаем адресом, по которому он шёл. Иначе проверка боевого
// сервера «доделала» бы недоделанный локальный прогон и смешала бы результаты
// двух разных мишеней в одном отчёте. У локального адреса пометки нет — имена
// файлов остаются прежними, на них смотрит report.mjs.
const HOST = new URL(BASE).hostname;
const TAG = /^(127\.0\.0\.1|localhost)$/.test(HOST) ? PROFILE : `${PROFILE}-${HOST}`;

// Прогон возобновляемый: результат каждой страницы дописывается сюда сразу.
// Если процесс убьют на середине, повторный запуск доделает остаток.
const ROWS = `.work/audit-rows-${TAG}.jsonl`;
const loadRows = () =>
  existsSync(ROWS)
    ? readFileSync(ROWS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];

// stdout при перенаправлении в файл буферизуется поблочно, поэтому прогресс
// пишем отдельно синхронно — иначе за долгим прогоном нельзя следить.
const PROGRESS = `.work/audit-progress-${TAG}.log`;
const note = (line) => {
  appendFileSync(PROGRESS, `${new Date().toISOString().slice(11, 19)}  ${line}\n`);
  console.log(line);
};

/**
 * Осознанно оставленные исключения. Всё, что вне этого списка, — дефект копии.
 *
 * Первое: на 26 страницах стоят плееры Vimeo, решено сохранить их как есть.
 * Помимо самого Vimeo сюда входит то, что грузит уже его iframe изнутри:
 * gstatic — кнопка Chromecast, challenges.cloudflare.com — антибот Turnstile,
 * datadoghq — телеметрия плеера. Проверено: все они встречаются исключительно
 * на тех же 26 страницах и ни на одной другой.
 *
 * Второе: Google Analytics — свой счётчик владельца сайта, возвращён по его
 * просьбе уже после снятия копии (см. tools/fixes.mjs). Этот, в отличие от
 * плееров, стоит на всех страницах: если он вдруг встретится не везде — значит
 * шаг правок отработал не до конца.
 */
const ALLOWED_EXTERNAL =
  /(^|\.)(vimeo\.com|vimeocdn\.com|gstatic\.com|challenges\.cloudflare\.com|browser-intake-datadoghq\.com|googletagmanager\.com|google-analytics\.com|analytics\.google\.com)$/;

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
      await new Promise((r) => setTimeout(r, 90));
    }
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((r) => setTimeout(r, 400));
    window.scrollTo(0, 0);
  }, maxSteps);
  await page.waitForTimeout(800);
}

/**
 * Ждать networkidle нельзя: плееры Vimeo на 26 страницах держат постоянные
 * соединения, и сеть не затихает никогда — ожидание всегда упиралось в таймаут
 * и давало по 40 секунд на страницу. Фиксированной паузы после `load` хватает:
 * ленивые ресурсы всё равно догружаются прокруткой.
 */
async function settleAfterLoad(page) {
  await page.waitForTimeout(1200);
}

async function main() {
  const manifest = JSON.parse(await readFile('.work/manifest.json', 'utf8'));
  const paths = manifest.pages.map((p) => p.urlPath);

  const done = new Set(loadRows().map((r) => r.path));
  const todo = paths.filter((p) => !done.has(p));
  writeFileSync(PROGRESS, '');
  note(`профиль ${PROFILE} (${profileOpts().viewport.width}px): страниц всего ${paths.length}, уже пройдено ${done.size}, осталось ${todo.length}`);
  if (!todo.length) note('всё пройдено — только собираю отчёт');
  // С выходом в сеть: плееры Vimeo должны реально загрузиться, иначе в лог попадёт
  // один оборванный запрос вместо полного набора, который увидит настоящий посетитель.
  // ssl-version-max — обход прокси песочницы, рвущего TLS-рукопожатие Chromium.
  if (todo.length) {
    const browser = await chromium.launch(launchOpts({
      args: ['--disable-features=PostQuantumKyber,EncryptedClientHello,TLS13EarlyData', '--ssl-version-max=tls1.2'],
    }));
    const ctx = await browser.newContext(profileOpts());

    for (const [i, path] of todo.entries()) {
      const page = await ctx.newPage();
      const row = { path, requests: 0, external: [], broken: [], consoleErrors: [] };

      page.on('request', (req) => {
        row.requests++;
        const url = req.url();
        const host = new URL(url).hostname;
        if (!LOCAL_HOSTS.has(host) && !url.startsWith('data:') && !url.startsWith('blob:')) {
          row.external.push({ url, type: req.resourceType() });
        }
      });
      page.on('response', (res) => {
        if (res.status() >= 400 && LOCAL_HOSTS.has(new URL(res.url()).hostname)) {
          row.broken.push({ url: res.url(), status: res.status() });
        }
      });
      page.on('console', (msg) => {
        if (msg.type() === 'error') row.consoleErrors.push(msg.text().slice(0, 200));
      });
      page.on('pageerror', (err) => row.consoleErrors.push(`pageerror: ${err.message.slice(0, 200)}`));

      const started = Date.now();
      try {
        await page.goto(`${BASE}${path}`, { waitUntil: 'load', timeout: 45000 });
        await settleAfterLoad(page);
        await scrollThrough(page);

        // Переход в соседнюю локаль — то, что делал бы переключатель языков.
        const alt = alternateOf(path);
        await page.goto(`${BASE}${alt}`, { waitUntil: 'load', timeout: 45000 });
        await settleAfterLoad(page);
        row.alt = alt;
        row.lang = await page.evaluate(() => document.documentElement.lang);
        row.langOk = row.lang === (alt.startsWith('/en') ? 'en' : 'ru');
        if (!row.langOk) note(`  ⚠ ${path} → ${alt}: lang=${row.lang}`);
      } catch (err) {
        row.error = err.message.split('\n')[0];
        note(`  ✗ ${path}: ${row.error}`);
      }
      await page.close();
      appendFileSync(ROWS, `${JSON.stringify(row)}\n`);
      note(`  [${done.size + i + 1}/${paths.length}] ${path} — ${row.requests} запр., ${Date.now() - started}мс`);
    }
    await browser.close();
  }

  // ── Сборка отчёта из накопленных строк ────────────────────────────────────
  const rows = loadRows();
  const external = rows.flatMap((r) => (r.external || []).map((e) => ({ page: r.path, ...e })));
  const broken = rows.flatMap((r) => (r.broken || []).map((b) => ({ page: r.path, ...b })));
  const consoleErrors = rows.flatMap((r) => (r.consoleErrors || []).map((t) => ({ page: r.path, text: t })));
  const totalRequests = rows.reduce((s, r) => s + (r.requests || 0), 0);
  const results = rows;

  const report = {
    profile: PROFILE,
    viewport: profileOpts().viewport,
    base: BASE,
    pages: paths.length,
    covered: rows.length,
    totalRequests,
    external,
    externalUnexpected: external.filter((e) => !ALLOWED_EXTERNAL.test(new URL(e.url).hostname)),
    broken,
    consoleErrors,
    results,
  };
  await writeFile(`.work/audit-report-${TAG}.json`, JSON.stringify(report, null, 2));

  console.log(`\nстраниц пройдено: ${rows.length}/${paths.length} (+ переход в соседнюю локаль на каждой)`);
  console.log(`сетевых запросов всего: ${totalRequests}`);
  console.log(`смена локали корректна: ${results.filter((r) => r.langOk).length}/${rows.length}`);

  const groupByHost = (list) => {
    const by = {};
    for (const e of list) (by[new URL(e.url).hostname] ||= []).push(e);
    return by;
  };
  const allowed = external.filter((e) => ALLOWED_EXTERNAL.test(new URL(e.url).hostname));
  const unexpected = external.filter((e) => !ALLOWED_EXTERNAL.test(new URL(e.url).hostname));

  console.log(`\n=== ЗАПРОСЫ К ВНЕШНИМ ДОМЕНАМ: ${external.length} ===`);
  console.log(`\n-- разрешённое исключение (плееры Vimeo): ${allowed.length} --`);
  for (const [host, list] of Object.entries(groupByHost(allowed))) {
    const pages = new Set(list.map((e) => e.page));
    console.log(`  ${host} — ${list.length} запр. на ${pages.size} стр.`);
  }
  console.log(`\n-- НЕОЖИДАННЫЕ (должно быть пусто): ${unexpected.length} --`);
  if (unexpected.length) {
    for (const [host, list] of Object.entries(groupByHost(unexpected))) {
      console.log(`  ✗ ${host} — ${list.length} запр., напр.: ${list[0].url.slice(0, 100)} (${list[0].type}) на ${list[0].page}`);
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

  const complete = rows.length === paths.length;
  if (!complete) console.log(`\n⚠ ПРОГОН НЕПОЛНЫЙ: осталось ${paths.length - rows.length} стр. Запустите ещё раз — продолжит с места остановки.`);
  process.exit(complete && unexpected.length === 0 && uniqBroken.length === 0 ? 0 : 1);
}

main();
