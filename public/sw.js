// Service worker: (1) makes the app a real installable PWA (Android requires
// one registered with a fetch handler, not just a manifest), (2) gives a
// basic offline app-shell fallback, (3) shows push notifications — but only
// when the app isn't already open/focused, per the "only when closed" ask.

const CACHE = 'us-app-shell-v1';
const SHELL_URLS = ['/', '/index.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL_URLS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Network-first for navigations (always get the latest build when online),
// falling back to the cached shell when offline. Cache-first for hashed
// build assets, which never change content once built.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then((res) => {
        caches.open(CACHE).then((c) => c.put('/index.html', res.clone()));
        return res;
      }).catch(() => caches.match('/index.html'))
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request).then((res) => {
        caches.open(CACHE).then((c) => c.put(request, res.clone()));
        return res;
      }))
    );
  }
});

self.addEventListener('push', (event) => {
  let data = { title: 'us.', body: 'You have a new update.' };
  try { if (event.data) data = { ...data, ...event.data.json() }; } catch {}

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const appIsOpen = clients.some((c) => c.visibilityState === 'visible');
      if (appIsOpen) return; // only notify when the app/site is actually closed/backgrounded
      return self.registration.showNotification(data.title, {
        body: data.body,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: 'us-app-update',
        renotify: true,
      });
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      if (clients.length) return clients[0].focus();
      return self.clients.openWindow('/');
    })
  );
});
