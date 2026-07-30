const CACHE_NAME = 'nasabah-bank-sampah-v6-tanpa-tombol-keluar';
const APP_SHELL = [
  './cek-saldo.html',
  './nasabah-v5.webmanifest',
  './logo_dlh.png',
  './icon-nasabah-v5-192.png',
  './icon-nasabah-v5-512.png',
  './icon-nasabah-v5-maskable-512.png',
  './apple-touch-icon-v5-180.png',
  './favicon-nasabah-v5-32.png',
  './supabase-adapter.js'
];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('nasabah-bank-sampah-') && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).then(response => {
      const copy=response.clone(); caches.open(CACHE_NAME).then(cache => cache.put('./cek-saldo.html',copy)); return response;
    }).catch(() => caches.match('./cek-saldo.html')));
    return;
  }
  event.respondWith(fetch(event.request).then(response => {
    const copy=response.clone(); caches.open(CACHE_NAME).then(cache => cache.put(event.request,copy)); return response;
  }).catch(() => caches.match(event.request)));
});
