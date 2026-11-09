"""Переписать адреса картинок в данных CMS с CDN Framer на локальные.

Запуск из корня репозитория: python3 tools/localize-cms.py (нужен только стандартный
Python). Шаг идемпотентный: записи, где картинка уже локальная, пропускаются.

Проблема. В файлах данных CMS (`site/assets/cms/**/*.cmsdata`) картинка проекта лежит
в поле `q9mXGa4GX` как JSON с адресами `https://framerusercontent.com/images/…`. Готовые
страницы устроены иначе: у них в блоке данных те же картинки уже локальные
(`/assets/images/…`), их переписала сборка копии. Пока страница берёт список проектов из
собственного блока, всё в порядке. Но стоит ей перечитать список из файлов CMS —
при переходе по ссылке внутри сайта или когда запрос поменялся и кэш страницы не подошёл —
карточки рисуются картинками с чужого CDN. Копия при этом зависит от Framer ровно там,
где мы от него избавлялись.

Где локальные адреса брать. Не выводить по правилу (имя файла получает хвост от хеша
запроса: `~512`, `~ed9b2a`), а взять готовыми из страницы самого проекта: у каждого из
31 проектов в блоке данных лежит его картинка уже локальная, и файлы под ней гарантированно
есть на диске. Остальное в JSON (размеры, подпись) обязано совпасть с данными CMS, иначе
шаг останавливается: значит, страница и CMS расходятся и менять наугад нельзя.

После этого шага нужен tools/cms-version.mjs — иначе у посетителей с кэшем останутся
старые файлы.
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cmsdata  # noqa: E402

ROOT = Path('site')
FIELD = 'q9mXGa4GX'
SLUG_FIELD = 'cUGfm0XTC'
HANDOVER = re.compile(r'<script type="framer/handover" id="__framer__handoverData">(.*?)</script>', re.S)
# какая папка страниц соответствует какой локали данных
PAGES = {'default': 'projects', 'o7ocaBPY0': 'en/projects'}


def dumps(o):
    return json.dumps(o, ensure_ascii=False, separators=(',', ':'))


def local_image(slug, locale):
    """Картинка проекта из блока данных его страницы: {src, srcSet, ...} с локальными адресами."""
    html = (ROOT / PAGES[locale] / slug / 'index.html').read_text(encoding='utf-8')
    arr = json.loads(HANDOVER.search(html).group(1))
    rec = next(el for el in arr if isinstance(el, dict) and FIELD in el)
    wrapper = arr[rec[FIELD]]            # {"type":11,"value":N} — «отзывчивая картинка»
    obj = arr[wrapper['value']]          # {"src":i,"srcSet":j,...} — индексы элементов
    return {k: arr[i] for k, i in obj.items()}


def urls(img):
    return [img['src']] + [u.split()[0] for u in img['srcSet'].split(',')]


def main():
    changed = 0
    for idx_path in sorted(ROOT.glob('assets/cms/**/*-indexes-*-0.cmsdata')):
        chunk_path = Path(str(idx_path).replace('-indexes-', '-chunk-'))
        locale = chunk_path.name.split('-chunk-')[1].rsplit('-0.', 1)[0]
        chunk, index = chunk_path.read_bytes(), idx_path.read_bytes()
        sections = cmsdata.parse_indexes(index)
        if not any(s['names'] == [FIELD.encode()] for s in sections):
            continue  # другая коллекция
        if locale not in PAGES:
            sys.exit(f'{chunk_path.name}: неизвестная локаль {locale!r}')
        cmsdata.selftest(chunk, index)

        slug_of = {}
        for s in sections:
            if s['names'] == [b'id', SLUG_FIELD.encode()]:
                for e in s['entries']:
                    slug_of[e['values'][0][1].decode()] = e['values'][1][1].decode()

        done = skipped = 0
        for rid, slug in slug_of.items():
            off, ln = cmsdata.record_spans(chunk, sections)[rid]
            rec = {f[0]: f for f in cmsdata.parse_record(chunk[off:off + ln])}
            raw = cmsdata.read_string(rec[FIELD.encode()][2])
            old = json.loads(raw)
            if dumps(old) != raw:
                sys.exit(f'{slug}: JSON картинки не собирается обратно без потерь — править небезопасно')
            if old['src'].startswith('/assets/'):
                skipped += 1
                continue

            new = local_image(slug, locale)
            for k in old:
                if k not in ('src', 'srcSet') and old[k] != new.get(k):
                    sys.exit(f'{slug} ({locale}): поле {k} в CMS {old[k]!r}, а на странице {new.get(k)!r}')
            if set(old) != set(new):
                sys.exit(f'{slug} ({locale}): набор полей картинки разный: {sorted(old)} и {sorted(new)}')
            for u in urls(new):
                if not (ROOT / u.lstrip('/')).exists():
                    sys.exit(f'{slug} ({locale}): файла {u} нет на диске')
            merged = {k: (new[k] if k in ('src', 'srcSet') else old[k]) for k in old}  # порядок ключей прежний

            chunk, sections, _, _ = cmsdata.set_field(chunk, sections, rid, FIELD, dumps(merged), vtype=0x0a, order='bytes')
            done += 1

        if done:
            cmsdata.verify(chunk, sections, ())
            new_index = cmsdata.build_indexes(sections)
            cmsdata.parse_indexes(new_index)
            chunk_path.write_bytes(chunk)
            idx_path.write_bytes(new_index)
            changed += 1
        print(f'  {chunk_path.name}: переписано картинок {done}, уже локальных {skipped}')
    print(f'\nфайлов данных CMS изменено: {changed}')


if __name__ == '__main__':
    main()
