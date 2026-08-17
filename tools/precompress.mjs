// Готовит .gz и .br рядом с текстовыми файлами, чтобы nginx отдавал их
// через gzip_static/brotli_static без траты CPU на каждый запрос.
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
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

let files = 0;
let rawTotal = 0;
let gzTotal = 0;
let brTotal = 0;

for await (const file of walk(ROOT)) {
  if (!EXT.has(extname(file).toLowerCase())) continue;
  const { size } = await stat(file);
  if (size < MIN) continue;
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

const mb = (n) => (n / 1e6).toFixed(1);
console.log(`сжато файлов: ${files}`);
console.log(`исходно: ${mb(rawTotal)} МБ → gzip ${mb(gzTotal)} МБ → brotli ${mb(brTotal)} МБ`);
console.log(`экономия brotli: ${(100 - (brTotal / rawTotal) * 100).toFixed(1)}%`);
