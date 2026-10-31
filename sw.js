// NEXT service worker: caches the app shell so it opens offline.
// Pages: network first (fresh when online), cached copy when offline.
// Assets (hashed filenames): cache first, saved on first fetch.
const CACHE = 'next-v1'
const SHELL = ['./', './index.html', './manifest.webmanifest', './favicon.svg', './apple-touch-icon.png', './icon-192.png', './icon-512.png']

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      // Also cache the JS/CSS the current index.html references, so the first visit works offline.
      const html = await (await fetch('./index.html', { cache: 'no-store' })).text()
      const assets = [...html.matchAll(/(?:src|href)="(\.\/assets\/[^"]+)"/g)].map((m) => m[1])
      await cache.addAll([...new Set([...SHELL, ...assets])])
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return

  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req)
          const cache = await caches.open(CACHE)
          cache.put('./index.html', res.clone())
          return res
        } catch {
          return (await caches.match('./index.html')) || Response.error()
        }
      })(),
    )
    return
  }

  event.respondWith(
    (async () => {
      const hit = await caches.match(req)
      if (hit) return hit
      const res = await fetch(req)
      if (res.ok) (await caches.open(CACHE)).put(req, res.clone())
      return res
    })(),
  )
})
