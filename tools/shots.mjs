// Шаг 6: скриншоты каждой страницы локально и на живом сайте + попиксельное сравнение.
//
// Чтобы сравнение мерило расхождения копии, а не дрожание анимаций:
//  • reducedMotion + animations:'disabled' в момент съёмки;
//  • прокрутка до конца и обратно — Framer грузит картинки лениво;
//  • ожидание document.fonts.ready — иначе ловим кадр с ещё не подставленным шрифтом.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { appendFileSync, writeFileSync } from 'node:fs';
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

async function shoot(page, url, file) {
  // networkidle как условие goto не годится: на страницах с зацикленным видео
  // сеть не затихает никогда, и ожидание всегда упирается в таймаут.
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
  await settle(page);
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
  const localBrowser = await chromium.launch({ executablePath: CHROME });
  const liveBrowser = await chromium.launch({
    executablePath: CHROME,
    proxy: { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' },
    args: LIVE_ARGS,
  });
  const ctxOpts = { viewport: VIEWPORT, deviceScaleFactor: 1, reducedMotion: 'reduce', ignoreHTTPSErrors: true };
  const localCtx = await localBrowser.newContext(ctxOpts);
  const liveCtx = await liveBrowser.newContext(ctxOpts);

  const rows = [];
  for (const [i, path] of paths.entries()) {
    const name = slug(path);
    const lf = `${OUT}/local/${name}.png`;
    const vf = `${OUT}/live/${name}.png`;
    try {
      const lp = await localCtx.newPage();
      await shoot(lp, `${LOCAL}${path}`, lf);
      await lp.close();

      const vp = await liveCtx.newPage();
      await shoot(vp, `${LIVE}${path}`, vf);
      await vp.close();

      const r = compare(await readFile(lf), await readFile(vf), `${OUT}/diff/${name}.png`);
      await writeFile(r.diffPath, r.diff);
      rows.push({ path, percent: r.percent, changed: r.changed, total: r.total, sizeLocal: r.sizeLocal, sizeLive: r.sizeLive });
      note(`  [${i + 1}/${paths.length}] ${path} — ${r.percent.toFixed(2)}%  ${r.sizeLocal} / ${r.sizeLive}`);
    } catch (err) {
      rows.push({ path, error: err.message.split('\n')[0] });
      note(`  ✗ [${i + 1}/${paths.length}] ${path}: ${err.message.split('\n')[0]}`);
    }
  }

  await localBrowser.close();
  await liveBrowser.close();

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
