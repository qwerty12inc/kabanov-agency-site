// Исключить скрытые кейсы из запросов постраничных списков проектов.
//
// Зачем. Списки проектов отдают записи порциями: на главной по 4, в «Проектах»
// по 10. Карточка скрытого кейса, спрятанная стилем, место в порции всё равно
// занимала, и сетка 2×2 превращалась в 2 + 1. Правильно — чтобы скрытый кейс
// не попадал в выборку вовсе, тогда порцию добирает следующий проект.
//
// Как. В запрос списка (pageSize:N,query:F()) добавляется условие where через
// вызов window.__kdaHide. Саму функцию со списком слагов ставит fixes.mjs в
// HTML (см. tools/hidden.mjs): HTML не кэшируется намертво, поэтому список
// скрытых потом меняется без правки кода. Если функции нет, запрос прежний.
//
// Категории не трогаем: там не порции, а один запрос с limit 10 или 14, и все
// кейсы категории показываются сразу. В «3D» их было 4 вместе со скрытым — после
// скрытия честно 3, четвёртого просто нет.
//
// Переименование. Чанки /assets/js отдаются с immutable на год, и вернувшийся
// посетитель не увидел бы правку, оставив файлу старое имя. Поэтому изменённый
// чанк получает новое имя, а вместе с ним — все чанки, которые на него
// ссылаются (их содержимое меняется: в них новое имя), и так по цепочке. HTML
// кэшируется с must-revalidate и подхватывает новые имена сразу.
//
// Шаг идемпотентный: чанк, в котором уже есть __kdaHide, пропускается.
import { readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, extname } from 'node:path';

const ROOT = 'site';
const JS = join(ROOT, 'assets/js');
const TEXT_EXT = new Set(['.html', '.mjs', '.js', '.css', '.json', '.xml', '.txt']);
const MARK = '__kdaHide';

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

/** Закрывающая скобка для открывающей на позиции open. Строки в шаблонных кавычках без скобок внутри — так в этих фабриках. */
function matchBrace(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  throw new Error('несбалансированные скобки');
}

/** Пропатчить фабрики запросов постраничных списков проектов. Возвращает [новый текст, число правок]. */
function patchChunk(src) {
  let out = src;
  let count = 0;
  for (const m of src.matchAll(/pageSize:\d+,query:([A-Za-z_$][\w$]*)\(\)/g)) {
    const fn = m[1];
    const head = `${fn}=()=>({from:{alias:\``;
    const start = out.indexOf(head);
    if (start < 0) throw new Error(`фабрика запроса ${fn} не найдена`);
    const open = start + head.indexOf('({') + 1;
    const close = matchBrace(out, open);
    const obj = out.slice(open, close + 1);
    if (!obj.includes('name:`cUGfm0XTC`')) continue; // не коллекция проектов
    const alias = obj.match(/alias:`([^`]+)`/)[1];
    let patched;
    const w = obj.indexOf(',where:');
    if (w === -1) {
      patched = `${obj.slice(0, -1)},...(globalThis.${MARK}?{where:globalThis.${MARK}(\`${alias}\`)}:{})}`;
    } else {
      const wOpen = w + ',where:'.length;
      if (obj[wOpen] !== '{') throw new Error(`${fn}: where не объект — такой случай не предусмотрен`);
      const wClose = matchBrace(obj, wOpen);
      const orig = obj.slice(wOpen, wClose + 1);
      patched = `${obj.slice(0, wOpen)}(globalThis.${MARK}?globalThis.${MARK}(\`${alias}\`,${orig}):${orig})${obj.slice(wClose + 1)}`;
    }
    out = out.slice(0, open) + patched + out.slice(close + 1);
    count++;
  }
  return [out, count];
}

const newName = (name, content) => {
  const h = createHash('sha1').update(content).digest('base64url').slice(0, 8);
  // имя.ХЕШ.mjs → имя.НОВЫЙХЕШ.mjs
  return name.replace(/\.[A-Za-z0-9_-]{8}\.mjs$/, `.${h}.mjs`);
};

async function main() {
  const files = (await readdir(JS)).filter((f) => f.endsWith('.mjs'));
  const content = new Map();
  for (const f of files) content.set(f, await readFile(join(JS, f), 'utf8'));

  // 1. Патч.
  const renames = new Map(); // старое имя → новое
  let patchedQueries = 0;
  for (const f of files) {
    const src = content.get(f);
    if (!/pageSize:\d+,query:/.test(src) || src.includes(MARK)) continue;
    const [out, n] = patchChunk(src);
    if (!n) continue;
    patchedQueries += n;
    content.set(f, out);
    renames.set(f, null); // имя посчитаем после замены ссылок
    console.log(`  запрос списка пропатчен: ${f} (${n})`);
  }
  if (!renames.size) {
    console.log('менять нечего — запросы списков уже пропатчены');
    return;
  }

  // 2. Цепочка ссылающихся чанков: их содержимое тоже меняется.
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of files) {
      if (renames.has(f)) continue;
      const src = content.get(f);
      if ([...renames.keys()].some((r) => src.includes(r))) {
        renames.set(f, null);
        grew = true;
        console.log(`  ссылается на изменённый — тоже переименуется: ${f}`);
      }
    }
  }

  // 3. Новые имена: от содержимого с уже обновлёнными ссылками на других.
  // Ссылки внутри файла на самого себя заменяются после, вместе со всеми.
  for (const f of renames.keys()) renames.set(f, newName(f, content.get(f) + f));
  for (const [f, src] of content) {
    let s = src;
    for (const [from, to] of renames) s = s.split(from).join(to);
    content.set(f, s);
  }

  // 4. Запись: новые файлы, удаление старых.
  for (const [from, to] of renames) {
    await writeFile(join(JS, to), content.get(from));
    await unlink(join(JS, from));
  }
  for (const f of files) if (!renames.has(f)) await writeFile(join(JS, f), content.get(f));

  // 5. Ссылки во всех остальных текстовых файлах сайта (HTML, карты и т. п.).
  let refFiles = 0;
  for await (const p of walk(ROOT)) {
    if (p.startsWith(JS) || !TEXT_EXT.has(extname(p))) continue;
    const before = await readFile(p, 'utf8');
    let s = before;
    for (const [from, to] of renames) s = s.split(from).join(to);
    if (s !== before) {
      await writeFile(p, s);
      refFiles++;
    }
  }

  console.log(`запросов пропатчено: ${patchedQueries}, файлов переименовано: ${renames.size}, ссылки обновлены в ${refFiles} файлах`);
  for (const [from, to] of renames) console.log(`  ${from} → ${to}`);

  // 6. Проверка: старых имён нигде не осталось.
  const left = [];
  for await (const p of walk(ROOT)) {
    if (!TEXT_EXT.has(extname(p))) continue;
    const s = await readFile(p, 'utf8');
    for (const from of renames.keys()) if (s.includes(from)) left.push(`${p}: ${from}`);
  }
  if (left.length) {
    console.log('ОСТАЛИСЬ ссылки на старые имена:', left.slice(0, 5));
    process.exit(1);
  }
}

await main();
