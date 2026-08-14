// Шаг 4: SEO-мета (hreflang, canonical, og:*, twitter:*) должны остаться нетронутыми.
// Сравниваем набор тегов в исходной странице и в собранной копии.
import { readFile } from 'node:fs/promises';

const TAG_RE =
  /<link\b[^>]*\brel=["'](?:canonical|alternate)["'][^>]*>|<meta\b[^>]*\b(?:property=["'](?:og:[^"']*)["']|name=["'](?:twitter:[^"']*|description)["'])[^>]*>/gi;

const tags = (html) => (html.match(TAG_RE) || []).map((t) => t.replace(/\s+/g, ' ').trim());

const manifest = JSON.parse(await readFile('.work/manifest.json', 'utf8'));
const files = [...manifest.pages.map((p) => p.file), '404.html'];

let mismatches = 0;
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
  const diff = before.filter((t) => !after.includes(t));
  if (diff.length || before.length !== after.length) {
    mismatches++;
    console.log(`РАСХОЖДЕНИЕ ${f}: было ${before.length}, стало ${after.length}`);
    for (const d of diff.slice(0, 4)) console.log(`   - ${d}`);
  }
}

console.log(`страниц проверено: ${files.length}`);
console.log(`тегов всего: ${totalTags}`);
console.log('по типам:', JSON.stringify(kinds, null, 0));
console.log(mismatches === 0 ? '✓ все SEO-теги сохранены без изменений' : `✗ расхождений: ${mismatches}`);
process.exit(mismatches === 0 ? 0 : 1);
