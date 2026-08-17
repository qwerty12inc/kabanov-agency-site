// Снятие следов Framer из того, что видит посетитель.
//
// Важно понимать границу. Убрать можно то, на что ссылаются только наши же
// файлы: имена файлов, метку генератора, адреса картинок для соцсетей. Нельзя
// трогать имена классов `framer-*` и атрибуты `data-framer-*` — их читает
// собственный код Framer во время работы страницы, и переименование сломает
// гидратацию. Подробнее в конце файла.
//
// Шаг идемпотентный: повторный запуск видит, что всё уже сделано, и молчит.
// Работает поверх `site/` напрямую — исходники страниц не переживают
// пересборку, а Framer уже отключён, так что `site/` теперь единственный
// источник правды.
import { readFile, writeFile, rename, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const ROOT = 'site';
const ORIGIN = 'https://kabanov.agency';

/**
 * Переименования. Слева — как называется сейчас, справа — как назовём.
 * Хеш в имени сохраняем: он от содержимого и участвует в кэшировании.
 * Рядом с каждым файлом лежат `.gz` и `.br` — их переименовываем вместе с ним,
 * иначе nginx отдаст сжатую копию под старым именем и получит 404.
 */
const RENAMES = [
  ['assets/js/framer.KNQD3WMr.mjs', 'assets/js/app.KNQD3WMr.mjs'],
  ['assets/js/framer-font-6VJIZ2IU.BV4yRwNx.mjs', 'assets/js/webfont-6VJIZ2IU.BV4yRwNx.mjs'],
  ['assets/vendor/lenis-1.3.17-framer', 'assets/vendor/lenis-1.3.17'],
];

/**
 * Расширение файлов данных CMS. Видно в панели сети браузера, поэтому меняем.
 * Тянет за собой три места вне этого файла: правила nginx (`deploy/locations.conf`,
 * там и тип содержимого, и запрет сжатия), `deploy/Caddyfile` и список исключений
 * в `tools/precompress.mjs`. Все три поправлены вместе с этим шагом.
 */
const EXT = ['.framercms', '.cmsdata'];

/** Метка генератора — то, по чему сайт определяют автоматические определялки. */
const GENERATOR_RE = /<meta name="generator" content="Framer [^"]*">/g;

const TEXT_EXT = new Set(['.html', '.mjs', '.js', '.css', '.json', '.xml', '.txt']);

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

/** Адрес картинки на CDN Framer → адрес на нашем домене. */
async function ogMap() {
  const raw = JSON.parse(await readFile('.work/asset-map.json', 'utf8'));
  const map = new Map();
  for (const [url, local] of Object.entries(raw)) {
    if (!url.includes('framerusercontent.com')) continue;
    if (!existsSync(join(ROOT, local))) continue;
    map.set(url, `${ORIGIN}/${local}`);
  }
  return map;
}

async function main() {
  // ── 1. Переименование файлов на диске ────────────────────────────────────
  let renamed = 0;
  for (const [from, to] of RENAMES) {
    for (const suffix of ['', '.gz', '.br']) {
      const src = join(ROOT, from + suffix);
      const dst = join(ROOT, to + suffix);
      if (!existsSync(src)) continue;
      if (existsSync(dst)) continue;
      await rename(src, dst);
      renamed++;
    }
  }
  // Смена расширения у файлов CMS.
  for await (const file of walk(ROOT)) {
    const i = file.indexOf(EXT[0]);
    if (i === -1) continue;
    const dst = file.slice(0, i) + EXT[1] + file.slice(i + EXT[0].length);
    if (existsSync(dst)) continue;
    await rename(file, dst);
    renamed++;
  }

  // ── 2. Замены в тексте ───────────────────────────────────────────────────
  const og = await ogMap();
  const counts = { generator: 0, og: 0, paths: 0, ext: 0, files: 0 };

  for await (const file of walk(ROOT)) {
    const dot = file.lastIndexOf('.');
    if (!TEXT_EXT.has(file.slice(dot))) continue;
    const before = await readFile(file, 'utf8');
    let s = before;

    const gen = s.match(GENERATOR_RE);
    if (gen) {
      s = s.replace(GENERATOR_RE, '');
      counts.generator += gen.length;
    }

    for (const [url, local] of og) {
      // В HTML амперсанды экранированы — учитываем оба написания.
      for (const variant of [url, url.replace(/&/g, '&amp;')]) {
        if (!s.includes(variant)) continue;
        const local2 = variant.includes('&amp;') ? local.replace(/&/g, '&amp;') : local;
        counts.og += s.split(variant).length - 1;
        s = s.split(variant).join(local2);
      }
    }

    for (const [from, to] of RENAMES) {
      // Полный путь и отдельно имя файла. Второе обязательно: чанки в
      // /assets/js импортируют друг друга относительно самих себя —
      // `import{…}from"./framer.KNQD3WMr.mjs"`, и полный путь там не
      // встречается ни разу. Замена только полного пути оставляла эти импорты
      // нетронутыми; ловилось это не проверкой ссылок (она смотрит на пути от
      // корня), а прогоном клиентской навигации.
      for (const needle of [from, from.slice(from.lastIndexOf('/') + 1)]) {
        if (!s.includes(needle)) continue;
        const to2 = needle === from ? to : to.slice(to.lastIndexOf('/') + 1);
        counts.paths += s.split(needle).length - 1;
        s = s.split(needle).join(to2);
      }
    }

    if (s.includes(EXT[0])) {
      counts.ext += s.split(EXT[0]).length - 1;
      s = s.split(EXT[0]).join(EXT[1]);
    }

    if (s !== before) {
      await writeFile(file, s);
      counts.files++;
    }
  }

  console.log(`переименовано файлов: ${renamed}`);
  console.log(`правок в тексте: ${counts.files} файлов`);
  console.log(`  метка генератора: ${counts.generator}`);
  console.log(`  адреса картинок для соцсетей: ${counts.og}`);
  console.log(`  пути переименованных файлов: ${counts.paths}`);
  console.log(`  расширение данных CMS: ${counts.ext}`);

  // ── 3. Проверка, что не осталось следов там, где их быть не должно ───────
  const leftovers = [];
  for await (const file of walk(ROOT)) {
    if (file.includes('framer')) leftovers.push(`имя файла: ${file}`);
  }
  for await (const file of walk(ROOT)) {
    if (!file.endsWith('.html')) continue;
    const s = await readFile(file, 'utf8');
    if (GENERATOR_RE.test(s)) leftovers.push(`метка генератора: ${file}`);
    if (s.includes('framerusercontent')) leftovers.push(`framerusercontent: ${file}`);
  }
  if (leftovers.length) {
    console.log('\nОСТАЛОСЬ (проверьте):');
    for (const l of leftovers.slice(0, 10)) console.log(`  ${l}`);
    process.exitCode = 1;
  } else {
    console.log('\nв именах файлов и в мета-тегах упоминаний не осталось');
  }
}

await main();

// ─────────────────────────────────────────────────────────────────────────────
// Что осознанно НЕ трогаем и почему.
//
// В разметке остаются классы вида `framer-ank9ug`, `framer-styles-preset-*`,
// атрибуты `data-framer-name`, `data-framer-component-type` и переменные CSS
// `--framer-text-color`. Только на главной их около двух тысяч.
//
// Это не забывчивость. Имена классов не просто лежат в HTML и CSS — их
// вычисляет и подставляет собственный код Framer, уже собранный в чанки в
// `/assets/js`. Часть имён там собирается из кусков во время работы страницы,
// поэтому текстовой заменой их не переименовать: HTML и CSS поменяются, а код,
// который ищет эти классы, продолжит искать старые. Результат — страница
// отрисуется, но останется неживой.
//
// Практическая сторона: имена классов видны только тому, кто откроет
// инструменты разработчика и станет читать разметку. Автоматические
// определялки технологий смотрят на другое — на метку генератора, на имена
// файлов и на домены, откуда грузятся ресурсы. Всё это мы убрали.
