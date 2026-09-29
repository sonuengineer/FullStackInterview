// Scans systemdesginchectsheet/ and writes the list of cheat-sheet files (PDF/HTML)
// into index.html, so the dashboard's "Cheat Sheets" tab can show and open them.
// The files themselves are NOT copied into index.html - the tab loads each one in a
// frame when you open it, so index.html stays small.
//
//   node tools/build-cheatsheets.mjs
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dirName = 'systemdesginchectsheet';
const csDir = join(root, dirName);
const indexFile = join(root, 'index.html');

// Never publish these, even if they sit in the same folder (resume, raw prompts).
const SKIP = [/^Sonu_Prajapati/i, /prompt/i];

// Nicer titles than the raw file names.
function titleOf(file) {
  return file
    .replace(/\.(pdf|html)$/i, '')
    .replace(/_/g, ' ')
    .replace(/\bHinglish Notes\b/i, '(Hinglish)')
    .replace(/\bSystem Design\b/i, 'System Design')
    .replace(/\s+/g, ' ')
    .trim();
}

// Groups keep the tab readable: interview-day sheets first, then topics.
function groupOf(title) {
  if (/checklist|framework|master/i.test(title)) return 'Start here';
  if (/sql|mongo|indexing|partition|replica|scaling|redis/i.test(title)) return 'Databases & caching';
  if (/system design|url shortener|chat|payment|notification|search|file upload|s3/i.test(title)) return 'System design';
  return 'Platform & practice';
}

const GROUP_ORDER = ['Start here', 'System design', 'Databases & caching', 'Platform & practice'];

const items = readdirSync(csDir)
  .filter((f) => /\.(pdf|html)$/i.test(f))
  .filter((f) => !SKIP.some((re) => re.test(f)))
  .map((file) => {
    const title = titleOf(file);
    return {
      file: dirName + '/' + file,
      title,
      kind: /\.pdf$/i.test(file) ? 'pdf' : 'html',
      kb: Math.round(statSync(join(csDir, file)).size / 1024),
      group: groupOf(title),
    };
  })
  .sort((a, b) =>
    (GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group)) || a.title.localeCompare(b.title));

// Escape "<" so nothing in a title can close the surrounding <script> tag.
const lt = String.fromCharCode(92) + 'u003c';
const json = JSON.stringify({ items }).replace(/</g, lt);
const block = '<!--CS-MANIFEST-START-->\n<script type="application/json" id="cs-manifest">' + json + '</script>\n<!--CS-MANIFEST-END-->';

let html = readFileSync(indexFile, 'utf8');
const start = html.indexOf('<!--CS-MANIFEST-START-->');
const end = html.indexOf('<!--CS-MANIFEST-END-->');
if (start >= 0 && end > start) {
  html = html.slice(0, start) + block + html.slice(end + '<!--CS-MANIFEST-END-->'.length);
} else {
  const marker = '<!-- ======================= END LESSON DATA';
  const at = html.indexOf(marker);
  if (at < 0) throw new Error('Could not find the END LESSON DATA marker in index.html');
  html = html.slice(0, at) + block + '\n' + html.slice(at);
}
writeFileSync(indexFile, html);

console.log('Cheat sheet list written to index.html (' + items.length + ' files):');
let lastGroup = '';
items.forEach((it) => {
  if (it.group !== lastGroup) { console.log('  [' + it.group + ']'); lastGroup = it.group; }
  console.log('    ' + it.title + ' (' + it.kind + ', ' + it.kb + ' KB)');
});
