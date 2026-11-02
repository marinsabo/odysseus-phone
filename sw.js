// The page itself, so it opens with no signal and queues what is typed. Same-origin only:
// nothing from GitHub is ever cached here, and a request carrying the token never comes near it.
const CACHE = "odysseus-phone-1";
const FILES = ["./", "index.html", "style.css", "app.js", "logic.js", "manifest.webmanifest", "icon.svg", "icon-180.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// The network first, so a new version arrives on the next open with signal; the cache otherwise.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        if (response.ok) caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((hit) => hit ?? caches.match("index.html"))),
  );
});
