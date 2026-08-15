// Собирает самодостаточную страницу-отчёт: контактный лист всех страниц копии
// с переключением «копия ↔ оригинал», «десктоп ↔ мобильный» и сводкой проверок.
import { readFile, writeFile } from 'node:fs/promises';

const load = async (f) => JSON.parse(await readFile(f, 'utf8'));

const thumbsD = await load('.work/thumbs-desktop.json');
const thumbsM = await load('.work/thumbs-mobile.json');
const auditD = await load('.work/audit-report-desktop.json');
const auditM = await load('.work/audit-report-mobile.json');
const shotsD = await load('.work/shots-report-desktop.json');
const shotsM = await load('.work/shots-report-mobile.json');
const assets = await load('.work/assets-report.json');

const videoPages = new Set(
  auditD.external.filter((e) => /vimeo/.test(new URL(e.url).hostname)).map((e) => e.page),
);

function summary(shots) {
  const rows = shots.rows.filter((r) => r.percent !== undefined);
  const avg = rows.reduce((s, r) => s + r.percent, 0) / rows.length;
  const max = rows.reduce((a, b) => (b.percent > a.percent ? b : a));
  return { avg, max, count: rows.length };
}
const sumD = summary(shotsD);
const sumM = summary(shotsM);

const byPathM = new Map(thumbsM.map((t) => [t.path, t]));
const pctM = new Map(shotsM.rows.map((r) => [r.path, r.percent]));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (v) => (v === null || v === undefined ? '—' : `${v.toFixed(3)}%`);

const frames = thumbsD
  .map((d) => {
    const m = byPathM.get(d.path);
    const kinds = [d.locale, videoPages.has(d.path) ? 'video' : 'novideo'].join(' ');
    const shot = (t, cls) =>
      t
        ? `<div class="shot ${cls}" style="aspect-ratio:${t.w}/${t.h}">
    <img class="a" src="${t.local}" alt="Копия страницы ${esc(t.path)}" loading="lazy" decoding="async">
    <img class="b" src="${t.live}" alt="Оригинал страницы ${esc(t.path)}" loading="lazy" decoding="async">
  </div>`
        : '';
    return `<figure class="frame" data-kind="${kinds}" data-path="${esc(d.path)}" data-d="${fmt(d.percent)}" data-m="${fmt(pctM.get(d.path))}" tabindex="0">
  ${shot(d, 'd')}
  ${shot(m, 'm')}
  <figcaption><span class="p">${esc(d.path)}</span><span class="pct d">${fmt(d.percent)}</span><span class="pct m">${fmt(pctM.get(d.path))}</span></figcaption>
</figure>`;
  })
  .join('\n');

const stats = [
  ['Страниц', '83', '82 из sitemap + 404'],
  ['Ресурсов', String(assets.assets), `${(assets.totalBytes / 1e6).toFixed(1)} МБ локально`],
  ['Десктоп 1440px', `${sumD.avg.toFixed(3)}%`, `максимум ${sumD.max.percent.toFixed(3)}%`],
  ['Мобильный 390px', `${sumM.avg.toFixed(3)}%`, `максимум ${sumM.max.percent.toFixed(3)}%`],
  ['Запросов наружу', '0', 'кроме плееров Vimeo'],
]
  .map(([k, v, n]) => `<div class="stat"><dt>${k}</dt><dd>${v}</dd><small>${n}</small></div>`)
  .join('');

const html = `<title>Контактный лист kabanov.agency</title>
<style>
:root{
  --paper:#EDEFF4; --surface:#FFFFFF; --sunk:#E3E7EF;
  --ink:#151824; --body:#3C4356; --muted:#727B92;
  --line:#D3D9E4; --accent:#2B45E0; --accent-soft:#E4E8FD; --flag:#9A5E06; --on-accent:#FFFFFF;
  --shadow:0 1px 2px rgba(21,24,36,.06),0 8px 24px rgba(21,24,36,.05);
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --paper:#0F1118; --surface:#171B26; --sunk:#12151E;
    --ink:#EDEFF5; --body:#B6BDCD; --muted:#7C879F;
    --line:#262C3B; --accent:#8CA0FF; --accent-soft:#1C2340; --flag:#E0A54A; --on-accent:#0F1118;
    --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.3);
  }
}
:root[data-theme="dark"]{
  --paper:#0F1118; --surface:#171B26; --sunk:#12151E;
  --ink:#EDEFF5; --body:#B6BDCD; --muted:#7C879F;
  --line:#262C3B; --accent:#8CA0FF; --accent-soft:#1C2340; --flag:#E0A54A; --on-accent:#0F1118;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.3);
}

*{box-sizing:border-box}
body{
  margin:0; background:var(--paper); color:var(--body);
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;
  font-size:15px; line-height:1.55; -webkit-font-smoothing:antialiased;
}
.wrap{max-width:1360px;margin:0 auto;padding:40px 24px 72px}

header{border-bottom:1px solid var(--line);padding-bottom:26px;margin-bottom:26px}
.eyebrow{
  font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin:0 0 10px
}
h1{
  margin:0 0 10px;color:var(--ink);font-size:clamp(26px,3.4vw,40px);
  font-weight:680;letter-spacing:-.028em;line-height:1.1;text-wrap:balance
}
.lede{margin:0;max-width:64ch;color:var(--body)}
.lede b{color:var(--ink);font-weight:600}

.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:1px;
  background:var(--line);border:1px solid var(--line);border-radius:10px;overflow:hidden;margin:26px 0}
.stat{background:var(--surface);padding:16px 18px}
.stat dt{font-family:ui-monospace,Menlo,monospace;font-size:10.5px;letter-spacing:.14em;
  text-transform:uppercase;color:var(--muted);margin:0 0 6px}
.stat dd{margin:0;color:var(--ink);font-size:26px;font-weight:660;letter-spacing:-.02em;
  font-variant-numeric:tabular-nums;line-height:1.1}
.stat small{display:block;margin-top:3px;font-size:12.5px;color:var(--muted)}

.bar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;
  position:sticky;top:0;z-index:5;padding:12px 0;background:var(--paper);
  border-bottom:1px solid var(--line);margin-bottom:20px}
.chips{display:flex;gap:6px;flex-wrap:wrap}
button{font:inherit;cursor:pointer}
.chip{
  font-family:ui-monospace,Menlo,monospace;font-size:11.5px;letter-spacing:.06em;
  padding:6px 12px;border-radius:999px;border:1px solid var(--line);
  background:var(--surface);color:var(--body);transition:.15s
}
.chip:hover{border-color:var(--accent);color:var(--ink)}
.chip[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}

.toggles{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap}
.seg{display:flex;align-items:center;border:1px solid var(--line);border-radius:999px;
  background:var(--surface);padding:3px}
.seg button{
  font-family:ui-monospace,Menlo,monospace;font-size:11.5px;letter-spacing:.06em;
  padding:6px 13px;border:0;border-radius:999px;background:transparent;color:var(--muted)
}
.seg button[aria-pressed="true"]{background:var(--ink);color:var(--paper)}
.hint{font-size:12.5px;color:var(--muted);flex-basis:100%}

.sheet{columns:4;column-gap:14px}
body.mobile .sheet{columns:6}
@media (max-width:1180px){.sheet{columns:3}body.mobile .sheet{columns:4}}
@media (max-width:800px){.sheet{columns:2}body.mobile .sheet{columns:3}}
@media (max-width:520px){.sheet{columns:1}body.mobile .sheet{columns:2}}
.frame{margin:0 0 14px;break-inside:avoid;display:block;
  background:var(--surface);border:1px solid var(--line);border-radius:8px;overflow:hidden;
  box-shadow:var(--shadow);cursor:zoom-in;outline:none;transition:border-color .15s}
.frame:hover,.frame:focus-visible{border-color:var(--accent)}
.frame:focus-visible{box-shadow:0 0 0 3px var(--accent-soft)}
.frame[hidden]{display:none}
.shot{position:relative;width:100%;background:var(--sunk);overflow:hidden}
.shot img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:top;display:block}
.shot .b{opacity:0;transition:opacity .18s}
body.show-live .shot .a{opacity:0}
body.show-live .shot .b{opacity:1}
.frame:hover .shot .a{opacity:0}
.frame:hover .shot .b{opacity:1}
body.show-live .frame:hover .shot .a{opacity:1}
body.show-live .frame:hover .shot .b{opacity:0}
/* Скрытый набор не декодируется браузером, поэтому оба устройства в одном файле
   не удваивают расход памяти при просмотре. */
body:not(.mobile) .shot.m,body:not(.mobile) .pct.m{display:none}
body.mobile .shot.d,body.mobile .pct.d{display:none}
figcaption{display:flex;justify-content:space-between;gap:8px;align-items:baseline;
  padding:8px 10px;border-top:1px solid var(--line);
  font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px}
figcaption .p{color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
figcaption .pct{color:var(--muted);font-variant-numeric:tabular-nums;flex:none}

dialog{border:0;padding:0;background:transparent;max-width:min(96vw,760px);width:100%}
dialog::backdrop{background:rgba(10,12,18,.82)}
.modal{background:var(--surface);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.modal .top{display:flex;justify-content:space-between;align-items:center;gap:12px;
  padding:10px 14px;border-bottom:1px solid var(--line);
  font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--ink)}
.modal .body{max-height:74vh;overflow:auto;background:var(--sunk);text-align:center}
.modal img{max-width:100%;display:inline-block;vertical-align:top}
.modal .top button{border:1px solid var(--line);background:var(--paper);color:var(--body);
  border-radius:6px;padding:5px 11px;font-family:ui-monospace,Menlo,monospace;font-size:11.5px}
.modal .top button:hover{border-color:var(--accent);color:var(--ink)}

.notes{margin-top:44px;padding-top:26px;border-top:1px solid var(--line);
  display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:26px}
.notes h2{grid-column:1/-1;margin:0;color:var(--ink);font-size:19px;font-weight:640;letter-spacing:-.015em}
.note h3{margin:0 0 5px;color:var(--ink);font-size:14px;font-weight:620}
.note p{margin:0;font-size:13.5px}
.note.flagged h3::before{content:"";display:inline-block;width:7px;height:7px;border-radius:2px;
  background:var(--flag);margin-right:7px;vertical-align:middle}
code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;
  background:var(--sunk);border:1px solid var(--line);border-radius:4px;padding:1px 5px;color:var(--ink)}
pre{margin:8px 0 0;background:var(--sunk);border:1px solid var(--line);border-radius:6px;
  padding:10px 12px;overflow-x:auto;font-family:ui-monospace,Menlo,Consolas,monospace;
  font-size:12.5px;line-height:1.7;color:var(--ink)}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>

<div class="wrap">
<header>
  <p class="eyebrow">Автономная копия · снята с Framer</p>
  <h1>Контактный лист kabanov.agency</h1>
  <p class="lede">Все <b>82 страницы</b> копии рядом с оригиналом, в двух раскладках. Наведите на кадр, чтобы увидеть живой сайт, — или переключите весь лист целиком. Среднее расхождение <b>${sumD.avg.toFixed(3)}%</b> на десктопе и <b>${sumM.avg.toFixed(3)}%</b> на мобильном; страниц с расхождением больше 2% нет ни в одной раскладке.</p>
  <dl class="stats">${stats}</dl>
</header>

<div class="bar">
  <div class="chips" id="filters">
    <button class="chip" data-f="all" aria-pressed="true">все · 82</button>
    <button class="chip" data-f="ru" aria-pressed="false">ru · 41</button>
    <button class="chip" data-f="en" aria-pressed="false">en · 41</button>
    <button class="chip" data-f="video" aria-pressed="false">с видео · ${videoPages.size}</button>
  </div>
  <div class="toggles">
    <div class="seg" role="group" aria-label="Раскладка">
      <button id="showDesktop" aria-pressed="true">десктоп</button>
      <button id="showMobile" aria-pressed="false">мобильный</button>
    </div>
    <div class="seg" role="group" aria-label="Что показывать">
      <button id="showCopy" aria-pressed="true">копия</button>
      <button id="showLive" aria-pressed="false">оригинал</button>
    </div>
  </div>
  <p class="hint">Наведение на отдельный кадр показывает противоположную сторону. Клик открывает страницу целиком.</p>
</div>

<div class="sheet" id="sheet">
${frames}
</div>

<section class="notes">
  <h2>Что стоит знать</h2>
  <div class="note">
    <h3>Как открыть у себя</h3>
    <p>Копия полностью статическая, нужен любой веб-сервер.</p>
    <pre>git clone …
npm install
npm run serve</pre>
  </div>
  <div class="note flagged">
    <h3>Плееры Vimeo</h3>
    <p>На ${videoPages.size} страницах видео осталось плеерами Vimeo — единственные обращения наружу. В России Vimeo заблокирован, там они не проиграются. Два ролика отдают 401 и на живом сайте.</p>
  </div>
  <div class="note flagged">
    <h3>og:image</h3>
    <p>Теги Open Graph сохранены без изменений и ведут на <code>framerusercontent.com</code>. После отключения подписки превью в мессенджерах перестанут открываться — переключаются командой <code>OG_LOCAL=1 npm run assets</code>.</p>
  </div>
  <div class="note">
    <h3>Чёрные блоки на месте видео</h3>
    <p>На части кадров вместо плеера — тёмная плашка про проверку соединения. Так отвечает антибот Cloudflare на сетевой путь, с которого снимались скриншоты. Плашка одинакова на обеих сторонах, поэтому расхождение этих страниц всё равно нулевое.</p>
  </div>
  <div class="note">
    <h3>Кадры обрезаны сверху</h3>
    <p>Длинные страницы в листе показаны верхней частью: полная мобильная страница доходит до 4700&nbsp;px, и целиком такие кадры сделали бы лист нечитаемым. Сравнение при этом считалось по странице целиком.</p>
  </div>
  <div class="note">
    <h3>Аналитика отключена</h3>
    <p>Вырезаны Google Analytics, GTM и телеметрия Framer. Через GTM подгружались ещё Яндекс.Метрика и Facebook Pixel. Скрипт трекинга кликов оставлен и оживёт, если вернуть <code>gtag</code>.</p>
  </div>
</section>
</div>

<dialog id="lb"><div class="modal">
  <div class="top"><span id="lbPath"></span>
    <span><button id="lbFlip">показать оригинал</button> <button id="lbClose">закрыть</button></span>
  </div>
  <div class="body"><img id="lbImg" alt=""></div>
</div></dialog>

<script>
const sheet = document.getElementById('sheet');
const frames = [...sheet.querySelectorAll('.frame')];

document.getElementById('filters').addEventListener('click', (e) => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  for (const c of e.currentTarget.querySelectorAll('.chip')) {
    c.setAttribute('aria-pressed', String(c === btn));
  }
  const f = btn.dataset.f;
  for (const fr of frames) {
    fr.hidden = f !== 'all' && !fr.dataset.kind.split(' ').includes(f);
  }
});

function pair(a, b, cls, on) {
  a.setAttribute('aria-pressed', String(!on));
  b.setAttribute('aria-pressed', String(on));
  document.body.classList.toggle(cls, on);
}
const copyBtn = document.getElementById('showCopy');
const liveBtn = document.getElementById('showLive');
copyBtn.addEventListener('click', () => pair(copyBtn, liveBtn, 'show-live', false));
liveBtn.addEventListener('click', () => pair(copyBtn, liveBtn, 'show-live', true));

const deskBtn = document.getElementById('showDesktop');
const mobBtn = document.getElementById('showMobile');
deskBtn.addEventListener('click', () => pair(deskBtn, mobBtn, 'mobile', false));
mobBtn.addEventListener('click', () => pair(deskBtn, mobBtn, 'mobile', true));

const lb = document.getElementById('lb');
const lbImg = document.getElementById('lbImg');
const lbPath = document.getElementById('lbPath');
const lbFlip = document.getElementById('lbFlip');
let current = null;
let lbLive = false;

function paint() {
  const isMobile = document.body.classList.contains('mobile');
  const shot = current.querySelector(isMobile ? '.shot.m' : '.shot.d');
  const img = shot.querySelector(lbLive ? '.b' : '.a');
  lbImg.src = img.src;
  lbImg.alt = img.alt;
  lbFlip.textContent = lbLive ? 'показать копию' : 'показать оригинал';
  lbPath.textContent = current.dataset.path + '  ·  ' +
    (isMobile ? current.dataset.m + '  ·  390px' : current.dataset.d + '  ·  1440px') +
    (lbLive ? '  ·  оригинал' : '  ·  копия');
}
function open(fr) {
  current = fr;
  lbLive = document.body.classList.contains('show-live');
  paint();
  lb.showModal();
}
for (const fr of frames) {
  fr.addEventListener('click', () => open(fr));
  fr.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(fr); }
  });
}
lbFlip.addEventListener('click', () => { lbLive = !lbLive; paint(); });
document.getElementById('lbClose').addEventListener('click', () => lb.close());
lb.addEventListener('click', (e) => { if (e.target === lb) lb.close(); });
</script>
`;

await writeFile('.work/contact-sheet.html', html);
console.log(`страница собрана: ${(Buffer.byteLength(html) / 1e6).toFixed(1)} МБ`);
console.log(`десктоп: среднее ${sumD.avg.toFixed(3)}%, максимум ${sumD.max.percent.toFixed(3)}% (${sumD.max.path})`);
console.log(`мобильный: среднее ${sumM.avg.toFixed(3)}%, максимум ${sumM.max.percent.toFixed(3)}% (${sumM.max.path})`);
