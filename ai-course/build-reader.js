// build-reader.js -- bundles all day-*.md files into reader.html using reader-template.html
// Run: node build-reader.js
const fs = require('fs');
const path = require('path');

const files = fs.readdirSync(__dirname)
  .filter(f => /^day-\d+.*\.md$/i.test(f))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

if (!files.length) { console.error('No day-*.md files found.'); process.exit(1); }

const chapters = files.map((f) => {
  const md = fs.readFileSync(path.join(__dirname, f), 'utf8');
  const title = (md.match(/^#\s+(.+)$/m) || [, f.replace(/\.md$/, '')])[1].trim();
  const module = (md.match(/\*\*Module:\*\*\s*(.+)/) || [, 'Epilogue'])[1].trim();
  const time = (md.match(/\*\*Time:\*\*\s*(.+)/) || [, ''])[1].trim();
  const words = md.split(/\s+/).length;
  const minutes = Math.max(1, Math.round(words / 190));
  return { file: f, title, module, time, minutes, md };
});

const modules = [...new Set(chapters.map(c => c.module))];
const template = fs.readFileSync(path.join(__dirname, 'reader-template.html'), 'utf8');

const dataJs = JSON.stringify(chapters).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, m => '\\u202' + (m === '\u2028' ? '8' : '9'));
const modulesJs = JSON.stringify(modules);

const out = template.replace('__DATA__', () => dataJs).replace('__MODULES__', () => modulesJs);

fs.writeFileSync(path.join(__dirname, 'reader.html'), out);
console.log(`Built reader.html -- ${chapters.length} chapters, ${(out.length / 1024).toFixed(0)} KB`);
chapters.forEach(c => console.log(`  ${c.title}  (${c.minutes} min, ${c.module})`));
console.log(`Modules: ${modules.join(' | ')}`);
