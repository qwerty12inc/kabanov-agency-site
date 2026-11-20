"""Добавить на сайт новый кейс (или обновить добавленный этим же шагом) по описанию в tools/projects.json.

Что меняется, и почему так много мест. Запись проекта сайт берёт из нескольких копий
сразу, и все они должны сойтись:

  1. Файлы CMS (обе локали): сама запись + все индексы. Новый кейс встаёт в коллекции
     первым — списки на сайте идут в порядке коллекции, а свежий кейс должен быть сверху.
     Бывшему первому проставляется «предыдущий» (previousItemId), новому — «следующий».
     Чанк и индексы собираются заново из записей (cmsdata.encode_collection); правило
     сортировки проверено пересборкой нетронутых данных байт в байт перед любой правкой.
  2. Страницы самого кейса /projects/<слаг> и /en/projects/<слаг>. Берутся с кейса-образца
     с таким же устройством (один ролик, без галереи) и в них заменяется всё, что относится
     к образцу: заголовок и мета-теги, адреса, блок данных страницы, текст, «следующий проект».
     После замены проверяется, что от образца ничего не осталось.
  3. Готовая разметка списков: главная и «Проекты» (порции по 4 и 10) и страницы
     категорий кейса. Без этого при загрузке сначала виден старый список, а через
     секунду он перестраивается. В списках категорий ещё и блок данных страницы: из него
     список берётся без запроса, и без правки нового кейса там не было бы вовсе.
     В категориях карточки разложены по колонкам по очереди (i % число колонок) —
     так их раскладывает код сайта, раскладка здесь та же.
  4. Карта сайта, tools/videos.json (чтобы check:videos проверял и этот кейс).
  5. Обложка: из исходника в tools/covers/ делаются варианты 512, 1024 и полный размер.
     Имя файла — хеш содержимого: картинки кэшируются на год, и новая обложка обязана
     получить новый адрес.

Повторный запуск безопасен: уже добавленный кейс обновляется (тексты, обложка, ролик,
категории), а не добавляется второй раз. Обновление разметки списков и карточек в
категориях делается только при первом добавлении — меняется обложка или заголовок,
старые значения в разметке заменяются на новые.

После шага: python3 tools/cms-ranges.py, node tools/cms-version.mjs, node tools/precompress.mjs.
"""
import hashlib
import html as htmllib
import json
import re
import struct
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import cmsdata  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
ROOT = REPO / 'site'
SPEC = REPO / 'tools/projects.json'
VIDEOS = REPO / 'tools/videos.json'
HOST = 'https://kabanov.agency'
LOCALES = {'ru': ('default', ''), 'en': ('o7ocaBPY0', '/en')}
SLUG, TITLE, CLIENT, CATS, IMAGE, VIDEO, DESC = 'cUGfm0XTC', 'xpeftzq6h', 'KHbFsYPgi', 'w8DEUQxPD', 'q9mXGa4GX', 'YoYO4a9Bc', 'q1Do62CvP'
HANDOVER = re.compile(r'(<script type="framer/handover" id="__framer__handoverData">)(.*?)(</script>)', re.S)
CARD = re.compile(r'<!--\$--><a class="([^"]+)" href="((?:\.\.?/)*)projects/([^"]+)">')


def esc(s):
    return htmllib.escape(s, quote=True)


def dumps(arr):
    return (json.dumps(arr, ensure_ascii=False, separators=(',', ':'))
            .replace('\u2028', '\\u2028').replace('\u2029', '\\u2029'))


# ── обложка ────────────────────────────────────────────────────────────────
def make_cover(src_path):
    from PIL import Image
    data = (REPO / src_path).read_bytes()
    h = hashlib.sha1(data).hexdigest()[:24]
    img = Image.open(REPO / src_path)
    w, hgt = img.size
    ext = '.jpg'
    out = ROOT / 'assets/images'
    full = out / f'{h}{ext}'
    if not full.exists():
        full.write_bytes(data)
    srcset = []
    for size in (512, 1024):
        p = out / f'{h}~{size}{ext}'
        if not p.exists():
            small = img.convert('RGB').resize((size, round(hgt * size / w)), Image.LANCZOS)
            small.save(p, 'JPEG', quality=85, optimize=True, progressive=True)
        srcset.append(f'/assets/images/{p.name} {size}w')
    srcset.append(f'/assets/images/{full.name} {w}w')
    return {'src': f'/assets/images/{full.name}', 'srcSet': ','.join(srcset), 'pixelWidth': w, 'pixelHeight': hgt}


def image_json(cover, alt):
    d = dict(cover)
    if alt:
        d['alt'] = alt
    return json.dumps(d, ensure_ascii=False, separators=(',', ':'))


# ── 1. CMS ─────────────────────────────────────────────────────────────────
def fields_of(rec):
    return {n.decode(): (t, raw) for n, t, raw in rec}


def str_of(rec, name):
    f = fields_of(rec).get(name)
    return cmsdata.read_string(f[1]) if f and f[0] in cmsdata.LEN_TYPES else None


def array_value(ids):
    out = bytearray(struct.pack('>H', len(ids)))
    for i in ids:
        out += bytes([0x0c]) + cmsdata.string_value(i)
    return bytes(out)


def new_record(spec, slug, loc, cover, next_id, created_ms):
    L = spec[loc]
    f = [
        cmsdata.string_field('id', spec['id']),
        cmsdata.int_field('createdAt', created_ms),
        cmsdata.int_field('updatedAt', created_ms),
    ]
    if next_id:
        f.append(cmsdata.string_field('nextItemId', next_id))
    f += [
        cmsdata.string_field(TITLE, L['title']),
        cmsdata.string_field(CLIENT, spec['client']),
        cmsdata.string_field(SLUG, slug),
        (CATS.encode(), 0x01, array_value(spec['categories'])),
        cmsdata.string_field('r3QMhiqpj', ''),
        (IMAGE.encode(), 0x0a, cmsdata.string_value(image_json(cover, L.get('alt')))),
        cmsdata.string_field(VIDEO, spec['video']),
        cmsdata.string_field('Uzi7i_2zQ', ''),
        cmsdata.string_field('ysZ7CdzvI', ''),
        cmsdata.string_field('aWe58MxjI', ''),
        cmsdata.string_field('BN1bKKxeG', ''),
        cmsdata.string_field(DESC, L['description']),
    ]
    return f


def with_field(rec, name, value_field, after):
    """Вставить или заменить поле записи. Новое поле ставится после поля `after` (так у записей Framer)."""
    out, done = [], False
    for n, t, raw in rec:
        if n == name.encode():
            out.append(value_field)
            done = True
        else:
            out.append((n, t, raw))
    if not done:
        i = next(k for k, (n, _, _) in enumerate(out) if n == after.encode()) + 1
        out.insert(i, value_field)
    return out


def patch_cms(slug, spec, cover, created_ms):
    """→ {локаль: dict(prev_first=(id, слаг, заголовок) того, кто был первым, или None при обновлении)}."""
    result = {}
    for loc, (locale_id, _) in LOCALES.items():
        idx_path = next(ROOT.glob(f'assets/cms/*/*/Jo_ECrywm-indexes-{locale_id}-0.cmsdata'))
        chunk_path = Path(str(idx_path).replace('-indexes-', '-chunk-'))
        chunk, index = chunk_path.read_bytes(), idx_path.read_bytes()
        cmsdata.selftest(chunk, index)
        cmsdata.rebuild_selftest(chunk, index)  # правило сортировки верно на этих данных
        sections = cmsdata.parse_indexes(index)
        records = cmsdata.decode_records(chunk, sections)
        by_slug = {str_of(r, SLUG): (rid, r) for rid, r in records}

        if slug in by_slug:
            rid, old = by_slug[slug]
            if rid != spec['id']:
                raise ValueError(f'{slug}: в CMS уже есть запись {rid}, а в projects.json id {spec["id"]}')
            of = fields_of(old)
            nxt = str_of(old, 'nextItemId')
            rec = new_record(spec, slug, loc, cover, nxt, struct.unpack('>q', of['createdAt'][1])[0])
            rec = with_field(rec, 'updatedAt', (b'updatedAt',) + of['updatedAt'], 'createdAt')
            if 'previousItemId' in of:
                rec = with_field(rec, 'previousItemId', (b'previousItemId',) + of['previousItemId'], 'updatedAt')
            records = [(r_id, rec if r_id == rid else r) for r_id, r in records]
            result[loc] = dict(prev_first=None, next=next(((str_of(r, SLUG), str_of(r, TITLE), r_id) for r_id, r in records if r_id == nxt), None))
            action = 'обновлена'
        else:
            if spec['id'] in {rid for rid, _ in records}:
                raise ValueError(f'id {spec["id"]} уже занят другой записью')
            first_id, first = records[0]
            rec = new_record(spec, slug, loc, cover, first_id, created_ms)
            first = with_field(first, 'previousItemId', cmsdata.string_field('previousItemId', spec['id']), 'updatedAt')
            records = [(spec['id'], rec), (first_id, first)] + records[1:]
            result[loc] = dict(prev_first=(first_id, str_of(first, SLUG), str_of(first, TITLE)),
                               next=(str_of(first, SLUG), str_of(first, TITLE), first_id))
            action = f'добавлена первой, перед {str_of(first, SLUG)}'

        new_chunk, new_sections = cmsdata.encode_collection(records, sections)
        new_index = cmsdata.build_indexes(new_sections)
        cmsdata.selftest(new_chunk, new_index)
        cmsdata.verify(new_chunk, cmsdata.parse_indexes(new_index))
        if (new_chunk, new_index) != (chunk, index):
            chunk_path.write_bytes(new_chunk)
            idx_path.write_bytes(new_index)
            print(f'  CMS {locale_id}: запись {slug} {action} (записей {len(records)})')
        else:
            print(f'  CMS {locale_id}: {slug} без изменений')
    return result


# ── блок данных страницы ───────────────────────────────────────────────────
class Handover:
    def __init__(self, page_html, where):
        self.m = HANDOVER.search(page_html)
        if not self.m:
            raise ValueError(f'{where}: нет блока handoverData')
        self.html, self.where = page_html, where
        self.arr = json.loads(self.m.group(2))
        if dumps(self.arr) != self.m.group(2):
            raise ValueError(f'{where}: блок handoverData не собирается обратно байт в байт')

    def refs(self, i):
        """Сколько раз на элемент i ссылаются (в объектах и массивах)."""
        n = 0
        for el in self.arr:
            if isinstance(el, dict):
                n += sum(1 for v in el.values() if v == i)
            elif isinstance(el, list) and el and el[0] != 'Map':
                n += el.count(i)
            elif isinstance(el, list):
                n += el[1:].count(i)
        return n

    def add(self, value):
        self.arr.append(value)
        return len(self.arr) - 1

    def set_primitive(self, owner, key, value):
        """owner[key] — номер элемента-значения. Правим на месте, если на значение больше никто не ссылается, иначе дописываем новое."""
        i = owner[key]
        if not isinstance(i, int) or self.refs(i) != 1:
            owner[key] = self.add(value)
        else:
            self.arr[i] = value

    def wrapped(self, rec, field, value):
        """Значение поля записи в обёртке {"type":…,"value":номер}."""
        w = rec[field]
        wrap = self.arr[w]
        if self.refs(w) != 1:
            wrap = dict(wrap)
            rec[field] = self.add(wrap)
        self.set_primitive(wrap, 'value', value)

    def image(self, rec, field, img):
        w = self.arr[rec[field]]
        if self.refs(rec[field]) != 1 or self.refs(w['value']) != 1:
            raise ValueError(f'{self.where}: картинка записи общая с другими — такой случай не предусмотрен')
        obj = self.arr[w['value']]
        for k in ('src', 'srcSet', 'pixelWidth', 'pixelHeight', 'alt'):
            if k in img:
                if k in obj:
                    self.set_primitive(obj, k, img[k])
                else:
                    obj[k] = self.add(img[k])
            elif k in obj:
                del obj[k]

    def text(self):
        return self.html[:self.m.start(2)] + dumps(self.arr) + self.html[self.m.end(2):]


def item_values(h, rec):
    """Строковые значения полей записи из блока данных: {поле: значение}."""
    out = {}
    for k, w in rec.items():
        wrap = h.arr[w] if isinstance(w, int) else None
        if isinstance(wrap, dict) and 'value' in wrap:
            v = h.arr[wrap['value']] if isinstance(wrap['value'], int) else None
            out[k] = v
    return out


# ── разметка ───────────────────────────────────────────────────────────────
def split_title_re(title):
    """Заголовок в разметке разбит на слова в span-ах (анимация появления по словам)."""
    words = esc(title).split(' ')
    return re.compile(r'(<span[^>]*>)' + r'</span> \1'.join(re.escape(w) for w in words) + r'</span>')


def replace_split_title(text, old, new):
    rx = split_title_re(old)

    def sub(m):
        return ' '.join(f'{m.group(1)}{w}</span>' for w in esc(new).split(' '))
    return rx.subn(sub, text)


def replace_card_fields(card, old, new):
    """old/new: dict(slug, title, src, srcSet, alt, w, h)."""
    out = card.replace(f'projects/{old["slug"]}"', f'projects/{new["slug"]}"')
    out = out.replace(f'srcset="{esc(old["srcSet"])}"', f'srcset="{esc(new["srcSet"])}"')
    out = out.replace(f'src="{esc(old["src"])}"', f'src="{esc(new["src"])}"')
    if old.get('alt'):
        out = out.replace(f'alt="{esc(old["alt"])}"', f'alt="{esc(new.get("alt") or "")}"')
    out, n = replace_split_title(out, old['title'], new['title'])
    if n == 0:
        raise ValueError(f'в карточке {old["slug"]} не найден заголовок «{old["title"]}»')
    stem = old['src'].rsplit('/', 1)[1].split('~')[0].split('.')[0]
    for leftover in (f'projects/{old["slug"]}"', stem, esc(old.get('alt') or '\0')):
        if leftover in out:
            raise ValueError(f'в карточке осталось от образца: {leftover}')
    if split_title_re(old['title']).search(out):
        raise ValueError(f'в карточке остался заголовок образца {old["title"]}')
    return out


def card_runs(text):
    """Подряд идущие карточки списков: [(start, end, [(slug, html)])]."""
    runs, cur = [], None
    for m in CARD.finditer(text):
        end = text.index('</a><!--/$-->', m.start()) + len('</a><!--/$-->')
        block = (m.group(3), text[m.start():end])
        if cur and cur[1] == m.start():
            cur[1] = end
            cur[2].append(block)
        else:
            cur = [m.start(), end, [block]]
            runs.append(cur)
    return runs


# ── 2. страницы кейса ──────────────────────────────────────────────────────
def build_pages(slug, spec, cover, cms_result):
    for loc, (locale_id, prefix) in LOCALES.items():
        L = spec[loc]
        tpl_path = ROOT / prefix.lstrip('/') / 'projects' / spec['template'] / 'index.html'
        page = tpl_path.read_text(encoding='utf-8')
        h = Handover(page, tpl_path)
        rec = next(el for el in h.arr if isinstance(el, dict) and TITLE in el and 'nextItemId' in el)
        old = item_values(h, rec)
        old_img = h.arr[h.arr[rec[IMAGE]]['value']]
        old_img = {k: h.arr[v] for k, v in old_img.items()}
        tslug = spec['template']
        tid = re.search(r'&quot;collectionItemId&quot;:&quot;([^&]+)&quot;', page).group(1)
        nxt_slug, nxt_title, nxt_id = cms_result[loc]['next']

        # блок данных
        q_i = h.arr[1][1]
        q = h.arr[q_i]
        lit = f'"right":{{"type":"LiteralValue","value":"{tslug}"}}'
        if q.count(lit) != 1:
            raise ValueError(f'{tpl_path}: в запросе страницы не найден слаг образца')
        h.arr[q_i] = q.replace(lit, f'"right":{{"type":"LiteralValue","value":"{slug}"}}')
        h.wrapped(rec, TITLE, L['title'])
        h.wrapped(rec, DESC, L['description'])
        h.wrapped(rec, VIDEO, spec['video'])
        h.wrapped(rec, 'nextItemId.xpeftzq6h', nxt_title)
        h.wrapped(rec, 'nextItemId.cUGfm0XTC', nxt_slug)
        h.wrapped(rec, 'nextItemId', nxt_id)
        img = dict(cover)
        if L.get('alt'):
            img['alt'] = L['alt']
        h.image(rec, IMAGE, img)
        page = h.text()

        # разметка и мета-теги (вне блока данных)
        m = HANDOVER.search(page)
        head, blob, tail = page[:m.start(2)], m.group(2), page[m.end(2):]

        def rep(s, a, b, expect=None):
            n = s.count(a)
            if n == 0 or (expect is not None and n != expect):
                raise ValueError(f'{tpl_path}: «{a[:60]}» встречается {n} раз, ожидалось {expect or "≥1"}')
            return s.replace(a, b)

        head = rep(head, esc(old[TITLE]), esc(L['title']))  # title, og:title, twitter:title
        head = rep(head, f'{HOST}{old_img["src"]}', f'{HOST}{cover["src"]}')  # og:image, twitter:image
        head = rep(head, f'/projects/{tslug}"', f'/projects/{slug}"')  # canonical, og:url, hreflang
        head = rep(head, f'&quot;cUGfm0XTC&quot;:&quot;{tslug}&quot;', f'&quot;cUGfm0XTC&quot;:&quot;{slug}&quot;', 1)
        head = rep(head, f'&quot;collectionItemId&quot;:&quot;{tid}&quot;', f'&quot;collectionItemId&quot;:&quot;{spec["id"]}&quot;', 1)
        head, n = replace_split_title(head, old[TITLE], L['title'])
        if n != 1:
            raise ValueError(f'{tpl_path}: заголовок h1 найден {n} раз')
        head = rep(head, f'>{esc(old[DESC])}</p>', f'>{esc(L["description"])}</p>', 1)
        tpl_next = re.search(r'href="\./([^"]+)">([^<]+) &gt;&gt;</a>', head)
        head = head[:tpl_next.start()] + f'href="./{nxt_slug}">{esc(nxt_title)} &gt;&gt;</a>' + head[tpl_next.end():]

        page = head + blob + tail
        # от образца ничего не должно остаться — ни в разметке, ни в блоке данных
        stem = old_img['src'].rsplit('/', 1)[1].split('~')[0]
        for leftover in (tslug, tid, stem, esc(old[TITLE]), old[TITLE], esc(old[DESC]), old[VIDEO].rsplit('/', 1)[1]):
            if leftover and leftover in page:
                raise ValueError(f'{tpl_path} → {slug}: от образца осталось «{leftover}»')

        out = ROOT / prefix.lstrip('/') / 'projects' / slug / 'index.html'
        out.parent.mkdir(parents=True, exist_ok=True)
        if not out.exists() or out.read_text(encoding='utf-8') != page:
            out.write_text(page, encoding='utf-8')
            print(f'  страница {out.relative_to(ROOT)} (образец {spec["template"]})')


# ── 3. списки ──────────────────────────────────────────────────────────────
def card_info(h, item):
    v = item_values(h, item)
    img = h.arr[h.arr[item[IMAGE]]['value']]
    img = {k: h.arr[i] for k, i in img.items()}
    return dict(slug=v[SLUG], title=v[TITLE], src=img['src'], srcSet=img['srcSet'], alt=img.get('alt'))


def cms_card(loc, slug):
    """Данные карточки из CMS (для списков, где в блоке данных нужной записи нет)."""
    locale_id = LOCALES[loc][0]
    idx_path = next(ROOT.glob(f'assets/cms/*/*/Jo_ECrywm-indexes-{locale_id}-0.cmsdata'))
    chunk = Path(str(idx_path).replace('-indexes-', '-chunk-')).read_bytes()
    sections = cmsdata.parse_indexes(idx_path.read_bytes())
    for rid, rec in cmsdata.decode_records(chunk, sections):
        if str_of(rec, SLUG) == slug:
            img = json.loads(str_of(rec, IMAGE))
            return dict(slug=slug, title=str_of(rec, TITLE), src=img['src'], srcSet=img['srcSet'], alt=img.get('alt'))
    raise KeyError(slug)


def patch_paginated(slug, spec, cover, cms_result, hidden):
    """Главная и «Проекты»: новая карточка первой, скрытые кейсы убраны, длина порции прежняя."""
    for loc, (_, prefix) in LOCALES.items():
        first = cms_result[loc]['prev_first']
        tpl = cms_card(loc, first[1])
        new = dict(slug=slug, title=spec[loc]['title'], src=cover['src'], srcSet=cover['srcSet'], alt=spec[loc].get('alt'))
        for page in (f'{prefix}/', f'{prefix}/projects'):
            path = ROOT / page.lstrip('/') / 'index.html'
            text = path.read_text(encoding='utf-8')
            runs = card_runs(text)
            if not runs:
                raise ValueError(f'{page}: карточек не найдено')
            for start, end, cards in reversed(runs):
                slugs = [s for s, _ in cards]
                if slugs[0] != first[1]:
                    raise ValueError(f'{page}: список начинается с {slugs[0]}, а ожидался {first[1]}')
                tpl_html = cards[0][1]
                body = [replace_card_fields(tpl_html, tpl, new)] + [c for s, c in cards if s not in hidden]
                body = body[:len(cards)]
                text = text[:start] + ''.join(body) + text[end:]
            path.write_text(text, encoding='utf-8')
            print(f'  список {page}: {len(runs)} вариантов разметки, первая карточка — {slug}')


def patch_categories(slug, spec, cover, cms_result):
    """Страницы категорий кейса: блок данных (список берётся из него) и разметка карточек по колонкам."""
    for loc, (_, prefix) in LOCALES.items():
        new = dict(slug=slug, title=spec[loc]['title'], src=cover['src'], srcSet=cover['srcSet'], alt=spec[loc].get('alt'))
        for path in sorted((ROOT / prefix.lstrip('/') / 'categories').glob('*/index.html')):
            text = path.read_text(encoding='utf-8')
            h = Handover(text, path)
            mp = h.arr[h.arr[0]['0']]
            touched, order = False, None
            for k in range(1, len(mp), 2):
                q = h.arr[mp[k]]
                cat = re.search(r'"where":\{"left":\{"type":"LiteralValue","value":"([^"]+)"\},"operator":"in"', q)
                if not cat or cat.group(1) not in spec['categories'] or '"name":"w8DEUQxPD"' not in q:
                    continue
                limit = json.loads(q[:q.rindex('}') + 1]).get('limit', {}).get('value')
                res = h.arr[mp[k + 1]]
                items = [h.arr[i] for i in res]
                if any(item_values(h, it).get(SLUG) == slug for it in items):
                    continue
                proto = items[0]
                obj = {}
                for f, w in proto.items():
                    wrap = h.arr[w]
                    if f == IMAGE:
                        img = dict(cover)
                        if new['alt']:
                            img['alt'] = new['alt']
                        inner = {kk: h.add(vv) for kk, vv in img.items()}
                        val = h.add(inner)
                    else:
                        val = h.add({SLUG: slug, TITLE: new['title'], 'id': spec['id']}[f])
                    obj[f] = h.add({'type': wrap['type'], 'value': val})
                res.insert(0, h.add(obj))
                if limit and len(res) > limit:
                    res.pop()
                touched = True
                order = order or [item_values(h, h.arr[i])[SLUG] for i in res]
            if not touched:
                continue
            text = h.text()

            # разметка: варианты под размеры экрана; в варианте может быть несколько колонок
            runs = card_runs(text)
            groups, cur = [], None
            for r in runs:
                # колонки одного варианта разделены только закрытием и открытием div (со стилем колонки)
                if cur and re.fullmatch(r'</div><div[^<>]*>', text[cur[-1][1]:r[0]]):
                    cur.append(r)
                else:
                    cur = [r]
                    groups.append(cur)
            for group in reversed(groups):
                cols = [[s for s, _ in r[2]] for r in group]
                k = len(cols)
                flat = [cols[i % k][i // k] for i in range(sum(map(len, cols)))]
                if flat != order[1:]:
                    raise ValueError(f'{path}: раскладка карточек {cols} не сходится с порядком данных {order[1:]}')
                html_of = {s: c for r in group for s, c in r[2]}
                tpl = cms_card(loc, order[1])
                html_of[slug] = replace_card_fields(html_of[order[1]], tpl, new)
                new_cols = [order[i::k] for i in range(k)]
                for r, col in reversed(list(zip(group, new_cols))):
                    text = text[:r[0]] + ''.join(html_of[s] for s in col) + text[r[1]:]
            path.write_text(text, encoding='utf-8')
            print(f'  категория {path.relative_to(ROOT).parent}: {len(groups)} вариантов разметки, порядок {order[:3]}…')


# ── 4. карта сайта и список роликов ────────────────────────────────────────
def patch_sitemaps(slug, cms_result):
    for loc, (_, prefix) in LOCALES.items():
        path = ROOT / f'sitemap_{loc}.xml'
        xml = path.read_text(encoding='utf-8')
        line = f'<url><loc>{HOST}{prefix}/projects/{slug}</loc></url>'
        if line in xml:
            continue
        before = f'<url><loc>{HOST}{prefix}/projects/{cms_result[loc]["prev_first"][1]}</loc></url>'
        if xml.count(before) != 1:
            raise ValueError(f'{path.name}: нет строки {before}')
        path.write_text(xml.replace(before, line + '\n' + before), encoding='utf-8')
        print(f'  {path.name}: + {prefix}/projects/{slug}')


def refresh_cards(slug, before):
    """Кейс уже на сайте и поменялся (обложка, заголовок): заменить старые значения его карточки во всех страницах."""
    own = {ROOT / p.lstrip('/') / 'projects' / slug / 'index.html' for _, p in LOCALES.values()}
    for loc, old in before.items():
        new = cms_card(loc, slug)
        if new == old:
            continue
        pairs = [(esc(old['srcSet']), esc(new['srcSet'])), (old['srcSet'], new['srcSet']),
                 (esc(old['src']), esc(new['src'])), (old['src'], new['src'])]
        if old.get('alt'):
            pairs += [(f'alt="{esc(old["alt"])}"', f'alt="{esc(new.get("alt") or "")}"'), (json.dumps(old['alt'], ensure_ascii=False), json.dumps(new.get('alt') or '', ensure_ascii=False))]
        pairs.append((json.dumps(old['title'], ensure_ascii=False), json.dumps(new['title'], ensure_ascii=False)))
        for path in ROOT.rglob('index.html'):
            if path in own:
                continue
            text = path.read_text(encoding='utf-8')
            if f'projects/{slug}' not in text:
                continue
            out = text
            for a, b in pairs:
                if a != b:
                    out = out.replace(a, b)
            out, _ = replace_split_title(out, old['title'], new['title'])
            out = out.replace(f'{esc(old["title"])} &gt;&gt;', f'{esc(new["title"])} &gt;&gt;')
            if out != text:
                path.write_text(out, encoding='utf-8')
                print(f'  обновлено в {path.relative_to(ROOT)}')


def main():
    spec_all = json.loads(SPEC.read_text(encoding='utf-8'))
    from_js = (REPO / 'tools/hidden.mjs').read_text(encoding='utf-8')
    hidden = set(re.findall(r"'([^']+)'", re.search(r'HIDDEN_CASES\s*=\s*\[([^\]]*)\]', from_js).group(1)))
    videos = json.loads(VIDEOS.read_text(encoding='utf-8'))
    for slug, spec in spec_all.items():
        print(f'{slug}:')
        cover = make_cover(spec['cover'])
        created = int(datetime.fromisoformat(spec['createdAt'].replace('Z', '+00:00')).timestamp() * 1000)
        before = {}
        for loc in LOCALES:
            try:
                before[loc] = cms_card(loc, slug)
            except KeyError:
                pass
        res = patch_cms(slug, spec, cover, created)
        build_pages(slug, spec, cover, res)
        if res['ru']['prev_first']:  # впервые добавлен
            patch_paginated(slug, spec, cover, res, hidden)
            patch_categories(slug, spec, cover, res)
            patch_sitemaps(slug, res)
        else:
            refresh_cards(slug, before)
        if videos.get(slug) != spec['video']:
            videos[slug] = spec['video']
            VIDEOS.write_text(json.dumps(videos, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
