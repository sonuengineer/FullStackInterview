// Builds a self-contained reading page (.html) next to each system design .md file,
// plus one Kindle-style index.html per system folder (all parts in one place).
// Usage: node systemdesign/build.mjs            (all .md files under systemdesign/)
//        node systemdesign/build.mjs path/to.md (one file)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const skip = new Set(['prompt.md', 'README.md', 'DESIGN-SPEC.md']);

function findMarkdown(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return findMarkdown(p);
    return e.name.endsWith('.md') && !skip.has(e.name) ? [p] : [];
  });
}

function page(title, md) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/mermaid/10.9.1/mermaid.min.js"></script>
<style>
  :root { --bg:#fafafa; --fg:#1f2328; --muted:#57606a; --border:#d0d7de; --code-bg:#f6f8fa; --accent:#0969da; --callout-bg:#fff8c5; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0d1117; --fg:#e6edf3; --muted:#8b949e; --border:#30363d; --code-bg:#161b22; --accent:#58a6ff; --callout-bg:#3b3410; }
  }
  * { box-sizing: border-box; }
  body { background:var(--bg); color:var(--fg); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
         line-height:1.65; max-width:900px; margin:0 auto; padding:40px 24px 100px; }
  h1,h2,h3 { line-height:1.3; }
  h1 { font-size:2rem; border-bottom:2px solid var(--border); padding-bottom:10px; }
  h2 { font-size:1.45rem; margin-top:2.4em; border-bottom:1px solid var(--border); padding-bottom:6px; }
  h3 { font-size:1.1rem; color:var(--accent); margin-top:1.8em; }
  code { background:var(--code-bg); padding:2px 6px; border-radius:4px; font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace; font-size:0.9em; }
  pre { background:var(--code-bg); padding:14px 16px; border-radius:8px; overflow-x:auto; border:1px solid var(--border); }
  pre code { background:none; padding:0; }
  blockquote { border-left:4px solid var(--accent); background:var(--callout-bg); margin:1.2em 0; padding:0.6em 1em; border-radius:0 6px 6px 0; }
  .table-wrap { overflow-x:auto; }
  table { border-collapse:collapse; width:100%; margin:1.2em 0; }
  th,td { border:1px solid var(--border); padding:8px 12px; text-align:left; vertical-align:top; }
  th { background:var(--code-bg); }
  ul,ol { padding-left:1.4em; }
  li { margin:0.35em 0; }
  .mermaid { background:white; border-radius:8px; padding:12px; margin:1.2em 0; }
  a { color:var(--accent); }
  hr { border:none; border-top:1px solid var(--border); margin:2.5em 0; }
  @media (max-width:600px) { body { padding:24px 16px 80px; } h1 { font-size:1.5rem; } }
</style>
</head>
<body>
<div id="content">Loading...</div>
<script type="text/markdown" id="md-source">
${md.replace(/<\/script/gi, '<\\/script')}
</script>
<script>
  mermaid.initialize({ startOnLoad: false, theme: 'default' });
  const src = document.getElementById('md-source').textContent;
  const renderer = new marked.Renderer();
  renderer.code = function(code, lang) {
    if (lang === 'mermaid') return '<div class="mermaid">' + code + '</div>';
    return '<pre><code>' + code.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</code></pre>';
  };
  renderer.table = function(header, body) {
    return '<div class="table-wrap"><table><thead>' + header + '</thead><tbody>' + body + '</tbody></table></div>';
  };
  document.getElementById('content').innerHTML = marked.parse(src, { renderer });
  mermaid.run({ querySelector: '.mermaid' });
</script>
</body>
</html>
`;
}

// Kindle-style reader: every folder with part-*.md files gets an index.html
// that holds all parts in one page (contents, themes, font size, saved position).
function buildReader(dir) {
  const files = fs.readdirSync(dir)
    .filter((f) => /^part-\d+.*\.md$/.test(f))
    .sort((a, b) => parseInt(a.slice(5), 10) - parseInt(b.slice(5), 10));
  if (files.length === 0) return;
  const parts = files.map((f) => {
    const md = fs.readFileSync(path.join(dir, f), 'utf8');
    const h1 = md.match(/^#\s+(.+)$/m)?.[1] ?? f;
    const label = h1.match(/\(Part \d+:\s*([^)]+)\)/)?.[1] ?? h1;
    return { file: f, label, md, h1 };
  });
  const bookTitle = parts[0].h1.split(' -- ')[0].replace(/[<>&]/g, '');
  const data = { title: bookTitle, parts: parts.map(({ label, md }) => ({ label, md })) };
  // escape "<" so part content can never close the surrounding <script> tag
  const json = JSON.stringify(data).replace(/</g, String.fromCharCode(92) + 'u003c');
  const template = fs.readFileSync(path.join(root, 'reader.template.html'), 'utf8');
  const html = template
    .split('__BOOK_TITLE__').join(bookTitle)
    .replace('/*__BOOK_DATA__*/', () => json);
  const out = path.join(dir, 'index.html');
  fs.writeFileSync(out, html);
  console.log('built', path.relative(root, out), `(${parts.length} parts)`);
}

const targets = process.argv[2] ? [path.resolve(process.argv[2])] : findMarkdown(root);
for (const file of targets) {
  const md = fs.readFileSync(file, 'utf8');
  const title = (md.match(/^#\s+(.+)$/m)?.[1] ?? path.basename(file, '.md')).replace(/[<>&]/g, '');
  const out = file.replace(/\.md$/, '.html');
  fs.writeFileSync(out, page(title, md));
  console.log('built', path.relative(root, out));
}
for (const dir of new Set(targets.map((f) => path.dirname(f)))) buildReader(dir);
