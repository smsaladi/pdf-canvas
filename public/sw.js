// PDF Canvas Service Worker — enables PWA install + offline caching

const CACHE_NAME = "pdf-canvas-v1";

// Assets to cache on install for offline use
const PRECACHE_URLS = [
  "/",
  "/index.html",
  "/styles/main.css",
  "/fonts/Arimo-Regular.ttf",
  "/fonts/Arimo-Bold.ttf",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Only handle http/https requests — skip blob:, data:, chrome-extension:, etc.
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  if (url.pathname.startsWith("/fonts/") || url.hostname === "fonts.gstatic.com") {
    // Cache-first for font files (they don't change)
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
  } else {
    // Network-first for everything else
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
  }
});
