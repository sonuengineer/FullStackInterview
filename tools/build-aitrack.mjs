// Scans the three AI reading apps and writes one manifest of their titles into
// index.html, so the dashboard's "AI Engineering" tab can list every part, day
// and chapter in the sidebar (and therefore in the sidebar search).
//
// Only TITLES go into index.html - never the content. Each app is a finished,
// self-contained page shown in a frame and deep-linked by #hash:
//
//   ai-guide/index.html   6 parts     #kinds .. #words        (hand-authored, listed below)
//   ai-course/reader.html 23 days     #ch/<zero-based index>  (scanned from ai-course/day-*.md)
//   ai-ebook/index.html   38 chapters #chapter-N-slug         (scanned from the ebook itself)
//
// The two pages in ai/ ("Deep dives") are NOT here - they are inlined markdown
// already written by tools/build-ai.mjs.
//
//   node tools/build-aitrack.mjs
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const indexFile = join(root, 'index.html');

// ---- 1. ai-guide: hand-authored JS content, so the parts are listed here,
// the same way build-systemdesign.mjs hard-codes its category order.
const GUIDE_PARTS = [
  ['kinds', '1. Kinds of AI'],
  ['language', '2. Human language'],
  ['inside', '3. Inside the model'],
  ['apps', '4. AI in real apps'],
  ['trust', '5. Build AI you can trust'],
  ['words', '6. Words to know'],
];

function guideItems() {
  const f = join(root, 'ai-guide', 'index.html');
  if (!existsSync(f)) return [];
  const html = readFileSync(f, 'utf8');
  // Only publish a part whose anchor actually exists, so a renamed section is caught here.
  return GUIDE_PARTS.filter(([id]) => html.includes('id="' + id + '"'))
    .map(([id, title]) => ({ title, hash: '#' + id }));
}

// ---- 2. ai-course: same extraction contract as ai-course/build-reader.js
// (H1 title, **Module:**, **Time:**), so the sidebar matches the reader exactly.
function courseItems() {
  const dir = join(root, 'ai-course');
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => /^day-\d+.*\.md$/i.test(f))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return files.map((f, i) => {
    const md = readFileSync(join(dir, f), 'utf8');
    const title = (md.match(/^#\s+(.+)$/m) || [, f.replace(/\.md$/, '')])[1].trim();
    const module = (md.match(/\*\*Module:\*\*\s*(.+)/) || [, 'Epilogue'])[1].trim();
    const minutes = Math.round(md.split(/\s+/).length / 190);
    // reader.html routes on #ch/<zero-based index into DATA>, which is this sort order.
    return { title, module, minutes, hash: '#ch/' + i };
  });
}

// ---- 3. ai-ebook: scan the built page for its chapter anchors.
function ebookItems() {
  const f = join(root, 'ai-ebook', 'index.html');
  if (!existsSync(f)) return [];
  const html = readFileSync(f, 'utf8');
  const out = [];
  const re = /<h1 id="(chapter-(\d+)-[^"]*)"[^>]*>([\s\S]*?)<\/h1>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const text = m[3].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    out.push({ title: text || 'Chapter ' + m[2], hash: '#' + m[1], n: Number(m[2]) });
  }
  out.sort((a, b) => a.n - b.n);
  return out.map(({ title, hash }) => ({ title, hash }));
}

const groups = [
  { key: 'guide', label: 'Start here -- how AI thinks', src: 'ai-guide/index.html', items: guideItems() },
  { key: 'course', label: 'Build it -- 21-day course', src: 'ai-course/reader.html', items: courseItems() },
  { key: 'ebook', label: 'Ship it -- Hinglish ebook', src: 'ai-ebook/index.html', items: ebookItems() },
].filter((g) => g.items.length > 0);

if (!groups.length) throw new Error('No AI track content found - check ai-guide/, ai-course/ and ai-ebook/');

// Escape "<" so nothing in a title can close the surrounding <script> tag.
const lt = String.fromCharCode(92) + 'u003c';
const json = JSON.stringify({ groups }).replace(/</g, lt);
const START = '<!--AITRACK-MANIFEST-START-->';
const END = '<!--AITRACK-MANIFEST-END-->';
const block = START + '\n<script type="application/json" id="aitrack-manifest">' + json + '</script>\n' + END;

let html = readFileSync(indexFile, 'utf8');
const start = html.indexOf(START);
const end = html.indexOf(END);
if (start >= 0 && end > start) {
  html = html.slice(0, start) + block + html.slice(end + END.length);
} else {
  const marker = '<!-- ======================= END LESSON DATA';
  const at = html.indexOf(marker);
  if (at < 0) throw new Error('Could not find the END LESSON DATA marker in index.html');
  html = html.slice(0, at) + block + '\n' + html.slice(at);
}
writeFileSync(indexFile, html);

const total = groups.reduce((n, g) => n + g.items.length, 0);
console.log('AI track manifest written to index.html (' + total + ' items, ' + Math.round(json.length / 1024) + ' KB):');
for (const g of groups) {
  console.log('  [' + g.label + '] -> ' + g.src + ' (' + g.items.length + ')');
  for (const it of g.items.slice(0, 3)) console.log('      ' + it.title + '  ' + it.hash);
  if (g.items.length > 3) console.log('      ... and ' + (g.items.length - 3) + ' more');
}
