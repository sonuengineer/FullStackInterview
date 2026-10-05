// Appends any lessons/NN-*.md that are not yet in index.html as a
// <script type="text/markdown" class="lesson-data"> block, inserted just before
// the END LESSON DATA marker. That is the same shape the existing 114 lessons
// use, so the dashboard picks them up with no other change.
//
// This script is deliberately APPEND-ONLY. It never rewrites or reorders an
// existing block, because the titles in index.html are hand-written and often
// differ from the file's H1 (e.g. 114's H1 starts "Blog: ..." while its title
// does not), so regenerating them would silently change the sidebar.
//
// A new lesson needs a title and a category, which live nowhere in the .md, so
// they are declared in NEW_LESSONS below -- the same way build-systemdesign.mjs
// hard-codes its category order.
//
//   node tools/build-lessons.mjs
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lessonsDir = join(root, 'lessons');
const indexFile = join(root, 'index.html');
const END = '<!-- ======================= END LESSON DATA ======================= -->';

// id -> { title, category }. Categories must match the existing spelling to
// merge into an existing sidebar group; a new name creates a new group.
const NEW_LESSONS = {
  // ---- Low-Level Design track
  '115': { title: 'LLD Interview Approach: Requirements to Code', category: 'Low-Level Design' },
  '116': { title: 'SOLID Principles with Node.js Examples', category: 'Low-Level Design' },
  '117': { title: 'Design Patterns That Actually Come Up', category: 'Low-Level Design' },
  '118': { title: 'LLD: Splitwise (Expense Split and Settlement)', category: 'Low-Level Design' },
  '119': { title: 'LLD: LRU Cache (O(1) Get and Put)', category: 'Low-Level Design' },
  '120': { title: 'LLD: Rate Limiter Class Design', category: 'Low-Level Design' },
  '121': { title: 'LLD: BookMyShow Seat Booking (Concurrency)', category: 'Low-Level Design' },
  '122': { title: 'LLD: Elevator System', category: 'Low-Level Design' },
  '123': { title: 'LLD: Notification Service Class Design', category: 'Low-Level Design' },
  '124': { title: 'LLD: Logging Library', category: 'Low-Level Design' },
  '125': { title: 'LLD: File Upload Client (Multipart and Resume)', category: 'Low-Level Design' },
  '126': { title: 'Machine Coding Round: 90 Minutes', category: 'Low-Level Design' },
  // ---- Behavioural round
  '127': { title: 'Tell Me About Yourself (60-Second Answer)', category: 'Behavioural Round' },
  '128': { title: 'STAR Method from Your Own Incidents', category: 'Behavioural Round' },
  '129': { title: 'Walk Me Through Your Project', category: 'Behavioural Round' },
  '130': { title: 'A Production Incident You Handled', category: 'Behavioural Round' },
  '131': { title: 'Disagreement With a Teammate or Manager', category: 'Behavioural Round' },
  '132': { title: 'A Time You Failed or Shipped a Bug', category: 'Behavioural Round' },
  '133': { title: 'Why Are You Leaving / Why This Company', category: 'Behavioural Round' },
  '134': { title: 'Questions to Ask the Interviewer', category: 'Behavioural Round' },
  '135': { title: 'Salary Negotiation (Indian Context)', category: 'Behavioural Round' },
  '136': { title: 'Weaknesses, Feedback and Growth', category: 'Behavioural Round' },
  // ---- Node.js internals
  '137': { title: 'Event Loop Phases and Microtasks', category: 'Node.js Internals' },
  '138': { title: 'Closures and Scope (Real Bugs)', category: 'Node.js Internals' },
  '139': { title: 'Prototypes, this, call/apply/bind', category: 'Node.js Internals' },
  '140': { title: 'Promises Internals and async/await', category: 'Node.js Internals' },
  '141': { title: 'Streams and Backpressure', category: 'Node.js Internals' },
  '142': { title: 'Buffers and Binary Data', category: 'Node.js Internals' },
  '143': { title: 'CommonJS vs ESM and Module Resolution', category: 'Node.js Internals' },
  '144': { title: 'Garbage Collection and Memory', category: 'Node.js Internals' },
  '145': { title: 'libuv Thread Pool: What Is Really Async', category: 'Node.js Internals' },
  '146': { title: 'EventEmitter and Listener Leaks', category: 'Node.js Internals' },
  '147': { title: 'TypeScript at the Runtime Boundary', category: 'Node.js Internals' },
};

const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

let html = readFileSync(indexFile, 'utf8');
const at = html.indexOf(END);
if (at < 0) throw new Error('Could not find the END LESSON DATA marker in index.html');

const present = new Set([...html.matchAll(/class="lesson-data"\s+data-id="([^"]+)"/g)].map((m) => m[1]));

const files = readdirSync(lessonsDir)
  .filter((f) => /^\d+-.*\.md$/.test(f))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

const added = [];
const skippedNoMeta = [];
let blocks = '';

for (const f of files) {
  const id = f.match(/^(\d+)-/)[1];
  if (present.has(id)) continue;
  const meta = NEW_LESSONS[id];
  if (!meta) { skippedNoMeta.push(f); continue; }
  const md = readFileSync(join(lessonsDir, f), 'utf8').trim();
  // A literal </script> inside the markdown would close the wrapper early.
  const safe = md.replace(/<\/script/gi, '<\\/script');
  blocks += '<script type="text/markdown" class="lesson-data" data-id="' + attr(id) +
    '" data-title="' + attr(meta.title) + '" data-category="' + attr(meta.category) +
    '" data-order="' + Number(id) + '">\n' + safe + '\n</script>\n\n';
  added.push({ id, title: meta.title, category: meta.category, file: f, lines: md.split('\n').length });
}

if (added.length) {
  html = html.slice(0, at) + blocks + html.slice(at);
  writeFileSync(indexFile, html);
}

console.log('Lessons already in index.html: ' + present.size);
console.log('Added: ' + added.length);
let lastCat = '';
for (const a of added) {
  if (a.category !== lastCat) { console.log('  [' + a.category + ']'); lastCat = a.category; }
  console.log('    ' + a.id + '. ' + a.title + '  (' + a.lines + ' lines)');
}
if (skippedNoMeta.length) {
  console.log('\nSkipped - no title/category declared in NEW_LESSONS (add them there):');
  skippedNoMeta.forEach((f) => console.log('    ' + f));
}
