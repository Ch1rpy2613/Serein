/* Atmos / Serein service worker — hand-written, no Workbox.
 * Bump CACHE_VERSION on any strategy change so activate cleans old caches.
 */
const CACHE_VERSION = 'serein-sw-v1';
const CACHE_NAME = CACHE_VERSION;

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

/**
 * @param {Request} request
 * @returns {boolean}
 */
function isApiRequest(request) {
  try {
    const url = new URL(request.url);
    return url.origin === self.location.origin && url.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

/**
 * @param {Request} request
 * @returns {boolean}
 */
function isNavigationRequest(request) {
  if (request.mode === 'navigate') return true;
  const accept = request.headers.get('accept') || '';
  return request.destination === 'document' || accept.includes('text/html');
}

/**
 * Network-first for HTML shell — avoids stale app shell with fresh data.
 * @param {Request} request
 */
async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) {
      void cache.put(request, fresh.clone());
    }
    return fresh;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw new Error('network-first: offline and no cache');
  }
}

/**
 * Stale-while-revalidate for hashed static assets.
 * @param {Request} request
 */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((response) => {
      if (response && response.ok) {
        void cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => undefined);

  if (cached) {
    void networkPromise;
    return cached;
  }

  const fresh = await networkPromise;
  if (fresh) return fresh;
  throw new Error('stale-while-revalidate: offline and no cache');
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (isApiRequest(request)) return; // data layer uses localStorage; never cache /api

  if (isNavigationRequest(request)) {
    event.respondWith(networkFirst(request));
    return;
  }

  try {
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
  } catch {
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});

/**
 * @param {unknown} raw
 * @returns {{ title: string, body: string, icon: string, url: string }}
 */
function parsePushPayload(raw) {
  const fallback = {
    title: 'Atmos',
    body: '',
    icon: '/atmos-icon-192.png',
    url: '/?alert=1',
  };
  if (!raw || typeof raw !== 'object') return fallback;
  const data = /** @type {Record<string, unknown>} */ (raw);
  return {
    title: typeof data.title === 'string' && data.title ? data.title : fallback.title,
    body: typeof data.body === 'string' ? data.body : fallback.body,
    icon: typeof data.icon === 'string' && data.icon ? data.icon : fallback.icon,
    url: typeof data.url === 'string' && data.url ? data.url : fallback.url,
  };
}

self.addEventListener('push', (event) => {
  let payload = parsePushPayload(null);
  try {
    if (event.data) {
      payload = parsePushPayload(event.data.json());
    }
  } catch {
    try {
      const text = event.data?.text();
      if (text) {
        try {
          payload = parsePushPayload(JSON.parse(text));
        } catch {
          payload = { ...payload, body: text };
        }
      }
    } catch {
      // keep fallback
    }
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: payload.icon,
      badge: '/atmos-icon-192.png',
      data: { url: payload.url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/?alert=1';
  const absoluteUrl = new URL(targetUrl, self.location.origin).href;

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      for (const client of allClients) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          await client.focus();
          try {
            client.postMessage({ type: 'serein:open-alert', url: absoluteUrl });
          } catch {
            // ignore
          }
          if ('navigate' in client && typeof client.navigate === 'function') {
            try {
              await client.navigate(absoluteUrl);
            } catch {
              // navigate may fail on some browsers; postMessage is enough
            }
          }
          return;
        }
      }

      await self.clients.openWindow(absoluteUrl);
    })(),
  );
});
