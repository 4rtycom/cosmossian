/* Cosmossian service worker: makes the site installable and keeps the heavy, rarely changing files on the device,
   so a second visit (or the installed app) starts almost at once.
   - The page itself: always fetched fresh when online (it carries live data), the last copy is used when offline.
   - Engine, textures, models, star data: served from the device, fetched once.
   - Live feeds under /api/: never stored here, except the Gaia star file, which is large and changes rarely. */
const V = 'cosmossian-v1';
const CORE = ['/lib/three/three.min.js', '/lib/three/post/CopyShader.js', '/lib/three/post/LuminosityHighPassShader.js',
  '/lib/three/post/EffectComposer.js', '/lib/three/post/UnrealBloomPass.js', '/logo.png', '/icon-192.png', '/favicon.ico'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

const STATIC = /^\/(lib|tex|models|data|deck)\/|^\/(logo|og-image|icon-[\w-]+|apple-touch-icon)\.png$|^\/favicon\.ico$/;

self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin !== location.origin) return;
  if (r.mode === 'navigate') {
    // fresh page when online; the last copy (or the start page) when offline
    e.respondWith(fetch(r).then(res => {
      if (res.ok && u.pathname === '/') { const c = res.clone(); caches.open(V).then(k => k.put('/', c)); }
      return res;
    }).catch(() => caches.match('/').then(m => m || Response.error())));
    return;
  }
  if (STATIC.test(u.pathname) || u.pathname === '/api/gaia.bin') {
    // data files and the Gaia file: answer from the device and refresh the stored copy in the background; everything else: fetched once
    const refresh = u.pathname.startsWith('/data/') || u.pathname === '/api/gaia.bin';
    e.respondWith(caches.open(V).then(c => c.match(r, { ignoreSearch: u.pathname.startsWith('/lib/') }).then(hit => {
      const net = () => fetch(r).then(res => { if (res.status === 200) c.put(r, res.clone()); return res; });
      if (!hit) return net();
      if (refresh) e.waitUntil(net().catch(() => {}));
      return hit;
    })));
  }
});
