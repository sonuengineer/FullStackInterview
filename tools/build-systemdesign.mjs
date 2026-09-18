// Scans systemdesign/<system>/part-*.md and writes the list of systems + parts into
// index.html, so the dashboard's "System Design" tab shows every system in a dropdown.
// Part text is NOT copied into index.html - the page loads each part's .md file when
// you open it, so index.html stays small and new parts only need this script re-run.
//
//   node tools/build-systemdesign.mjs
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sdDir = join(root, 'systemdesign');
const indexFile = join(root, 'index.html');

// Same order as systemdesign/README.md; anything else is appended alphabetically.
const ORDER = ['url-shortener', 'rate-limiter', 'payment-system', 'file-storage', 'news-feed', 'chat-system', 'search-system', 'notification-paging'];

const partNum = (f) => parseInt(f.slice(5), 10);
const pretty = (slug) => slug.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

const systems = readdirSync(sdDir)
  .filter((d) => statSync(join(sdDir, d)).isDirectory())
  .map((slug) => {
    const files = readdirSync(join(sdDir, slug))
      .filter((f) => /^part-\d+.*\.md$/.test(f))
      .sort((a, b) => partNum(a) - partNum(b));
    if (!files.length) return null;
    const parts = files.map((file) => {
      const md = readFileSync(join(sdDir, slug, file), 'utf8');
      const h1 = (md.match(/^#\s+(.+)$/m) || [])[1] || file;
      const label = (h1.match(/\(Part \d+:\s*([^)]+)\)/) || [])[1] || h1;
      return { n: partNum(file), file, label: label.trim() };
    });
    const firstH1 = (readFileSync(join(sdDir, slug, files[0]), 'utf8').match(/^#\s+(.+)$/m) || [])[1] || '';
    const title = firstH1.split(' -- ')[0].trim() || pretty(slug);
    return { slug, title, parts };
  })
  .filter(Boolean)
  .sort((a, b) => {
    const ia = ORDER.indexOf(a.slug), ib = ORDER.indexOf(b.slug);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.slug.localeCompare(b.slug);
  });

// Escape "<" so nothing in a title can close the surrounding <script> tag.
const lt = String.fromCharCode(92) + 'u003c';
const json = JSON.stringify({ systems }).replace(/</g, lt);
const block = '<!--SD-MANIFEST-START-->\n<script type="application/json" id="sd-manifest">' + json + '</script>\n<!--SD-MANIFEST-END-->';

let html = readFileSync(indexFile, 'utf8');
const start = html.indexOf('<!--SD-MANIFEST-START-->');
const end = html.indexOf('<!--SD-MANIFEST-END-->');
if (start >= 0 && end > start) {
  html = html.slice(0, start) + block + html.slice(end + '<!--SD-MANIFEST-END-->'.length);
} else {
  const marker = '<!-- ======================= END LESSON DATA';
  const at = html.indexOf(marker);
  if (at < 0) throw new Error('Could not find the END LESSON DATA marker in index.html');
  html = html.slice(0, at) + block + '\n' + html.slice(at);
}
writeFileSync(indexFile, html);

console.log('System Design list written to index.html:');
systems.forEach((s) => console.log('  ' + s.title + ' - ' + s.parts.length + ' part(s): ' + s.parts.map((p) => p.n).join(', ')));
