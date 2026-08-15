// Шаг 6: скриншоты каждой страницы локально и на живом сайте + попиксельное сравнение.
//
// Чтобы сравнение мерило расхождения копии, а не дрожание анимаций:
//  • reducedMotion + animations:'disabled' в момент съёмки;
//  • прокрутка до конца и обратно — Framer грузит картинки лениво;
//  • ожидание document.fonts.ready — иначе ловим кадр с ещё не подставленным шрифтом.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { appendFileSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const LOCAL = process.env.BASE_URL || 'http://127.0.0.1:4173';
const LIVE = 'https://kabanov.agency';
const CHROME = '/opt/pw-browsers/chromium';
const OUT = 'shots';
const THRESHOLD = Number(process.env.THRESHOLD || 2); // % расхождения для попадания в отчёт
const VIEWPORT = { width: 1440, height: 900 };

// Прокси песочницы рвёт TLS-рукопожатие Chromium с современными расширениями,
// поэтому для живого сайта фиксируем TLS 1.2. На вёрстку это не влияет.
const LIVE_ARGS = [
  '--disable-features=PostQuantumKyber,EncryptedClientHello,TLS13EarlyData',
  '--ssl-version-max=tls1.2',
];

const slug = (p) => (p === '/' ? 'home' : p.replace(/^\//, '').replace(/\//g, '_'));

// Прогон возобновляемый: снятые PNG остаются на диске и переиспользуются,
// поэтому повторный запуск доснимает только недостающие страницы.
const ROWS = '.work/shots-rows.jsonl';
const loadRows = () =>
  existsSync(ROWS)
    ? readFileSync(ROWS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];

// stdout при перенаправлении в файл буферизуется поблочно — прогресс пишем синхронно.
const PROGRESS = '.work/shots-progress.log';
const note = (line) => {
  appendFileSync(PROGRESS, `${new Date().toISOString().slice(11, 19)}  ${line}\n`);
  console.log(line);
};

async function settle(page, maxSteps = 80) {
  // Шагов ограниченное число: прокрутка сама удлиняет страницу, и условие
  // `y < document.body.scrollHeight` с перечитыванием высоты не сходится.
  await page.evaluate(async (limit) => {
    const step = Math.round(window.innerHeight * 0.8);
    let y = 0;
    for (let i = 0; i < limit; i++) {
      y += step;
      if (y > document.body.scrollHeight) break;
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 150));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 500));
  }, maxSteps);
  // .then(() => true): сам FontFaceSet через мост Playwright не сериализуется.
  await page.evaluate(() => document.fonts.ready.then(() => true)).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(700);
}

/**
 * Плееры Vimeo в iframe грузятся дольше самой страницы. Если снять кадр раньше,
 * на одной стороне окажется плеер, а на другой — пустое место, и сравнение
 * покажет расхождение в 2-3% там, где копия ни при чём (наблюдалось в обе
 * стороны: и живой без плеера, и копия без плеера).
 */
async function waitForVimeo(page, timeout = 20000) {
  const deadline = Date.now() + timeout;
  // Сначала дать iframe'ам появиться в DOM.
  while (Date.now() < deadline) {
    if (page.frames().some((f) => /player\.vimeo\.com/.test(f.url()))) break;
    await page.waitForTimeout(300);
  }
  const frames = page.frames().filter((f) => /player\.vimeo\.com/.test(f.url()));
  if (!frames.length) return 0;
  // Затем дождаться, пока внутри отрисуется постер или само видео.
  await Promise.all(
    frames.map((f) =>
      f.waitForSelector('video, .vp-video, .vp-preview, [class*=poster]', {
        timeout: Math.max(1000, deadline - Date.now()),
      }).catch(() => {}),
    ),
  );
  await page.waitForTimeout(2000);
  return frames.length;
}

async function shoot(page, url, file) {
  // networkidle как условие goto не годится: на страницах с зацикленным видео
  // сеть не затихает никогда, и ожидание всегда упирается в таймаут.
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
  await settle(page);
  await waitForVimeo(page);
  await page.screenshot({ path: file, fullPage: true, animations: 'disabled', caret: 'hide' });
}

/** Сравнение с выравниванием по максимальной высоте: недостающее добиваем прозрачным. */
function compare(aBuf, bBuf, diffPath) {
  const a = PNG.sync.read(aBuf);
  const b = PNG.sync.read(bBuf);
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const pad = (img) => {
    if (img.width === width && img.height === height) return img;
    const out = new PNG({ width, height });
    PNG.bitblt(img, out, 0, 0, Math.min(img.width, width), Math.min(img.height, height), 0, 0);
    return out;
  };
  const pa = pad(a);
  const pb = pad(b);
  const diff = new PNG({ width, height });
  const changed = pixelmatch(pa.data, pb.data, diff.data, width, height, { threshold: 0.1 });
  return {
    changed,
    total: width * height,
    percent: (changed / (width * height)) * 100,
    sizeLocal: `${a.width}×${a.height}`,
    sizeLive: `${b.width}×${b.height}`,
    diff: PNG.sync.write(diff),
    diffPath,
  };
}

async function main() {
  const manifest = JSON.parse(await readFile('.work/manifest.json', 'utf8'));
  const paths = manifest.pages.map((p) => p.urlPath);
  await mkdir(`${OUT}/local`, { recursive: true });
  await mkdir(`${OUT}/live`, { recursive: true });
  await mkdir(`${OUT}/diff`, { recursive: true });

  writeFileSync(PROGRESS, '');
  const measured = new Set(loadRows().map((r) => r.path));
  const todo = paths.filter((p) => !measured.has(p));
  note(`страниц всего ${paths.length}, уже сравнено ${measured.size}, осталось ${todo.length}`);

  let localBrowser;
  let liveBrowser;
  let localCtx;
  let liveCtx;
  const ensureBrowsers = async () => {
    if (localBrowser) return;
    // Локальному браузеру даём тот же выход в сеть, что и «живому». На 26 страницах
    // стоят плееры Vimeo; без доступа наружу они отрисовались бы только на живом
    // сайте, и сравнение показало бы расхождение там, где копия ни при чём.
    const opts = {
      executablePath: CHROME,
      proxy: { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' },
      args: LIVE_ARGS,
    };
    localBrowser = await chromium.launch(opts);
    liveBrowser = await chromium.launch(opts);
    const ctxOpts = { viewport: VIEWPORT, deviceScaleFactor: 1, reducedMotion: 'reduce', ignoreHTTPSErrors: true };
    localCtx = await localBrowser.newContext(ctxOpts);
    liveCtx = await liveBrowser.newContext(ctxOpts);
  };

  for (const [i, path] of todo.entries()) {
    const name = slug(path);
    const lf = `${OUT}/local/${name}.png`;
    const vf = `${OUT}/live/${name}.png`;
    const n = measured.size + i + 1;
    try {
      // Каждая сторона снимается независимо: после пересборки копии достаточно
      // удалить shots/local, живые снимки останутся и переснимать их не нужно.
      const jobs = [];
      if (!existsSync(lf)) {
        await ensureBrowsers();
        jobs.push(async () => {
          const lp = await localCtx.newPage();
          try { await shoot(lp, `${LOCAL}${path}`, lf); } finally { await lp.close(); }
        });
      }
      if (!existsSync(vf)) {
        await ensureBrowsers();
        jobs.push(async () => {
          const vp = await liveCtx.newPage();
          try { await shoot(vp, `${LIVE}${path}`, vf); } finally { await vp.close(); }
        });
      }
      // Обе стороны параллельно: браузеры разные, друг другу не мешают.
      await Promise.all(jobs.map((j) => j()));

      const r = compare(await readFile(lf), await readFile(vf), `${OUT}/diff/${name}.png`);
      await writeFile(r.diffPath, r.diff);
      const row = { path, percent: r.percent, changed: r.changed, total: r.total, sizeLocal: r.sizeLocal, sizeLive: r.sizeLive };
      appendFileSync(ROWS, `${JSON.stringify(row)}\n`);
      note(`  [${n}/${paths.length}] ${path} — ${r.percent.toFixed(2)}%  ${r.sizeLocal} / ${r.sizeLive}`);
    } catch (err) {
      const row = { path, error: err.message.split('\n')[0] };
      appendFileSync(ROWS, `${JSON.stringify(row)}\n`);
      note(`  ✗ [${n}/${paths.length}] ${path}: ${row.error}`);
    }
  }

  await localBrowser?.close();
  await liveBrowser?.close();

  const rows = loadRows();
  rows.sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1));
  await writeFile('.work/shots-report.json', JSON.stringify({ threshold: THRESHOLD, viewport: VIEWPORT, rows }, null, 2));

  const ok = rows.filter((r) => r.percent !== undefined);
  const over = ok.filter((r) => r.percent > THRESHOLD);
  const failed = rows.filter((r) => r.error);

  console.log(`\nсравнено страниц: ${ok.length}/${paths.length}`);
  if (ok.length) {
    const avg = ok.reduce((s, r) => s + r.percent, 0) / ok.length;
    console.log(`среднее расхождение: ${avg.toFixed(3)}%`);
    console.log(`медиана: ${ok.map((r) => r.percent).sort((a, b) => a - b)[Math.floor(ok.length / 2)].toFixed(3)}%`);
  }
  console.log(`\n=== РАСХОЖДЕНИЕ БОЛЬШЕ ${THRESHOLD}%: ${over.length} ===`);
  for (const r of over) {
    console.log(`  ${r.percent.toFixed(2).padStart(6)}%  ${r.path.padEnd(42)} локально ${r.sizeLocal} / живой ${r.sizeLive}`);
  }
  if (!over.length) console.log('  таких страниц нет');

  console.log(`\n=== топ-10 по расхождению ===`);
  for (const r of ok.slice(0, 10)) {
    console.log(`  ${r.percent.toFixed(3).padStart(7)}%  ${r.path.padEnd(42)} ${r.sizeLocal} / ${r.sizeLive}`);
  }
  if (failed.length) {
    console.log(`\n=== не удалось снять: ${failed.length} ===`);
    for (const f of failed) console.log(`  ${f.path}: ${f.error}`);
  }
}

main();
