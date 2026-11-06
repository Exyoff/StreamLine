// Offline support: cache the app shell, serve cache-first and refresh in the background.
// (a new version fetches every file from the server, not from the browser's HTTP cache — GitHub Pages lets that keep
// a file ten minutes, and the old one would then be served from here until its next refresh)
const CACHE = 'streamline-v85';
const ASSETS = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/state.js', 'js/units.js', 'js/mesh.js', 'js/scene.js', 'js/ops.js', 'js/operators.js',
  'js/viewport.js', 'js/gizmo.js', 'js/ui.js', 'js/icons.js', 'js/io.js',
  'js/sketch.js', 'js/draw.js', 'js/features.js', 'js/csg.js', 'js/edges.js', 'js/constraints.js', 'js/cmdline.js', 'js/modifiers.js', 'js/sweep.js', 'js/history.js', 'js/browser.js', 'js/kernel.js', 'js/library.js', 'js/projects.js', 'vendor/occ/replicad.js', 'vendor/occ/casting-c4FpthHM.js', 'vendor/occ/replicad_single.js', 'vendor/occ/replicad_single.wasm',
  'vendor/three.module.min.js', 'vendor/lines/LineSegments2.js', 'vendor/lines/LineSegmentsGeometry.js', 'vendor/lines/LineMaterial.js', 'vendor/lines/Line2.js', 'vendor/lines/LineGeometry.js', 'vendor/fonts/LiberationSans-Bold.ttf', 'icons/icon.svg', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const hit = await cache.match(e.request, { ignoreSearch: true });
    // (the background refresh asks the server whether the file changed, past the HTTP cache)
    const req = e.request.mode === 'navigate' ? e.request : new Request(e.request, { cache: 'no-cache' });
    const net = fetch(req).then(r => { if (r.ok) cache.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
