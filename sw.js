/* EFETL 英文練習 — service worker
   導覽頁走 network-first（永遠拿到最新題目），離線時退回快取；
   靜態資源走 stale-while-revalidate（先給快取、背景更新）。
   音檔的 Range 請求一律直送網路，不進快取。
   VERSION 只有在要「強制清空所有舊快取」時才需要往上加。 */
const VERSION = 'v2';
const SHELL = 'efetl-shell-' + VERSION;
const RUNTIME = 'efetl-runtime-' + VERSION;

const SHELL_FILES = [
  '/',
  '/index.html',
  '/offline.html',
  '/manifest.json',
  '/favicon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL)
      .then((c) => Promise.allSettled(SHELL_FILES.map((f) => c.add(f))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL && k !== RUNTIME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // 影音的 Range 請求（206）不能進 Cache Storage，直接走網路
  if (req.headers.has('range')) return;

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(RUNTIME).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req)
          .then((hit) => hit || caches.match('/offline.html')))
    );
    return;
  }

  // 靜態資源：stale-while-revalidate —— 先給快取（秒開），同時在背景抓新版，
  // 所以就算你用同一個檔名覆蓋圖片／音檔，下次開啟就會是新的。
  e.respondWith(
    caches.match(req).then((hit) => {
      const fresh = fetch(req).then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(RUNTIME).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || fresh;
    })
  );
});
