// Offline support: cache the app shell, serve cache-first and refresh in the background.
const CACHE = 'streamline-v25';
const ASSETS = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/state.js', 'js/units.js', 'js/mesh.js', 'js/scene.js', 'js/ops.js', 'js/operators.js',
  'js/viewport.js', 'js/gizmo.js', 'js/ui.js', 'js/icons.js', 'js/io.js',
  'js/sketch.js', 'js/draw.js', 'js/features.js', 'js/csg.js', 'js/edges.js', 'js/constraints.js', 'js/cmdline.js', 'js/modifiers.js', 'js/sweep.js', 'js/history.js', 'js/browser.js',
  'vendor/three.module.min.js', 'vendor/lines/LineSegments2.js', 'vendor/lines/LineSegmentsGeometry.js', 'vendor/lines/LineMaterial.js', 'vendor/lines/Line2.js', 'vendor/lines/LineGeometry.js', 'icons/icon.svg', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const hit = await cache.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then(r => { if (r.ok) cache.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
