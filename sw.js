self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));

self.addEventListener('push', event => {
  if (!event.data) return;

  let data;
  try { data = event.data.json(); }
  catch(e) { data = { title: 'StayOps', body: event.data.text() }; }

  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'stayops',
    requireInteraction: true,
    vibrate: [200, 100, 200],
    data: { url: data.url || '/' }
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'StayOps', options)
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Prefer an existing app window; navigate it to the notification's URL so
      // the user lands on the intended screen (previously we focused without
      // navigating, leaving the user wherever they last were).
      for (const c of list) {
        if (c.url && c.url.startsWith(self.location.origin)) {
          if ('navigate' in c) {
            return c.navigate(url).then(() => c.focus()).catch(() => c.focus());
          }
          return c.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
