"""Чтение и запись двоичных файлов данных CMS (site/assets/cms/**/*.cmsdata).

Формат выяснен разбором самих файлов, а не по документации (её у Framer нет),
поэтому каждая операция здесь проверяется круговым прогоном: разобрали → собрали
обратно → получили тот же файл байт в байт. Пока круговая проверка не проходит
на всех файлах, править данные нельзя — `selftest()` для этого и нужен.

Чанк (`*-chunk-<локаль>-0.cmsdata`):
    u32  число записей
    запись × N, вплотную друг к другу:
        u16  число полей
        поле × K:  u32 длина имени, имя, u8 тип, значение
    типы значения: 0x0c строка, 0x0a JSON-объект, 0x07 ссылка (все три — u32 длина +
    байты), 0x04 число (8 байт), 0x01 массив (u16 число элементов,
    у каждого свой u8 тип + значение).

Индексы (`*-indexes-<локаль>-0.cmsdata`) — разделы подряд, по одному на поле
или на пару полей (например, id → слаг):
    u32 длина + JSON-заголовок {"type":1} (у индекса по массиву — {"type":0}),
    u8 число полей в индексе (1 или 2),
    имена полей (u32 длина + имя) × число полей, u32 число записей, затем записи:
        значение × число полей: u8 тип (0x0c строка / 0x04 число / 0x00 пусто) [+ значение],
        u48 смещение записи в чанке, u32 длина записи.
Смещения указывают на начало записи в чанке (первая запись — со смещения 4).
"""
import struct

# Типы значений, у которых за типом идёт u32 длина и сами байты: 0x0c строка,
# 0x0a JSON-объект (картинка), 0x07 ссылка — JSON-строка в кавычках.
LEN_TYPES = (0x0c, 0x0a, 0x07)


class Reader:
    def __init__(self, data, pos=0):
        self.d, self.pos = data, pos

    def u8(self):
        v = self.d[self.pos]; self.pos += 1; return v

    def u16(self):
        v = struct.unpack('>H', self.d[self.pos:self.pos + 2])[0]; self.pos += 2; return v

    def u32(self):
        v = struct.unpack('>I', self.d[self.pos:self.pos + 4])[0]; self.pos += 4; return v

    def u48(self):
        v = int.from_bytes(self.d[self.pos:self.pos + 6], 'big'); self.pos += 6; return v

    def raw(self, n):
        v = self.d[self.pos:self.pos + n]; self.pos += n; return v


# ── индексы ────────────────────────────────────────────────────────────────
def _read_value(r, t, where):
    if t in LEN_TYPES: return r.raw(r.u32())
    if t == 0x04: return r.raw(8)
    if t == 0x00: return None
    if t == 0x01:  # массив (ссылки на категории): u16 число элементов, у каждого свой тип
        start = r.pos
        for _ in range(r.u16()):
            et = r.u8()
            _read_value(r, et, where)
        return r.d[start:r.pos]
    raise ValueError(f'неизвестный тип значения {t:#x} в индексе {where!r} на {r.pos}')


def _write_value(out, t, v):
    if t in LEN_TYPES: out += struct.pack('>I', len(v)) + v
    elif t in (0x04, 0x01): out += v


def parse_indexes(data):
    """→ список разделов. Раздел: dict(header, names=[имена полей], entries=[dict(values=[(тип, значение)], offset, length)])."""
    r, sections = Reader(data), []
    while r.pos < len(data):
        header = r.raw(r.u32())
        names = [r.raw(r.u32()) for _ in range(r.u8())]
        entries = []
        for _ in range(r.u32()):
            values = []
            for _ in names:
                t = r.u8()
                values.append((t, _read_value(r, t, names)))
            entries.append(dict(values=values, offset=r.u48(), length=r.u32()))
        sections.append(dict(header=header, names=names, entries=entries))
    return sections


def build_indexes(sections):
    out = bytearray()
    for s in sections:
        out += struct.pack('>I', len(s['header'])) + s['header'] + bytes([len(s['names'])])
        for n in s['names']:
            out += struct.pack('>I', len(n)) + n
        out += struct.pack('>I', len(s['entries']))
        for e in s['entries']:
            for t, v in e['values']:
                out.append(t)
                _write_value(out, t, v)
            out += e['offset'].to_bytes(6, 'big') + struct.pack('>I', e['length'])
    return bytes(out)


# ── чанк ───────────────────────────────────────────────────────────────────
def record_spans(chunk, sections):
    """Границы записей по индексу `id`: {id: (смещение, длина)} и проверка, что они плотно покрывают чанк."""
    ids = next(s for s in sections if s['names'] == [b'id'])
    spans = {e['values'][0][1].decode(): (e['offset'], e['length']) for e in ids['entries']}
    pos = 4
    for rid, (off, ln) in sorted(spans.items(), key=lambda kv: kv[1][0]):
        if off != pos:
            raise ValueError(f'записи не вплотную: {rid} со смещения {off}, ожидалось {pos}')
        pos = off + ln
    if pos != len(chunk):
        raise ValueError(f'записи кончаются на {pos}, а чанк — {len(chunk)} байт')
    return spans


def parse_record(rec):
    """→ список полей [(имя, тип, сырые байты значения вместе с длиной)]. Нужен, чтобы заменить одно поле, ничего не ломая."""
    r = Reader(rec)
    fields = []
    for _ in range(r.u16()):
        name = r.raw(r.u32())
        start = r.pos
        t = r.u8()
        _skip_value(r, t)
        fields.append((name, t, rec[start + 1:r.pos]))
    if r.pos != len(rec):
        raise ValueError(f'запись разобрана не до конца: {r.pos} из {len(rec)}')
    return fields


def _skip_value(r, t):
    if t in LEN_TYPES: r.raw(r.u32())
    elif t == 0x04: r.raw(8)
    elif t == 0x01:
        for _ in range(r.u16()):
            _skip_value(r, r.u8())
    elif t == 0x00: pass
    elif t == 0x02: r.raw(1)
    else: raise ValueError(f'неизвестный тип поля {t:#x} на {r.pos}')


def build_record(fields):
    out = bytearray(struct.pack('>H', len(fields)))
    for name, t, raw in fields:
        out += struct.pack('>I', len(name)) + name + bytes([t]) + raw
    return bytes(out)


def string_value(s):
    return struct.pack('>I', len(s.encode())) + s.encode()


def read_string(raw):
    n = struct.unpack('>I', raw[:4])[0]
    return raw[4:4 + n].decode()


def set_field(chunk, sections, record_id, field, value, vtype=0x0c, order='both'):
    """Записать значение поля у записи (строка 0x0c, ссылка 0x07 или JSON 0x0a — всё это текст с u32-длиной); вернуть (новый чанк, новые разделы индекса, старое значение, прирост длины).

    Пересчитывает всё, что зависит от записи:
      * длину самой записи и смещения всех записей после неё — во всех индексах;
      * значение в индексе по этому полю: индекс лежит отсортированным по значению
        (пустые строки первыми, при равенстве — в прежнем порядке), поэтому запись
        переезжает на своё место. Порядок важен: поиск по индексу двоичный, и
        неотсортированный индекс молча теряет записи.

    `order` — каким сравнением проверять порядок индекса: 'both' (по умолчанию, см. ниже) или
    'bytes'. Байтовый порядок выбирается только там, где проверено на данных, что индекс
    отсортирован по байтам, а без учёта регистра — нет: так устроен индекс по картинкам.

    Каким именно сравнением Framer сортирует, выяснено лишь отчасти: индекс названий
    идёт без учёта регистра («Junion, muted, okko, Palabra, pragma»), индексы слагов и
    ссылок — и так, и так одинаково. Поэтому вставка разрешена, только если порядок
    остаётся верным при ОБОИХ сравнениях — по байтам и без учёта регистра; иначе
    ошибка, а не догадка. Если индекс не был отсортирован до правки, тоже ошибка.
    """
    spans = record_spans(chunk, sections)
    off, ln = spans[record_id]
    fields = parse_record(chunk[off:off + ln])
    names = [f[0] for f in fields]
    key = field.encode()
    if key not in names:
        raise KeyError(f'у записи {record_id} нет поля {field}')
    i = names.index(key)
    if fields[i][1] != vtype:
        raise ValueError(f'поле {field}: тип {fields[i][1]:#x}, а ожидался {vtype:#x}')
    old = read_string(fields[i][2])
    fields[i] = (key, vtype, string_value(value))
    new_rec = build_record(fields)
    delta = len(new_rec) - ln

    new_chunk = chunk[:off] + new_rec + chunk[off + ln:]
    out = []
    for s in sections:
        ents = []
        for e in s['entries']:
            e = dict(e, values=list(e['values']))
            if e['offset'] == off:
                e['length'] += delta
                if s['names'] == [key]:
                    e['values'] = [(vtype, value.encode())]
            elif e['offset'] > off:
                e['offset'] += delta
            ents.append(e)
        if s['names'] == [key]:
            before = [e['values'][0][1] for e in s['entries']]
            ok = _sorted_both_ways if order == 'both' else (lambda v: v == sorted(v))
            if not ok(before):
                raise ValueError(f'индекс {field} не отсортирован по значению — порядок неизвестен, правка небезопасна')
            ents.sort(key=lambda e: e['values'][0][1])  # устойчивая: равные остаются в прежнем порядке
            if not ok([e['values'][0][1] for e in ents]):
                raise ValueError(f'значение встаёт в индекс {field} неоднозначно — место определить нельзя')
        out.append(dict(s, entries=ents))
    return new_chunk, out, old, delta


def _sorted_both_ways(vals):
    return vals == sorted(vals) and [v.lower() for v in vals] == sorted(v.lower() for v in vals)


def find_record(chunk, sections, slug_field, slug):
    """id записи по слагу — через индекс id + слаг."""
    pair = next(s for s in sections if s['names'] == [b'id', slug_field.encode()])
    hits = [e['values'][0][1].decode() for e in pair['entries'] if e['values'][1][1].decode() == slug]
    if len(hits) != 1:
        raise KeyError(f'слаг {slug!r}: найдено записей {len(hits)}')
    return hits[0]


def verify(chunk, sections, sorted_fields=()):
    """Целостность после правки: записи плотно покрывают чанк, каждая разбирается, значения в индексах
    совпадают с записями, а индексы по полям `sorted_fields` отсортированы: «поле» — и по байтам, и без
    учёта регистра, «поле:bytes» — только по байтам (так устроен индекс по картинкам)."""
    spans = record_spans(chunk, sections)
    for rid, (off, ln) in spans.items():
        assert build_record(parse_record(chunk[off:off + ln])) == chunk[off:off + ln], rid
    wanted = {f.split(':')[0]: (f.split(':') + ['both'])[1] for f in sorted_fields}  # 'поле' или 'поле:bytes'
    for s in sections:
        if len(s['names']) == 1 and s['names'][0].decode() in wanted:
            vals = [e['values'][0][1] for e in s['entries']]
            good = vals == sorted(vals) if wanted[s['names'][0].decode()] == 'bytes' else _sorted_both_ways(vals)
            assert good, f'индекс {s["names"][0].decode()} не отсортирован'
    # значение в индексе по полю должно совпадать с тем, что в самой записи
    for s in sections:
        if len(s['names']) != 1:
            continue
        field = s['names'][0]
        for e in s['entries']:
            t, v = e['values'][0]
            if t not in LEN_TYPES:
                continue
            rec = dict((f[0], f) for f in parse_record(chunk[e['offset']:e['offset'] + e['length']]))
            if field in rec and rec[field][1] == t:
                assert read_string(rec[field][2]).encode() == v, f'индекс {field.decode()} расходится с записью'
    return len(spans)


def selftest(chunk, index_bytes):
    """Круговая проверка: разобрать и собрать обратно должно давать тот же файл."""
    sections = parse_indexes(index_bytes)
    assert build_indexes(sections) == index_bytes, 'индексы: сборка не совпала с исходником'
    spans = record_spans(chunk, sections)
    for rid, (off, ln) in spans.items():
        rec = chunk[off:off + ln]
        assert build_record(parse_record(rec)) == rec, f'запись {rid}: сборка не совпала с исходником'
    return len(sections), len(spans)
