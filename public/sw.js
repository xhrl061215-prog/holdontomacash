/**
 * Minimal service worker: an app-shell cache so the UI opens offline.
 *
 * Deliberately conservative about data. API responses are NEVER cached — a
 * budget tool showing stale totals as if current is the failure mode this whole
 * project has been guarding against. Offline shows the shell and the app's own
 * network error, not yesterday's numbers.
 */
const SHELL_CACHE = 'budgettracker-shell-v1'
const SHELL_ASSETS = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  // Never cache API or auth traffic.
  if (url.pathname.startsWith('/api-proxy') || url.pathname.startsWith('/auth')) return
  if (url.origin !== self.location.origin) return

  // Navigations: network first, shell as offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html').then((r) => r || Response.error())),
    )
    return
  }

  // Static assets: cache first, then network.
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request).then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone()
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy))
          }
          return response
        }),
    ),
  )
})
