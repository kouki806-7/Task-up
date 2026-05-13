const CACHE_VERSION = 'v4';
const STATIC_CACHE = `daily-flow-static-${CACHE_VERSION}`;
const CDN_CACHE = `daily-flow-cdn-${CACHE_VERSION}`;

const STATIC_ASSETS = [
    './',
    './index.html',
    './app.js?v=51',
    './style.css',
    './icon.jpg',
];

// CDN hostnames whose responses we cache (stale-while-revalidate)
const CDN_HOSTS = [
    'www.gstatic.com',      // Firebase SDK
    'fonts.googleapis.com', // Google Fonts CSS
    'fonts.gstatic.com',    // Google Fonts files
    'apis.google.com',      // Google API loader
    'accounts.google.com',  // Google Identity Services
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(STATIC_CACHE)
            .then(cache => cache.addAll(STATIC_ASSETS))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys
                    .filter(k => k !== STATIC_CACHE && k !== CDN_CACHE)
                    .map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const { request } = event;
    const url = new URL(request.url);

    // Skip non-GET and browser extensions
    if (request.method !== 'GET' || url.protocol === 'chrome-extension:') return;

    // Local app files: cache-first, update cache in background
    if (url.origin === self.location.origin) {
        event.respondWith(
            caches.open(STATIC_CACHE).then(cache =>
                cache.match(request).then(cached => {
                    const networkFetch = fetch(request).then(response => {
                        if (response.ok) cache.put(request, response.clone());
                        return response;
                    }).catch(() => null);
                    return cached || networkFetch;
                })
            )
        );
        return;
    }

    // Firebase SDK & CDN resources: stale-while-revalidate
    if (CDN_HOSTS.some(h => url.hostname.endsWith(h))) {
        event.respondWith(
            caches.open(CDN_CACHE).then(cache =>
                cache.match(request).then(cached => {
                    const networkFetch = fetch(request).then(response => {
                        // status 0 = opaque (no-cors); treat as cacheable
                        if (response.status === 0 || response.ok) {
                            cache.put(request, response.clone());
                        }
                        return response;
                    }).catch(() => null);

                    // Serve cached copy immediately; refresh in background
                    return cached || networkFetch;
                })
            )
        );
        return;
    }

    // External API calls (weather, Google Calendar, Gmail, Gemini, Firestore REST):
    // Let the browser handle them; errors are already caught in app.js
});
