# Buffers Aur Binary Data Node Mein

> **Connects to**: [[141-streams-and-backpressure]] (streams chunks Buffer mein hi deti hain) aur [[48-huge-json-payloads]] (body size limits Buffer bytes par lagti hain, characters par nahi).

## 1. Kahani: "Max 500 Characters" Wala Bug

Ek comment API hai. Validation ek line ki:

```js
if (comment.length > 500) return res.status(422).json({ error: 'Too long' });
```

QA pass. Launch. Hindi users aate hain -- aur DB se error:

```
ERROR: value too long for type character varying(500)
```

Comment mein 500 "characters" hi the. Phir column kaise overflow hua?

Kyunki DB column ne **bytes** naape, JS ne **UTF-16 code units** naape. `"namaste"` Devanagari mein likha jaaye to har akshar UTF-8 mein **3 bytes** leta hai. Ek 500-character Hindi comment ~1500 bytes ka hai.

Yahin se Buffer ki kahani shuru hoti hai.

## 2. Buffer Kyun Exist Karta Hai

JavaScript ki `String` **text** hai -- UTF-16 code units ka sequence. Par network aur disk ko text nahi pata; unke paas sirf **bytes** hain.

| Cheez | Unit |
|---|---|
| JS String | UTF-16 code units (character nahi, code unit) |
| TCP socket, file, image, PDF, zip, AES output | raw bytes (0-255) |

Browser mein ye kaam `Uint8Array`/`ArrayBuffer` karte hain. Node ne 2009 mein, `TypedArray` se bhi pehle, apna `Buffer` banaya -- ab wo **`Uint8Array` ka subclass** hai, plus encoding/slicing helpers.

> **Term: Buffer** -- V8 heap ke **bahar** allocate ki gayi fixed-length raw bytes ki jagah, jisme aap bytes ko padh/likh sakte ho aur kisi bhi encoding mein interpret kar sakte ho.

Bahar allocate hone ka natija: Buffer `heapUsed` mein nahi dikhta, `external` mein dikhta hai ([[144-garbage-collection-and-memory]] mein poora).

## 3. Buffer Banane Ke Teen Tareeke

```js
Buffer.from('hello');                   // existing data se (string/array/buffer)
Buffer.from([0xde, 0xad, 0xbe, 0xef]);
Buffer.alloc(16);                       // 16 bytes, SAB zero
Buffer.allocUnsafe(16);                 // 16 bytes, purana kachra andar
```

`new Buffer(...)` **deprecated aur Node 22+ mein hata diya gaya** hai. Wajah security thi: `new Buffer(n)` number ke saath uninitialized memory deta tha, par `new Buffer(str)` string se data. Agar koi JSON se aaye value seedha de de --

```js
// PURANA BUG: body { "data": 1024 } bheja to 1024 bytes ka kachra
const buf = new Buffer(req.body.data);
```

-- to attacker number bhej kar purani process memory (passwords, tokens, dusre users ka data) response mein nikaal sakta tha. Isliye API do hisson mein tod di: `Buffer.from` (data) aur `Buffer.alloc` (size).

### `alloc` vs `allocUnsafe`

| | Speed | Content |
|---|---|---|
| `Buffer.alloc(n)` | dheema (zero-fill karta hai) | sab 0 |
| `Buffer.allocUnsafe(n)` | tez | **recycled memory**, purana data |

`allocUnsafe` ki "unsafe" asli hai: wo memory pehle kisi aur cheez ne use ki thi. Agar aapne saare n bytes **overwrite nahi kiye** aur poora buffer bhej diya, to purana content leak ho gaya.

```js
const buf = Buffer.allocUnsafe(64);
const written = buf.write(payload);     // maan lo 10 bytes likhe
socket.write(buf);                      // BUG: 54 bytes purana kachra bheja
socket.write(buf.subarray(0, written)); // SAHI: sirf jo likha
```

Rule: `allocUnsafe` sirf tab jab aap **turant poora buffer bhar** rahe ho (jaise hot path mein read loop). Baaki hamesha `alloc`.

## 4. `buf.length` Bytes Hai -- Aur Yahi Bug Tha

```js
const s = 'hello';
s.length;                       // 5
Buffer.byteLength(s, 'utf8');   // 5  (ASCII -> 1 byte each)
```

Ab Devanagari. "namaste" ka Devanagari spelling 6 code points ka hai (na + maatra + ma + s + t + e jaisa), aur UTF-8 mein **har** Devanagari code point 3 bytes leta hai:

```js
const hi = devanagariNamaste;           // 6 code points
hi.length;                              // 6   <- JS yahi dekhta hai
Buffer.byteLength(hi, 'utf8');          // 18  <- disk/DB/network yahi dekhte hain
```

To 500-character limit = **1500 bytes** tak. Emoji aur bura: ek emoji 4 bytes UTF-8 **aur** JS mein `length === 2` (surrogate pair). Flag emoji 8 bytes aur `length === 4`.

```js
// SAHI validation -- jo cheez fail hoti hai usi unit mein naapo
const bytes = Buffer.byteLength(comment, 'utf8');
if (bytes > 2000) return res.status(422).json({ error: 'Too long', bytes, max: 2000 });
```

Aur user ko dikhane wali ginti ke liye `[...str].length` (code points) use karo, `str.length` nahi.

## 5. Encodings Aur Base64 Ka 33% Tax

```js
const buf = Buffer.from('hi');
buf.toString('utf8');    // 'hi'
buf.toString('hex');     // '6869'    -> 2x size
buf.toString('base64');  // 'aGk='    -> ~1.33x size
```

| Encoding | Size factor | Kab |
|---|---|---|
| `utf8` | 1x (ASCII), 2-4x (non-Latin) | normal text |
| `base64` | **~1.33x** | binary ko text channel (JSON, email, data URI) mein bhejna |
| `base64url` | ~1.33x | JWT, URL-safe tokens (`+/` ki jagah `-_`) |
| `hex` | 2x | hashes, HMAC signatures, debugging |
| `latin1` | 1x | legacy byte-per-char protocols |

Ganit: base64 **3 bytes ko 4 characters** banata hai -> 4/3 = 1.333. Iska practical matlab: ek 6 MB image ko JSON mein base64 bhejoge to body **8 MB** ki ho jaayegi, aur aapka `express.json({ limit: '6mb' })` reject kar dega. Mobile apps ka ye classic bug hai -- fix: `multipart/form-data` ya presigned URL ([[87-2gb-upload-direct-to-s3]]), base64-in-JSON nahi.

Ek aur: base64 **encryption nahi hai**. Ye sirf representation hai, koi bhi decode kar sakta hai.

## 6. Multi-Byte Character Chunk Boundary Par Kat Jaata Hai

Streaming padhte waqt chunk boundary character ke beech aa sakti hai:

```js
// BUG: har chunk ko alag se decode kar rahe hain
let text = '';
stream.on('data', (chunk) => { text += chunk.toString('utf8'); });
```

Maan lo ek 3-byte Devanagari character ke 2 bytes chunk 1 ke aakhir mein gaye, 3rd byte chunk 2 mein. Chunk 1 ka `toString('utf8')` adhoore bytes ko valid nahi padh paata -> `U+FFFD` replacement character (wo "?" wala box). Data **permanently corrupt**, aur sirf non-English input par -- isliye test mein kabhi nahi pakda jaata.

Do fixes:

```js
// Fix A: StringDecoder -- adhoore bytes agle chunk tak hold karta hai
const { StringDecoder } = require('node:string_decoder');
const decoder = new StringDecoder('utf8');

let text = '';
stream.on('data', (chunk) => { text += decoder.write(chunk); });  // safe
stream.on('end', () => { text += decoder.end(); });               // bacha hua flush

// Fix B: pehle saare bytes jodo, decode baad mein (chhote payload ke liye)
const buf = Buffer.concat(chunks);
const text2 = buf.toString('utf8');
```

Ya bas `stream.setEncoding('utf8')` -- wo andar StringDecoder hi lagata hai. Yahi `tail` wali problem ka byte-level bhai hai jo [[141-streams-and-backpressure]] ke line splitter mein thi.

## 7. Asli Backend Kaam #1: Webhook HMAC Ko Raw Body Chahiye

Stripe/Razorpay/GitHub webhook ka signature **exact bytes** par banta hai jo unhone bheje. JSON parse karke dobara stringify karna un bytes ko **badal** deta hai (key order, spacing, unicode escaping, number formatting). Signature fail -> aapke saare webhooks 400.

```js
// GALAT: body parser ne original bytes kha liye
app.use(express.json());
app.post('/webhook', (req, res) => {
  const expected = hmac(JSON.stringify(req.body));   // ye wo bytes nahi hain
});
```

Sahi: us **ek route** par raw Buffer rakho, baaki app ke liye JSON parser rehne do.

```js
const express = require('express');
const crypto = require('node:crypto');
const app = express();

// raw parser SIRF webhook route par, json parser se PEHLE
app.post('/webhooks/stripe',
  express.raw({ type: 'application/json', limit: '1mb' }),   // req.body = Buffer
  (req, res) => {
    const signature = Buffer.from(req.get('X-Signature') ?? '', 'hex');
    const expected = crypto
      .createHmac('sha256', process.env.WEBHOOK_SECRET)
      .update(req.body)                                     // Buffer, exact bytes
      .digest();                                            // Buffer, hex nahi

    if (signature.length !== expected.length ||
        !crypto.timingSafeEqual(signature, expected)) {
      return res.status(401).end();
    }
    const event = JSON.parse(req.body.toString('utf8'));     // verify ke BAAD parse
    res.status(202).end();
  }
);

app.use(express.json());    // baaki routes normal
```

Teen cheezein jo yahan deliberate hain:
1. **`express.raw` pehle** -- order matter karta hai; `express.json()` pehle lag gaya to raw bytes gaye.
2. **`timingSafeEqual`** -- `===` ya `a.equals(b)` pehle mismatch par turant return karta hai; timing se attacker byte-by-byte signature guess kar sakta hai. `timingSafeEqual` constant time leta hai.
3. **Length check pehle** -- `timingSafeEqual` **alag length** par `RangeError` **throw** karta hai (false return nahi karta). Length compare na karo to attacker chhota header bhej kar 500 giraa sakta hai. Isliye: length check -> phir timingSafeEqual.

## 8. Asli Backend Kaam #2: Uploads, Hashing, Comparisons

```js
// File ka SHA-256 -- poori file memory mein laaye bina
const hash = crypto.createHash('sha256');
await pipeline(fs.createReadStream(path), hash);
const digest = hash.digest('hex');       // upload integrity check ([[125-lld-file-upload-client]])
```

```js
// Magic bytes se file type check -- extension aur Content-Type dono jhooth bol sakte hain
const head = buffer.subarray(0, 4);
const isPng = head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
const isPdf = buffer.subarray(0, 5).toString('latin1') === '%PDF-';
```

```js
// subarray vs copy -- bada farak
const view = big.subarray(0, 10);   // SAME memory, 1 GB buffer zinda rehta hai
const copy = Buffer.from(view);     // alag 10 bytes, bada buffer GC ho sakta hai
```

Wo doosri line kyun zaroori hai: `subarray` (aur purana `slice`) **view** deta hai, copy nahi. 1 GB buffer ka 10-byte view cache mein rakh diya to **poora 1 GB** reachable rehta hai -- ek silent `external` memory leak ([[144-garbage-collection-and-memory]]).

## 9. Production Reality

- Buffers `external` memory hain -- heap limit (`--max-old-space-size`) unpar lagti hi nahi. Container memory limit lagti hai. To `heapUsed` normal dikhte hue bhi pod `OOMKilled` ho sakta hai.
- `Buffer.concat` poora naya buffer allocate karta hai. Bade data ke liye streaming ([[141-streams-and-backpressure]]) hi raasta hai.
- `buffer.constants.MAX_LENGTH` ek hard ceiling hai (~4 GB 64-bit par) -- usse bada single buffer possible hi nahi.
- Secrets Buffer mein rakh ke `buf.fill(0)` kar sakte ho; String immutable hai, use wipe nahi kar sakte. (GC ki guarantee nahi hai, par behtar hai.)
- Logs mein Buffer kabhi `JSON.stringify` mat karo -- `{"type":"Buffer","data":[72,101,...]}` megabytes mein log bhar dega.

## 10. Common Galtiyan

- `str.length` se byte limit lagana -> non-English input par DB overflow (ye lesson ki kahani).
- `allocUnsafe` ka poora buffer bheja bina poora bhare -> purani memory leak.
- Webhook verify karne se pehle body JSON parse kar dena -> signature mismatch, hamesha.
- Signature compare mein `===` -> timing attack; aur `timingSafeEqual` bina length check -> `RangeError` crash.
- Image ko base64 karke JSON mein bhejna -> 33% bada payload + double memory.
- Chunks ko alag-alag `toString()` karna -> multi-byte character corrupt.
- Bade buffer ka `subarray` long-lived cache mein rakhna -> poora parent buffer zinda.

## 🧠 Remember

> String text hai, Buffer bytes hai -- aur jo cheez fail hoti hai (DB column, network, HMAC) wo hamesha **bytes** naapti hai, isliye `str.length` ki jagah `Buffer.byteLength`, `new Buffer` ki jagah `Buffer.from`/`alloc`, naive chunk decode ki jagah `StringDecoder`, aur webhook verify karte waqt raw body ke bina signature kabhi match nahi karega.

## Quick Self-Test

1. 500-character Hindi comment `varchar(500)` column mein kyun nahi ghusta, aur validation kis function se likhoge?
2. `Buffer.allocUnsafe(64)` mein 10 bytes likh kar poora buffer bhej dene se exactly kya leak hota hai?
3. `express.json()` lagane ke baad webhook signature verify kyun fail hoga, aur fix mein middleware order kya hoga?
4. `crypto.timingSafeEqual` ko different-length buffers dene par kya hota hai -- `false` ya kuch aur?
5. 6 MB image base64 karke JSON mein bhejne par body size kitni hogi aur kyun?
6. 1 GB buffer ka `subarray(0, 10)` cache mein rakhne se memory par kya asar?
