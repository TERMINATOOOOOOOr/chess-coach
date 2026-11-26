"""Сквозной тест в Chromium: партия, подсказки, топ-ходы, зевок + «взять назад», угроза, мобильная вёрстка.

Запуск:  python tests/e2e.py              (сам поднимает http.server)
         python tests/e2e.py --file dist/shoh.html   (проверка однофайловой сборки по file://)
Скриншоты пишутся в tests/screens/.
"""
import argparse
import asyncio
import contextlib
import pathlib
import socket
import subprocess
import sys
import time

from playwright.async_api import async_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SHOTS = ROOT / 'tests' / 'screens'
FILES = 'abcdefgh'


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


@contextlib.contextmanager
def server():
    port = free_port()
    proc = subprocess.Popen(
        [sys.executable, '-m', 'http.server', str(port), '--bind', '127.0.0.1'],
        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        for _ in range(50):
            with contextlib.suppress(OSError), socket.create_connection(('127.0.0.1', port), 0.2):
                break
            time.sleep(0.1)
        yield f'http://127.0.0.1:{port}/'
    finally:
        proc.terminate()


class Check:
    def __init__(self):
        self.failed = 0

    def __call__(self, ok, name):
        print(('  OK   ' if ok else '  FAIL ') + name)
        if not ok:
            self.failed += 1


async def sq_center(page, sq):
    box = await page.locator('#board').bounding_box()
    orient = await page.evaluate('document.querySelector("#board .sq").dataset.sq') == 'a8' and 'w' or 'b'
    f = FILES.index(sq[0])
    r = int(sq[1])
    col, row = (f, 8 - r) if orient == 'w' else (7 - f, r - 1)
    size = box['width'] / 8
    return box['x'] + (col + 0.5) * size, box['y'] + (row + 0.5) * size


async def click_move(page, a, b):
    for sq in (a, b):
        x, y = await sq_center(page, sq)
        await page.mouse.click(x, y)
        await page.wait_for_timeout(80)


async def drag_move(page, a, b):
    x1, y1 = await sq_center(page, a)
    x2, y2 = await sq_center(page, b)
    await page.mouse.move(x1, y1)
    await page.mouse.down()
    await page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, steps=6)
    await page.mouse.move(x2, y2, steps=6)
    await page.mouse.up()


async def wait_js(page, expr, timeout=30000):
    await page.wait_for_function(expr, timeout=timeout)


async def run(url, check):
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={'width': 1440, 'height': 900})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: m.type == 'error' and errors.append(m.text))
        await page.goto(url)

        # 1. старт через окно выбора соперника
        await page.wait_for_selector('#setup[open]')
        await page.click('.bot:has-text("Пешка")')
        await page.click('#setup button[value=start]')
        await wait_js(page, 'window.__shoh.state.analysis !== null')
        check(True, 'тренер проанализировал стартовую позицию')
        ev = await page.text_content('#coach-eval')
        check(ev.startswith('+') or ev.startswith('0') or ev.startswith('−'), f'оценка показана: {ev}')

        # 2. ход кликами и ответ бота
        await click_move(page, 'e2', 'e4')
        await wait_js(page, 'window.__shoh.state.entries.length >= 2')
        check(True, 'ход кликом e2-e4, бот ответил')
        await wait_js(page, 'window.__shoh.state.entries[0].result !== null')
        tag = await page.text_content('#bubble-tag')
        check(bool(tag), f'ход оценён: {tag.strip()}')

        # 3. подсказка в три шага
        await wait_js(page, 'window.__shoh.state.analysis !== null')
        await page.click('#btn-hint')
        t1 = await page.text_content('#bubble-text')
        await page.click('#btn-hint')
        marked = await page.locator('#board .sq.hint-from').count()
        await page.click('#btn-hint')
        t3 = await page.text_content('#bubble-text')
        arrows = await page.locator('#board .arrow.hint').count()
        check(len(t1) > 10, f'подсказка 1 (идея): {t1}')
        check(marked == 1, 'подсказка 2 подсветила фигуру')
        check(arrows == 1 and ' — ' in t3, f'подсказка 3 (стрелка + ход): {t3}')
        check(await page.is_disabled('#btn-hint'), 'после трёх подсказок кнопка неактивна')

        # 4. топ-3 хода
        await page.click('label:has(#tg-top)')
        items = await page.locator('#topmoves li').count()
        best_arrows = await page.locator('#board .arrow.best, #board .arrow.alt, #board .arrow.alt2').count()
        check(items >= 2 and best_arrows >= 2, f'топ-ходы: {items} в списке, {best_arrows} стрелки')
        await page.screenshot(path=str(SHOTS / 'desktop-hints.png'))
        await page.click('label:has(#tg-top)')

        # 5. ход перетаскиванием (конь g1-f3 или b1-c3)
        legal = await page.evaluate('window.__shoh.state.game.moves({verbose:true}).map(m=>m.from+m.to)')
        mv = 'g1f3' if 'g1f3' in legal else 'b1c3'
        await drag_move(page, mv[:2], mv[2:])
        await wait_js(page, 'window.__shoh.state.entries.length >= 4')
        check(True, f'ход перетаскиванием {mv}, бот ответил')

        # 6. зевок коня и «взять назад»
        fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3'
        await page.evaluate(f'window.__shoh.start("{fen}", "w", "pawn")')
        await wait_js(page, 'window.__shoh.state.analysis !== null')
        await click_move(page, 'f3', 'g5')
        await wait_js(page, 'window.__shoh.state.entries[0] && window.__shoh.state.entries[0].result !== null')
        cls = await page.evaluate('window.__shoh.state.entries[0].result.cls')
        text = await page.text_content('#bubble-text')
        check(cls in ('blunder', 'mistake'), f'Кg5 оценён как «{cls}»')
        check('коня' in text, f'объяснение: {text}')
        check(await page.locator('#board .badge').count() == 1, 'значок оценки на доске')
        check(await page.is_visible('#btn-retry'), 'кнопка «Взять назад и попробовать снова» видна')
        await page.screenshot(path=str(SHOTS / 'desktop-blunder.png'))
        await page.click('#btn-retry')
        await wait_js(page, 'window.__shoh.state.entries.length === 0')
        back = await page.evaluate('window.__shoh.state.game.fen()')
        check(back == fen, 'позиция вернулась к ходу до зевка')

        # 7. угроза мата
        fen = 'rnb1k1nr/pppp1ppp/8/2b1p3/4P2q/8/PPPP1PPP/RNBQKBNR w KQkq - 2 4'
        await page.evaluate(f'window.__shoh.start("{fen}", "w", "pawn")')
        await wait_js(page, '!document.getElementById("bubble-warn").hidden')
        warn = await page.text_content('#bubble-warn')
        check('мата' in warn, f'предупреждение: {warn}')
        check(await page.locator('#board .arrow.threat').count() == 1, 'стрелка угрозы на доске')
        await page.screenshot(path=str(SHOTS / 'desktop-threat.png'))

        # 7б. превращение пешки через окно выбора фигуры
        fen = '8/4P1k1/8/8/8/8/8/K7 w - - 0 1'
        await page.evaluate(f'window.__shoh.start("{fen}", "w", "pawn")')
        await wait_js(page, 'window.__shoh.state.analysis !== null')
        await click_move(page, 'e7', 'e8')
        await page.wait_for_selector('#board .promo-btn')
        await page.screenshot(path=str(SHOTS / 'desktop-promo.png'))
        await page.click('#board .promo-btn[aria-label="Ферзь"]')
        await wait_js(page, 'window.__shoh.state.entries.length >= 1')
        piece = await page.evaluate('JSON.stringify(window.__shoh.state.game.history({verbose:true})[0].promotion)')
        check(piece == '"q"', 'пешка превратилась в ферзя через окно выбора')

        # 7в. быстрый ход до окончания анализа не ломает подсказку
        await page.evaluate('window.__shoh.start("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "w", "king")')
        await page.wait_for_timeout(50)
        await click_move(page, 'd2', 'd4')
        await wait_js(page, 'window.__shoh.state.entries.length >= 2', 40000)
        await page.click('#btn-hint')
        await wait_js(page, 'window.__shoh.state.analysis && window.__shoh.state.analysis.fen === window.__shoh.state.game.fen()', 30000)
        await page.wait_for_timeout(300)
        hint_text = await page.text_content('#bubble-text')
        check('Секунду' not in hint_text and len(hint_text) > 10, f'подсказка после быстрого хода: {hint_text}')

        # 8. мат и итог партии
        fen = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 2 3'
        await page.evaluate(f'window.__shoh.start("{fen}", "w", "pawn")')
        await wait_js(page, 'window.__shoh.state.analysis !== null')
        await click_move(page, 'h5', 'f7')
        await page.wait_for_selector('#result[open]', timeout=15000)
        title = await page.text_content('#result-title')
        check(title == 'Победа!', f'итог: {title}')
        await page.screenshot(path=str(SHOTS / 'desktop-result.png'))
        await page.click('#result button[value=close]')

        # 9. мобильная вёрстка
        m = await browser.new_page(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
        m.on('pageerror', lambda e: errors.append(str(e)))
        await m.goto(url)
        await m.wait_for_selector('#setup[open]')
        await m.screenshot(path=str(SHOTS / 'mobile-setup.png'))
        await m.click('#setup button[value=start]')
        await wait_js(m, 'window.__shoh.state.analysis !== null')
        overflow = await m.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
        check(overflow <= 0, f'нет горизонтального скролла на телефоне ({overflow}px)')
        await m.screenshot(path=str(SHOTS / 'mobile-game.png'), full_page=True)

        check(not errors, 'консоль без ошибок' + ('' if not errors else f': {errors[:3]}'))
        await browser.close()


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser()
    ap.add_argument('--file', help='открыть файл по file:// вместо сервера')
    args = ap.parse_args()
    SHOTS.mkdir(parents=True, exist_ok=True)
    check = Check()
    if args.file:
        asyncio.run(run((ROOT / args.file).resolve().as_uri(), check))
    else:
        with server() as url:
            asyncio.run(run(url, check))
    print('\nитог:', 'всё прошло' if not check.failed else f'провалено проверок: {check.failed}')
    sys.exit(1 if check.failed else 0)


if __name__ == '__main__':
    main()
