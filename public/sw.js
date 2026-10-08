/* Download Manager — service worker (sans dépendance, modèle guitare).
 * Stratégie simple, adaptée à une appli 100 % statique servie avec ses API :
 * - navigation : réseau d'abord, repli sur index.html en cache (hors-ligne) ;
 * - assets même origine (JS, CSS, images, polices) : cache d'abord, puis
 *   réseau + mise en cache ;
 * - jamais interceptés : requêtes non-GET, API perso (.php / ?action=, JSON
 *   dynamique), origines tierces (Transmission, Plex, TMDB, Allociné, C411…).
 */
const CACHE = 'download-manager-v2';
const APP_SHELL = ['./', './index.html', './manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function isApiRequest(url) {
  return url.pathname.endsWith('.php') || url.searchParams.has('action');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  // Origines tierces : jamais interceptées.
  if (url.origin !== self.location.origin) return;
  // API perso (même origine que l'appli) : toujours le réseau.
  if (isApiRequest(url)) return;
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches
            .open(CACHE)
            .then((c) => c.put('./index.html', copy))
            .catch(() => {});
          return res;
        })
        .catch(() => caches.match('./index.html')),
    );
    return;
  }
  // Assets statiques : cache d'abord, MAJ réseau en arrière-plan.
  event.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (res && (res.status === 200 || res.status === 0)) {
            const copy = res.clone();
            caches
              .open(CACHE)
              .then((c) => c.put(req, copy))
              .catch(() => {});
          }
          return res;
        })
        .catch(() => hit);
      return hit || net;
    }),
  );
});
