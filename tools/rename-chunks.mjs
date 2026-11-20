// Переименовать цепочкой чанки /assets/js, которые уже изменены на диске другим шагом
// (tools/cms-ranges.py правит текст, а имена — здесь, общим для всех шагов способом,
// см. tools/chunks.mjs). Запуск: node tools/rename-chunks.mjs <имя.mjs> [...]
import { loadChunks, commitChunks } from './chunks.mjs';

const names = process.argv.slice(2);
if (!names.length) {
  console.error('укажите имена изменённых чанков');
  process.exit(2);
}
const content = await loadChunks();
for (const n of names) if (!content.has(n)) throw new Error(`чанка ${n} нет в /assets/js`);
await commitChunks(content, new Set(names));
