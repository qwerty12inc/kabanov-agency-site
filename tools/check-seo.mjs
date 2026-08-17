// Шаг 4: SEO-мета (hreflang, canonical, og:*, twitter:*) должны остаться нетронутыми.
// Сравниваем набор тегов в исходной странице и в собранной копии.
//
// Одно исключение разрешено намеренно: `og:image` и `twitter:image` переехали с
// framerusercontent.com на наш домен (`tools/debrand.mjs`). Оставлять их на чужом
// CDN было нельзя — подписка Framer отключена, и однажды он перестанет отдавать
// файлы, а превью ссылок в мессенджерах и соцсетях молча опустеют.
//
// Исключение не «пропускаем эти теги», а проверка построже обычной: адрес обязан
// вести на наш домен И соответствующий файл обязан лежать на диске. Битую
// картинку в превью такая проверка поймает, а простое сравнение «было = стало»
// не поймало бы ничего.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const TAG_RE =
  /<link\b[^>]*\brel=["'](?:canonical|alternate)["'][^>]*>|<meta\b[^>]*\b(?:property=["'](?:og:[^"']*)["']|name=["'](?:twitter:[^"']*|description)["'])[^>]*>/gi;

const tags = (html) => (html.match(TAG_RE) || []).map((t) => t.replace(/\s+/g, ' ').trim());

const manifest = JSON.parse(await readFile('.work/manifest.json', 'utf8'));
const files = [...manifest.pages.map((p) => p.file), '404.html'];

const ORIGIN = 'https://kabanov.agency';
const assetMap = JSON.parse(await readFile('.work/asset-map.json', 'utf8'));
const decode = (s) => s.replace(/&amp;/g, '&');

/**
 * Тег превью, у которого поменялся только адрес картинки: с CDN Framer на наш.
 * Возвращает true, только если новый адрес действительно ведёт на наш домен и
 * файл лежит на диске.
 */
function rewrittenImage(before, after) {
  const url = (t) => decode(t.match(/content="([^"]+)"/)?.[1] ?? '');
  const kind = (t) => t.match(/(?:property|name)="([^"]+)"/)?.[1] ?? '';
  if (!/^(og:image|twitter:image)$/.test(kind(before))) return false;
  const was = url(before);
  if (!was.includes('framerusercontent.com')) return false;
  const local = assetMap[was];
  if (!local) return false;
  const expected = `${ORIGIN}/${local}`;
  const hit = after.find((t) => kind(t) === kind(before) && url(t) === expected);
  return Boolean(hit) && existsSync(`site/${local}`);
}

let mismatches = 0;
let rewritten = 0;
let totalTags = 0;
const kinds = {};

for (const f of files) {
  const before = tags(await readFile(`.work/pages/${f}`, 'utf8'));
  const after = tags(await readFile(`site/${f}`, 'utf8'));
  totalTags += before.length;
  for (const t of before) {
    const k = t.match(/hreflang="([^"]+)"/)
      ? `hreflang:${t.match(/hreflang="([^"]+)"/)[1]}`
      : t.match(/rel="canonical"/) ? 'canonical'
      : t.match(/property="(og:[^"]+)"/)?.[1]
      ?? t.match(/name="(twitter:[^"]+)"/)?.[1]
      ?? 'description';
    kinds[k] = (kinds[k] || 0) + 1;
  }
  const missing = before.filter((t) => !after.includes(t));
  const ok = missing.filter((t) => rewrittenImage(t, after));
  rewritten += ok.length;
  const diff = missing.filter((t) => !ok.includes(t));
  if (diff.length || before.length !== after.length) {
    mismatches++;
    console.log(`РАСХОЖДЕНИЕ ${f}: было ${before.length}, стало ${after.length}`);
    for (const d of diff.slice(0, 4)) console.log(`   - ${d}`);
  }
}

console.log(`страниц проверено: ${files.length}`);
console.log(`тегов всего: ${totalTags}`);
console.log('по типам:', JSON.stringify(kinds, null, 0));
console.log(`картинок превью переведено на свой домен: ${rewritten} (проверено, что файлы на месте)`);
console.log(mismatches === 0 ? '✓ все SEO-теги на месте' : `✗ расхождений: ${mismatches}`);
process.exit(mismatches === 0 ? 0 : 1);
