// Статическая проверка: каждая ссылка вида /assets/… должна указывать на файл,
// который реально лежит на диске. Ловит ресурсы, пропущенные при сборе,
// не поднимая браузер.
import { readdir, readFile, access } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOT = 'site';
const SCAN_EXT = new Set(['.html', '.mjs', '.js', '.css', '.json']);
const REF_RE = /["'`(]\/assets\/[^"'`)\s\\]+/g;

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

// Не адреса, а префиксы для startsWith() — по ним рантайм определяет источник
// шрифта. Файлов с такими именами не существует и не должно.
const PREFIX_LITERALS = new Set(['/assets/fonts/gstatic-', '/assets/fonts/fontshare-']);

const missing = new Map();
let refs = 0;
let scanned = 0;

for await (const file of walk(ROOT)) {
  if (!SCAN_EXT.has(extname(file).toLowerCase())) continue;
  scanned++;
  const text = await readFile(file, 'utf8');
  for (const m of text.matchAll(REF_RE)) {
    const ref = m[0].slice(1).split('?')[0].split('#')[0];
    if (PREFIX_LITERALS.has(ref)) continue;
    refs++;
    try {
      await access(join(ROOT, ref));
    } catch {
      if (!missing.has(ref)) missing.set(ref, new Set());
      missing.get(ref).add(file);
    }
  }
}

console.log(`просмотрено файлов: ${scanned}`);
console.log(`ссылок на /assets: ${refs}`);
console.log(`битых: ${missing.size}`);
for (const [ref, from] of [...missing].slice(0, 30)) {
  console.log(`  ✗ ${ref}\n      из: ${[...from].slice(0, 3).join(', ')}`);
}
process.exit(missing.size ? 1 : 0);
