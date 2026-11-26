"""Собирает dist/shoh.html — один файл, который открывается двойным кликом (file://), без сервера.

CSS вклеивается в <style>, ES-модули — в один inline-модуль (каждый модуль в своей области видимости),
Stockfish — в <script type="text/plain">, из которого воркер создаётся через Blob URL.
"""
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
ORDER = [
    'vendor/chess.js', 'js/coach.js', 'js/engine.js', 'js/bots.js', 'js/board.js',
    'js/store.js', 'js/chesscom.js', 'js/prefs.js', 'js/ui/dom.js', 'js/review.js', 'js/reviewer.js',
    'js/ui/tabs.js', 'js/app.js', 'js/ui/games.js', 'js/ui/review.js', 'js/ui/progress.js', 'js/ui/settings.js',
    'js/main.js',
]

IMPORT_RE = re.compile(r"^\s*import\s*\{[^}]*\}\s*from\s*'[^']+';\s*$", re.M | re.S)
EXPORT_RE = re.compile(r'^export\s+(?:async\s+)?(?:function|class|const|let)\s+(\w+)', re.M)


def read(rel):
    return (ROOT / rel).read_text(encoding='utf-8')


def module(rel, only=None):
    src = IMPORT_RE.sub('', read(rel))
    names = EXPORT_RE.findall(src)
    if re.search(r'^export\s+(default|\{)', src, re.M):
        raise SystemExit(f'{rel}: неподдерживаемая форма export')
    src = re.sub(r'^export\s+', '', src, flags=re.M)
    if only:
        names = [n for n in names if n in only]
    body = f'// ── {rel} ──\n{src}\n'
    if not names:
        return f'(() => {{\n{body}}})();\n'
    lst = ', '.join(names)
    return f'const {{ {lst} }} = (() => {{\n{body}return {{ {lst} }};\n}})();\n'


def main():
    html = read('index.html')
    for href in ['assets/pieces.css', 'css/app.css']:
        tag = f'<link rel="stylesheet" href="{href}">'
        assert tag in html, tag
        html = html.replace(tag, f'<style>\n{read(href)}</style>')

    # PWA-ссылки по file:// не работают — убираем, иконку вклеиваем data-URI
    import base64
    html = re.sub(r'\s*<link rel="manifest"[^>]*>', '', html)
    html = re.sub(r'\s*<link rel="apple-touch-icon"[^>]*>', '', html)
    icon = base64.b64encode((ROOT / 'icons' / 'icon-192.png').read_bytes()).decode()
    html = html.replace('href="icons/icon-192.png"', f'href="data:image/png;base64,{icon}"')

    names = {}
    for rel in ORDER:
        for n in EXPORT_RE.findall(read(rel)):
            if rel.startswith('vendor') and n != 'Chess':
                continue
            if n in names:
                raise SystemExit(f'имя {n} экспортируют и {names[n]}, и {rel}')
            names[n] = rel
    missing = sorted(set(str(p.relative_to(ROOT)).replace('\\', '/') for p in (ROOT / 'js').rglob('*.js')) - set(ORDER))
    if missing:
        raise SystemExit(f'модули не в ORDER: {missing}')

    js = ''.join(module(rel, only={'Chess'} if rel.startswith('vendor') else None) for rel in ORDER)
    sf = read('vendor/stockfish.js')
    for bad in ('</script', '<!--'):
        assert bad not in js and bad not in sf, bad
    tag = '<script type="module" src="js/main.js"></script>'
    assert tag in html
    html = html.replace(
        tag,
        f'<script id="stockfish-src" type="text/plain">{sf}</script>\n  <script type="module">\n{js}</script>',
    )
    out = ROOT / 'dist' / 'shoh.html'
    out.parent.mkdir(exist_ok=True)
    out.write_text(html, encoding='utf-8')
    print(f'{out.relative_to(ROOT)}: {out.stat().st_size / 1024 / 1024:.2f} МБ')


if __name__ == '__main__':
    main()
