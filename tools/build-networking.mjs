// Embeds every networking/NN-*.md page into index.html as a network-data block,
// so the dashboard's "Networking" tab works even when opened as a local file.
// Re-run after adding or editing a page:   node tools/build-networking.mjs
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'networking');
const indexFile = join(root, 'index.html');
const START = '<!--NETWORK-DATA-START-->';
const END = '<!--NETWORK-DATA-END-->';

const files = readdirSync(dir)
  .filter((f) => /^\d+-.*\.md$/.test(f))
  .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

const blocks = files.map((file) => {
  const md = readFileSync(join(dir, file), 'utf8');
  const h1 = (md.match(/^#\s+(.+)$/m) || [])[1] || file;
  // "3. Internet -> Load Balancer -> App" -> n = 3, title = the rest
  const m = h1.match(/^\s*(\d+)\.\s*(.+)$/);
  const n = m ? m[1] : String(parseInt(file, 10));
  const title = (m ? m[2] : h1).trim().replace(/"/g, "'");
  return { file, n, title, md };
});

const html = blocks.map((b) =>
  '<script type="text/markdown" class="network-data" data-n="' + b.n + '" data-title="' + b.title + '">\n' +
  b.md + (b.md.endsWith('\n') ? '' : '\n') + '</script>').join('\n');

let index = readFileSync(indexFile, 'utf8');
const s = index.indexOf(START), e = index.indexOf(END);
if (s >= 0 && e > s) {
  index = index.slice(0, s) + START + '\n' + html + '\n' + index.slice(e);
} else {
  const marker = '<!-- ======================= END LESSON DATA';
  const at = index.indexOf(marker);
  if (at < 0) throw new Error('Could not find the END LESSON DATA marker in index.html');
  index = index.slice(0, at) + START + '\n' + html + '\n' + END + '\n' + index.slice(at);
}
writeFileSync(indexFile, index);

console.log('Networking pages embedded in index.html:');
blocks.forEach((b) => console.log('  ' + b.n + '. ' + b.title));
