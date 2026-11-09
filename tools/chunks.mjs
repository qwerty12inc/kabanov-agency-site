// Общее для шагов, которые правят код Framer в /assets/js: переименование изменённых
// файлов цепочкой.
//
// Зачем переименовывать. Файлы в /assets отдаются с `immutable` на год: вернувшийся
// посетитель не спрашивает сервер, есть ли новая версия, а берёт файл из кэша по
// имени. Значит, изменённый файл должен получить новое имя, иначе правку увидят
// только те, кто на сайте впервые. HTML кэшируется с must-revalidate и подхватывает
// новые имена сразу.
//
// Почему цепочкой. Чанки импортируют друг друга по имени — `from"./shared-lib.Xx.mjs"`.
// Переименовали один — изменилось содержимое тех, кто его импортирует (в них теперь
// новое имя), а значит, и им нужно новое имя, и так вверх по зависимостям до самих
// страниц. Хеш в имени берётся от содержимого, поэтому одинаковый результат
// получается при любом порядке обхода.
import { readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, extname } from 'node:path';

export const ROOT = 'site';
export const JS = join(ROOT, 'assets/js');
const TEXT_EXT = new Set(['.html', '.mjs', '.js', '.css', '.json', '.xml', '.txt']);

export async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

/** Все чанки /assets/js: имя файла → текст. */
export async function loadChunks() {
  const files = (await readdir(JS)).filter((f) => f.endsWith('.mjs'));
  const content = new Map();
  for (const f of files) content.set(f, await readFile(join(JS, f), 'utf8'));
  return content;
}

const newName = (name, content) => {
  const h = createHash('sha1').update(content).digest('base64url').slice(0, 8);
  return name.replace(/\.[A-Za-z0-9_-]{8}\.mjs$/, `.${h}.mjs`);
};

/**
 * Записать изменения и переименовать цепочкой.
 *
 * @param content  Map «имя чанка → текст» после правок (из loadChunks)
 * @param changed  имена чанков, в которых текст изменён напрямую
 * @param log      функция для сообщений
 * @returns        Map «старое имя → новое»
 */
export async function commitChunks(content, changed, log = console.log) {
  const renames = new Map([...changed].map((f) => [f, null]));

  // Цепочка: чанк, ссылающийся на переименованный, тоже меняется.
  let grew = true;
  while (grew) {
    grew = false;
    for (const [f, src] of content) {
      if (renames.has(f)) continue;
      if ([...renames.keys()].some((r) => src.includes(r))) {
        renames.set(f, null);
        grew = true;
        log(`  ссылается на изменённый — тоже переименуется: ${f}`);
      }
    }
  }

  for (const f of renames.keys()) renames.set(f, newName(f, content.get(f) + f));
  for (const [f, src] of content) {
    let s = src;
    for (const [from, to] of renames) s = s.split(from).join(to);
    content.set(f, s);
  }

  for (const [from, to] of renames) {
    await writeFile(join(JS, to), content.get(from));
    await unlink(join(JS, from));
  }
  for (const [f, src] of content) if (!renames.has(f)) await writeFile(join(JS, f), src);

  // Ссылки в остальных текстовых файлах сайта: страницы, карты сайта и т. п.
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
  log(`файлов переименовано: ${renames.size}, ссылки обновлены в ${refFiles} файлах`);
  for (const [from, to] of renames) log(`  ${from} → ${to}`);

  // Проверка: старых имён нигде не осталось.
  const left = [];
  for await (const p of walk(ROOT)) {
    if (!TEXT_EXT.has(extname(p))) continue;
    const s = await readFile(p, 'utf8');
    for (const from of renames.keys()) if (s.includes(from)) left.push(`${p}: ${from}`);
  }
  if (left.length) throw new Error(`остались ссылки на старые имена: ${left.slice(0, 5).join('; ')}`);
  return renames;
}
