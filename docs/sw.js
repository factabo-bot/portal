// 同じオリジンに他のアプリが同居しているので、キャッシュ名は必ず portal- で始め、消すのも portal- のものだけ。
const CACHE = 'portal-v43';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icon-v1.svg', 'icon-v1-192.png', 'icon-v1-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((u) => new Request(u, { cache: 'reload' })))));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((k) => k.startsWith('portal-') && k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
// 自分のファイルだけ、ネットを先に見て、つながらなければキャッシュ
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || !u.pathname.startsWith('/portal/')) return;
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then((r) => {
    const copy = r.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copy));
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
