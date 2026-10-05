# Garbage Collection Aur Memory Node Mein

> **Connects to**: [[22-nodejs-memory-leak-debugging]] (leak dhoondhne ka step-by-step process), [[93-cpu-spike-every-night-217am]] (GC pauses CPU graph mein kaise dikhte hain), [[64-500mb-video-upload-memory]] (bade buffers aur memory) aur [[119-lld-lru-cache]] (bounded cache ka design). | [[146-eventemitter-and-listener-leaks]] (listener leaks)

## 1. Kahani: "Memory 300 MB Se 1.9 GB, Phir Restart"

Ek Node API hai. Deploy ke baad RSS 300 MB. 6 ghante baad 900 MB. 14 ghante baad `OOMKilled`, pod restart, aur wahi curve dobara.

Pehli reaction team ki: **"heap chhota hai, badha do."**

```
node --max-old-space-size=4096 server.js
```

Ab crash 14 ghante ki jagah **38 ghante** baad hota hai. Leak waisa hi hai -- bas baalti badi ho gayi. Aur crash ab zyada bura hai: 4 GB heap par GC pause lamba hota hai, to marne se pehle latency bhi kharab ho jaati hai.

Ye lesson samjhane ke liye hai ki **GC kya karta hai**, isliye leak kya hota hai, aur usko dhoondhne ka sahi kram kya hai.

## 2. V8 Memory Ka Layout (Interview Jitna Deep)

```
+------------------------------------------------------+
|  V8 Heap  (--max-old-space-size isi par lagta hai)   |
|                                                      |
|  New Space (Young Gen)   | Old Space (Old Gen)       |
|  chhota: 1-16 MB         | bada: GBs                 |
|  "from" + "to" halves    | ek bada region            |
|  Scavenge (minor GC)     | Mark-Sweep-Compact (major)|
|  bahut tez, ms se kam    | dheema, 10-100+ ms        |
+------------------------------------------------------+
|  Bahar: Buffers, ArrayBuffers, sockets, zlib ("external") |
|  heap limit INME lagti hi nahi -- container limit lagti hai |
+------------------------------------------------------+
```

### Naya object kahan banta hai

Har naya object **New Space** mein banta hai. New Space do halves mein bata hai: `from` aur `to`.

**Scavenge (minor GC)**: jab `from` bhar jaata hai, V8 **sirf zinda** objects ko `to` mein copy karta hai aur `from` ko ek jhatke mein khaali maan leta hai. Lagat zinda objects ke proportional hai, kachre ke nahi.

Yahi poore mental model ki jad hai: typical request handler mein 99% objects (parsed JSON, temp strings, intermediate arrays) response ke baad **mar** jaate hain. Unko free karne ki lagat ~**zero** hai -- V8 ne unhe copy hi nahi kiya.

### Promotion aur major GC

Jo object **do scavenges survive** kar leta hai, V8 use **Old Space** mein promote kar deta hai. Logic: "jo ab tak zinda hai wo aage bhi zinda rahega."

**Mark-Sweep-Compact (major GC)** Old Space ke liye hai:
- **Mark**: roots (globals, stack, active closures, timer list, listener arrays) se chal kar jo reachable hai usko mark karo.
- **Sweep**: jo unmarked hai wo jagah free list mein.
- **Compact**: fragmentation hatane ke liye objects ko paas-paas sarka do.

Ye **poore** Old Space par chalta hai. 2 GB Old Space = ghanta bhar ka kachra scan karna. Isliye lamba pause.

> **Natija ek line mein**: short-lived objects **sasta** hain, long-lived objects **mehnga**. Request-scoped garbage se darne ki zaroorat nahi; module-level jama hone wale data se darne ki zaroorat hai.

(V8 ye kaam concurrent/incremental marking aur background threads se baantta hai, par major GC ke chhote "stop-the-world" hisse rehte hain -- wahi aapke p99 latency spikes hain.)

## 3. GC Language Mein "Leak" Kya Hota Hai

C mein leak = aapne `free()` call nahi kiya. JS mein `free()` hi nahi hai. To leak kya hai?

> **Leak = ek reference jo aap bhool gaye.** Memory free nahi hoti kyunki wo **technically reachable** hai -- GC bilkul sahi kaam kar raha hai, aapka code hi use reachable rakhe baitha hai.

Iska ek bahut practical matlab hai: **"GC ko force karo"** kabhi fix nahi hota. `global.gc()` / `--expose-gc` sirf proof ke liye hai (pause ke baad bhi `heapUsed` wapas na aaye -> confirmed leak). Reachable object ko koi GC free nahi karega.

## 4. Chaar Usual Culprits

### a) Module-level Map/array jo sirf badhta hai

```js
// LEAK: har naya userId ek permanent entry
const sessionCache = new Map();
app.use((req, res, next) => {
  sessionCache.set(req.user.id, { ...req.user, at: Date.now() });   // delete kahin nahi
  next();
});
```

Traffic ke saath badhta hai, aur kabhi ghatta nahi. 50k unique users/din = 50k entries/din, hamesha ke liye.

### b) Event listeners jo remove nahi hote

```js
// LEAK: har request par naya listener, closure res ko pakde rehta hai
app.get('/stream', (req, res) => {
  bus.on('update', (d) => res.write(JSON.stringify(d)));
});

// FIX: handler named rakho aur cleanup par hata do
app.get('/stream', (req, res) => {
  const onUpdate = (d) => res.write(JSON.stringify(d));
  bus.on('update', onUpdate);
  res.on('close', () => bus.off('update', onUpdate));
});
```

Listener **do** cheezein zinda rakhta hai: closure, aur us closure ke andar ka `res` -> socket -> buffers. Signal: logs mein `MaxListenersExceededWarning`.

### c) Closures jo bada object capture karte hain

```js
// LEAK: callback ko sirf id chahiye, par closure POORA 50 MB buffer pakad leta hai
function register(file) {                        // file.buffer = 50 MB
  cleanupTasks.push(() => notify(file.id));      // `file` poora captured
}

// FIX: sirf zaroori value nikaal lo -- 50 MB free ho sakta hai
function register(file) {
  const { id } = file;
  cleanupTasks.push(() => notify(id));
}
```

V8 closure ke liye ek context object rakhta hai; scope mein bada variable hai aur closure usko reference karta hai, to poora object zinda rehta hai.

### d) Timers jo clear nahi hote

```js
// LEAK: per-socket interval, disconnect ke baad bhi chalta rehta hai
io.on('connection', (socket) => {
  const t = setInterval(() => socket.emit('ping'), 5000);
  socket.on('disconnect', () => clearInterval(t));   // ye line hi fix hai
});
```

Timers GC roots hain -- active timer apna callback, aur callback ka poora closure, zinda rakhta hai. Yahi wo leak hai jo **traffic se independent** dikhta hai ([[22-nodejs-memory-leak-debugging]] ki kahani).

## 5. `--max-old-space-size` Kya Karta Hai (Aur Kya Nahi)

```
node --max-old-space-size=2048 server.js    # Old Space ceiling 2 GB
```

| Situation | Badhane ka asar |
|---|---|
| Genuinely bada **working set** (bada legit cache, bada dataset) | **sahi fix** |
| Leak | crash **postpone**, GC pause lamba, bas |

Ek cheez jo log galat karte hain: **container limit se kam rakho.** Heap limit `external` memory, Buffers, aur native allocations ko count nahi karti. Pod limit 2 GB aur `--max-old-space-size=2048` = pod OOM hoga **pehle** ki V8 apna major GC trigger kare. Thumb rule: heap limit ~ container limit ka 75%.

## 6. Diagnose Step 1: `process.memoryUsage()` Ko Padhna

```js
setInterval(() => {
  const m = process.memoryUsage();
  logger.info({
    rss: Math.round(m.rss / 1e6),
    heapTotal: Math.round(m.heapTotal / 1e6),
    heapUsed: Math.round(m.heapUsed / 1e6),
    external: Math.round(m.external / 1e6),
    arrayBuffers: Math.round(m.arrayBuffers / 1e6),
  }, 'mem_mb');
}, 30_000);
```

| Field | Matlab | Badhe to shaq |
|---|---|---|
| **rss** | OS ne process ko di gayi **total** physical memory (code, stack, heap, native, sab) | ye hi cheez container ko OOMKill karwaati hai |
| **heapTotal** | V8 ne OS se **reserve** ki hui heap | normal sawtooth, isko chase mat karo |
| **heapUsed** | heap ka actually **use** ho raha hissa | JS object leak (Map, closures, listeners) |
| **external** | V8 se jude **heap ke bahar** ke allocations -- Buffers, zlib, sockets | **Buffer/stream leak** |
| **arrayBuffers** | `external` ka wo hissa jo ArrayBuffer/Buffer hai | upload, crypto, binary code path |

Padhne ka tareeka:
- **Sawtooth `heapUsed`, flat baseline** -> normal. GC kaam kar raha hai.
- **`heapUsed` ka baseline har GC ke baad upar** -> JS-side leak. Heap snapshot lo.
- **`heapUsed` flat par `rss`/`external` chadh raha** -> **Buffer leak**, aur heap snapshot mein ye **dikhega hi nahi**. Dekho: streams jo destroy nahi hote, `Buffer.concat` loops, bade buffers ke `subarray` views cache mein ([[142-buffers-and-binary-data]]).

Ye aakhri point hi sabse mehnga debugging mistake hai: ghanton heap snapshot mein kuch nahi milta kyunki leak JS heap mein hi nahi hai.

## 7. Diagnose Step 2: Do Heap Snapshots Compare Karo

Ek snapshot bekaar hai -- usme sab kuch dikhega aur kuch pata nahi chalega. **Do** chahiye.

```js
// SIGUSR2 par snapshot -- prod-safe switch
const v8 = require('node:v8');
process.on('SIGUSR2', () => {
  const file = v8.writeHeapSnapshot();     // blocking, heap ke size ke barabar file
  logger.warn({ file }, 'heap snapshot written');
});
```

`kill -SIGUSR2 <pid>` se baseline lo, 1-2 ghante normal traffic chalne do, phir doosra lo. Chrome DevTools -> Memory -> dono `.heapsnapshot` load karo -> second select karo -> **Comparison** view, baseline ke against.

Dekhna kya hai:

| Column | Kya batata hai |
|---|---|
| **# Delta** | kitne objects **extra** bane (positive aur badhta = suspect) |
| **Size Delta** | un objects ne kitni memory li |
| **Retained Size** | is object ke marne par kitni memory **actually** free hogi |

**Retained size** hi asli number hai. Ek `Map` ka shallow size 100 bytes ho sakta hai par retained size 800 MB -- kyunki wo 800 MB ko zinda rakhe hui hai.

Phir us constructor par click karo aur **Retainers** panel dekho -- wo exact reference chain hai root se object tak: `(GC roots) -> global -> sessionCache -> Map -> entries`. Yahi aapka answer hai, line number ke saath.

Prod note: snapshot **stop-the-world** hai (GB heap = seconds ka freeze) aur disk par heap ke barabar file likhta hai. Ek instance ko load balancer se nikaal kar lo, ya staging par load replay karo.

## 8. Leaking Cache Aur Uska Bounded Fix

```js
// LEAK: unbounded. 100k products x 40 KB JSON = 4 GB.
const cache = new Map();
async function getProduct(id) {
  if (cache.has(id)) return cache.get(id);
  const p = await db.product.findById(id);
  cache.set(id, p);                      // eviction NAHI, TTL NAHI
  return p;
}
```

```ts
// FIX: bounded + TTL. Memory ab ek CEILING ke andar hai.
import { LRUCache } from 'lru-cache';

const cache = new LRUCache<string, Product>({
  max: 5_000,                            // entry cap
  maxSize: 200 * 1024 * 1024,            // byte cap -- entry sizes vary karti hain
  sizeCalculation: (p) => Buffer.byteLength(JSON.stringify(p)),
  ttl: 10 * 60 * 1000,                   // stale data ka bound (alag concern)
});

export async function getProduct(id: string): Promise<Product> {
  const hit = cache.get(id);
  if (hit) return hit;
  const p = await db.product.findById(id);
  cache.set(id, p);                      // 5001st entry par LRU evict karega
  return p;
}
```

LRU ka internal design -- HashMap + doubly linked list, O(1) get/put -- [[119-lld-lru-cache]] mein hai. Yahan point ek hai: **entry count se nahi, bytes se bound karo** jab entries ka size wildly different ho. 5,000 entries ka cap bekaar hai agar ek entry 40 KB hai aur doosri 4 MB.

Aur `WeakMap`/`WeakRef` ke chakkar mein padne se pehle socho ki cache **process ke bahar** (Redis) hona chahiye tha kya -- multi-pod setup mein in-process cache ki hit rate anyway kharab hoti hai.

## 9. Production Reality

- **GC spikes = latency spikes.** `--trace-gc` ya `perf_hooks` ke `gc` observer se major GC ki duration measure karo. 2 GB heap par 200 ms pause aapke p99 mein saaf dikhega -- aur ye "slow query" jaisa dikhta hai jabki DB ka koi dosh nahi ([[93-cpu-spike-every-night-217am]] wala "pattern pehchano" sabak).

```js
const { PerformanceObserver } = require('node:perf_hooks');
new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    if (e.duration > 50) logger.warn({ ms: e.duration, kind: e.detail?.kind }, 'long_gc');
  }
}).observe({ entryTypes: ['gc'] });
```

- **Alert `rss` par karo**, `heapUsed` par nahi. OOMKill `rss` dekhta hai.
- **Restart ek mitigation hai, fix nahi.** PM2/Kubernetes ka auto-restart symptom chhupa deta hai jabki leak waisa hi rehta hai.
- Jo **sahi** `heapUsed` metric alert karna hai: GC ke **baad** ka baseline, average nahi. Average sawtooth se smooth ho jaata hai.
- Request-scoped allocation se mat daro. "Object creation avoid karo" wali micro-optimization New Space ke saamne bekaar hai. Jo cheez rakhi jaa rahi hai usko dekho.

## 10. Common Galtiyan

- Leak par `--max-old-space-size` badhana aur use fix maanna.
- `global.gc()` call karke socha ki leak theek ho gaya -- reachable object GC nahi hota.
- Sirf ek heap snapshot lena -- compare bina kuch nahi milta.
- Buffer/stream leak ko JS heap snapshot mein dhoondhna (wo `external` mein hai, heap mein nahi).
- `heapTotal` ko leak ka proof maanna -- wo reserve hai, use nahi.
- Container limit ke **barabar** heap limit set karna -> V8 ko GC ka mauka milne se pehle pod OOM.
- Cache ko entry-count se bound karna jab entry sizes 1 KB se 5 MB tak hain.

## 🧠 Remember

> GC kabhi galti nahi karta -- leak ka matlab hai ek reference jo aap bhool gaye, isliye heap badhane se crash sirf **postpone** hota hai; `heapUsed` chadhe to JS-side leak (Map, listener, closure, timer) aur heap snapshots compare karke retainer chain pakdo, par `external`/`rss` chadhe aur `heapUsed` flat ho to leak **JS heap mein hi nahi** hai -- wo Buffer hai, aur snapshot usko dikhayega bhi nahi.

## Quick Self-Test

1. Scavenge aur Mark-Sweep-Compact mein kya farak hai, aur isse ye kyun nikalta hai ki short-lived objects sasta hain?
2. C ke leak aur JS ke leak mein conceptual farak kya hai -- aur isliye `global.gc()` kyun fix nahi karta?
3. `heapUsed` flat hai par `rss` 400 MB chadh gaya -- aap kahan dhoondhoge, aur heap snapshot kaam karega ya nahi?
4. `--max-old-space-size` ko container memory limit ke barabar set karne par kya galat hoga?
5. Heap snapshot comparison mein "Retained Size" kyun "Shallow Size" se zyada useful hai?
6. Cache ko `max: 5000` entries se bound kiya aur phir bhi OOM hua -- kya chhoot gaya?
