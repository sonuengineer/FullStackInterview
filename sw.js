// Offline support for the Learning Dashboard. Hand-written on purpose: the repo has
// no package.json and the build scripts in tools/ are plain Node ESM, so there is no
// Workbox and no npm here.
//
// WHY this shape: index.html already carries all 147 lessons inline, so caching that
// one 1.1 MB file is what actually makes the site readable on a phone with no network.
// Everything else the site can load -- 67 system design parts (3.8 MB), the three
// iframed reading apps (1.5 MB), 5 MB of diagrams, 1.8 MB of cheat-sheet PDFs, the
// 2.7 MB encrypted prep page -- adds up to roughly 19 MB. Precaching that on a first
// visit would be hostile, so it is cached as the user opens it instead: whatever you
// have read once stays readable offline.
//
// The constants in the generated block below are written by tools/build-sw.mjs.
// Do not edit them by hand -- run `node tools/build-sw.mjs`.

/* SW-BUILD-START */
const SHELL_VERSION = 'b63c7ed85a';
// Same-origin files cached on install. "./" is the dashboard itself: "/" and
// "/index.html" are the same 1.1 MB page, so only one copy is stored.
const PRECACHE_LOCAL = [
  './',
  'manifest.webmanifest',
  'icons/icon.svg',
];
// Cross-origin files cached on install (small, URL-versioned, and the page is
// unusable without them).
const PRECACHE_CROSS_ORIGIN = [
  'https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js',
];
// Too big to precache, fetched into the runtime cache once the page is up.
const WARM_CROSS_ORIGIN = [
  'https://cdnjs.cloudflare.com/ajax/libs/mermaid/10.9.1/mermaid.min.js',
];
// Cross-origin hosts this worker is allowed to cache at all.
const CACHEABLE_HOSTS = [
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];
/* SW-BUILD-END */

// Bumped BY HAND, and only when the cache layout or a strategy changes. It is
// deliberately not derived from the content hash: the runtime cache is the user's
// offline library (it can hold many MB of parts, PDFs and images they chose to
// open), and wiping that on every content deploy would be the wrong trade.
const RUNTIME_VERSION = '1';

const SHELL_CACHE = 'dash-shell-' + SHELL_VERSION;
const RUNTIME_CACHE = 'dash-runtime-' + RUNTIME_VERSION;
const CURRENT_CACHES = [SHELL_CACHE, RUNTIME_CACHE];

// Absolute URLs, resolved once against the scope so comparisons are cheap.
const SCOPE = self.registration.scope;
const SHELL_URL = new URL('./', SCOPE).href;
const SHELL_SET = new Set(
  PRECACHE_LOCAL.concat(PRECACHE_CROSS_ORIGIN).map((u) => new URL(u, SCOPE).href)
);

// Shown for a navigation to something that was never opened while online. Inline
// rather than a file, so there is one less thing that has to be in the cache for
// the offline path to work at all. Colours are the site's sepia theme.
//
// The "back to the dashboard" link must be absolute: this page is served in place
// of a URL like /prep/index.html, so a relative "./" would point at /prep/.
const HOME_PATH = new URL('./', SCOPE).pathname;
const OFFLINE_HTML = [
  '<!DOCTYPE html>',
  '<html lang="en"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<title>Offline</title><style>',
  'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;',
  'background:#f5f0e6;color:#2b2620;font-family:Georgia,"Times New Roman",serif;padding:24px}',
  '.box{max-width:30em;background:#fff;border:1px solid #ddd3c0;border-radius:12px;padding:24px 26px}',
  'h1{font-size:1.3rem;margin:0 0 .6em}p{line-height:1.6;margin:.6em 0}',
  'a,button{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;font-size:.9rem}',
  'a{display:inline-block;margin-top:14px;background:#a8631e;color:#fff;border-radius:8px;',
  'padding:9px 14px;text-decoration:none}.m{color:#6b6255;font-size:.85rem}',
  '</style></head><body><div class="box">',
  '<h1>You are offline</h1>',
  '<p>This page was never opened while you had a connection, so there is no saved copy of it.</p>',
  '<p class="m">The dashboard and all of its lessons are saved. Anything else -- system design',
  ' parts, the AI reading apps, diagrams, PDFs -- is saved the first time you open it online.</p>',
  '<a href="' + HOME_PATH + '">Open the dashboard</a>',
  '</div></body></html>',
].join('');

// Only a navigation gets the HTML page. A failed .md or .json fetch gets a bare
// 503 instead, so the page's own error handling sees an error and not a chunk of
// HTML it would try to render.
function offlineResponse(request) {
  const isPage = request && request.mode === 'navigate';
  return new Response(isPage ? OFFLINE_HTML : 'Offline and not cached', {
    status: 503,
    statusText: 'Offline',
    headers: {
      'Content-Type': isPage ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

// "/" and "/index.html" are one page served under two URLs. Everything funnels to
// the "./" entry so the 1.1 MB file is never stored twice.
function isShellUrl(url) {
  return url.href === SHELL_URL || url.href === SHELL_URL + 'index.html';
}

function cacheNameFor(url) {
  return SHELL_SET.has(url.href) ? SHELL_CACHE : RUNTIME_CACHE;
}

// An opaque response (a no-cors cross-origin fetch) has status 0 and an unreadable
// body, so response.ok is ALWAYS false for it -- it cannot be validated, only
// accepted. A 206 cannot be stored at all: cache.put() rejects partial responses.
function isStorable(res) {
  if (!res) return false;
  if (res.type === 'opaque') return true;
  return res.ok && res.status !== 206;
}

// Cross-origin libraries are requested by the browser in no-cors mode (a plain
// <script src> has no crossorigin attribute), which would give us an opaque
// response we cannot tell apart from a CDN error page. cdnjs and Google Fonts both
// send Access-Control-Allow-Origin: *, so ask for cors first and get a checkable
// status; fall back to the original no-cors request only if that fails, so a CDN
// without CORS still works in a best-effort way.
async function fetchCrossOrigin(request) {
  const url = typeof request === 'string' ? request : request.url;
  try {
    const res = await fetch(new Request(url, { mode: 'cors', credentials: 'omit' }));
    if (res.ok) return res;
  } catch (e) {
    /* fall through to no-cors */
  }
  return fetch(typeof request === 'string' ? new Request(url, { mode: 'no-cors' }) : request);
}

function fetchFor(request) {
  const sameOrigin = new URL(request.url).origin === self.location.origin;
  return sameOrigin ? fetch(request) : fetchCrossOrigin(request);
}

// ---- Strategies --------------------------------------------------------------

// Immutable-ish bytes (images, PDFs, fonts, URL-versioned CDN libraries): never
// pay for a revalidation, the URL changes when the content does.
async function cacheFirst(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  let res;
  try {
    res = await fetchFor(request);
  } catch (e) {
    return offlineResponse(request);
  }
  if (isStorable(res)) {
    const name = cacheNameFor(new URL(request.url));
    caches.open(name).then((c) => c.put(request, res.clone())).catch(() => {});
  }
  return res;
}

// Content that can be rebuilt (system design .md, the iframed apps and their
// css/js): answer instantly from the cache, then refresh it in the background.
// Vercel sends an ETag, so the background request is normally a cheap 304.
async function staleWhileRevalidate(request, event) {
  const hit = await caches.match(request);
  const update = fetchFor(request).then((res) => {
    if (isStorable(res)) {
      const name = cacheNameFor(new URL(request.url));
      return caches.open(name).then((c) => c.put(request, res.clone())).then(() => res);
    }
    return res;
  });
  if (hit) {
    // Keep the worker alive until the refresh lands, but never let it fail the
    // response the page already has.
    event.waitUntil(update.catch(() => {}));
    return hit;
  }
  try {
    return await update;
  } catch (e) {
    return offlineResponse(request);
  }
}

// THE important one. index.html must never be cache-first: it is the whole app,
// it is rebuilt by tools/build-*.mjs constantly, and a cache-first HTML shell is
// how a static site becomes permanently un-updatable. Network wins when it
// answers; the cache is only a fallback.
async function networkFirst(request, event) {
  const url = new URL(request.url);
  const shell = isShellUrl(url);
  const key = shell ? SHELL_URL : request;
  try {
    const res = await fetch(request);
    if (isStorable(res)) {
      const name = shell ? SHELL_CACHE : RUNTIME_CACHE;
      event.waitUntil(
        caches.open(name).then((c) => c.put(key, res.clone())).catch(() => {})
      );
    }
    return res;
  } catch (e) {
    const hit = await caches.match(key);
    if (hit) return hit;
    return offlineResponse(request);
  }
}

// ---- Lifecycle ---------------------------------------------------------------

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Deliberately NOT cache.addAll(): it is all-or-nothing, so one 404 or one CDN
    // hiccup would throw and leave the user with no offline copy at all. Each entry
    // is cached on its own and a failure is swallowed -- the install must never
    // reject over an asset that is merely nice to have.
    for (const url of PRECACHE_LOCAL) {
      try {
        // no-cache, not reload: this revalidates instead of re-downloading 1.1 MB
        // that the page just fetched a moment ago.
        const res = await fetch(new Request(url, { cache: 'no-cache' }));
        if (isStorable(res)) await cache.put(url, res);
      } catch (e) {
        /* ignore */
      }
    }
    for (const url of PRECACHE_CROSS_ORIGIN) {
      try {
        const res = await fetchCrossOrigin(url);
        if (isStorable(res)) await cache.put(url, res);
      } catch (e) {
        /* ignore */
      }
    }
  })());
  // No skipWaiting() here. An update takes effect only when the user asks for it
  // through the in-page banner, so a reader is never swapped onto a new build
  // mid-page.
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        // Only our own caches: other things may share this origin (preview
        // deployments, other pages), and deleting their storage is not our call.
        .filter((n) => n.startsWith('dash-') && CURRENT_CACHES.indexOf(n) === -1)
        .map((n) => caches.delete(n))
    );
    // Control the page that registered us right away, so .md files, images and
    // frames opened during this very first visit are already being saved.
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (data.type === 'WARM') {
    // mermaid is ~2.8 MB -- far too big to put in front of a first visit. But the
    // page loads it on every online visit anyway, and the browser's HTTP cache
    // already holds it (cdnjs serves it immutable), so copying it into the runtime
    // cache after the page is up usually costs no network at all. Net effect: the
    // site is fully offline-ready after ONE online visit instead of two.
    event.waitUntil((async () => {
      const cache = await caches.open(RUNTIME_CACHE);
      for (const url of WARM_CROSS_ORIGIN) {
        try {
          if (await cache.match(url)) continue;
          const res = await fetchCrossOrigin(url);
          if (isStorable(res)) await cache.put(url, res);
        } catch (e) {
          /* ignore */
        }
      }
    })());
  }
});

// ---- Routing -----------------------------------------------------------------

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return;
  }
  // chrome-extension:, data:, blob: and friends cannot be cached.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Byte-range requests: Chrome's built-in PDF viewer asks for ranges, and
  // cache.put() rejects the 206 that comes back. Go to the network, and if that
  // fails fall back to the whole file if we happen to have it.
  if (request.headers.has('range')) {
    event.respondWith(
      fetch(request).catch(() => caches.match(request).then((hit) => hit || offlineResponse(request)))
    );
    return;
  }

  if (url.origin !== self.location.origin) {
    // Only the libraries and fonts the site actually depends on. Anything else
    // cross-origin is left completely alone.
    if (CACHEABLE_HOSTS.indexOf(url.hostname) !== -1) event.respondWith(cacheFirst(request));
    return;
  }

  // A top-level page load. destination is 'iframe' for the framed reading apps and
  // PDFs, which are handled further down -- they are not the app shell.
  if (request.mode === 'navigate' && request.destination !== 'iframe') {
    event.respondWith(networkFirst(request, event));
    return;
  }
  // An explicit fetch of the shell (rare, but it must not become cache-first).
  if (isShellUrl(url)) {
    event.respondWith(networkFirst(request, event));
    return;
  }

  if (/\.(png|jpe?g|jfif|gif|webp|svg|ico|pdf|woff2?|ttf|otf|eot)$/i.test(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // .md parts, the framed apps' html/css/js, the manifest: refreshable content.
  event.respondWith(staleWhileRevalidate(request, event));
});
