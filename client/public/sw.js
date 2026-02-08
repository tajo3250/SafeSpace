// Service worker for SafeSpace PWA.
// - Caches the app shell and static assets for offline use
// - Network-first for API/socket, cache-first for static assets
// - Auto-updates when a new version is deployed

const CACHE_NAME = "safespace-v2";
const SHELL = ["/"];

// Static asset extensions to cache
const CACHEABLE_EXTENSIONS = /\.(js|css|woff2?|ttf|png|jpg|jpeg|svg|ico|webp)$/i;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Skip non-GET requests
  if (e.request.method !== "GET") return;

  // Skip socket.io, API calls, and chrome-extension requests
  if (
    url.pathname.startsWith("/socket.io") ||
    url.pathname.startsWith("/api/") ||
    url.protocol === "chrome-extension:"
  ) {
    return;
  }

  // For navigation requests (HTML pages): network-first with offline fallback
  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
          return response;
        })
        .catch(() => caches.match("/"))
    );
    return;
  }

  // For Vite hashed assets (contain hash in filename): cache-first (immutable)
  if (url.pathname.startsWith("/assets/") && CACHEABLE_EXTENSIONS.test(url.pathname)) {
    e.respondWith(
      caches.match(e.request).then(
        (cached) =>
          cached ||
          fetch(e.request).then((response) => {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
            return response;
          })
      )
    );
    return;
  }

  // For brand/static assets: stale-while-revalidate
  if (url.pathname.startsWith("/brand/") || CACHEABLE_EXTENSIONS.test(url.pathname)) {
    e.respondWith(
      caches.match(e.request).then((cached) => {
        const fetchPromise = fetch(e.request)
          .then((response) => {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
            return response;
          })
          .catch(() => cached);
        return cached || fetchPromise;
      })
    );
    return;
  }

  // Everything else: network-first
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
