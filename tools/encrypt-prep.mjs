// Builds the private interview-prep page and publishes ONLY an encrypted copy.
//
//   node tools/encrypt-prep.mjs            (encrypt + commit + push)
//   node tools/encrypt-prep.mjs --no-push  (encrypt only)
//
// 1. Rebuilds interview-prep/index.html from the .md notes (plaintext, never committed;
//    interview-prep/ is in .gitignore).
// 2. Asks for a password (hidden input, typed twice). The password is never written
//    anywhere - not to disk, not to the repo, not to the browser.
// 3. Encrypts the whole page with AES-256-GCM. The key is derived from the password with
//    PBKDF2-SHA256 (600,000 iterations) and a fresh random salt on every run.
// 4. Writes prep/index.html: a small lock screen + the ciphertext. The browser decrypts it
//    with the Web Crypto API only after the right password is entered.
//
// Run it in PowerShell or cmd (Git Bash/mintty can't hide typed characters).
import { execFileSync } from 'node:child_process';
import { randomBytes, pbkdf2Sync, createCipheriv } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ITERATIONS = 600000;

function askHidden(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) {
      reject(new Error('Needs an interactive terminal. Run this in PowerShell or cmd.'));
      return;
    }
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData);
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') { stdout.write('\n'); process.exit(1); } // Ctrl+C
        if (ch === '\u0008' || ch === '\u007f') { value = value.slice(0, -1); continue; } // Backspace
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

// 1. Rebuild the plaintext page from the notes.
execFileSync(process.execPath, [join(root, 'interview-prep', 'build-html.mjs')], { stdio: 'inherit' });
const plaintext = readFileSync(join(root, 'interview-prep', 'index.html'), 'utf8');

// 2. Password, typed twice, hidden.
let password, repeat;
try {
  password = await askHidden('Password: ');
  if (password.length < 12) {
    console.error('Use at least 12 characters - anyone can download the encrypted file and try guesses offline.');
    process.exit(1);
  }
  repeat = await askHidden('Repeat password: ');
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
if (repeat !== password) {
  console.error('Passwords did not match. Nothing was written.');
  process.exit(1);
}

// 3. Encrypt. Web Crypto's AES-GCM expects ciphertext followed by the 16-byte auth tag.
const salt = randomBytes(16);
const iv = randomBytes(12);
const key = pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');
const cipher = createCipheriv('aes-256-gcm', key, iv);
const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);

const payload = JSON.stringify({
  v: 1,
  kdf: 'PBKDF2-SHA256',
  iterations: ITERATIONS,
  salt: salt.toString('base64'),
  iv: iv.toString('base64'),
  data: encrypted.toString('base64'),
});

// 4. Lock page. Contains no plaintext and no password - only the ciphertext and the
//    public salt/IV/iteration count needed to derive the key again.
const lockPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Private - Interview Prep</title>
<style>
  :root { --bg: #f5f0e6; --card: #fff; --text: #2b2620; --muted: #6b6255; --border: #ddd3c0; --accent: #a8631e; --err: #b3261e; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #1a1712; --card: #211d16; --text: #e8e0d0; --muted: #a89f8c; --border: #3a352a; --accent: #e0a458; --err: #f2b8b5; }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { display: grid; place-items: center; background: var(--bg); color: var(--text);
         font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; padding: 16px; }
  form { width: 100%; max-width: 360px; background: var(--card); border: 1px solid var(--border);
         border-radius: 12px; padding: 28px 24px; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  p { margin: 0 0 18px; color: var(--muted); font-size: 14px; }
  input { width: 100%; padding: 11px 12px; font-size: 16px; border: 1px solid var(--border);
          border-radius: 8px; background: var(--bg); color: var(--text); }
  button { width: 100%; margin-top: 12px; padding: 11px; font-size: 16px; border: 0; border-radius: 8px;
           background: var(--accent); color: #fff; cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
  #msg { min-height: 22px; margin: 10px 0 0; font-size: 14px; }
  #msg.err { color: var(--err); }
  #back { display: block; margin-top: 16px; text-align: center; font-size: 14px; color: var(--muted); }
</style>
</head>
<body>
<form id="unlock" autocomplete="off">
  <h1>&#128274; Private notes</h1>
  <p>This page is encrypted. Enter the password to read it. The password is not stored anywhere.</p>
  <input id="pw" type="password" placeholder="Password" autofocus autocomplete="off">
  <button id="btn" type="submit">Unlock</button>
  <div id="msg" role="status"></div>
  <a id="back" href="../index.html">&larr; Back to lessons</a>
</form>
<script id="payload" type="application/json">${payload}</script>
<script>
  const P = JSON.parse(document.getElementById('payload').textContent);
  const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  async function decrypt(password) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: bytes(P.salt), iterations: P.iterations },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(P.iv) }, key, bytes(P.data));
    return new TextDecoder().decode(plain);
  }

  document.getElementById('unlock').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = document.getElementById('pw');
    const btn = document.getElementById('btn');
    const msg = document.getElementById('msg');
    if (!window.crypto || !crypto.subtle) {
      msg.className = 'err'; msg.textContent = 'This browser needs HTTPS (or a modern browser) to decrypt.';
      return;
    }
    btn.disabled = true; msg.className = ''; msg.textContent = 'Decrypting...';
    try {
      const html = await decrypt(pw.value);
      pw.value = '';
      document.open(); document.write(html); document.close();
    } catch (err) {
      msg.className = 'err'; msg.textContent = 'Wrong password.';
      btn.disabled = false; pw.select();
    }
  });
</script>
</body>
</html>
`;

mkdirSync(join(root, 'prep'), { recursive: true });
writeFileSync(join(root, 'prep', 'index.html'), lockPage);
console.log('Wrote prep/index.html (encrypted, ' + Math.round(encrypted.length / 1024) + ' KB of ciphertext).');

// 5. Publish: commit and push ONLY the encrypted file. Skip with --no-push.
if (process.argv.includes('--no-push')) {
  console.log('Skipped push (--no-push). Commit prep/index.html when ready.');
} else {
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim();
  try {
    git('add', '--', 'prep/index.html');
    if (!git('diff', '--cached', '--name-only', '--', 'prep/index.html')) {
      console.log('No changes to publish.');
    } else {
      git('commit', '-m', 'Update encrypted interview-prep notes', '--', 'prep/index.html');
      git('push', 'origin', 'HEAD');
      console.log('Pushed. Live in about a minute at https://sonuengineer.github.io/FullStackInterview/prep/');
    }
  } catch (err) {
    console.error('Encrypted file is written, but the git push failed:');
    console.error(String(err.stderr || err.message).trim());
    console.error('Fix the problem (e.g. run: gh auth switch --user sonuengineer), then run:');
    console.error('  git add prep/index.html && git commit -m "Update prep" && git push');
    process.exit(1);
  }
}
