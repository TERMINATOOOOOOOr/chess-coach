"""Живые обновления APK (js/updater.js) в имитации нативной среды.

В браузер подставляется поддельный window.Capacitor (Filesystem, Preferences, WebView в localStorage),
GitHub Pages подменяется «новой версией» с одним изменённым файлом. «Перезапуск приложения» —
новая вкладка: базовая папка берётся из закреплённой (как Capacitor читает её при старте).
Запуск: python tools/build_site.py && python tests/e2e_updater.py
"""
import asyncio
import copy
import hashlib
import json
import sys

from playwright.async_api import async_playwright

from e2e import ROOT, Check, server, wait_js

WWW = ROOT / 'www'
REMOTE = 'https://terminatooooooor.github.io/chess-coach/'
CHANGED = 'js/ui/settings.js'

FAKE_CAPACITOR = r"""
(() => {
  const LS = localStorage;
  const Filesystem = {
    async writeFile({ path, data }) { LS.setItem('fs:' + path, String(data.length)); },
    async readdir() {
      const s = new Set();
      for (let i = 0; i < LS.length; i++) { const k = LS.key(i); if (k.startsWith('fs:')) s.add(k.slice(3).split('/')[0]); }
      return { files: [...s].map((name) => ({ name })) };
    },
    async rmdir({ path }) { for (const k of Object.keys(LS)) if (k.startsWith('fs:' + path + '/')) LS.removeItem(k); },
    async getUri({ path }) { return { uri: 'file:///data/user/0/shoh/files/' + path }; },
  };
  const Preferences = {
    async get({ key }) { return { value: LS.getItem('pref:' + key) }; },
    async set({ key, value }) { LS.setItem('pref:' + key, value); },
    async remove({ key }) { LS.removeItem('pref:' + key); },
  };
  const WebView = {
    async setServerBasePath({ path }) {
      await window.fakeNative('set', path);
      LS.setItem('fake.switches', String(+(LS.getItem('fake.switches') || 0) + 1));
      setTimeout(() => location.reload(), 30);
    },
    async getServerBasePath() { return { path: await window.fakeNative('get', '') }; },
    async persistServerBasePath() { await window.fakeNative('persist', ''); },
  };
  window.Capacitor = {
    isNativePlatform: () => true,
    isPluginAvailable: (n) => !!window.Capacitor.Plugins[n],
    Plugins: { Filesystem, Preferences, WebView },
  };
})();
"""


def make_remote(local, extra_requires=None):
    content = (WWW / CHANGED).read_bytes() + b'\n// v2\n'
    m = copy.deepcopy(local)
    m['version'] = 'v2test'
    m['built'] = local['built'] + 1000
    m['files'][CHANGED] = hashlib.sha256(content).hexdigest()
    if extra_requires:
        m['requires'] = m['requires'] + extra_requires
    return m, content


async def new_ctx(browser, url, remote, changed_content, log, broken=False):
    """Контекст = телефон. ctx.native — состояние нативной части: текущая и закреплённая папка."""
    ctx = await browser.new_context(viewport={'width': 412, 'height': 915}, is_mobile=True)
    native = {'base': '', 'persisted': ''}
    ctx.native = native

    async def fake_native(source, op, arg):
        if op == 'set':
            native['base'] = arg
        elif op == 'persist':
            native['persisted'] = native['base']
        return native['base']

    await ctx.expose_binding('fakeNative', fake_native)
    await ctx.add_init_script(FAKE_CAPACITOR)

    async def remote_route(route):
        path = route.request.url.split(REMOTE, 1)[1].split('?')[0]
        log.append(path)
        if path == 'version.json':
            return await route.fulfill(json=remote, headers={'Access-Control-Allow-Origin': '*'})
        body = changed_content if path == CHANGED else (WWW / path).read_bytes()
        await route.fulfill(body=body, headers={'Access-Control-Allow-Origin': '*'})

    async def local_route(route):
        # после переключения базовой папки «телефон» отдаёт файлы новой версии
        on = bool(native['base'])
        rel = route.request.url.split(url, 1)[1].split('?')[0].split('#')[0]
        if on and rel == 'version.json':
            return await route.fulfill(json=remote)
        if on and broken and rel == 'js/main.js':
            return await route.fulfill(body='throw new Error("сломанная сборка")', content_type='text/javascript')
        await route.continue_()

    await ctx.route(REMOTE + '**', remote_route)
    await ctx.route(url + '**', local_route)
    await ctx.route('https://api.chess.com/**', lambda r: r.fulfill(status=404, json={}, headers={'Access-Control-Allow-Origin': '*'}))
    return ctx


async def launch(ctx, url, hash_=''):
    """Холодный старт приложения: Capacitor берёт закреплённую папку (или встроенную версию)."""
    ctx.native['base'] = ctx.native['persisted']
    page = await ctx.new_page()
    page.on('pageerror', lambda e: None)
    await page.goto(url + hash_)
    return page


async def ls(page, key):
    return await page.evaluate(f'localStorage.getItem({json.dumps(key)})')


async def run(url, check):
    local = json.loads((WWW / 'version.json').read_text(encoding='utf-8'))
    remote, changed = make_remote(local)
    async with async_playwright() as p:
        browser = await p.chromium.launch()

        # ── 1. обычное обновление ──
        log = []
        ctx = await new_ctx(browser, url, remote, changed, log)
        a = await launch(ctx, url, '#settings')
        await wait_js(a, "localStorage.getItem('pref:shoh.update.ready') !== null", 30000)
        fetched = sorted(set(log) - {'version.json'})
        check(fetched == sorted(['index.html', CHANGED]), f'скачаны только изменённые файлы и HTML: {fetched}')
        files = await a.evaluate("Object.keys(localStorage).filter(k => k.startsWith('fs:www-v2test/')).length")
        check(files == len(remote['files']) + 1, f'в папке новой версии все файлы: {files} из {len(remote["files"]) + 1}')
        status = await a.text_content('#upd-status')
        check('скачано' in status, f'статус: {status}')
        await a.close()

        b = await launch(ctx, url, '#settings')  # перезапуск приложения
        await wait_js(b, "/обновился/.test(document.getElementById('upd-status').textContent)", 10000)
        no_flags = await ls(b, 'pref:shoh.update.ready') is None and await ls(b, 'pref:shoh.update.trying') is None
        check(ctx.native['persisted'].endswith('www-v2test'), f'после перезапуска новая версия включилась и закреплена: {ctx.native["persisted"]}')
        check(no_flags, 'флаги обновления убраны')
        await b.screenshot(path=str(ROOT / 'tests' / 'screens' / 'phone-updated.png'))
        await b.close()

        c = await launch(ctx, url, '#settings')  # ещё один запуск: уже на новой версии, без переключений
        await wait_js(c, "/Установлена последняя|обновился/.test(document.getElementById('upd-status').textContent)", 20000)
        switches = await ls(c, 'fake.switches')
        check(switches == '1', f'лишних переключений нет: {switches}')
        await ctx.close()

        # ── 2. сломанная версия откатывается и помечается плохой ──
        ctx = await new_ctx(browser, url, remote, changed, [], broken=True)
        a = await launch(ctx, url, '#settings')
        await wait_js(a, "localStorage.getItem('pref:shoh.update.ready') !== null", 30000)
        await a.close()
        for _ in (1, 2):
            pg = await launch(ctx, url)
            await pg.wait_for_timeout(2000)  # переключилась, новая версия упала, подтверждения нет
            await pg.close()
        d = await launch(ctx, url, '#settings')
        await wait_js(d, "(localStorage.getItem('pref:shoh.update.bad') || '').includes('v2test')", 15000)
        check(not ctx.native['persisted'], 'сломанная версия не закреплена: работает прежняя')
        switches = await ls(d, 'fake.switches')
        check(switches == '2', f'после 2 неудач версия помечена плохой (переключений: {switches})')
        await ctx.close()

        # ── 3. версии нужен нативный плагин, которого нет — просим новый APK ──
        remote3, changed3 = make_remote(local, extra_requires=['Camera'])
        ctx = await new_ctx(browser, url, remote3, changed3, [])
        a = await launch(ctx, url, '#settings')
        await wait_js(a, "!document.getElementById('upd-apk-row').hidden", 20000)
        check(await ls(a, 'pref:shoh.update.ready') is None, 'нужен новый APK: веб-часть не ставится, видна кнопка «Скачать APK»')
        await a.screenshot(path=str(ROOT / 'tests' / 'screens' / 'phone-need-apk.png'))
        await ctx.close()
        await browser.close()


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    if not (WWW / 'version.json').exists():
        raise SystemExit('сначала python tools/build_site.py')
    (ROOT / 'tests' / 'screens').mkdir(parents=True, exist_ok=True)
    check = Check()
    with server(WWW) as url:
        asyncio.run(run(url, check))
    print('\nитог:', 'всё прошло' if not check.failed else f'провалено проверок: {check.failed}')
    sys.exit(1 if check.failed else 0)


if __name__ == '__main__':
    main()
