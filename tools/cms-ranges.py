"""Сверить границы индексов в модуле коллекции с самими файлами индексов и поправить.

Зачем. Код сайта не читает файл индексов целиком как набор разделов: для каждого
индекса в нём записан байтовый диапазон `range:{from:…,to:…}`, и загрузчик вырезает
раздел ровно по этим числам. Записан в двух местах, и оба надо держать верными:
  * модуль коллекции `assets/modules/<коллекция>/<версия>/Jo_ECrywm.js`;
  * общий чанк `assets/js/shared-lib.*.mjs` — у него своя копия описания коллекции,
    и при переходах по сайту работает именно она (первая версия этого шага правила
    только модуль, и переходы падали с «… is not valid JSON»).
Любая правка данных, меняющая длину значения в индексе (адрес ролика, адрес картинки,
новая запись), сдвигает разделы, и числа обязаны сдвинуться вместе с ними. Иначе
загрузчик режет не там и получает мусор вместо индекса.

Ошибка тихая: индексы по картинкам, роликам и описаниям сайт сейчас в запросах не
использует, поэтому сдвиг их границ ничего видимого не ломал — пока какой-нибудь
запрос (сортировка, фильтр) не обратится к такому индексу. Поэтому шаг проверяет все
границы, а не только «нужные».

Запуск:  python3 tools/cms-ranges.py           — поправить, если разошлось
         python3 tools/cms-ranges.py --check   — только проверить (код выхода 1 при расхождении)

Изменённые чанки /assets/js переименовываются цепочкой (tools/rename-chunks.mjs), как
после любой правки кода. Шаг идемпотентный. После него — cms-version (имя папки версии
зависит и от модуля коллекции).
"""
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import cmsdata  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent / 'site'

# Блок одной локали в модуле: `<локаль>:new o({chunks:[…"./Jo_ECrywm-chunk-<локаль>-0.cmsdata"…],…indexes:[…]…})`.
# Внутри — по одному `new m({…fieldNames:X,range:{from:A,to:B},url:…indexes-<локаль>-0.cmsdata…})` на раздел.
RANGE = re.compile(r'range:\{from:(\d+),to:(\d+)\}')


def fix_module(module_path, check_only):
    js = module_path.read_text(encoding='utf-8')
    if '/assets/modules/' in str(module_path):
        data_dir = Path(str(module_path.parent).replace('/assets/modules/', '/assets/cms/'))
    else:  # чанк: папка данных — из адреса модуля рядом с диапазоном
        mod = re.search(r'new URL\(`(/assets/modules/[^`]+)/[^/`]+\.js`', js)
        if not mod:
            raise ValueError(f'{module_path.name}: не найден адрес модуля коллекции')
        data_dir = ROOT / mod.group(1).lstrip('/').replace('assets/modules/', 'assets/cms/')
    out, problems = [], []
    # Каждое упоминание диапазона относится к файлу индексов, чей адрес идёт в том же `new m({…})` сразу после.
    for m in RANGE.finditer(js):
        url = re.match(r',url:new URL\(["`]\./([^"`]+)["`]', js[m.end():])
        if not url:
            raise ValueError(f'{module_path.name}: у диапазона на {m.start()} не найден адрес файла')
        out.append((m, url.group(1)))

    by_file = {}
    for m, name in out:
        by_file.setdefault(name, []).append(m)

    new_js = js
    shift = 0
    replacements = []
    for name, matches in by_file.items():
        sections = cmsdata.parse_indexes((data_dir / name).read_bytes())
        bounds = cmsdata.section_bounds(sections)
        if len(bounds) != len(matches):
            raise ValueError(f'{name}: разделов в файле {len(bounds)}, а диапазонов в модуле {len(matches)}')
        for m, (a, b) in zip(matches, bounds):
            cur = (int(m.group(1)), int(m.group(2)))
            if cur != (a, b):
                problems.append(f'{name}: {cur[0]}–{cur[1]} → {a}–{b}')
                replacements.append((m.start(), m.end(), f'range:{{from:{a},to:{b}}}'))
    for start, end, text in sorted(replacements):
        new_js = new_js[:start + shift] + text + new_js[end + shift:]
        shift += len(text) - (end - start)

    if problems and not check_only:
        module_path.write_text(new_js, encoding='utf-8')
    return problems, len(out)


def main():
    check_only = '--check' in sys.argv
    bad = 0
    renamed = []
    files = sorted(ROOT.glob('assets/modules/*/*/*.js')) + sorted(ROOT.glob('assets/js/*.mjs'))
    for module in files:
        if 'range:{from:' not in module.read_text(encoding='utf-8'):
            continue
        problems, total = fix_module(module, check_only)
        rel = module.relative_to(ROOT)
        if problems:
            bad += 1
            if module.parent == ROOT / 'assets/js':
                renamed.append(module.name)
            print(f'  {"✗" if check_only else "исправлено"} {rel}: {len(problems)} из {total} диапазонов')
            for p in problems[:6]:
                print(f'      {p}')
        else:
            print(f'  ✓ {rel}: все {total} диапазонов совпадают с файлами')
    if check_only and bad:
        sys.exit(1)
    if renamed and not check_only:
        subprocess.run(['node', str(Path(__file__).parent / 'rename-chunks.mjs'), *renamed], check=True, cwd=ROOT.parent)


if __name__ == '__main__':
    main()
