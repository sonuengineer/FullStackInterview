# LLD: File Upload Client Design (Multipart Aur Resume)

> **Scope:** ye **client-side class design** hai. Server/storage ka side -- presigned URLs, S3 multipart, status tracking, memory -- [[87-2gb-upload-direct-to-s3]], [[49-large-file-upload-with-status]] aur [[64-500mb-video-upload-memory]] mein hai. Interview mein dono alag sawaal hain.

## 1. Kahani: 1.8 GB Par 94% Pe Fail

Aapke app mein users video upload karte hain. Code ek line ka hai:

```ts
await fetch('/upload', { method: 'POST', body: file });   // 1.8 GB ek request mein
```

Office WiFi par kaam karta hai. User ke 4G par: 11 minute chalta hai, 94% par network blip aata hai, aur **poora upload shuru se** dobara. Teesri koshish ke baad user app uninstall kar deta hai. Upar se: progress bar nahi hai, cancel button kaam nahi karta, aur server par kabhi-kabhi file **corrupt** mil jaati hai -- pata nahi kaunsa byte gira.

Ek request = **ek atomic failure unit**. 1.8 GB ko ek failure unit banana hi design bug hai.

## 2. Mental Model

> File ko **chunks** mein todo. Har chunk apna retry unit hai. Konsa chunk pass hua ye **session** yaad rakhta hai. Resume = jo pass ho gaye unhe skip karo.

```
File (1.8 GB)
  -> split into N parts (8 MB each = 225 parts)
  -> upload 4 at a time (bounded concurrency)
  -> part fail -> wahi part retry (poori file nahi)
  -> app band ho gaya -> session se resume, 220 parts skip
  -> complete -> server parts jodta hai -> checksum verify
```

## 3. Chunk Size Kaise Chunein?

| Chunk size | Problem |
|---|---|
| 256 KB | 1.8 GB = 7200 requests. Per-request overhead (TLS, headers, server round trip) hi bottleneck. |
| 8 MB | Sweet spot: ~225 parts, retry sasta, parallelism achha |
| 200 MB | Ek retry = 200 MB dobara. Aur memory mein ek part bhi bhaari. |

Rules jo practice se aate hain:
- **5 MB - 16 MB** default rakho (S3 ka minimum part size 5 MB hai, aakhri part exempt).
- **Max 10,000 parts** (S3 limit) -- isliye bade file par size scale karo: `chunkSize = max(8MB, ceil(fileSize / 9000))`.
- Mobile/slow network par chhota (5 MB), fast wired par bada (16-32 MB).

```ts
function pickChunkSize(fileSize: number, min = 8 * 1024 * 1024, maxParts = 9_000) {
  return Math.max(min, Math.ceil(fileSize / maxParts));
}
```

## 4. UploadSession: Jo Yaad Rakhta Hai

```ts
export interface PartState { readonly index: number; etag?: string; done: boolean; }

export interface UploadSessionSnapshot {   // localStorage / IndexedDB mein persist hota hai
  readonly uploadId: string;               // server/S3 ka multipart upload id
  readonly fileKey: string;                // name + size + lastModified ka hash
  readonly chunkSize: number;
  readonly parts: PartState[];
}

export class UploadSession extends EventEmitter {
  private readonly parts: PartState[];
  private uploaded = 0;                                      // bytes
  private readonly controller = new AbortController();

  constructor(
    private readonly file: Blob,
    private readonly api: UploadApi,                         // inject -> testable
    private readonly chunkSize: number,
    private readonly concurrency = 4,
    private readonly uploadId: string,
    resumeFrom?: UploadSessionSnapshot,
  ) {
    super();
    const total = Math.ceil(file.size / chunkSize);
    this.parts = resumeFrom?.parts ?? Array.from({ length: total },
      (_, i) => ({ index: i, done: false }));
    this.uploaded = this.parts.filter((p) => p.done).length * chunkSize;
  }

  snapshot(): UploadSessionSnapshot { /* persist ke liye */ }
  async start(): Promise<{ key: string }> { /* Section 5 */ }
  cancel(reason = 'user cancelled') { this.controller.abort(reason); }
  private sliceOf(index: number): Blob {
    return this.file.slice(index * this.chunkSize, Math.min(this.file.size, (index + 1) * this.chunkSize));
  }
}
```

Dhyan do do cheezein: `api` **inject** hua hai (test mein fake), aur state `parts[]` hai -- *"kahan tak pahuncha"* nahi. Sirf "kahan tak pahuncha" rakhna galat hai kyunki parallel upload mein part 7 part 5 se pehle khatam ho sakta hai.

## 5. Bounded Concurrency: 4, 400 Nahi

Saare 225 parts ek saath `Promise.all` mein daal dena tempting hai. Phir: browser ka 6-connection-per-host limit, 225 x 8 MB = 1.8 GB **memory** mein, aur mobile radio choke. Ek chhota semaphore kaafi hai:

```ts
async start() {
  const pending = this.parts.filter((p) => !p.done).map((p) => p.index);
  let cursor = 0;

  // N "workers" -- har worker queue se agla index uthata hai. Yahi bounded concurrency hai.
  const worker = async () => {
    while (cursor < pending.length) {
      if (this.controller.signal.aborted) return;
      const index = pending[cursor++];
      await this.uploadPart(index);
    }
  };
  await Promise.all(Array.from({ length: this.concurrency }, worker));

  if (this.controller.signal.aborted) { await this.api.abort(this.uploadId); throw new Error('aborted'); }
  return this.api.complete(this.uploadId, this.parts.map((p) => ({ index: p.index, etag: p.etag! })));
}
```

Library chahiye to `p-limit` wahi kaam karta hai:

```ts
const limit = pLimit(4);
await Promise.all(pending.map((i) => limit(() => this.uploadPart(i))));
```

## 6. uploadPart: Retry, Progress, Abort, Checksum

```ts
private async uploadPart(index: number): Promise<void> {
  const blob = this.sliceOf(index);
  const md5 = await md5Base64(blob);                    // per-part integrity
  const policy = { maxAttempts: 4, baseMs: 500, maxMs: 8_000 };

  for (let attempt = 1; ; attempt++) {
    try {
      const url = await this.api.presignPart(this.uploadId, index);   // short-lived URL
      const res = await fetch(url, {
        method: 'PUT',
        body: blob,
        headers: { 'content-md5': md5 },
        signal: this.controller.signal,                  // cancel yahan pahunchta hai
      });
      if (!res.ok) throw new HttpError(res.status);

      const part = this.parts[index];
      part.etag = res.headers.get('etag') ?? undefined;
      part.done = true;
      this.uploaded += blob.size;
      this.emit('progress', { uploaded: this.uploaded, total: this.file.size,
        percent: Math.floor((this.uploaded / this.file.size) * 100) });
      this.emit('snapshot', this.snapshot());            // caller persist kare
      return;
    } catch (err) {
      if (this.controller.signal.aborted) throw err;     // cancel = retry nahi
      const retryable = err instanceof HttpError ? err.status >= 500 || err.status === 429
                                                  : true;             // network error
      if (!retryable || attempt === policy.maxAttempts) throw err;
      const cap = Math.min(policy.maxMs, policy.baseMs * 2 ** (attempt - 1));
      await sleep(Math.random() * cap);                  // backoff + jitter
    }
  }
}
```

Teen cheezein yahan jaanboojh kar hain:

- **Per-part retry, whole-file retry nahi.** Ek part fail = 8 MB dobara, 1.8 GB nahi. Whole-file retry sirf tab chahiye jab `complete` fail ho ya file hi badal jaaye.
- **`content-md5` per part.** Server har part verify karta hai, aur `complete` par file ka overall checksum match karta hai. Bina iske "silently corrupt file" wala bug months tak chhupa rehta hai.
- **Ek hi `AbortController`** poore session ke liye: `cancel()` saare in-flight parts ko ek saath rok deta hai, aur `signal.aborted` ki wajah se retry loop retry nahi karta. Phir `api.abort(uploadId)` se S3 ke orphan parts clean hote hain -- warna wo **storage ka bill** bante rehte hain.

## 7. Resume Actually Kaise Hota Hai

```ts
const key = await fileKey(file);                 // name + size + lastModified (+ sample hash)
const saved = await store.get(key);              // IndexedDB
const session = saved
  ? new UploadSession(file, api, saved.chunkSize, 4, saved.uploadId, saved)
  : new UploadSession(file, api, pickChunkSize(file.size), 4, await api.initiate(file.name));

session.on('snapshot', (s) => store.put(key, s));
session.on('progress', (p) => setBar(p.percent));
await session.start();
```

Do zaroori baatein:
- `fileKey` mein **size aur lastModified** daalo. Sirf naam par match karoge to user ne file edit ki to aap aadhi purani aadhi nayi file jod denge.
- Server se bhi **`listParts(uploadId)`** poochho. Client ka snapshot jhooth bol sakta hai (browser crash, do tabs); server ki list hi source of truth hai.
- Session ka TTL rakho (S3 par lifecycle rule se incomplete multipart uploads 7 din mein delete).

## 8. Honest Note: Production Mein Aap Ye Nahi Likhte

Real project mein aap `@aws-sdk/lib-storage` ka `Upload` (ya tus/Uppy, GCS resumable) use karte hain -- ye sab already karta hai: chunking, concurrency, retry, abort, progress events.

To interview mein value kya hai? **Yahi samjhana ki SDK aapke liye kya kar raha hai.** Jo candidate kehta hai *"main `lib-storage` use karunga"* aur ruk jaata hai, wo fail karta hai. Jo kehta hai *"`lib-storage` use karunga -- wo part size chunta hai, `queueSize` se concurrency bound karta hai, per-part retry karta hai, `abort()` par incomplete multipart clean karta hai; main sirf resume ke liye uploadId persist karunga aur server-side `listParts` se reconcile karunga"* -- wo pass karta hai. Build-vs-rent ki wahi soch [[46-build-vs-rent-infrastructure]] mein hai.

## 9. Trade-offs Aur Galtiyan

- **Chhota chunk** = zyada requests, zyada overhead. **Bada chunk** = mehnga retry, zyada memory. Fixed 8 MB galat nahi, par network-aware adaptive size extra complexity hai -- pehle fixed se shuru karo.
- **Zyada concurrency** = tez, par user ka baaki internet bhi khaa jaata hai aur mobile par throughput *girta* hai. 3-6 practical range hai.
- **Client-side resume** sirf tab kaam karta hai jab user wahi device/browser use kare. Cross-device resume ke liye uploadId server par user ke saath store karo.
- Galtiyan: `file.arrayBuffer()` karke poori file memory mein lena (mobile tab crash); progress ko *bheje* bytes par dikhana *confirm* ke bajaye (bar 100% par atak jaata hai); cancel par `api.abort` na karna (orphan parts ka bill); `parts[]` ke bajaye sirf "offset" rakhna (parallel upload mein galat); `etag` save na karna (`complete` call reject ho jaayega).

## 🧠 Remember

> Ek badi file ko ek request bhejna matlab ek failure par sab dobara. Isliye: **file ko chunks mein todo, session ko batane do kaunsa part done hai, bounded concurrency (4) se bhejo, retry per-part karo jitter ke saath, progress events se nikalo, cancel ek `AbortController` se karo, aur checksum se verify karo** -- aur asli project mein ye sab SDK ka managed uploader karta hai, bas aapko pata hona chahiye ki wo kya kar raha hai.

## Quick Self-Test

1. 256 KB chunk aur 200 MB chunk -- dono kis wajah se bure hain?
2. Session mein "kitne bytes ho gaye" ke bajaye `parts[]` array kyun rakhte hain?
3. Per-part retry whole-file retry se kaise sasta hai, aur whole-file retry kab zaroori hai?
4. Cancel par `api.abort(uploadId)` call karna kyun zaroori hai?
5. Client ka resume snapshot kab jhooth bolta hai, aur usse kaise reconcile karoge?
6. Resume ke liye file ka key sirf filename par kyun nahi ban sakta?
