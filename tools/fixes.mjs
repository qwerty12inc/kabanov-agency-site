// Наши правки поверх копии — то, чего в оригинале на Framer не было.
//
// Всё остальное в этом проекте старается быть точным слепком, и это осознанно:
// пока идёт приёмка, любое расхождение с оригиналом означает ошибку переноса.
// Здесь — единственное место, где мы намеренно расходимся, каждая правка с
// обоснованием. Шаг идемпотентный: повторный запуск ничего не удваивает, а
// блок целиком переписывается, поэтому его можно гонять после каждого
// `npm run assets`.
import { readFile, writeFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = 'site';
const MARK_OPEN = '<!-- правки копии -->';
const MARK_CLOSE = '<!-- /правки копии -->';

/**
 * Правка 1. Имя следующего проекта не помещалось в узкий экран.
 *
 * Блок «Project nav item» внизу страницы проекта: слева «<< All Cases»,
 * справа имя следующего проекта. На узком экране Framer ставит их в колонку,
 * но обёртка имени свёрстана как `white-space:pre; flex:none; width:auto` —
 * то есть строка неразрывная и шириной по содержимому. При ширине окна 382px
 * она занимает 419px, центрируется и обрезается по 19px с каждой стороны.
 *
 * Проверено: на живом сайте у Framer ровно то же самое, скриншоты совпали
 * побайтово. Это не следствие переноса, а давняя особенность вёрстки — просто
 * раньше её нельзя было починить, не заходя в редактор Framer.
 *
 * Правим двумя строчками и только внутри того же брейкпоинта, который Framer
 * использует для этой секции (809.98px), чтобы на широком экране ничего не
 * поменялось. `white-space` задаём и потомкам: у обёртки его наследуют h5 и a.
 * Выравнивание задаём переменной `--framer-text-alignment`, а не `text-align`:
 * текст Framer читает выравнивание именно из неё, обычное свойство он бы
 * перебил своим.
 *
 * Селекторы начинаются с `html` не для красоты. Стоять последним в `head` мало:
 * Framer при гидратации дописывает часть стилей в `head` уже во время работы, и
 * они оказываются после нашего блока. При равной специфичности выигрывает тот,
 * кто ниже, — то есть он. Лишний `html` поднимает специфичность на единицу, и
 * порядок перестаёт что-либо решать. Проверено: без него текст переносился, но
 * выравнивание не применялось.
 *
 * Выравнивание задаём на самом `h5`, а не на обёртке: переменная на обёртке
 * значение получала, но `h5` объявлял её заново.
 *
 * И задаём через `!important` — единственный случай на весь проект, поэтому
 * с обоснованием. Правило-соперник найдено замером, а не подбором:
 * `.framer-BtgpD .framer-styles-preset-8tgqm3:not(.rich-text-wrapper)` — три
 * класса. Перебить его селектором можно, только вписав в свой те же
 * сгенерированные имена, а они держатся на хешах сборки Framer: изменится
 * хеш — правка тихо перестанет действовать, и никто этого не заметит.
 * `!important` от хешей не зависит. Побочных эффектов нет: правило живёт
 * внутри одного брейкпоинта и адресует один блок.
 *
 * Ссылка внутри наследует значение сама — пользовательские свойства
 * наследуются, отдельное правило для неё не нужно.
 */
const NEXT_PROJECT_OVERFLOW = {
  name: 'перенос имени следующего проекта на узком экране',
  needle: 'framer-ank9ug',
  css: `@media (max-width:809.98px){
html .framer-ank9ug,html .framer-ank9ug h5,html .framer-ank9ug a{white-space:normal}
html .framer-ank9ug{max-width:100%}
html .framer-ank9ug h5.framer-text{--framer-text-alignment:center!important}
}`,
};

/**
 * Правка 2. Google Analytics.
 *
 * При снятии копии вся аналитика вырезалась намеренно: чужие счётчики в
 * автономной копии — это утечка данных туда, куда владелец сайта уже не
 * заглядывает. Свой счётчик возвращаем осознанно и по просьбе владельца.
 *
 * Единственная тонкость — клиентская навигация. Framer при переходе по
 * внутренней ссылке не перезагружает страницу, а меняет адрес через
 * History API. Обычный счётчик засчитал бы только первую страницу за визит.
 * GA4 такие переходы умеет ловить сам: в «расширенной статистике» есть пункт
 * «Изменения страницы на основе событий истории браузера», и он включён по
 * умолчанию. Поэтому своего обработчика мы НЕ добавляем — он дал бы двойной
 * счёт вместе со встроенным.
 *
 * Проверено на живой копии: при клике по внутренней ссылке уходит второй
 * page_view с новым адресом. Если счётчик вдруг перестанет считать переходы —
 * смотреть в GA4: Администратор → Потоки данных → Расширенная статистика.
 */
const GOOGLE_ANALYTICS = {
  name: 'счётчик Google Analytics',
  needle: '</head>', // ставим на все страницы без исключения
  html: `<script async src="https://www.googletagmanager.com/gtag/js?id=G-S4XYP0N8G7"></script>
<script>
window.dataLayer=window.dataLayer||[];
function gtag(){dataLayer.push(arguments)}
gtag('js',new Date());
gtag('config','G-S4XYP0N8G7');
</script>`,
};

/**
 * Правка 3. Скрытые кейсы.
 *
 * «Скрыть» здесь значит «убрать из витрины», а не «удалить»: кейса нет ни в
 * одном списке, ни в «следующем проекте», ни в карте сайта, поисковикам велено
 * его не индексировать, — но по прямой ссылке страница открывается. Так не
 * ломаются ссылки, которые уже отправлены клиентам, и вернуть кейс можно,
 * просто убрав его слаг из этого списка.
 *
 * Карточки прячем стилем, а не вырезаем из HTML, и это не лень. Списки
 * проектов рисуются двумя путями: при прямом заходе — из готового HTML, а при
 * переходе по ссылке внутри сайта — заново в браузере, из данных CMS. Данные
 * CMS — двоичный формат Framer с таблицей смещений, и вырезать из него запись,
 * не сломав остальные, нельзя без разбора формата. Стиль же действует на оба
 * пути одинаково: он стоит в <head> каждой страницы и переживает клиентскую
 * навигацию, потому что <head> при ней не перезагружается. По той же причине
 * правило ставится на все страницы, а не только на те, где есть карточка.
 *
 * Карточка в разметке — это <a>, обёрнутая вокруг всей плитки, поэтому
 * спрятанная ссылка не оставляет в сетке дыры. Ссылки бывают относительными
 * («./projects/…», «../projects/…», «./…»), но все кончаются на «/слаг».
 * `!important` — потому что у Framer встречаются правила отображения с
 * большей специфичностью, а скрытие должно побеждать безусловно.
 */
const HIDDEN_CASES = ['3d-movie-muted'];

const HIDE_CASES = {
  name: 'скрытые кейсы: карточки и ссылки',
  needle: '</head>',
  css: `${HIDDEN_CASES.map((slug) => `html a[href$="/${slug}"]`).join(',')}{display:none!important}`,
};

const NOINDEX_HIDDEN = {
  name: 'скрытые кейсы: запрет индексации',
  match: (file) => HIDDEN_CASES.some((slug) => file.replace(/\\/g, '/').endsWith(`/projects/${slug}/index.html`)),
  html: '<meta name="robots" content="noindex">',
};

const FIXES = [NEXT_PROJECT_OVERFLOW, GOOGLE_ANALYTICS, HIDE_CASES, NOINDEX_HIDDEN];

/**
 * Карта сайта: записи скрытых кейсов убираются. Поисковикам незачем знать
 * про страницу, которую мы просим не индексировать.
 */
async function pruneSitemaps() {
  let removed = 0;
  for (const name of await readdir(ROOT)) {
    if (!/^sitemap.*\.xml$/.test(name)) continue;
    const path = join(ROOT, name);
    const before = await readFile(path, 'utf8');
    let xml = before;
    for (const slug of HIDDEN_CASES) {
      const re = new RegExp(`<url>(?:(?!</url>)[\\s\\S])*?/projects/${slug}</loc>(?:(?!</url>)[\\s\\S])*?</url>\\s*`, 'g');
      xml = xml.replace(re, () => {
        removed++;
        return '';
      });
    }
    if (xml !== before) await writeFile(path, xml);
  }
  // Повторный запуск законно ничего не находит, поэтому ноль — не ошибка.
  // Ошибка — если кейс где-то остался.
  for (const name of await readdir(ROOT)) {
    if (!/^sitemap.*\.xml$/.test(name)) continue;
    const xml = await readFile(join(ROOT, name), 'utf8');
    for (const slug of HIDDEN_CASES) {
      if (xml.includes(`/projects/${slug}<`)) throw new Error(`${name}: скрытый кейс ${slug} остался в карте сайта`);
    }
  }
  return removed;
}

async function* htmlFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* htmlFiles(path);
    else if (entry.name.endsWith('.html')) yield path;
  }
}

async function main() {
  const applied = new Map(FIXES.map((f) => [f.name, 0]));
  let touched = 0;
  let total = 0;

  for await (const file of htmlFiles(ROOT)) {
    total++;
    let html = await readFile(file, 'utf8');

    // Снимаем прошлый блок целиком — так правку можно переписать или убрать,
    // а не накапливать слоями.
    const from = html.indexOf(MARK_OPEN);
    if (from !== -1) {
      const to = html.indexOf(MARK_CLOSE, from);
      if (to === -1) throw new Error(`${file}: открывающая метка есть, закрывающей нет`);
      html = html.slice(0, from) + html.slice(to + MARK_CLOSE.length);
    }

    // Стили собираем в один <style>, разметку вставляем как есть. Порядок
    // внутри блока — как в FIXES.
    const css = [];
    const markup = [];
    for (const fix of FIXES) {
      const fits = fix.match ? fix.match(file, html) : html.includes(fix.needle);
      if (!fits) continue;
      if (fix.css) css.push(`/* ${fix.name} */\n${fix.css}`);
      if (fix.html) markup.push(`<!-- ${fix.name} -->\n${fix.html}`);
      applied.set(fix.name, applied.get(fix.name) + 1);
    }

    if (css.length || markup.length) {
      const parts = [];
      if (css.length) parts.push(`<style>\n${css.join('\n')}\n</style>`);
      if (markup.length) parts.push(markup.join('\n'));
      const block = `${MARK_OPEN}\n${parts.join('\n')}\n${MARK_CLOSE}`;
      // Ставим перед </head>: правка должна быть позже стилей Framer, иначе
      // при равной специфичности выиграет он.
      const head = html.lastIndexOf('</head>');
      if (head === -1) throw new Error(`${file}: не найден </head>`);
      html = html.slice(0, head) + block + html.slice(head);
      touched++;
    }

    await writeFile(file, html);
  }

  console.log(`страниц просмотрено: ${total}, правки внесены в ${touched}`);
  for (const [name, count] of applied) {
    if (count === 0) throw new Error(`правка «${name}» не подошла ни к одной странице — разметка изменилась`);
    console.log(`  ${name}: ${count} стр.`);
  }
  const pruned = await pruneSitemaps();
  console.log(`  скрытые кейсы: из карты сайта убрано записей ${pruned}${pruned ? '' : ' (уже убраны раньше)'}`);
}

await main();
