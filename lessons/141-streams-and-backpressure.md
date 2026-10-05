# Streams Aur Backpressure: Memory Bachane Ka Asli Tareeka

> **Connects to**: [[64-500mb-video-upload-memory]] (bada upload buffer karne par memory kyun phatti hai), [[48-huge-json-payloads]] (bade payload ka same rule), [[87-2gb-upload-direct-to-s3]] (bytes ko API se bahar rakhna) aur [[125-lld-file-upload-client]] (client side chunking). | [[145-libuv-thread-pool-what-is-really-async]] (file I/O thread pool)

## 1. Kahani: 2 GB Ki File Ne Pod Gira Diya

Ek reporting service hai. Kaam simple lagta hai -- S3 se ek CSV uthao, process karo, response bhejo:

```js
const data = fs.readFileSync('/tmp/export.csv');   // 2 GB file
res.send(transform(data.toString()));
```

Dev machine par 10 MB ki sample file thi -- sab chalta tha. Production mein file 2 GB ho gayi. Result:

```
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
```

Pod `OOMKilled`. Aur mazedaar baat: **usi machine par** `cat export.csv | gzip > out.gz` aaram se chalta hai, 5 MB memory mein. Kyun?

Kyunki `cat` file ko **poori** memory mein nahi laata. Wo **64 KB ka chunk** padhta hai, aage bhejta hai, agla chunk padhta hai. Bas yahi stream hai.

## 2. Problem Ki Jad

| Approach | Memory | 2 GB file |
|---|---|---|
| `readFileSync` / `await fs.readFile` | poori file | 2 GB RAM, OOM |
| Stream | ek chunk + buffer | ~5-10 MB, chalta hai |

Node ka default heap `--max-old-space-size` ke hisaab se hota hai (aksar 1.5-4 GB). Buffer bhi `buffer.constants.MAX_LENGTH` se bada nahi ho sakta. To "bas RAM badha do" ek deewar par ja kar rukta hai -- aur 100 concurrent requests par wo deewar 100x pehle aa jaati hai ([[64-500mb-video-upload-memory]] wali ganit).

## 3. Chaar Stream Types Ek Table Mein

| Type | Kya karta hai | Example |
|---|---|---|
| **Readable** | bytes/objects **deta** hai | `fs.createReadStream`, HTTP `req`, DB cursor |
| **Writable** | bytes/objects **leta** hai | `fs.createWriteStream`, HTTP `res`, socket |
| **Duplex** | dono -- independent read aur write side | TCP `net.Socket` |
| **Transform** | Duplex jisme output input se **banta** hai | `zlib.createGzip()`, CSV parser, crypto cipher |

Mental model:

```
Readable  --(chunks)-->  Transform  --(chunks)-->  Writable
  source                  processing                 sink
```

Transform hi 90% custom code hai jo aap likhenge.

## 4. Backpressure -- Poora Concept Ek Line Mein

> Producer tez hai, consumer dheema hai. Backpressure wo mechanism hai jisse dheema consumer tez producer ko kehta hai: **"ruk ja, main bhar gaya hoon."**

Technically: `writable.write(chunk)` **boolean** return karta hai.

- `true` -> internal buffer mein jagah hai, aur bhejo.
- `false` -> buffer `highWaterMark` (default 16 KB) cross kar gaya. **Ab rukna chahiye** aur `'drain'` event ka wait karna chahiye.

Yahan asli bug hai: `write()` ka `false` sirf ek **salah** hai. Ignore kar do to Node crash nahi karega -- wo chupchap chunks **memory mein queue** karta rahega. Aapka 2 GB disk se nikal kar 2 GB RAM mein aa jaayega, bas dhire-dhire.

### Galat: naive `on('data')` loop

```js
// BUG: write() ka return value ignore -- backpressure hi nahi hai
const src = fs.createReadStream('export.csv');
const dst = fs.createWriteStream('/mnt/slow-nfs/out.csv');

src.on('data', (chunk) => {
  dst.write(chunk);          // false aaye to bhi padhte rehte hain
});
src.on('end', () => dst.end());
```

Disk (ya S3, ya slow NFS) 20 MB/s leta hai, read 400 MB/s deta hai. Farak `dst` ke buffer mein jama hota hai -> RSS chadhta hai -> OOM.

### Sahi (manual): pause/resume

```js
src.on('data', (chunk) => {
  if (!dst.write(chunk)) src.pause();    // bhar gaya -> padhna rok do
});
dst.on('drain', () => src.resume());     // khaali hua -> phir padho
```

### Sahi (asli tareeka): `pipeline`

```js
const { pipeline } = require('node:stream/promises');

await pipeline(
  fs.createReadStream('export.csv'),
  zlib.createGzip(),
  fs.createWriteStream('export.csv.gz')
);
// memory: do-teen highWaterMark buffers, bas
```

`pipe` aur `pipeline` **khud** pause/resume karte hain. Backpressure manually likhne ki zaroorat hi nahi -- isliye production code mein hamesha yahi.

## 5. `pipeline` Kyun, `.pipe()` Chain Kyun Nahi

`.pipe()` **errors forward nahi karta** aur fail hone par **upstream destroy nahi karta**.

```js
// BUG: gzip error aaya to readStream khula reh gaya -> fd leak
src.pipe(gzip).pipe(dst);
```

Agar `dst` fail hua (disk full), `src` ka file descriptor khula rehta hai. Ek request par ye dikhta nahi; 10,000 requests baad `EMFILE: too many open files` aata hai -- aur stack trace upload code ki taraf ishaara bhi nahi karega.

`pipeline` guarantee deta hai:
- koi bhi stream error ho -> **sab** streams destroy, saare fds band.
- promise version `await` hota hai, to `try/catch` aur HTTP error handling natural hai.

```js
app.get('/export', async (req, res) => {
  try {
    await pipeline(db.queryStream(sql), toCsv(), res);   // client disconnect bhi handle
  } catch (err) {
    req.log.error({ err }, 'export failed');
    if (!res.headersSent) res.status(500).end();         // headers ja chuke to bas socket band
  }
});
```

Note: streaming response mein **headers pehle** chale jaate hain. Beech mein error aaya to aap status code badal nahi sakte -- isliye `headersSent` check zaroori hai.

## 6. Pattern 1: Line-By-Line Transform

CSV ko line-wise process karna, poori file memory mein lae bina:

```ts
import { Transform, TransformCallback } from 'node:stream';

class LineSplitter extends Transform {
  private tail = '';
  constructor() { super({ readableObjectMode: true }); }   // bahar objects/strings

  _transform(chunk: Buffer, _enc: string, cb: TransformCallback) {
    const parts = (this.tail + chunk.toString('utf8')).split('\n');
    this.tail = parts.pop() ?? '';        // aakhri tukda adhoori line ho sakti hai
    for (const line of parts) this.push(line);
    cb();
  }
  _flush(cb: TransformCallback) {         // stream khatam -- bacha hua tail bhejo
    if (this.tail) this.push(this.tail);
    cb();
  }
}
```

Do cheezein jo log bhoolte hain:
1. **`tail`** -- chunk boundary line ke beech mein kat sakti hai. Isko sambhalna hi pure code ka core hai (same problem multi-byte characters ke saath -- [[142-buffers-and-binary-data]] mein `StringDecoder`).
2. **`_flush`** -- aakhri line ka `\n` nahi hota; `_flush` ke bina wo line chup-chaap gayab ho jaati hai.

## 7. Pattern 2: DB Result Set -> CSV Response (Array Banaye Bina)

Ye sabse common real bug hai: 5 lakh rows ka report.

```js
// BUG: 500k rows ka array, phir ek bada string -- do baar memory
const rows = await pg.query('SELECT * FROM orders WHERE created_at > $1', [from]);
res.send(rows.map(toCsvLine).join('\n'));
```

Streaming version -- memory rows ki ginti se independent:

```js
const QueryStream = require('pg-query-stream');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');

app.get('/orders.csv', async (req, res) => {
  const client = await pool.connect();
  try {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=orders.csv');

    // batchSize: cursor se 1000 rows ek baar -- poora result set nahi
    const query = new QueryStream('SELECT id, total, created_at FROM orders', [], { batchSize: 1000 });
    const toCsv = new Transform({
      objectMode: true,
      transform(row, _e, cb) { cb(null, `${row.id},${row.total},${row.created_at}\n`); },
    });

    await pipeline(client.query(query), toCsv, res);
  } finally {
    client.release();                        // pool connection wapas, hamesha
  }
});
```

Asli mechanism: `res` (socket) dheema hai -> backpressure gzip/transform se hoke **DB cursor tak** pahunchta hai -> Postgres se agli batch tabhi maangi jaati hai jab client ne pichhli consume kar li. Poora chain khud ko regulate karta hai.

## 8. Pattern 3: `Readable.from` Aur `for await`

Koi bhi async iterable ko stream bana dena:

```js
const { Readable } = require('node:stream');

async function* paginate(cursor = null) {           // API pagination
  do {
    const page = await api.list({ cursor, limit: 100 });
    for (const item of page.items) yield JSON.stringify(item) + '\n';
    cursor = page.nextCursor;
  } while (cursor);
}

await pipeline(Readable.from(paginate()), fs.createWriteStream('items.ndjson'));
```

Aur ulta -- stream ko loop ki tarah padhna:

```js
for await (const line of lineStream) {      // backpressure automatic
  await handle(line);                       // jitna slow await, utna slow read
}
```

`for await` ki khoobi: loop body `await` karti hai, to Readable apne aap paused rehta hai. Readable side ka backpressure **free** mil jaata hai. Error handling bhi normal `try/catch` -- isliye naya code likhte waqt `on('data')` se behtar hai. Dhyan: loop se `break` karne par stream destroy ho jaata hai -- jo aksar aap chahte bhi hain.

## 9. Production Reality

- **`highWaterMark` tune karo, blindly nahi.** Default 64 KB (file) / 16 KB (socket). Bada karne se throughput thoda badhta hai par per-connection memory bhi -- 5,000 connections x 1 MB = 5 GB.
- **Object mode mein `highWaterMark` = object count** (default 16), bytes nahi. 16 bade objects bhi GB ban sakte hain.
- **Client disconnect**: `res` par `'close'`/`'error'` aata hai; `pipeline` upstream DB cursor destroy kar dega. Iske bina abandoned queries DB par chalti rehti hain.
- **Timeouts**: slow consumer streaming response ko ghanton khula rakh sakta hai. Idle timeout rakho.
- **Monitoring**: `process.memoryUsage().rss` streaming endpoints par flat hona chahiye, request size ke saath proportional nahi. Yahi aapka test hai.
- **Gzip CPU**: `createGzip` CPU kharch karta hai; bahut concurrent streams par ye event loop dabata hai ([[58-less-traffic-more-cpu]] jaisa pattern).

## 10. Trade-offs

| Streaming | Buffering |
|---|---|
| Memory constant | Memory input ke saath badhti hai |
| Pehla byte jaldi (TTFB achha) | Pehla byte poora kaam hone ke baad |
| Beech mein error -> status code badla nahi ja sakta | Error -> clean 500 bhej sakte ho |
| Code zyada (chunk boundaries, flush) | Code 2 line |
| Random access nahi -- sirf aage | Poora data haath mein, kuch bhi karo |

Chhoti, bounded cheez (10 KB JSON, 100 rows) ke liye streaming **overengineering** hai. Rule: agar size **user input se** badh sakti hai, stream karo.

## 11. Common Galtiyan

- `write()` ka return value ignore karna -- "kaam kar raha hai" par memory chupchap chadh rahi hai.
- `.pipe()` chain par error handler na lagana -> fd leak, `EMFILE`.
- Transform mein `cb()` call bhool jaana -> stream hamesha ke liye hang (koi error nahi, bas chup).
- `_flush` na likhna -> aakhri adhoora chunk gayab.
- Bade upload ko `express.json()`/`multer` memory storage se guzaarna -- parser poora body buffer kar leta hai, stream ka faida khatam ([[48-huge-json-payloads]]).
- Streaming response par pehle `res.status(500)` bhejne ki koshish jab headers already ja chuke.

## 🧠 Remember

> Stream ka matlab hai "poora data memory mein mat lao" aur backpressure ka matlab hai "dheema consumer tez producer ko rok sake" -- `write()` ka `false` wahi brake hai, aur `stream.pipeline` us brake ko plus error cleanup ko aapke liye handle kar deta hai, isliye production mein `.pipe()` chain ki jagah hamesha `pipeline`.

## Quick Self-Test

1. `src.on('data', c => dst.write(c))` crash nahi karta par memory chadhti hai -- exactly kahan jama ho raha hai?
2. `.pipe()` chain mein ek stream fail hone par kaunsa resource leak hota hai, aur wo error kis exception ke roop mein hafton baad dikhta hai?
3. CSV ko line-wise parse karne wale Transform mein `tail` variable aur `_flush` kyun chahiye?
4. DB cursor -> CSV -> HTTP response chain mein slow client Postgres ki query ko dheema kaise karta hai?
5. Object mode mein `highWaterMark: 16` ka matlab bytes hai ya objects -- aur ye kaise OOM de sakta hai?
