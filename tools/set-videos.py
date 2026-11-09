"""Поставить ролики Vimeo в кейсы: tools/videos.json, слаг → адрес.

Запуск из корня репозитория: python3 tools/set-videos.py (нужен только стандартный
Python). Шаг идемпотентный: что уже стоит как надо — пропускается.

Зачем он нужен. Видео кейса — поле `YoYO4a9Bc` в записи проекта. Запись живёт в трёх
местах, и править надо все:
  1. данные CMS (`site/assets/cms/**/*.cmsdata`) — оттуда страница берёт запись при
     переходе по ссылке внутри сайта; по одному файлу на локаль плюс файл индексов;
  2. «передаточный» блок в самой странице (`__framer__handoverData`) — оттуда запись
     берёт страница при прямом заходе, на каждую локаль своя копия;
  3. готовая разметка страницы: у кейса с видео стоит контейнер плеера, у кейса без
     видео — картинка.

Ловушка, из-за которой одно из двух видео не работало. Компонент плеера принимает
только адрес с числом сразу после `vimeo.com/` (правило /^https?:\\/\\/vimeo\\.com\\/(\\d+)/).
Ссылка «поделиться» вида vimeo.com/kabanovagency/vkpeopleawards числа не содержит:
плееру уходил id 0, и он молча ничего не рисовал. Так было и на Framer. Поэтому здесь
принимаются только адреса с числом — `vimeo.com/<номер>`; номер ролика берётся из
oEmbed (https://vimeo.com/api/oembed.json?url=<ссылка>, поле video_id).

После этого шага нужен tools/cms-version.mjs: файлы данных CMS у посетителей лежат в
кэше, и без смены имени папки версии они продолжат видеть старую запись.
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cmsdata  # noqa: E402

ROOT = Path('site')
FIELD = 'YoYO4a9Bc'          # главное видео записи проекта
SLUG_FIELD = 'cUGfm0XTC'
URL_RE = re.compile(r'^https://vimeo\.com/\d+$')

HANDOVER = re.compile(r'(<script type="framer/handover" id="__framer__handoverData">)(.*?)(</script>)', re.S)

# Контейнер плеера в готовой разметке — как у любого кейса с видео (проверено на
# VK • People Awards). Плеер дорисовывает уже браузер, поэтому внутри пусто.
PLAYER_SSR = (
    '<div class="framer-18c4zth-container"><!--$--><div borderradius="0" bottomleftradius="0" '
    'bottomrightradius="0" height="100%" id="DCZHhK26S" topleftradius="0" toprightradius="0" '
    'width="100%" style="--background-rgb:rgba(0, 0, 0, 0);background:var(--vimeo-background, '
    'rgba(0, 0, 0, 0));height:100%;width:100%;border-radius:0px;position:relative;display:flex;'
    'justify-content:center;align-items:center;overflow:hidden"><div class="framer-vimeo" '
    'style="width:100%;height:100%"></div></div><!--/$--></div>'
)


def dumps(arr):
    # Framer пишет U+2028/2029 экранированными (иначе ломается JS-строка), json.dumps — буквами.
    return (json.dumps(arr, ensure_ascii=False, separators=(',', ':'))
            .replace('\u2028', '\\u2028').replace('\u2029', '\\u2029'))


# ── 1. данные CMS ──────────────────────────────────────────────────────────
def patch_cms(videos):
    changed = 0
    for idx_path in sorted(ROOT.glob('assets/cms/**/*-indexes-*-0.cmsdata')):
        chunk_path = Path(str(idx_path).replace('-indexes-', '-chunk-'))
        chunk, index = chunk_path.read_bytes(), idx_path.read_bytes()
        sections = cmsdata.parse_indexes(index)
        if not any(s['names'] == [FIELD.encode()] for s in sections):
            continue  # другая коллекция
        cmsdata.selftest(chunk, index)  # до правки всё должно собираться обратно байт в байт
        touched = []
        for slug, url in videos.items():
            rid = cmsdata.find_record(chunk, sections, SLUG_FIELD, slug)
            chunk, sections, old, delta = cmsdata.set_field(chunk, sections, rid, FIELD, url) \
                if _current(chunk, sections, rid) != url else (chunk, sections, None, 0)
            if old is not None:
                touched.append(f'{slug}: {old or "(пусто)"} → {url} ({delta:+d} байт)')
        if touched:
            cmsdata.verify(chunk, sections, (FIELD,))
            new_index = cmsdata.build_indexes(sections)
            cmsdata.parse_indexes(new_index)
            chunk_path.write_bytes(chunk)
            idx_path.write_bytes(new_index)
            changed += 1
            print(f'  CMS {chunk_path.name}:')
            for t in touched:
                print(f'      {t}')
    return changed


def _current(chunk, sections, rid):
    off, ln = cmsdata.record_spans(chunk, sections)[rid]
    rec = {f[0]: f for f in cmsdata.parse_record(chunk[off:off + ln])}
    return cmsdata.read_string(rec[FIELD.encode()][2])


# ── 2 и 3. страница ────────────────────────────────────────────────────────
def patch_page(path, url):
    html = path.read_text(encoding='utf-8')
    notes = []

    m = HANDOVER.search(html)
    if not m:
        raise ValueError(f'{path}: нет блока handoverData')
    blob = m.group(2)
    arr = json.loads(blob)
    if dumps(arr) != blob:
        raise ValueError(f'{path}: блок handoverData не собирается обратно байт в байт — править небезопасно')
    rec = next((el for el in arr if isinstance(el, dict) and FIELD in el), None)
    if rec is None:
        raise ValueError(f'{path}: в блоке нет записи с полем {FIELD}')
    current = arr[arr[rec[FIELD]]['value']]
    if current != url:
        # Ничего не правим на месте: обёртка и строка могут быть общими с другими полями
        # (пустая строка у всех полей сразу). Дописываем два новых элемента в конец и
        # перенаправляем поле. Индексы существующих элементов не меняются, а на последний
        # элемент (`["Map"]`) корневой объект ссылается по номеру, а не по положению.
        n = len(arr)
        arr.append({'type': 6, 'value': n + 1})
        arr.append(url)
        rec[FIELD] = n
        new_blob = dumps(arr)
        html = html[:m.start(2)] + new_blob + html[m.end(2):]
        notes.append(f'блок данных: {current or "(пусто)"} → {url}')

    # Готовая разметка: у кейса без видео — два варианта картинки под размеры экрана.
    a = html.index('<article')
    content = html.index('<div class="framer-1mt0chy"', a)
    head = html[a:content]
    if 'framer-18c4zth-container' not in head:
        start = html.index('<div class="ssr-variant', a)
        seg = html[start:content]
        if seg.count('<div class="ssr-variant') != 2 or seg.count('data-framer-name="Project Image"') != 2:
            raise ValueError(f'{path}: на месте картинки не то, что ожидалось (два варианта Project Image)')
        html = html[:start] + PLAYER_SSR + html[content:]
        notes.append('разметка: картинка заменена контейнером плеера')

    if notes:
        path.write_text(html, encoding='utf-8')
    return notes


def main():
    videos = json.loads(Path('tools/videos.json').read_text(encoding='utf-8'))
    for slug, url in videos.items():
        if not URL_RE.match(url):
            sys.exit(f'{slug}: адрес {url!r} не подходит. Нужен вид https://vimeo.com/<номер>: компонент плеера '
                     f'не понимает ссылки вида vimeo.com/<аккаунт>/<имя> и молча ничего не рисует. '
                     f'Номер ролика даёт oEmbed: https://vimeo.com/api/oembed.json?url=<ссылка> (video_id).')

    print('данные CMS:')
    cms = patch_cms(videos)
    if not cms:
        print('  уже как надо')

    print('страницы:')
    pages = 0
    for slug, url in videos.items():
        for base in ('projects', 'en/projects'):
            path = ROOT / base / slug / 'index.html'
            if not path.exists():
                sys.exit(f'нет страницы {path}')
            notes = patch_page(path, url)
            if notes:
                pages += 1
                print(f'  {base}/{slug}:')
                for n in notes:
                    print(f'      {n}')
    if not pages:
        print('  уже как надо')
    print(f'\nфайлов данных CMS изменено: {cms}, страниц изменено: {pages}')


if __name__ == '__main__':
    main()
