"""Рисует иконки приложения из assets/icon.svg: PWA (192/512/maskable/apple) и Android (mipmap, сплэш).

Рендер SVG — через Chromium (Playwright), масштабирование — PIL.
Запуск: python tools/make_icons.py
"""
import asyncio
import io
import pathlib

from PIL import Image, ImageDraw
from playwright.async_api import async_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SVG = (ROOT / 'assets' / 'icon.svg').read_text(encoding='utf-8')


async def render(size, scale_mark=1.0):
    """Квадрат size×size; scale_mark < 1 — фигура меньше (безопасная зона maskable/adaptive)."""
    svg = SVG
    if scale_mark != 1.0:
        svg = svg.replace('scale(7.6)', f'scale({7.6 * scale_mark:.3f})')
    html = f'<html><body style="margin:0;background:#0e0f12">{svg.replace("<svg ", f"<svg width={size} height={size} ")}</body></html>'
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={'width': size, 'height': size})
        await pg.set_content(html)
        png = await pg.screenshot(clip={'x': 0, 'y': 0, 'width': size, 'height': size})
        await b.close()
    return Image.open(io.BytesIO(png)).convert('RGBA')


def rounded(img, radius_ratio=0.22):
    mask = Image.new('L', img.size, 0)
    r = int(img.size[0] * radius_ratio)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, img.size[0] - 1, img.size[1] - 1], r, fill=255)
    out = Image.new('RGBA', img.size, (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def circle(img):
    mask = Image.new('L', img.size, 0)
    ImageDraw.Draw(mask).ellipse([0, 0, img.size[0] - 1, img.size[1] - 1], fill=255)
    out = Image.new('RGBA', img.size, (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


async def main():
    full = await render(1024)
    safe = await render(1024, 0.72)  # для maskable и adaptive-иконок Android

    icons = ROOT / 'icons'
    icons.mkdir(exist_ok=True)
    rounded(full).resize((192, 192), Image.LANCZOS).save(icons / 'icon-192.png')
    rounded(full).resize((512, 512), Image.LANCZOS).save(icons / 'icon-512.png')
    safe.resize((512, 512), Image.LANCZOS).save(icons / 'maskable-512.png')
    full.convert('RGB').resize((180, 180), Image.LANCZOS).save(icons / 'apple-touch-icon.png')
    print('PWA: icons/*.png')

    res = ROOT / 'android' / 'app' / 'src' / 'main' / 'res'
    if not res.exists():
        print('android/ ещё нет — Android-иконки пропущены')
        return
    dens = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
    for d, k in dens.items():
        folder = res / f'mipmap-{d}'
        folder.mkdir(exist_ok=True)
        s = int(48 * k)
        rounded(full, 0.2).resize((s, s), Image.LANCZOS).save(folder / 'ic_launcher.png')
        circle(full).resize((s, s), Image.LANCZOS).save(folder / 'ic_launcher_round.png')
        f = int(108 * k)
        safe.resize((f, f), Image.LANCZOS).save(folder / 'ic_launcher_foreground.png')
    # фон adaptive-иконки — тот же графит
    values = res / 'values'
    bg = values / 'ic_launcher_background.xml'
    if bg.exists():
        bg.write_text('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#0E0F12</color>\n</resources>\n', encoding='utf-8')
    # сплэш: все splash.png, что сгенерировал Capacitor, заменяем тёмным с маркой по центру
    for sp in res.glob('drawable*/splash.png'):
        w, h = Image.open(sp).size
        canvas = Image.new('RGB', (w, h), (14, 15, 18))
        m = int(min(w, h) * 0.34)
        mark = circle(full).resize((m, m), Image.LANCZOS)
        canvas.paste(mark, ((w - m) // 2, (h - m) // 2), mark)
        canvas.save(sp)
    print('Android: mipmap-*, splash')


if __name__ == '__main__':
    asyncio.run(main())
