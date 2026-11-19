/* zaalis Glyphes service worker: app shell offline, push notifications. */
const SHELL = 'glyphes-shell-v4';
const FILES = ['/', '/app.css', '/app.js', '/glyph.js', '/glass.js','/manifest.webmanifest', '/icons/glyph-180.png', '/icons/glyph-192.png', '/icons/glyph-512.png'];

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(SHELL).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
    event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Network first for the shell (always fresh when online), cache when offline.
// API calls, sign-in and the live stream are never cached.
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/') || url.pathname === '/link') return;
    event.respondWith(fetch(event.request).then(response => {
        if (response.ok && FILES.includes(url.pathname)) { const copy = response.clone(); caches.open(SHELL).then(c => c.put(event.request, copy)); }
        return response;
    }).catch(() => caches.match(event.request).then(hit => hit || caches.match('/'))));
});
self.addEventListener('push', (event) => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'Glyphes', body: event.data && event.data.text() }; }
    event.waitUntil(self.registration.showNotification(data.title || 'Glyphes', {
        body: data.body || '', tag: data.tag || undefined, renotify: !!data.tag,
        icon: '/icons/glyph-192.png', badge: '/icons/badge-96.png', data: { glyphId: data.glyphId || null },
    }));
});
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const glyphId = event.notification.data && event.notification.data.glyphId;
    const target = glyphId ? `/?g=${encodeURIComponent(glyphId)}` : '/';
    event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
        const open = list.find(c => new URL(c.url).origin === location.origin);
        if (open) { open.postMessage({ glyphId }); return open.focus(); }
        return self.clients.openWindow(target);
    }));
});
