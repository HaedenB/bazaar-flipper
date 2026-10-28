"use strict";

/* Cache the app shell for offline use and retain the last successful Bazaar response. */
const SHELL_CACHE = "bazaar-shell-v10";
const DATA_CACHE = "bazaar-data-v1";

const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "recipes.js",
  "manifest.json",
  "fonts/minecraft.woff2",
  "fonts/minecraft.woff",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== DATA_CACHE)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Live API: try the network first and fall back to cached data offline.
  if (url.hostname === "api.hypixel.net") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();

            caches.open(DATA_CACHE)
              .then((cache) => cache.put(event.request, copy));
          }

          return response;
        })
        .catch(() => caches.match(event.request))
    );

    return;
  }

  // App shell: use cached files first, then the network.
  if (url.origin === location.origin) {
    event.respondWith(
      caches.match(event.request)
        .then((cached) => cached || fetch(event.request))
    );
  }
});