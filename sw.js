// يحفظ ملفات التطبيق ليعمل دون إنترنت، ويجلب أحدث نسخة متى توفّر الاتصال
const CACHE = 'hafez-v5';
const FILES = ['./', './index.html', './manifest.json', './apple-touch-icon.png', './icon-192.png', './icon-512.png',
  './fonts/plex-arabic-400-arabic.woff2', './fonts/plex-arabic-400-latin.woff2', './fonts/plex-arabic-500-arabic.woff2', './fonts/plex-arabic-500-latin.woff2', './fonts/plex-arabic-700-arabic.woff2', './fonts/plex-arabic-700-latin.woff2'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
