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
// Переименование изменённых чанков цепочкой — в tools/chunks.mjs, там же объяснено, зачем.
//
// Шаг идемпотентный: чанк, в котором уже есть __kdaHide, пропускается.
import { loadChunks, commitChunks } from './chunks.mjs';

const MARK = '__kdaHide';

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

async function main() {
  const content = await loadChunks();

  const changed = new Set();
  let patchedQueries = 0;
  for (const [f, src] of content) {
    if (!/pageSize:\d+,query:/.test(src) || src.includes(MARK)) continue;
    const [out, n] = patchChunk(src);
    if (!n) continue;
    patchedQueries += n;
    content.set(f, out);
    changed.add(f);
    console.log(`  запрос списка пропатчен: ${f} (${n})`);
  }
  if (!changed.size) {
    console.log('менять нечего — запросы списков уже пропатчены');
    return;
  }
  await commitChunks(content, changed);
  console.log(`запросов пропатчено: ${patchedQueries}`);
}

await main();
