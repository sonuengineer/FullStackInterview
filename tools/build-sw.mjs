// Wires up offline support: writes the precache list and the cache version into
// sw.js, and injects the registration + update banner into index.html.
//
// Nothing here is precached blindly. index.html carries every lesson inline, so the
// shell is the one file worth paying for on install; the ~19 MB of parts, frames,
// images and PDFs is cached by sw.js as the user opens it. mermaid (~2.8 MB) is
// deliberately NOT precached - it goes in the warm list, which sw.js pulls into the
// runtime cache after the page is up (the page loads it anyway, so it costs nothing
// extra, and install stays small).
//
// Run it after any build-*.mjs that rewrites index.html, so the version matches the
// file that is actually deployed:
//
//   node tools/build-sw.mjs
//
// Re-running it is a no-op: index.html is injected first, then hashed, so the second
// run computes the same version and rewrites the same bytes.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const indexFile = join(root, 'index.html');
const swFile = join(root, 'sw.js');

// Pages whose <head> declares the site's cross-origin dependencies. Only the head is
// scanned: lesson markdown further down index.html is full of example URLs that must
// never end up in the worker's allowlist.
const HEAD_SOURCES = [
  'index.html',
  'ai-course/reader.html',
  'ai-ebook/index.html',
  'ai-guide/index.html',
  ...readdirSync(join(root, 'systemdesginchectsheet'))
    .filter((f) => /\.html$/i.test(f))
    .map((f) => 'systemdesginchectsheet/' + f),
];

// Anything matching this is too big to hold up an install, however useful it is.
const TOO_BIG_TO_PRECACHE = /mermaid/i;

function headOf(file) {
  const p = join(root, file);
  if (!existsSync(p)) return '';
  const html = readFileSync(p, 'utf8');
  const end = html.indexOf('</head>');
  return end > 0 ? html.slice(0, end) : html.slice(0, 20000);
}

// ---- 1. Scan the heads for cross-origin assets -------------------------------
const shellScripts = new Set();   // index.html's own <script src>: hard dependencies
const cdnHosts = new Set();

for (const file of HEAD_SOURCES) {
  const head = headOf(file);
  let m;
  const scriptRe = /<script[^>]+src="(https:\/\/[^"]+)"/g;
  while ((m = scriptRe.exec(head)) !== null) {
    // Only the dashboard's own scripts are shell. The framed reading apps bring
    // their own libraries (highlight.js and its themes) - those are runtime-cached
    // when the user opens a frame, not pushed onto everyone's first visit.
    if (file === 'index.html') shellScripts.add(m[1]);
    cdnHosts.add(new URL(m[1]).hostname);
  }
  // Stylesheets, fonts and preconnects: cached at runtime, so only the host matters.
  const linkRe = /<link[^>]+href="(https:\/\/[^"]+)"/g;
  while ((m = linkRe.exec(head)) !== null) cdnHosts.add(new URL(m[1]).hostname);
}

if (!shellScripts.size) throw new Error('No cross-origin <script src> found in the head of index.html');

const precacheCdn = [...shellScripts].filter((u) => !TOO_BIG_TO_PRECACHE.test(u)).sort();
const warmCdn = [...shellScripts].filter((u) => TOO_BIG_TO_PRECACHE.test(u)).sort();
const hosts = [...cdnHosts].sort();

// ---- 2. The same-origin shell ------------------------------------------------
// "./" is the dashboard. "/index.html" is the same 1.1 MB response under a second
// URL, so it is NOT listed - sw.js maps both to this one entry.
const precacheLocal = ['./'];
for (const f of ['manifest.webmanifest']) if (existsSync(join(root, f))) precacheLocal.push(f);
if (existsSync(join(root, 'icons'))) {
  for (const f of readdirSync(join(root, 'icons')).filter((f) => /\.(svg|png)$/i.test(f)).sort()) {
    precacheLocal.push('icons/' + f);
  }
}

// ---- 3. The blocks injected into index.html ----------------------------------
// Kept here, not hand-edited in index.html, so this script owns them and a re-run
// can rewrite them in place.
const HEAD_BLOCK = `<meta name="theme-color" content="#f5f0e6">
<style>
  /* Offline / update toast - same card + accent language as the toolbar buttons */
  #sw-toast {
    position: fixed;
    bottom: 16px;
    right: 16px;
    z-index: 100;
    display: none;
    align-items: center;
    gap: 10px;
    max-width: 330px;
    background: var(--card-bg);
    color: var(--fg);
    border: 1px solid var(--accent);
    border-radius: 10px;
    padding: 10px 12px;
    box-shadow: 0 2px 14px rgba(0,0,0,0.2);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
    font-size: 0.8rem;
    line-height: 1.45;
  }
  #sw-toast.show { display: flex; }
  #sw-toast button {
    flex: 0 0 auto;
    background: var(--code-bg);
    border: 1px solid var(--border);
    color: var(--fg);
    border-radius: 6px;
    padding: 6px 10px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.78rem;
  }
  #sw-toast button:hover { background: var(--accent); color: #fff; }
  @media (max-width: 768px) { #sw-toast { left: 12px; right: 12px; bottom: 12px; max-width: none; } }
  /* mermaid not available (offline before it was cached): the diagram source is
     shown as a code block instead of an unstyled blob of text. */
  #reader .mermaid.mermaid-raw, #sd-body .mermaid.mermaid-raw {
    white-space: pre;
    overflow-x: auto;
    background: var(--code-bg);
    color: var(--muted);
    border: 1px dashed var(--border);
    font-family: "SFMono-Regular", Consolas, monospace;
    font-size: 0.78rem;
  }
</style>
<script>
// Stubs for the two CDN libraries above. This runs after their <script> tags, so it
// sees whether they actually loaded. Without it, a first visit with no network dies
// on "mermaid is not defined" at the top of the main script and renders nothing at
// all - with it, lessons still render and diagrams degrade to their source text.
(function () {
  // The web app manifest is linked from here, not from the markup: a static
  // <link rel="manifest"> makes Chrome fetch it on file:// too, where it is
  // blocked as a cross-origin request and logs an error on every local read.
  var h = location.hostname;
  if (location.protocol === 'https:' || h === 'localhost' || h === '127.0.0.1' || h === '[::1]') {
    try {
      var link = document.createElement('link');
      link.rel = 'manifest';
      link.href = 'manifest.webmanifest';
      document.head.appendChild(link);
    } catch (e) {}
  }
  if (typeof window.marked === 'undefined') {
    var esc = function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); };
    window.marked = {
      Renderer: function () {},
      parse: function (md) { return '<pre>' + esc(md) + '</pre>'; }
    };
  }
  if (typeof window.mermaid === 'undefined') {
    window.mermaid = {
      initialize: function () {},
      run: function (opts) {
        try {
          var sel = (opts && opts.querySelector) || '.mermaid';
          Array.prototype.forEach.call(document.querySelectorAll(sel), function (el) {
            el.classList.add('mermaid-raw');
          });
        } catch (e) {}
        return Promise.resolve();
      }
    };
  }
})();
</scr` + `ipt>`;

const TOAST_BLOCK = `<div id="sw-toast" role="status" aria-live="polite">
  <span id="sw-toast-msg"></span>
  <button type="button" id="sw-toast-act"></button>
</div>`;

const REGISTER_BLOCK = `<script>
// Service worker registration. Every branch is guarded: if this fails, is
// unsupported, or the file was opened straight from disk, the dashboard behaves
// exactly as it did before offline support existed.
(function () {
  try {
    var host = location.hostname;
    // Service workers need a secure context and do not exist on file:// at all -
    // and the owner opens this file locally, so bail out quietly instead of
    // logging a SecurityError on every local read.
    var allowed = location.protocol === 'https:' ||
      host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
    if (!allowed || !('serviceWorker' in navigator)) return;

    var toast = document.getElementById('sw-toast');
    var msgEl = document.getElementById('sw-toast-msg');
    var actEl = document.getElementById('sw-toast-act');
    var onAct = null;
    function show(text, label, fn) {
      if (!toast) return;
      msgEl.textContent = text;
      actEl.textContent = label;
      onAct = fn;
      toast.classList.add('show');
    }
    function hide() { if (toast) toast.classList.remove('show'); }
    if (actEl) actEl.addEventListener('click', function () {
      var fn = onAct;
      hide();
      if (fn) fn();
    });

    // Reload only after the user asks for the update, and only once: a blind
    // controllerchange reload would also fire on the very first activation.
    var wantReload = false, reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!wantReload || reloaded) return;
      reloaded = true;
      location.reload();
    });

    function offerUpdate(worker) {
      show('New version available.', 'Reload', function () {
        wantReload = true;
        try { worker.postMessage({ type: 'SKIP_WAITING' }); } catch (e) {}
        // If the new worker never takes over, reload anyway rather than leaving
        // the user looking at a dismissed banner and an old build.
        setTimeout(function () {
          if (!reloaded) { reloaded = true; location.reload(); }
        }, 2500);
      });
    }

    function noteOnce() {
      var KEY = 'dashboard.offlineNoteSeen';
      try {
        if (localStorage.getItem(KEY)) return;
        localStorage.setItem(KEY, '1');
      } catch (e) { return; }
      show('Saved for offline reading. Every page you open while online stays readable without a connection.', 'Got it', null);
      setTimeout(hide, 12000);
    }

    // mermaid is too big to precache, so ask the worker to pull it into the
    // runtime cache once the page is up - that makes the site fully offline-ready
    // after one online visit instead of two.
    function warm() {
      var c = navigator.serviceWorker.controller;
      if (c && navigator.onLine) { try { c.postMessage({ type: 'WARM' }); } catch (e) {} }
    }

    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(function (reg) {
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
      reg.addEventListener('updatefound', function () {
        var sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', function () {
          if (sw.state !== 'installed') return;
          // A controller already exists => this is an update to an older build.
          if (navigator.serviceWorker.controller) offerUpdate(sw);
          else noteOnce();
        });
      });
      setTimeout(warm, 1500);
    }).catch(function () { /* offline support is optional - never break the page */ });

    navigator.serviceWorker.addEventListener('controllerchange', warm);
  } catch (e) { /* ignore */ }
})();
</scr` + `ipt>`;

// ---- 4. Inject into index.html (before hashing, so a re-run is a no-op) ------
let html = readFileSync(indexFile, 'utf8');

// Same marker-replace-or-insert-at-anchor pattern as build-systemdesign.mjs.
function inject(name, block, anchor, before) {
  const START = '<!--' + name + '-START-->';
  const END = '<!--' + name + '-END-->';
  const wrapped = START + '\n' + block + '\n' + END;
  const start = html.indexOf(START);
  const end = html.indexOf(END);
  if (start >= 0 && end > start) {
    html = html.slice(0, start) + wrapped + html.slice(end + END.length);
    return 'updated';
  }
  const at = html.indexOf(anchor);
  if (at < 0) throw new Error('Could not find the anchor ' + JSON.stringify(anchor) + ' in index.html');
  const cut = before ? at : at + anchor.length;
  html = html.slice(0, cut) + (before ? wrapped + '\n' : '\n' + wrapped) + html.slice(cut);
  return 'inserted';
}

const injected = {
  // In the head, after the two CDN <script> tags so the stubs can see them fail.
  SW_HEAD: inject('SW-HEAD', HEAD_BLOCK, '</head>', true),
  SW_TOAST: inject('SW-TOAST', TOAST_BLOCK, '<body data-theme="sepia">', false),
  SW_REGISTER: inject('SW-REGISTER', REGISTER_BLOCK, '</body>', true),
};
writeFileSync(indexFile, html);

// ---- 5. Version + sw.js ------------------------------------------------------
// Hash of the deployed index.html plus the precache list, so the shell cache is
// only invalidated when something real changed.
const lists = { precacheLocal, precacheCdn, warmCdn, hosts };
const version = createHash('sha256')
  .update(html)
  .update(JSON.stringify(lists))
  .digest('hex')
  .slice(0, 10);

const arr = (name, items, indent = '  ') =>
  items.length
    ? 'const ' + name + ' = [\n' + items.map((u) => indent + "'" + u + "',").join('\n') + '\n];'
    : 'const ' + name + ' = [];';

const generated = [
  "const SHELL_VERSION = '" + version + "';",
  '// Same-origin files cached on install. "./" is the dashboard itself: "/" and',
  '// "/index.html" are the same 1.1 MB page, so only one copy is stored.',
  arr('PRECACHE_LOCAL', precacheLocal),
  '// Cross-origin files cached on install (small, URL-versioned, and the page is',
  '// unusable without them).',
  arr('PRECACHE_CROSS_ORIGIN', precacheCdn),
  '// Too big to precache, fetched into the runtime cache once the page is up.',
  arr('WARM_CROSS_ORIGIN', warmCdn),
  '// Cross-origin hosts this worker is allowed to cache at all.',
  arr('CACHEABLE_HOSTS', hosts),
].join('\n');

const SW_START = '/* SW-BUILD-START */';
const SW_END = '/* SW-BUILD-END */';
let sw = readFileSync(swFile, 'utf8');
const swStart = sw.indexOf(SW_START);
const swEnd = sw.indexOf(SW_END);
if (swStart < 0 || swEnd <= swStart) {
  throw new Error('sw.js is missing its ' + SW_START + ' / ' + SW_END + ' markers');
}
sw = sw.slice(0, swStart) + SW_START + '\n' + generated + '\n' + sw.slice(swEnd);
writeFileSync(swFile, sw);

// ---- 6. Report ---------------------------------------------------------------
console.log('Service worker built: sw.js @ ' + version + ' (runtime cache version is hand-bumped in sw.js)');
console.log('  precache (install):');
for (const u of precacheLocal) console.log('    ' + u);
for (const u of precacheCdn) console.log('    ' + u);
console.log('  warmed after load (too big for install):');
for (const u of warmCdn) console.log('    ' + u);
console.log('  cacheable cross-origin hosts: ' + hosts.join(', '));
console.log('  everything else (systemdesign/*.md, ai-*/ frames, Images/, PDFs, prep/) is cached on first open');
console.log('  index.html blocks: ' + Object.entries(injected).map(([k, v]) => k + ' ' + v).join(', '));
