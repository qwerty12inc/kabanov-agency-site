#!/usr/bin/env python3
"""Ссылка «следующий кейс» должна быть в каждом кейсе.

Цепочку задаёт поле nextItemId в CMS. Она рвётся в двух случаях:
  * следующий кейс скрыт (tools/hidden.mjs) — ссылку на него прячет стиль, кнопка пропадает;
  * кейс последний — nextItemId у него нет.
Скрипт ведёт ссылку на ближайший следующий НЕ скрытый кейс, а у последнего — на первый (по кругу).
Правит и данные CMS (для переходов без перезагрузки), и готовые страницы (разметка + блок handoverData).
Запускать после add-project.py и после правки HIDDEN_CASES; затем cms-ranges.py, cms-version, precompress.
Повторный запуск ничего не меняет.
"""
import importlib.util
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / 'tools'))
spec = importlib.util.spec_from_file_location('addproject', REPO / 'tools/add-project.py')
ap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ap)
cmsdata, ROOT = ap.cmsdata, ap.ROOT

NEXT_BLOCK = re.compile(r'<div class="[^"]+" data-framer-name="Next".*?</h5></div>', re.S)
NEXT_LINK = re.compile(r'href="\./([^"]+)">([^<]+) &gt;&gt;</a>')


def hidden_cases():
    js = (REPO / 'tools/hidden.mjs').read_text(encoding='utf-8')
    return set(re.findall(r"'([^']+)'", re.search(r'HIDDEN_CASES\s*=\s*\[([^\]]*)\]', js).group(1)))


def plan(records, hidden):
    """→ {слаг: (id, слаг, заголовок) следующего} для всех видимых кейсов."""
    by_id = dict(records)
    slug = lambda r: ap.str_of(r, ap.SLUG)
    first = next((rid for rid, r in records if slug(r) not in hidden))
    out = {}
    for rid, r in records:
        if slug(r) in hidden:
            continue
        nxt, seen = ap.str_of(r, 'nextItemId'), set()
        while nxt and nxt in by_id and slug(by_id[nxt]) in hidden and nxt not in seen:
            seen.add(nxt)
            nxt = ap.str_of(by_id[nxt], 'nextItemId')
        if not nxt or nxt not in by_id or slug(by_id[nxt]) in hidden:
            nxt = first
        out[slug(r)] = (nxt, slug(by_id[nxt]), ap.str_of(by_id[nxt], ap.TITLE))
    return out


def main():
    hidden, changed = hidden_cases(), 0
    for loc, (locale_id, prefix) in ap.LOCALES.items():
        idx_path = next(ROOT.glob(f'assets/cms/*/*/Jo_ECrywm-indexes-{locale_id}-0.cmsdata'))
        chunk_path = Path(str(idx_path).replace('-indexes-', '-chunk-'))
        chunk, index = chunk_path.read_bytes(), idx_path.read_bytes()
        cmsdata.selftest(chunk, index)
        sections = cmsdata.parse_indexes(index)
        records = cmsdata.decode_records(chunk, sections)
        target = plan(records, hidden)

        # 1. CMS
        new = []
        for rid, r in records:
            t = target.get(ap.str_of(r, ap.SLUG))
            if t and ap.str_of(r, 'nextItemId') != t[0]:
                after = 'previousItemId' if 'previousItemId' in ap.fields_of(r) else 'updatedAt'
                r = ap.with_field(r, 'nextItemId', cmsdata.string_field('nextItemId', t[0]), after)
                print(f'  CMS {locale_id}: {ap.str_of(r, ap.SLUG)} → {t[1]}')
            new.append((rid, r))
        new_chunk, new_sections = cmsdata.encode_collection(new, sections)
        new_index = cmsdata.build_indexes(new_sections)
        cmsdata.selftest(new_chunk, new_index)
        cmsdata.verify(new_chunk, cmsdata.parse_indexes(new_index))
        if (new_chunk, new_index) != (chunk, index):
            chunk_path.write_bytes(new_chunk)
            idx_path.write_bytes(new_index)
            changed += 1

        # 2. страницы
        sample = None  # готовый блок «Next» с любой страницы этой локали — образец для кейса, где блока нет
        pages = {s: ROOT / prefix.lstrip('/') / 'projects' / s / 'index.html' for s in target}
        for s, path in pages.items():
            m = NEXT_BLOCK.search(path.read_text(encoding='utf-8'))
            if m and NEXT_LINK.search(m.group(0)):
                sample = m.group(0)
                break
        for s, path in pages.items():
            nid, nslug, ntitle = target[s]
            page = path.read_text(encoding='utf-8')
            h = ap.Handover(page, path)
            rec = next(el for el in h.arr if isinstance(el, dict) and ap.TITLE in el and 'nextItemId' in el)
            str_type = h.arr[rec[ap.TITLE]]['type']
            for field, value in (('nextItemId.xpeftzq6h', ntitle), ('nextItemId.cUGfm0XTC', nslug), ('nextItemId', nid)):
                if isinstance(h.arr[rec[field]], dict):
                    if h.arr[h.arr[rec[field]]['value']] != value:
                        h.wrapped(rec, field, value)
                else:  # поле пустое (null) — заводим обёртку {"type": строка, "value": …}
                    rec[field] = h.add({'type': str_type, 'value': h.add(value)})
            out = h.text()
            m = ap.HANDOVER.search(out)
            head, rest = out[:m.start(2)], out[m.start(2):]
            link = f'href="./{nslug}">{ap.esc(ntitle)} &gt;&gt;</a>'
            blocks = NEXT_BLOCK.findall(head)
            if blocks:
                head = NEXT_BLOCK.sub(lambda b: NEXT_LINK.sub(lambda _: link, b.group(0)), head)
            else:
                anchor = re.compile(r'(data-framer-name="All works".*?</h5></div>)(</section>)', re.S)
                if len(anchor.findall(head)) != 1:
                    raise ValueError(f'{path}: не найдено место для блока «Next»')
                block = NEXT_LINK.sub(lambda _: link, sample)
                head = anchor.sub(lambda a: a.group(1) + block + a.group(2), head)
            out = head + rest
            if out != page:
                path.write_text(out, encoding='utf-8')
                print(f'  страница {path.relative_to(ROOT)} → {nslug}')
                changed += 1
    print('изменений нет' if not changed else f'изменено файлов: {changed}')


if __name__ == '__main__':
    main()
