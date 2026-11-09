// Сменить имя папки версии данных CMS, если данные внутри изменились.
//
// Проблема. Файлы данных CMS лежат по адресу вида
//   /assets/cms/<коллекция>/<версия>/Jo_ECrywm-chunk-default-0.cmsdata
// и на сервере отдавались с `immutable` на год. У Framer на его CDN это было верно:
// при любом изменении данных менялась папка версии. У копии папка не менялась, и
// правка данных (скрыть кейс, поставить ролик) дошла бы только до тех, кто на сайте
// впервые: вернувшийся посетитель взял бы файл из кэша и при переходе по ссылке
// внутри сайта увидел бы старую запись.
//
// Решение. Имя папки версии — хеш содержимого её файлов. Изменили данные — имя
// сменилось — старые адреса осиротели, а новые у посетителей не закэшированы. Шаг
// идемпотентный: если имя уже совпадает с хешем, ничего не происходит.
//
// Две папки с одним именем версии. Рядом с данными (`assets/cms/<коллекция>/<версия>/`)
// лежат модули самой коллекции (`assets/modules/<коллекция>/<версия>/`, там Jo_ECrywm.js
// и другие), и код ссылается на обе по одному и тому же имени. Переименовать надо обе:
// первая версия этого шага трогала только данные, и ссылка на модули повисла.
// Поймала это статическая проверка ссылок (npm run check:links), а браузерные
// сценарии — нет: модули при переходах по сайту не запрашиваются.
//
// Где имя папки записано в коде. Один раз, в shared-lib: оттуда загрузчик строит
// адреса файлов (`/assets/modules/<коллекция>/<версия>/Jo_ECrywm.js`, а `/modules/`
// потом заменяется на `/cms/`). Изменился этот чанк — переименовываются и все, кто его
// импортирует, цепочкой (tools/chunks.mjs).
//
// Версионируются только коллекции из COLLECTIONS: остальные не трогаем, чтобы не
// сбрасывать кэш без причины.
import { readdir, readFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ROOT, loadChunks, commitChunks, walk } from './chunks.mjs';

const CMS = join(ROOT, 'assets/cms');
const MODULES = join(ROOT, 'assets/modules');
const COLLECTIONS = ['iRXqyPhCWdDdBHHl7jDH']; // проекты

async function contentHash(dir) {
  const files = [];
  for await (const p of walk(dir)) files.push(p);
  files.sort();
  const h = createHash('sha1');
  for (const p of files) h.update(p.slice(dir.length)).update(await readFile(p));
  return h.digest('base64url').slice(0, 20); // той же длины, что у родных имён
}

async function main() {
  const content = await loadChunks();
  const changed = new Set();
  let bumped = 0;

  for (const coll of COLLECTIONS) {
    const versions = await readdir(join(CMS, coll));
    if (versions.length !== 1) throw new Error(`в ${coll} ожидалась одна папка версии, а их ${versions.length}`);
    const cur = versions[0];
    const want = await contentHash(join(CMS, coll, cur));

    if (cur !== want) {
      await rename(join(CMS, coll, cur), join(CMS, coll, want));
      let refs = 0;
      for (const [f, src] of content) {
        if (!src.includes(cur)) continue;
        content.set(f, src.split(cur).join(want));
        changed.add(f);
        refs++;
      }
      if (!refs) throw new Error(`имя папки версии ${cur} нигде в коде не найдено — загрузчик устроен иначе, чем ожидалось`);
      console.log(`  ${coll}: версия ${cur} → ${want} (упоминаний в ${refs} чанках)`);
      bumped++;
    } else {
      console.log(`  ${coll}: версия ${cur} уже соответствует содержимому`);
    }

    // Папка модулей должна называться так же. Проверяется всегда, а не только при смене:
    // так шаг сам чинит расхождение, оставшееся от неполного запуска.
    const modDir = join(MODULES, coll);
    if (existsSync(modDir)) {
      const mods = await readdir(modDir);
      if (mods.length !== 1) throw new Error(`в modules/${coll} ожидалась одна папка версии, а их ${mods.length}`);
      if (mods[0] !== want) {
        await rename(join(modDir, mods[0]), join(modDir, want));
        console.log(`  modules/${coll}: ${mods[0]} → ${want}`);
      }
    }
  }

  if (!bumped) {
    console.log('менять нечего');
    return;
  }
  await commitChunks(content, changed);
}

await main();
