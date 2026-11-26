"""Собирает www/ — сайт для GitHub Pages и веб-часть APK (Capacitor берёт её же).

В sw.js подставляется версия = хеш содержимого, чтобы телефоны получали обновления.
Запуск: python tools/build_site.py
"""
import hashlib
import pathlib
import shutil

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'www'
FILES = ['index.html', 'manifest.webmanifest', 'css/app.css', 'assets/pieces.css']
DIRS = ['js', 'vendor', 'icons']


def collect():
    out = [ROOT / f for f in FILES]
    for d in DIRS:
        out += sorted(p for p in (ROOT / d).rglob('*') if p.is_file())
    return out


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    files = collect()
    h = hashlib.sha256()
    for src in files:
        rel = src.relative_to(ROOT)
        dst = OUT / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)
        h.update(str(rel).encode())
        h.update(src.read_bytes())
    version = h.hexdigest()[:12]
    sw = (ROOT / 'sw.js').read_text(encoding='utf-8')
    assert "const VERSION = 'dev';" in sw
    # все ли файлы оболочки из ASSETS реально есть в сборке
    import re
    assets = re.findall(r"^\s+'([^']+)',$", sw.split('const ASSETS = [')[1].split('];')[0], re.M)
    missing = [a for a in assets if a not in ('./',) and not (OUT / a).exists()]
    if missing:
        raise SystemExit(f'sw.js ссылается на отсутствующие файлы: {missing}')
    js_files = {str(p.relative_to(OUT)).replace('\\', '/') for p in (OUT / 'js').rglob('*.js')}
    not_cached = sorted(js_files - set(assets))
    if not_cached:
        raise SystemExit(f'эти модули не попадут в офлайн-кеш, добавь их в ASSETS в sw.js: {not_cached}')
    (OUT / 'sw.js').write_text(sw.replace("const VERSION = 'dev';", f"const VERSION = '{version}';"), encoding='utf-8')
    (OUT / '.nojekyll').write_text('', encoding='utf-8')
    print(f'www/: {len(files) + 1} файлов, версия {version}')


if __name__ == '__main__':
    main()
