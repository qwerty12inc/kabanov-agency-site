"""Собрать текстовые страницы сайта (услуги, кейсы) из markdown в обычный HTML.

Зачем отдельно от Framer. Страницы Framer — это React-приложение: текст в них разбит на
слова, заголовки продублированы для мобильной и десктопной версии, контакты повторены
трижды. Для новых страниц ТЗ требует обратного: один H1, текст абзацами прямо в HTML,
настоящие таблицы, ответы FAQ без JavaScript. Поэтому они собираются здесь, без скриптов,
в стиле сайта (те же шрифты и цвета, такая же шапка и подвал).

Источник — markdown в формате сводного файла текстов:
    ### Title / ### Meta-описание / ### H1 / ### Блок N. Название (или ### Задача …)
Разметка блоков:
    **Подзаголовок**             отдельной строкой → <h3>
    **1  Шаг**\\nтекст           в «Как работаем» → пункт нумерованного списка
    **Вопрос?**\\nответ          в «Вопросы и ответы» → <h3> + <p>
    **Кейс**\\nтекст\\n`[Смотреть кейс]` `адрес` в «Кейсы» → карточка со ссылкой
    | таблица |, - список, `[Прислать бриф]` → <table>, <ul>, кнопка

Пометки `[?…]`, `[уточнить]`, `[на утверждение Николаю]` (раздел 3 ТЗ):
    --draft    страница собирается в .work/preview/ (не в site/, не в git — репозиторий
               публичный), с noindex, пометки подсвечены жёлтым — для показа Николаю;
    без флага  страница собирается в site/ и только если пометок нет; иначе — ошибка
               со списком строк. Так неутверждённое не может попасть на сайт.

    --draft --to-site  тот же черновик, но в site/ — чтобы посмотреть на хостинге. Страница
               с noindex, ни откуда не ссылается и не в sitemap, но доступна по адресу,
               и её HTML попадает в публичный репозиторий.

Запуск:  python3 tools/build-pages.py .work/content/design-support.md --slug services/design-support --draft
"""
import argparse
import html
import json
import re
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = 'https://kabanov.agency'
MARK = re.compile(r'\[\?[^\]]*\]|\[уточнить[^\]]*\]|\[на утверждение[^\]]*\]')
FIGMA = 'https://www.figma.com/proto/A6np5wJyAAdvY5uFyWwg0v/kda_presentation?node-id=1-6894&amp;viewport=4938%2C1095%2C0.28&amp;t=jlmRVnvuFjopZUfQ-1&amp;scaling=scale-down-width&amp;content-scaling=fixed&amp;page-id=0%3A1'
# Веер карточек «Как работаем»: на десктопе блок закрепляется, а прокрутка страницы двигает
# карточки справа налево — от «1 чуть левее центра» до «6 чуть правее центра»; наклон каждой
# карточки зависит от её расстояния до центра экрана. Без скрипта (и на узких экранах, и при
# «уменьшить движение») карточки — обычная сетка: текст в HTML от этого не зависит.
FAN_JS = '''(()=>{const pin=document.querySelector('.steps-pin');if(!pin)return;
const ol=pin.querySelector('.steps'),cards=[...ol.children],root=document.documentElement;
const ok=()=>matchMedia('(min-width:1100px)').matches&&!matchMedia('(prefers-reduced-motion: reduce)').matches;
let x0=0,x1=0,travel=1;
function layout(){root.classList.toggle('fan',ok());if(!ok()){pin.style.height='';ol.style.transform='';cards.forEach(c=>c.style.transform='');return}
const vw=innerWidth,W=cards[0].offsetWidth,step=cards[1].offsetLeft-cards[0].offsetLeft;
x0=vw/2-0.65*W-W/2;x1=vw/2+0.65*W-W/2-(cards.length-1)*step;travel=Math.max(1,x0-x1);
pin.style.height=(innerHeight+travel)+'px';update()}
function update(){if(!root.classList.contains('fan'))return;const vw=innerWidth,W=cards[0].offsetWidth,step=W+18;
const p=Math.min(1,Math.max(0,-pin.getBoundingClientRect().top/travel)),x=x0-(x0-x1)*p;
ol.style.transform='translateX('+x+'px)';
for(const li of cards){const d=Math.max(-3,Math.min(3,(x+li.offsetLeft+W/2-vw/2)/step));li.style.transform='translateY('+(d*d*10)+'px) rotate('+(d*5)+'deg)'}}
let raf=0;addEventListener('scroll',()=>{cancelAnimationFrame(raf);raf=requestAnimationFrame(update)},{passive:true});
addEventListener('resize',layout);layout()})();'''
CONFIG = ROOT / 'tools' / 'pages.json'  # адрес кнопки «Прислать бриф», адреса кейсов и т. п.


def load_config():
    return json.loads(CONFIG.read_text(encoding='utf-8')) if CONFIG.exists() else {}


def esc(s):
    return html.escape(s, quote=False)


def inline(text, cfg):
    """**жирный**, `[Кнопка]`, пометки. Пометки в обратных кавычках и без них."""
    out = []
    pos = 0
    for m in re.finditer(r'`([^`]+)`|\*\*([^*]+)\*\*|' + MARK.pattern, text):
        out.append(esc(text[pos:m.start()]))
        if m.group(1) is not None:
            inner = m.group(1)
            if MARK.fullmatch(inner):
                out.append(f'<mark class="todo">{esc(inner)}</mark>')
            else:
                out.append(f'<code>{esc(inner)}</code>')
        elif m.group(2) is not None:
            out.append(f'<strong>{inline(m.group(2), cfg)}</strong>')
        else:
            out.append(f'<mark class="todo">{esc(m.group(0))}</mark>')
        pos = m.end()
    out.append(esc(text[pos:]))
    return ''.join(out)


def marks_in(text):
    return MARK.findall(text)


def brief_button(chunk, cfg):
    """Строка вида `[Прислать бриф]` `[? куда ведёт кнопка …]`."""
    label = re.search(r'`\[([^\]?]+)\]`', chunk).group(1)
    url = cfg.get('brief_url')
    rest = ''.join(f' <mark class="todo">{esc(m)}</mark>' for m in marks_in(chunk))
    if not url and not rest:
        rest = ' <mark class="todo">[? куда ведёт кнопка]</mark>'
    return f'<p class="cta"><a class="button" href="{esc(url or "#contacts")}">{esc(label)}</a>{rest}</p>'


def is_button(chunk):
    return (bool(re.fullmatch(r'(`\[[^\]]+\]`\s*)+', chunk.strip())) and '[Смотреть кейс]' not in chunk
            and bool(re.search(r'`\[([^\]?]+)\]`', chunk)) and not MARK.fullmatch(re.search(r'`(\[[^\]]+\])`', chunk).group(1)))


def table(lines, cfg):
    rows = [[c.strip() for c in l.strip().strip('|').split('|')] for l in lines if not re.fullmatch(r'\|[\s\-|:]+\|', l.strip())]
    head, body = rows[0], rows[1:]
    th = ''.join(f'<th scope="col">{inline(c, cfg)}</th>' for c in head)
    trs = []
    for r in body:
        total = r[0].lower().startswith('итого')
        tds = ''.join(f'<td>{inline(c, cfg)}</td>' for c in r)
        trs.append(f'<tr{" class=total" if total else ""}>{tds}</tr>')
    return f'<div class="table"><table><thead><tr>{th}</tr></thead><tbody>{"".join(trs)}</tbody></table></div>'


def chunks_of(body):
    return [c.strip('\n') for c in re.split(r'\n\s*\n', body.strip()) if c.strip() and c.strip() != '---']


BOLD_LINE = re.compile(r'\*\*([^*]+)\*\*\s*(`[^`]*`\s*)*')


def render_block(name, body, cfg):
    kind = name.lower()
    parts = []
    steps, faq, cards = [], [], []
    last_h3 = ''

    def flush():
        if steps:
            parts.append('<ol class="steps">' + ''.join(steps) + '</ol>')
            steps.clear()
        if cards:
            parts.append('<div class="cards">' + ''.join(cards) + '</div>')
            cards.clear()
        if faq:
            parts.append('<div class="faq">' + ''.join(faq) + '</div>')
            faq.clear()

    for c in chunks_of(body):
        lines = c.split('\n')
        first = lines[0].strip()
        if is_button(c):
            flush()
            parts.append(brief_button(c, cfg))
        elif first.startswith('|'):
            flush()
            parts.append(table(lines, cfg))
        elif all(l.strip().startswith('- ') for l in lines):
            flush()
            cls = ''
            if 'что входит' in kind:  # плитка; «не входит» — приглушённая
                cls = ' class="tiles muted"' if last_h3.lower().startswith(('что не', 'не ')) else ' class="pills"'
            parts.append(f'<ul{cls}>' + ''.join(f'<li>{inline(l.strip()[2:], cfg)}</li>' for l in lines) + '</ul>')
        elif BOLD_LINE.fullmatch(first):
            title = BOLD_LINE.fullmatch(first).group(1).strip()
            rest = [l for l in lines[1:]]
            step = re.match(r'(\d+)\s+(.+)', title)
            if 'как работаем' in kind and step and rest:
                steps.append(f'<li><h3>{inline(step.group(2), cfg)}</h3><p>{inline(" ".join(rest), cfg)}</p></li>')
            elif 'кейсы' in kind and rest:
                link_line = rest[-1] if '[Смотреть кейс]' in rest[-1] else ''
                text = ' '.join(l for l in rest if l is not link_line)
                case = cfg.get('cases', {}).get(title.split(' — ')[0].strip(), {})
                notes = [m for m in marks_in(link_line) if not (case.get('href') and 'адрес страницы кейса' in m and ';' not in m)]
                if not case.get('img'):
                    notes.append('[? обложка кейса]')
                note = ''.join(f'<mark class="todo">{esc(m)}</mark> ' for m in notes)
                img = (f'<img src="{esc(case["img"])}" alt="{html.escape(case.get("alt", ""))}">'
                       if case.get('img') else '<span class="noimg"></span>')
                inner = f'<span class="case-img">{img}</span><h3>{inline(title, cfg)}</h3><p>{inline(text, cfg)}</p>'
                body_ = f'<a href="{esc(case["href"])}">{inner}</a>' if case.get('href') else f'<div>{inner}</div>'
                cards.append(f'<article class="case">{body_}{f"<p class=notes>{note}</p>" if note else ""}</article>')
            elif 'вопросы' in kind and rest:
                # аккордеон на <details>: ответ лежит в HTML сразу, без JavaScript (п. 4 ТЗ)
                faq.append(f'<details><summary><h3>{inline(title, cfg)}</h3></summary><p>{inline(" ".join(rest), cfg)}</p></details>')
            elif 'следующий шаг' in kind and rest:
                flush()
                parts.append(f'<h2>{inline(title, cfg)}</h2><p>{inline(" ".join(rest), cfg)}</p>')
            else:
                flush()
                last_h3 = title
                parts.append(f'<h3>{inline(title, cfg)}</h3>')
                if rest:
                    parts.append(f'<p>{inline(" ".join(rest), cfg)}</p>')
        else:
            flush()
            parts.append(f'<p>{inline(" ".join(l.strip() for l in lines), cfg)}</p>')
    flush()
    return '\n'.join(parts)


def parse(src):
    sections = re.split(r'^### (.+)$', src, flags=re.M)
    meta, blocks = {}, []
    for i in range(1, len(sections), 2):
        head, body = sections[i].strip(), sections[i + 1]
        if head in ('Title', 'Meta-описание', 'H1'):
            meta[head] = ' '.join(chunks_of(body)).strip()
        else:
            blocks.append((re.sub(r'^Блок \d+\.\s*', '', head), body))
    return meta, blocks


CSS = (ROOT / 'tools' / 'pages.css')


def render_included(name, body, cfg):
    """«Что входит»: заголовок в центре, вокруг — овалы с задачами (как «Наши услуги» на
    главной); пары «**Подзаголовок**» + абзац ниже — карточками."""
    chunks = chunks_of(body)
    pills, cards = [], []
    i = 0
    while i < len(chunks):
        c = chunks[i]
        lines = c.split('\n')
        if all(l.strip().startswith('- ') for l in lines) and not pills:
            pills = [inline(l.strip()[2:], cfg) for l in lines]
        elif BOLD_LINE.fullmatch(lines[0].strip()):
            title = BOLD_LINE.fullmatch(lines[0].strip()).group(1).strip()
            text = ' '.join(lines[1:])
            if not text and i + 1 < len(chunks) and not chunks[i + 1].startswith(('**', '- ', '|')):
                i += 1
                text = chunks[i]
            if not (text == '' and i + 1 < len(chunks) and chunks[i + 1].startswith('- ')):
                cards.append(f'<article class="fit-card"><h3>{inline(title, cfg)}</h3><p>{inline(" ".join(text.split()), cfg)}</p></article>')
        else:
            cards.append(f'<p>{inline(" ".join(c.split()), cfg)}</p>')
        i += 1
    orbit = ('<div class="orbit">' + f'<h2>{esc(name)}</h2>'
             + '<ul class="pills">' + ''.join(f'<li>{x}</li>' for x in pills) + '</ul></div>')
    fit = f'<div class="fit">{"".join(cards)}</div>' if cards else ''
    return f'<section class="included">{orbit}{fit}</section>'


def page(meta, blocks, slug, cfg, draft):
    url = f'{SITE}/{slug}'
    out = []
    for name, body in blocks:
        low = name.lower()
        inner = render_block(name, body, cfg)
        if low == 'первый абзац':
            out.append(f'<div class="lead">{inner}</div>')
        elif low == 'следующий шаг':
            out.append(f'<section class="next">{inner}</section>')
        elif low == 'что входит':
            out.append(render_included(name, body, cfg))
        elif low == 'как работаем' and '</ol>' in inner:
            ol, rest = inner.split('</ol>', 1)
            out.append(f'<section class="how"><div class="steps-pin"><div class="steps-stage"><h2>{esc(name)}</h2>\n{ol}</ol></div></div>\n{rest}</section>')
        else:
            wide = ' class="wide"' if low == 'кейсы' else ''
            out.append(f'<section{wide}><h2>{esc(name)}</h2>\n{inner}</section>')
    robots = '<meta name="robots" content="noindex, nofollow">' if draft else ''
    banner = '<div class="draft-banner">Черновик: закрыт от индексации. Жёлтым — пометки, которые нужно снять до публикации.</div>' if draft else ''
    return f'''<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(meta["Title"])}</title>
<meta name="description" content="{html.escape(meta["Meta-описание"])}">
{robots}
<link rel="canonical" href="{url}">
<meta property="og:title" content="{html.escape(meta["Title"])}">
<meta property="og:description" content="{html.escape(meta["Meta-описание"])}">
<meta property="og:url" content="{url}">
<meta property="og:type" content="website">
<link rel="icon" href="/assets/images/uwd4WCJ9i6vHzzrPSdncKju4X2Q.png">
<link rel="apple-touch-icon" href="/assets/images/HOmg6eFMv70BlOltxwxumbIqzk.png">
<style>{CSS.read_text(encoding="utf-8")}</style>
</head>
<body>
{banner}
<header class="top"><nav>
<a href="/projects">Проекты</a>
<a class="logo" href="/" aria-label="kabanov agency, на главную">kabanov<br>agency</a>
<a href="/#contacts">Контакты</a>
</nav></header>
<main>
<h1>{inline(meta["H1"], cfg)}</h1>
{chr(10).join(out)}
</main>
<footer id="contacts">
<p class="footer-title">Обсудим<br>ваши задачи?</p>
<p class="footer-sub">Мы на связи 24/7</p>
<ul class="contacts">
<li><a href="mailto:hello@kabanov.agency"><span>Почта</span><span>hello@kabanov.agency</span></a></li>
<li><a href="https://t.me/kabanov_agency"><span>Телеграм</span><span>@kabanov_agency</span></a></li>
<li><a href="https://vimeo.com/kabanovagency"><span>Vimeo</span><span>kabanov agency</span></a></li>
<li><a href="{FIGMA}"><span>Презентация</span><span>Figma</span></a></li>
</ul>
<p class="logo">kabanov<br>agency</p>
<p class="copy">© {date.today().year} ООО «КДА»</p>
</footer>
<script>{FAN_JS}</script>
</body>
</html>
'''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('source')
    ap.add_argument('--slug', required=True, help='адрес без слеша в начале, напр. services/design-support')
    ap.add_argument('--draft', action='store_true')
    ap.add_argument('--to-site', action='store_true', help='черновик положить в site/ (noindex, без ссылок и sitemap) — посмотреть вживую')
    a = ap.parse_args()
    src = Path(a.source).read_text(encoding='utf-8')
    src = re.sub(r'<!--.*?-->', '', src, flags=re.S)
    cfg = load_config()
    meta, blocks = parse(src)
    for k in ('Title', 'Meta-описание', 'H1'):
        if not meta.get(k):
            sys.exit(f'нет раздела «### {k}»')
    if not a.draft:
        bad = [(i + 1, l.strip()) for i, l in enumerate(src.split('\n')) if MARK.search(l)]
        if bad or not cfg.get('brief_url'):
            for n, l in bad[:40]:
                print(f'  {n}: {l[:140]}')
            sys.exit(f'✗ не опубликовано: пометок {len(bad)}' + ('' if cfg.get('brief_url') else ', нет brief_url в tools/pages.json'))
    base = ROOT / '.work' / 'preview' if a.draft and not a.to_site else ROOT / 'site'
    dest = base / a.slug / 'index.html'
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(page(meta, blocks, a.slug, cfg, a.draft), encoding='utf-8')
    n = len(MARK.findall(src))
    print(f'{"черновик" if a.draft else "страница"} {dest.relative_to(ROOT)}' + (f', пометок {n}' if n else ''))


if __name__ == '__main__':
    main()
