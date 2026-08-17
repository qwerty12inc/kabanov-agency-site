// Готовит .gz и .br рядом с текстовыми файлами, чтобы nginx отдавал их
// через gzip_static/brotli_static без траты CPU на каждый запрос.
import { readdir, readFile, writeFile, stat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { gzip, brotliCompress, constants } from 'node:zlib';
import { promisify } from 'node:util';

const gz = promisify(gzip);
const br = promisify(brotliCompress);

const ROOT = process.env.ROOT || 'site';
// .cmsdata сюда НЕ входит: загрузчик CMS сверяет длину ответа с ожидаемой, а у
// предсжатого файла Content-Length — это размер архива. Рантайм падал с
// «Request failed: Unexpected response length» и выключал интерактивность страницы.
const EXT = new Set(['.html', '.css', '.js', '.mjs', '.json', '.svg', '.xml', '.txt']);
const MIN = 1024; // мельче сжимать смысла нет

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

/**
 * Нужно ли пересжимать. Оба архива должны существовать и быть не старше
 * исходника — иначе делаем заново.
 *
 * Смысл не в экономии времени на сжатии, а в трафике заливки: `rsync` считает
 * файл изменившимся по размеру и времени правки, поэтому пересозданный архив с
 * тем же содержимым он всё равно отправит целиком. При 254 архивах это лишние
 * мегабайты на каждое обновление, даже если поменялась одна страница.
 *
 * Время правки — не самый строгий признак, но здесь достаточный: исходники
 * появляются либо из `git pull`, либо из шагов сборки, и оба ставят свежее
 * время. Если возникнут сомнения, полное пересжатие возвращается удалением
 * архивов: `find site -name '*.gz' -o -name '*.br' | xargs rm`.
 */
async function upToDate(file, mtimeMs) {
  for (const ext of ['.gz', '.br']) {
    if (!existsSync(file + ext)) return false;
    const s = await stat(file + ext);
    if (s.mtimeMs < mtimeMs) return false;
  }
  return true;
}

let files = 0;
let skipped = 0;
let rawTotal = 0;
let gzTotal = 0;
let brTotal = 0;

for await (const file of walk(ROOT)) {
  if (!EXT.has(extname(file).toLowerCase())) continue;
  const { size, mtimeMs } = await stat(file);
  if (size < MIN) continue;
  if (await upToDate(file, mtimeMs)) {
    skipped++;
    continue;
  }
  const buf = await readFile(file);
  const [g, b] = await Promise.all([
    gz(buf, { level: 9 }),
    br(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }),
  ]);
  await writeFile(`${file}.gz`, g);
  await writeFile(`${file}.br`, b);
  files++;
  rawTotal += buf.length;
  gzTotal += g.length;
  brTotal += b.length;
}

/**
 * Уборка осиротевших архивов — тех `.gz`/`.br`, у которых больше нет исходника.
 *
 * Появляются они при переименовании файлов и живут незаметно: `.gz` и `.br`
 * перечислены в `.gitignore`, поэтому переименование, пришедшее через git, их
 * не трогает — на каждой машине остаётся свой набор под старыми именами.
 * Дальше `rsync --delete` сверяется с локальным каталогом, сироту там находит
 * и вместо удаления заливает на сервер.
 *
 * Последствие не косметическое. `gzip_static` отдаёт `.gz` в ответ на запрос
 * исходного имени, даже когда самого исходника рядом уже нет. То есть старое
 * имя продолжает возвращать 200 любому браузеру, поддерживающему gzip, —
 * переименование как будто и не случалось.
 *
 * Нашли это не мы: агент на заливке заметил, что `--delete` собирается удалить
 * 10 файлов вместо 14, и раскопал причину. Здесь она закрыта на будущее.
 */
let orphans = 0;
for await (const file of walk(ROOT)) {
  const ext = extname(file).toLowerCase();
  if (ext !== '.gz' && ext !== '.br') continue;
  const source = file.slice(0, -ext.length);
  if (existsSync(source)) continue;
  await unlink(file);
  orphans++;
  console.log(`  удалён архив без исходника: ${file}`);
}

const mb = (n) => (n / 1e6).toFixed(1);
if (orphans) console.log(`архивов-сирот удалено: ${orphans}`);
console.log(`сжато файлов: ${files}${skipped ? `, пропущено без изменений: ${skipped}` : ''}`);
if (files) {
  console.log(`исходно: ${mb(rawTotal)} МБ → gzip ${mb(gzTotal)} МБ → brotli ${mb(brTotal)} МБ`);
  console.log(`экономия brotli: ${(100 - (brTotal / rawTotal) * 100).toFixed(1)}%`);
} else {
  console.log('всё уже сжато — пересобирать нечего');
}
