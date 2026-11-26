// Service worker: приложение и движок работают офлайн; партии с chess.com — только из сети.
const VERSION = 'dev'; // tools/build_site.py подставляет хеш содержимого
const CACHE = `shoh-${VERSION}`;
const ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'assets/pieces.css',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png',
  'vendor/chess.js',
  'vendor/stockfish.js',
  'js/main.js',
  'js/app.js',
  'js/board.js',
  'js/bots.js',
  'js/coach.js',
  'js/engine.js',
  'js/chesscom.js',
  'js/review.js',
  'js/reviewer.js',
  'js/updater.js',
  'js/store.js',
  'js/prefs.js',
  'js/ui/dom.js',
  'js/ui/tabs.js',
  'js/ui/games.js',
  'js/ui/review.js',
  'js/ui/progress.js',
  'js/ui/settings.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('shoh-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // партии с chess.com — всегда свежие, без кеша
  if (url.hostname === 'api.chess.com') return;

  // шрифты: из кеша, а если нет — из сети с сохранением
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(
      caches.open(CACHE).then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res.ok || res.type === 'opaque') c.put(req, res.clone());
          return res;
        } catch {
          return new Response('', { status: 504 });
        }
      }),
    );
    return;
  }

  if (url.origin !== location.origin) return;

  // открытие приложения (в т.ч. «Поделиться» с ?text=…) — оболочка той же версии, что и скрипты в кеше;
  // новая версия приходит вместе с новым service worker
  if (req.mode === 'navigate') {
    e.respondWith(caches.match('index.html', { ignoreSearch: true }).then((hit) => hit || fetch(req)));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req)));
});
