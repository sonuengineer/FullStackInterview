# Rate Limiter -- HLD + LLD (Part 6: Implement It -> Interview Answers -> Whiteboard -> Cheat Sheet)

> Is file mein prompt ke **Parts 26-30** hain: coding round mein "Implement a rate limiter" kaise solve karein, 30-second answer, 5-minute answer, whiteboard par diagram kis order mein banayein, aur poore Rate Limiter (Parts 1-5) ki final cheat sheet.
> Ye last file hai. Parts 1-5 mein humne design samjha (token bucket, Redis Lua, fallback, scaling); yahan hum usko **interview mein bolna, likhna aur draw karna** seekhenge.

---

## PART 26 -- Code Design Question: "Implement a rate limiter"

### Pehle samjho: ye system design round nahi hai

Rate limiter **sabse common coding-round question** hai (LeetCode/LLD rounds mein "Design Hit Counter", "Logger Rate Limiter", "Implement a rate limiter class"). Yahan interviewer Redis Cluster, Postgres rules, Envoy nahi dekhna chahta. Woh dekhna chahta hai:

- Tum **clarify** karte ho (per key? kaunsa algorithm? limit kya?) ya seedha typing?
- Tum **algorithm ka naam aur uska reason** bata sakte ho?
- Code **time ko sahi handle** karta hai (lazy refill, clock, floats)?
- **Memory bound** hai? Lakhon keys aayi toh kya?
- **Complexity** aur **concurrency** ka jawab hai?

Iska matlab: **ek file, in-memory `Map`, koi Redis nahi.** Lekin tum bologe ki "yahi algorithm production mein Redis Lua script ke andar chalta hai" -- Part 3 wala same logic.

> Connection: URL Shortener ke Part 26 mein bhi yahi pattern tha -- in-memory class, injectable clock `now`, phir "production mein storage badlega, interface nahi". Yahan bhi same.

### Step 1 -- Clarify (1-2 minute, typing se pehle)

> "Code likhne se pehle kuch cheezein confirm kar leta hoon."

| Question | Mera assumption (agar interviewer bole "you decide") |
|---|---|
| Limit **per key** hai (user / IP / API key) ya global? | Per key -- `tryConsume(key)` |
| Kaunsa algorithm? Burst allowed hai? | **Token bucket** -- burst up to `capacity`, phir steady `refillPerSec`. Comparison ke liye sliding window log bhi likh dunga |
| Limit aur window kya hai? | Constructor mein configurable, e.g. `login` rule: capacity 5, refill 5/60 per sec (5 per minute) |
| Har request ka cost same hai? | Default 1, optional `cost` (batch API = zyada tokens) |
| Reject par caller ko kya chahiye? | `allowed`, `remaining`, `retryAfterMs` -- taaki `429` + `Retry-After` header ban sake |
| Single process ya distributed? | Single process, in-memory. Distributed ke liye Redis Lua (bolunga, likhunga nahi) |
| Thread-safety? | Node single-threaded; `tryConsume` synchronous hai toh lock nahi chahiye |
| Keys unbounded ho sakti hain? | Haan (IPs) -- isliye `maxKeys` bound + idle sweep |

> Interview tip: "burst allowed hai?" ye ek question hi algorithm decide kar deta hai. Burst chahiye -> token bucket. Strict smooth output chahiye -> leaky bucket. Exact count chahiye -> sliding log.

### Step 2 -- Logic pehle bolo (code se pehle, Hinglish mein)

> "Main har key ke liye ek chhota object rakhunga: `{ tokens, lastRefillMs }`. Bas do numbers -- isliye memory O(1) per key.
>
> Refill ke liye koi timer nahi chalaunga -- lakhon keys ke liye lakhon timers pagalpan hai. Main **lazy refill** karunga: jab request aaye, tab hisaab lagaunga ki pichhli baar se kitna time guzra, `elapsed x refillPerSec` tokens add karunga, aur `capacity` par cap kar dunga.
>
> Phir agar `tokens >= cost` hai toh cost minus karke allow. Warna reject, aur `retryAfterMs = kami wale tokens / refill rate` -- yaani kitni der baad itne tokens ban jaayenge.
>
> Nayi key aaye toh bucket **full** se start hoga -- naya client burst kar sakta hai.
>
> Memory ke liye `Map` ko LRU jaisa use karunga: JS `Map` insertion order yaad rakhta hai, toh access par delete + set karke key ko end mein bhej dunga, aur limit cross hui toh sabse pehli (oldest) key hata dunga. Plus ek `sweepIdle()` -- jo bucket already full hai woh 'naye bucket' jaisa hi hai, usko delete karna safe hai.
>
> Clock ko inject karunga (`now: () => number`) taaki test mein time aage-peeche kar sakun bina `sleep` ke."

Ab code.

### Step 3 -- TypeScript code (single file, self-contained)

```ts
export interface ConsumeResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number; // 0 when allowed
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

const EPSILON = 1e-9; // float error absorb karne ke liye

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 100_000,
  ) {
    if (!(capacity > 0) || !(refillPerSec > 0)) {
      throw new RangeError('capacity and refillPerSec must be > 0');
    }
    if (!Number.isInteger(maxKeys) || maxKeys < 1) {
      throw new RangeError('maxKeys must be a positive integer');
    }
  }

  tryConsume(key: string, cost = 1): ConsumeResult {
    if (!Number.isFinite(cost) || cost <= 0) {
      throw new RangeError('cost must be a positive number');
    }
    if (cost > this.capacity) {
      throw new RangeError('cost > capacity: can never be allowed');
    }

    const nowMs = this.now();
    const bucket = this.getBucket(key, nowMs);
    this.refill(bucket, nowMs);

    if (bucket.tokens + EPSILON >= cost) {
      bucket.tokens = Math.max(0, bucket.tokens - cost);
      return { allowed: true, remaining: Math.floor(bucket.tokens + EPSILON), retryAfterMs: 0 };
    }

    const missing = cost - bucket.tokens;
    return {
      allowed: false,
      remaining: Math.floor(bucket.tokens + EPSILON),
      retryAfterMs: Math.ceil((missing * 1000) / this.refillPerSec - EPSILON),
    };
  }

  // Full bucket = "no bucket": delete karne se behaviour nahi badalta.
  sweepIdle(): number {
    const nowMs = this.now();
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      this.refill(bucket, nowMs);
      if (bucket.tokens + EPSILON >= this.capacity) {
        this.buckets.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.buckets.size;
  }

  private refill(bucket: Bucket, nowMs: number): void {
    const elapsedMs = Math.max(0, nowMs - bucket.lastRefillMs);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + (elapsedMs * this.refillPerSec) / 1000);
    bucket.lastRefillMs = Math.max(bucket.lastRefillMs, nowMs);
  }

  private getBucket(key: string, nowMs: number): Bucket {
    let bucket = this.buckets.get(key);
    if (bucket) {
      this.buckets.delete(key); // LRU: re-insert = "most recently used"
    } else {
      bucket = { tokens: this.capacity, lastRefillMs: nowMs };
      if (this.buckets.size >= this.maxKeys) {
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
    }
    this.buckets.set(key, bucket);
    return bucket;
  }
}

export class SlidingWindowLogLimiter {
  private readonly logs = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(limit) || limit < 1 || !(windowMs > 0)) {
      throw new RangeError('limit must be a positive integer and windowMs > 0');
    }
  }

  tryConsume(key: string): ConsumeResult {
    const nowMs = this.now();
    const log = this.logs.get(key) ?? [];
    const cutoff = nowMs - this.windowMs;

    let expired = 0;
    while (expired < log.length && log[expired] <= cutoff) expired++;
    if (expired > 0) log.splice(0, expired);

    if (log.length < this.limit) {
      log.push(nowMs);
      this.logs.set(key, log);
      return { allowed: true, remaining: this.limit - log.length, retryAfterMs: 0 };
    }
    this.logs.set(key, log);
    return { allowed: false, remaining: 0, retryAfterMs: log[0] + this.windowMs - nowMs };
  }
}
```

> Ye code `tsc --strict` (TypeScript 5, target ES2022) se bina error compile hota hai, aur neeche ka output actually run karke nikala gaya hai.

### Step 4 -- Line-by-line explanation

**Code Explanation -- types aur constant:**

- `interface ConsumeResult { allowed; remaining; retryAfterMs }` -- caller ko jo chahiye bas wahi. Production ke `RateLimitDecision` (Part 2) mein iske alawa `limit` (= capacity) aur `resetSec` bhi hain; woh middleware headers ke liye bana leta hai.
- `retryAfterMs: number; // 0 when allowed` -- spec wala same contract: allow par 0.
- `interface Bucket { tokens; lastRefillMs }` -- **poori state sirf 2 numbers.** Redis mein yahi `HSET key tokens .. ts ..` ke 2 fields hain.
- `const EPSILON = 1e-9` -- floating point ki chhoti galti absorb karne ke liye. Isko halke mein mat lo -- output section mein dikhega ki iske bina ek valid request reject hoti hai.

**Code Explanation -- `TokenBucketLimiter` constructor:**

- `private readonly buckets = new Map<string, Bucket>()` -- key -> bucket. `Map` isliye, plain object nahi: koi bhi string key safe (`__proto__` jaisa issue nahi), `size` O(1), aur **insertion order guaranteed** -- LRU isi par tika hai.
- `capacity` -- max burst (bucket kitna bhar sakta hai).
- `refillPerSec` -- steady rate. `login` rule ke liye `5 / 60` = ~0.0833 token/sec = har 12 second mein 1 token.
- `now: () => number = Date.now` -- **injectable clock.** Test mein `() => fakeNow` doge. Interviewer ko ye testability bahut pasand aati hai.
- `maxKeys = 100_000` -- memory ki upper limit. Default isliye taaki bhoolne par bhi process OOM na ho.
- `if (!(capacity > 0) || !(refillPerSec > 0))` -- `!(x > 0)` style jaan boojh ke: `NaN > 0` false hai, toh `NaN` bhi pakda jaata hai. `x <= 0` likhte toh `NaN` nikal jaata.
- `Number.isInteger(maxKeys)` -- `maxKeys = 2.5` jaisa config bug yahin fail ho.

**Code Explanation -- `tryConsume`:**

- `cost = 1` -- default ek request = ek token. Heavy endpoint (bulk export) ka cost 10 rakh sakte ho -- ye **cost-based limiting** hai (Part 4 security).
- `!Number.isFinite(cost) || cost <= 0` -> `RangeError` -- `cost = 0` ya negative diya toh bucket **bharne** lagta (minus of minus). `NaN`/`Infinity` bhi block.
- `if (cost > this.capacity) throw` -- ye request **kabhi bhi** allow nahi ho sakti, chahe jitna wait karo (bucket capacity se upar nahi bharta). Reject + `retryAfterMs` dena jhooth hota -- client wait karke phir fail hota. Isliye error: middleware isko 400/413 bana dega.
- `const nowMs = this.now();` -- time **ek hi baar** padho, poore function mein wahi use karo. Do jagah `Date.now()` karte toh dono alag ho sakte hain.
- `getBucket(key, nowMs)` -- mile toh LRU touch, na mile toh naya full bucket.
- `this.refill(bucket, nowMs)` -- **lazy refill**: jitna time guzra utne tokens add (neeche detail).
- `bucket.tokens + EPSILON >= cost` -- allow check. Epsilon float error ke liye.
- `bucket.tokens = Math.max(0, bucket.tokens - cost)` -- consume. `Math.max(0, ...)` isliye ki epsilon ki wajah se `0.9999999999999999 - 1` = `-1.1e-16` jaisa tiny negative na bache.
- `remaining: Math.floor(bucket.tokens + EPSILON)` -- header mein integer jaana chahiye (`RateLimit-Remaining: 2`), 2.73 nahi. Floor isliye ki 0.9 token ka matlab "abhi 0 requests bachi".
- `missing = cost - bucket.tokens` -- kitne tokens kam hain.
- `retryAfterMs: Math.ceil((missing * 1000) / this.refillPerSec - EPSILON)` -- `missing / refillPerSec` = seconds, `x 1000` = ms. **Ceil** isliye ki client thoda jaldi aaya toh phir 429 milega; thoda late safe hai. `- EPSILON` isliye ki `2000.0000000000002` ko 2001 na bana de. Ye wahi formula hai jo Lua mein hai: `math.ceil((cost - tokens) * 1000 / rate)`.

**Code Explanation -- `sweepIdle` aur `size`:**

- Core insight: **full bucket = no bucket.** Agar ek key ka bucket capacity tak bhar chuka hai, toh delete karke dobara banane par bhi woh full hi banega. Behaviour same, memory free.
- `for (const [key, bucket] of this.buckets)` -- JS `Map` iterate karte waqt delete karna safe hai (spec-defined).
- `this.refill(bucket, nowMs)` phir `tokens + EPSILON >= capacity` -> delete.
- Production mein ise `setInterval(() => limiter.sweepIdle(), 60_000).unref()` se chalate -- `unref()` taaki ye timer process ko band hone se na roke. Redis mein yahi kaam **`PEXPIRE`** karta hai (`capacity * 1000 / rate + 1000` ms, jaise `api-free` ke liye 61 second).
- `get size()` -- sirf tests/metrics ke liye.

**Code Explanation -- `refill` (dil of the algorithm):**

- `elapsedMs = Math.max(0, nowMs - bucket.lastRefillMs)` -- clock **peeche** gaya (NTP correction) toh elapsed negative hota aur tokens **ghat** jaate. `Math.max(0, ..)` usse bachata hai. Lua mein bhi same line hai: `math.max(0, now - ts)`.
- `Math.min(this.capacity, tokens + elapsedMs * refillPerSec / 1000)` -- time ke hisaab se tokens add, lekin capacity se zyada kabhi nahi. 1 ghante baad aaye client ko 300 tokens nahi, sirf 5 milenge. **Yahi burst ki limit hai.**
- `bucket.lastRefillMs = Math.max(bucket.lastRefillMs, nowMs)` -- timestamp kabhi peeche mat le jao. Agar clock 10 second peeche gaya aur hum `ts = now` kar dete, toh clock theek hone par wahi 10 second **dobara** gine jaate -> free tokens.

**Code Explanation -- `getBucket` (LRU):**

- `this.buckets.get(key)` -- O(1) average.
- Mila toh `this.buckets.delete(key)` -- phir neeche `set` karenge toh key `Map` ke **end** mein chali jaayegi = "most recently used". Ye 2-line LRU trick hai, alag linked list nahi chahiye.
- Nahi mila toh `{ tokens: this.capacity, lastRefillMs: nowMs }` -- naya client **full bucket** se start.
- `if (this.buckets.size >= this.maxKeys)` -- jagah nahi hai toh `this.buckets.keys().next().value` = **sabse purani** (least recently used) key, usko delete.
- `if (oldest !== undefined)` -- `--strict` mein `next().value` ka type `string | undefined` hai; TypeScript ko khush rakhna + safe.
- `this.buckets.set(key, bucket)` -- insert / re-insert.

**Code Explanation -- `SlidingWindowLogLimiter` (comparison ke liye):**

- `logs = new Map<string, number[]>()` -- har key ke liye **har allowed request ka timestamp**. Yahi iski memory problem hai: limit 1000 hai toh 1000 numbers per key.
- Constructor: `limit` integer >= 1, `windowMs > 0`.
- `cutoff = nowMs - this.windowMs` -- isse purane (ya barabar) timestamps window ke bahar hain.
- `while (log[expired] <= cutoff) expired++` + `log.splice(0, expired)` -- array sorted hai (time badhta hai), toh aage se purane hata do. Ek baar mein ek `splice`, har element ke liye `shift()` nahi.
- `if (log.length < this.limit)` -> `push(nowMs)` + allow. `remaining = limit - log.length`.
- Reject par `retryAfterMs = log[0] + windowMs - nowMs` -- sabse purana timestamp jab window se bahar niklega, tab ek slot khaalega. (`<= cutoff` ki wajah se exactly us moment par allow hota hai -- output mein t=10000 dekho.)
- Isme **boundary burst nahi** hota (fixed window mein window edge par 2x limit nikal jaati hai -- Part 3). Exact hai, lekin memory O(limit) per key.

### Step 5 -- Chalake dikhao (usage + real output)

```ts
import { TokenBucketLimiter, SlidingWindowLogLimiter, ConsumeResult } from './rate-limiter';

let fakeNow = 0;
const clock = () => fakeNow;
const show = (label: string, r: ConsumeResult) =>
  console.log(`${label.padEnd(24)} t=${String(fakeNow).padStart(6)}  allowed=${r.allowed}  remaining=${r.remaining}  retryAfterMs=${r.retryAfterMs}`);

// 'login' rule: capacity 5, refillPerSec 5/60 (1 token per 12 s)
const login = new TokenBucketLimiter(5, 5 / 60, clock);
const priya = '203.0.113.7:priya@example.com';

for (let i = 1; i <= 6; i++) show(`A${i} priya`, login.tryConsume(priya));
show('B  rahul (other key)', login.tryConsume('198.51.100.4:rahul@example.com'));
for (const t of [2_000, 4_000, 6_000, 8_000, 10_000]) {
  fakeNow = t; // har 2 s par retry
  show('C  priya retry', login.tryConsume(priya));
}
fakeNow = 12_000;
show('D  priya', login.tryConsume(priya));
show('E  priya', login.tryConsume(priya));
fakeNow = 600_000;
show('F  priya cost=3', login.tryConsume(priya, 3));
fakeNow = 590_000; // clock peeche gaya
show('G  priya (clock back)', login.tryConsume(priya));
for (const [label, cost] of [['H  cost=10', 10], ['I  cost=0', 0]] as const) {
  try {
    login.tryConsume(priya, cost);
  } catch (e) {
    console.log(`${label.padEnd(24)} -> ${(e as Error).message}`);
  }
}
fakeNow = 1_200_000;
console.log(`J  size before sweep = ${login.size}, removed = ${login.sweepIdle()}, size after = ${login.size}`);

const tiny = new TokenBucketLimiter(5, 1, clock, 2);
['k1', 'k2', 'k3'].forEach((k) => tiny.tryConsume(k));
console.log(`K  maxKeys=2 after 3 keys -> size = ${tiny.size}`);

// Sliding window log: 3 requests per 10 s
fakeNow = 0;
const log = new SlidingWindowLogLimiter(3, 10_000, clock);
for (const t of [0, 1_000, 2_000, 3_000, 10_000, 10_001]) {
  fakeNow = t;
  show('L  sliding log', log.tryConsume('ak_live_9f2c'));
}
```

**Actual output:**

```
A1 priya                 t=     0  allowed=true  remaining=4  retryAfterMs=0
A2 priya                 t=     0  allowed=true  remaining=3  retryAfterMs=0
A3 priya                 t=     0  allowed=true  remaining=2  retryAfterMs=0
A4 priya                 t=     0  allowed=true  remaining=1  retryAfterMs=0
A5 priya                 t=     0  allowed=true  remaining=0  retryAfterMs=0
A6 priya                 t=     0  allowed=false  remaining=0  retryAfterMs=12000
B  rahul (other key)     t=     0  allowed=true  remaining=4  retryAfterMs=0
C  priya retry           t=  2000  allowed=false  remaining=0  retryAfterMs=10000
C  priya retry           t=  4000  allowed=false  remaining=0  retryAfterMs=8000
C  priya retry           t=  6000  allowed=false  remaining=0  retryAfterMs=6000
C  priya retry           t=  8000  allowed=false  remaining=0  retryAfterMs=4000
C  priya retry           t= 10000  allowed=false  remaining=0  retryAfterMs=2000
D  priya                 t= 12000  allowed=true  remaining=0  retryAfterMs=0
E  priya                 t= 12000  allowed=false  remaining=0  retryAfterMs=12000
F  priya cost=3          t=600000  allowed=true  remaining=2  retryAfterMs=0
G  priya (clock back)    t=590000  allowed=true  remaining=1  retryAfterMs=0
H  cost=10               -> cost > capacity: can never be allowed
I  cost=0                -> cost must be a positive number
J  size before sweep = 2, removed = 2, size after = 0
K  maxKeys=2 after 3 keys -> size = 2
L  sliding log           t=     0  allowed=true  remaining=2  retryAfterMs=0
L  sliding log           t=  1000  allowed=true  remaining=1  retryAfterMs=0
L  sliding log           t=  2000  allowed=true  remaining=0  retryAfterMs=0
L  sliding log           t=  3000  allowed=false  remaining=0  retryAfterMs=7000
L  sliding log           t= 10000  allowed=true  remaining=0  retryAfterMs=0
L  sliding log           t= 10001  allowed=false  remaining=0  retryAfterMs=999
```

**Code Explanation -- output kya prove karta hai:**

- `let fakeNow = 0` + `const clock = () => fakeNow` -- fake clock. `fakeNow = 600_000` = "10 minute aage", bina wait kiye.
- `show(label, r)` -- ek line mein result print karne ka helper.
- `new TokenBucketLimiter(5, 5 / 60, clock)` -- exactly spec ka `login` rule: 5 attempts per minute per (IP + username). Key bhi spec wale format mein `203.0.113.7:priya@example.com` (Redis mein `rl:login:203.0.113.7:priya@example.com` hota).
- **A1-A5** -- full bucket se 5 ka burst allow, `remaining` 4 -> 0.
- **A6** -- 6th attempt reject, `retryAfterMs=12000` -- ek token 12 second mein banta hai (60 / 5).
- **B** -- `rahul` ki alag key, uska apna full bucket. Priya ke block hone se Rahul par koi asar nahi -- **per-key** limiting.
- **C** -- Priya har 2 second par retry karti rahi: `retryAfterMs` 10000 -> 8000 -> ... -> 2000. Har reject par bhi refill hota hai, token bante rehte hain.
- **D** -- t=12000 par **allow**. Yahan ek chhupi hui bug thi: 6 baar `2000 x (5/60) / 1000` jodne par JS mein **`0.9999999999999999`** aata hai, `1` nahi. Humne `EPSILON = 0` karke bhi chalaya -- tab D ka output `allowed=false retryAfterMs=1` aaya aur C ki values `10001, 8001` jaisi aayin. Yaani **epsilon ke bina ek bilkul valid request reject hoti.**
- **E** -- D ke turant baad phir 12 second wait.
- **F** -- 10 minute baad aayi: bucket 5 par cap (~49 nahi), cost 3 -> remaining 2. Cost-based limiting.
- **G** -- clock 10 second **peeche** gaya: koi crash nahi, koi extra token nahi (2 -> 1). `Math.max` wali dono lines ka kaam.
- **H / I** -- `cost=10 > capacity 5` aur `cost=0` -- dono `RangeError`.
- **J** -- 20 minute baad dono buckets full -> `sweepIdle` ne dono hata diye, size 0. Memory wapas.
- **K** -- `maxKeys=2` wale limiter mein 3 keys daali, size 2 hi raha -- LRU ne sabse purani (`k1`) nikaal di.
- **L** -- sliding log (3 per 10 s): 3 allow, t=3000 reject with `retryAfterMs=7000`; t=10000 par pehla timestamp (0) window se bahar -> allow; t=10001 par phir full, `999` ms baad slot khulega.

### Step 6 -- Edge cases (interviewer zaroor poochega)

| Edge case | Humara code kya karta hai | Production (Parts 2-4) mein |
|---|---|---|
| `cost > capacity` | `RangeError` -- kabhi allow ho hi nahi sakta, jhootha `retryAfter` nahi dete | Middleware 400/413; rule validation ensure kare ki max cost <= capacity |
| `cost` 0 / negative / `NaN` | `RangeError` -- warna bucket ulta bharta | Request validation (zod) |
| Clock peeche gaya (NTP) | `Math.max(0, elapsed)` + `lastRefillMs` kabhi peeche nahi | Lua **Redis `TIME`** use karta hai -- saare Node servers ke liye ek hi clock, clock skew khatam |
| Float precision (`0.9999999999999999`) | `EPSILON = 1e-9` compare, floor, ceil mein | Lua bhi doubles use karta hai; same concern (dekho neeche note) |
| Nayi key | Full bucket se start (burst allowed) | Lua: `tokens == nil -> capacity` |
| Bahut saari keys (IP scan, IPv6) | `maxKeys` LRU + `sweepIdle` | Redis `PEXPIRE` idle keys hataata hai; ~150 B/key x 10M = ~1.5 GB; IPv6 ko /64 par group karo |
| LRU eviction ka side effect | Evict hui key dobara aayi toh **full bucket** -> thoda over-admission | Isliye `maxKeys` generous rakho; Redis mein `maxmemory-policy` aisi rakho ki limiter keys randomly evict na hon (Part 3) |
| Long idle client | Capacity par cap -- 1 ghante baad bhi sirf 5 ka burst | Same (`math.min(capacity, ...)`) |
| Concurrency (ek process) | **Safe.** `tryConsume` synchronous hai, koi `await` nahi -- event loop isko beech mein nahi todta, toh read-modify-write atomic hai. Lock nahi chahiye | -- |
| Concurrency (multi-instance) | **Broken.** Har Node instance ka apna `Map` -> 10 instances = 10x limit | Shared **Redis + Lua script** (spec wala canonical `tokenBucket` script): `HMGET` -> math -> `HSET` + `PEXPIRE` ek atomic step. GET-then-SET JS mein karte toh 2 requests dono "1 token bacha" padh ke dono allow kar dete |
| Worker threads / cluster mode | Har worker ka alag `Map` -- same multi-instance problem | Redis |
| Process restart | Saare buckets gayab -> sabko full bucket (limits briefly reset) | Redis mein bhi counters ephemeral hain -- ye **acceptable** hai, isliye Postgres mein nahi rakhte |
| Redis down (production) | -- | `MemoryTokenBucketStore` (yahi class jaisa) fallback, capacity aur refill **divided by number of instances** |

> Interview line: "Ye in-memory version single process ke liye correct hai kyunki Node ka event loop synchronous code ko interleave nahi karta. Multiple instances par main yahi algorithm Redis Lua script mein le jaunga -- `HMGET`, refill math, `HSET`, `PEXPIRE` -- ek atomic script, aur time Redis `TIME` se, taaki clock skew na ho. Aur Redis down hua toh yahi class fallback banegi, capacity ko instances ki count se divide karke."

### Step 7 -- Complexity

Pehle symbols fix karo:

- **K** = distinct keys (clients) memory mein
- **L** = sliding log ki `limit` (per window max requests)

| Operation | Time | Kyun |
|---|---|---|
| `TokenBucketLimiter.tryConsume` | **O(1)** average | Ek `Map` get + delete + set, thoda arithmetic. Koi loop nahi, koi timer nahi (lazy refill) |
| LRU eviction | **O(1)** | `keys().next()` sirf pehli key deta hai |
| `sweepIdle` | **O(K)** | Saari keys scan -- isliye background mein har minute, request path par nahi |
| `SlidingWindowLogLimiter.tryConsume` | **O(L)** worst case | Expired timestamps count karna + `splice` array shift karta hai. Amortized kam, lekin burst ke baad ek call mein L tak kaam |

| Structure | Space | Kyun |
|---|---|---|
| Token bucket | **O(K)** | Har key ke liye sirf 2 numbers. `maxKeys` se bounded |
| Sliding window log | **O(K x L)** | Har key ke liye L timestamps. Spec numbers par: 10M keys x ~100 entries x ~60 B = **~60 GB** -- rejected |

> Interview line: "Token bucket O(1) time aur O(1) space per key hai -- sirf tokens aur last timestamp. Sliding log exact hai lekin O(limit) per key memory leta hai; hamare 10 million clients par woh roughly 60 GB ho jaata, jabki token bucket ~1.5 GB. Isliye production mein token bucket."

---

## PART 27 -- 30-Second Answer

> "At a high level, I would use ek token bucket rate limiter jo har Node.js instance mein Express middleware ki tarah chalta hai, aur state ek shared Redis Cluster mein rakhta hai -- taaki limit saare instances par global ho. Har request par ek atomic Lua script chalti hai jo Redis ki `TIME` se refill karti hai aur token consume karti hai -- ek round trip, koi race nahi, koi clock skew nahi. Rules jaise free 100 per minute, pro 1000 per minute, login 5 per minute, Postgres mein hain aur har 30 second memory mein refresh hote hain. Reject par 429 with `Retry-After` aur `RateLimit` headers. Peak ~100K checks per second ke liye 3 Redis primaries. Aur Redis down ho toh fail-open with local in-memory fallback -- availability over strictness."

(Bolne mein ~40 seconds. Algorithm, 3 components, 1 number, 1 failure decision -- bas.)

---

## PART 28 -- 5-Minute Interview Answer (natural Hinglish)

> Ise ratna nahi hai. Har minute ka **goal** yaad rakho; words apne aap aayenge. Beech beech mein check-in: "Is this direction okay?"

### 0:00 - 0:45 -- Requirements clarify karo

"Main pehle requirements clarify karunga. Kisko limit kar rahe hain -- API key wale customers, logged-in users, ya anonymous IPs? ... Theek hai, teeno. Aur limits plan ke hisaab se alag hongi -- free 100 per minute, pro 1000 per minute, anonymous 60 per minute per IP, aur login par strict 5 attempts per minute per IP plus username, brute force rokne ke liye.

Limit **global** chahiye na, per server nahi? ... Haan. Toh ek shared state chahiye.

Non-functional mein mere liye teen cheezein important hain: latency -- limiter har request ke raaste mein hai, toh p99 par 2 ms se zyada add nahi karna. Availability -- limiter gira toh poori API nahi girni chahiye. Aur accuracy -- **exact nahi, approximately sahi** chalega; 100 ki jagah 102 nikal gaye toh koi baat nahi."

### 0:45 - 1:30 -- Scale estimate

"Maan lete hain 2 billion API requests per day. Toh 2 billion by 86,400 -- roughly 23K per second average, peak 4x yaani ~93K, round karke **100K checks per second**. Clients -- API keys, users, IPs -- 10 million per day.

Ek important insight: ye system **read-heavy nahi hai.** Har check ek read plus ek write hai -- counter update. Toh URL shortener jaisa 'cache laga do' yahan kaam nahi karega.

Memory -- ek bucket ~150 bytes, 10 million keys -- ~1.5 GB. Toh memory problem nahi hai; **throughput** problem hai."

### 1:30 - 2:30 -- Architecture + request flow

"Initially main simple architecture rakhunga. Client, load balancer, stateless Node.js instances, aur har instance mein ek `rateLimit` middleware. Middleware cheap API-key identification ke baad aur heavy auth ya business logic se pehle chalega -- taaki reject hone wali request sasti pade.

Flow: request aayi, middleware ne identity nikaali -- API key, user ID, ya IP. Rule dhoondha, jaise `api-free`. Redis key banayi `rl:api-free:<apiKey>`, aur Redis par ek Lua script chalayi. Script ne bataya allowed ya nahi, kitne remaining, aur retry kab. Allowed hai toh `RateLimit-Limit`, `Remaining`, `Reset` headers lagake `next()`. Nahi toh **429** with `Retry-After`.

State Redis mein kyun? Kyunki in-memory counters har instance ke alag honge -- 10 instances matlab 10 guna limit. Redis in-memory hai, fast hai, atomic scripts deta hai, aur TTL se idle keys apne aap hat jaati hain. Counters ephemeral hain, isliye SQL mein nahi."

### 2:30 - 3:15 -- Algorithm + concurrency

"Algorithm main **token bucket** lunga. Fixed window simple hai lekin window boundary par 2x burst nikal jaata hai. Sliding log exact hai lekin har request ka timestamp store karta hai -- hamare scale par ~60 GB. Token bucket mein sirf do fields hain -- tokens aur last timestamp -- burst allow karta hai up to capacity, phir steady refill. AWS API Gateway aur Stripe jaise systems bhi isi family ka use karte hain.

Concurrency: agar main Node se GET karke phir SET karun, toh do parallel requests dono 'ek token bacha' padh lengi aur dono allow ho jaayengi. Isliye poora read-modify-write ek **Lua script** mein -- Redis script ko atomically chalata hai. Aur time main Node se nahi, Redis ke `TIME` se leta hoon -- warna alag servers ki clock skew se tokens galat banenge."

### 3:15 - 4:15 -- Scaling + rules

"At scale, yahan bottleneck Redis throughput ho sakta hai. Ek primary par main safe budget ~50K scripts per second maanta hoon, aur peak 100K hai. Isliye main **Redis Cluster** lunga -- 3 primaries, har ek ~33K, har primary ka ek replica. Hamari script ek hi key touch karti hai, toh cluster mein hash tags ki bhi zarurat nahi.

Aur bade scale par -- har check ke liye Redis jaane ki jagah instance locally tokens ka chhota batch lease kar sakta hai, edge par coarse per-IP limits laga sakte hain, aur agar bahut saari polyglot services hain toh ek standalone rate limit service -- Envoy RLS jaisa gRPC.

Rules Postgres mein hain -- few hundred rows, relational, audited. Har instance unhe memory mein cache karta hai aur har 30 second refresh -- DB hot path par kabhi nahi. Enterprise customer ke liye override table. Naya rule pehle dry-run mode mein -- sirf metric, block nahi."

### 4:15 - 5:00 -- Failures, security, trade-offs, wrap-up

"However, Redis down hone par hum fail-open karenge local fallback ke saath. Matlab 20 ms timeout ke baad main in-memory token bucket use karta hoon, capacity aur refill ko instances ki count se divide karke -- limit approximately global rehti hai, API down nahi hoti, aur `rate_limiter_fallback_total` metric alert bhejta hai. Login jaisa sensitive rule `failMode: closed` hai -- lekin woh sirf tab kaam aata hai jab koi decision possible hi na ho, jaise startup par rules load hi nahi hue.

Security: IP sirf trusted proxy ke `X-Forwarded-For` se, IPv6 ko /64 par group, login par IP plus username. Aur ye limiter DDoS protection nahi hai -- volumetric attack edge ya WAF par rukna chahiye.

One trade-off here is accuracy vs latency aur availability: Redis replication async hai aur fallback approximate hai, toh kabhi kabhi thoda over-admission hoga. Main woh accept karta hoon kyunki exact global counting ke liye har request par consensus chahiye -- slow aur fragile. Doosra trade-off -- token bucket burst allow karta hai; agar downstream strict smooth rate chahta hai toh leaky bucket better hai.

Summary: token bucket, Redis Lua se atomic aur global, Postgres rules memory mein cached, aur failure par fail-open with local fallback. Kisi part mein deep dive karein?"

---

## PART 29 -- Whiteboard Drawing Order

**Rule:** diagram ek saath mat banao. Har box tab draw karo jab uska **reason** bol rahe ho. Rate limiter mein ek extra rule: board par **request path** ko sabse mota rakho, kyunki limiter usi path par latency add karta hai.

### Step 1 -- Client

```
[Clients: API scripts (API key) | Web/App users | Anonymous (IP)]
```

**Ab interviewer ko kya explain karna hai?**

> "Teen tarah ki identities hain -- API key, user ID, IP -- aur har ek ka alag rule. Client-side limiting pe trust nahi kar sakte -- customer ka script bug wala retry loop bhi ho sakta hai, attacker bhi. Isliye limit server side."

**Abhi mat draw karo:** DNS, CDN. Pehle core flow.

### Step 2 -- Edge / Load Balancer (coarse IP limit)

```
[Clients]
    |
    v
[Edge: LB / API Gateway]   coarse per-IP limit (nginx limit_req / Kong / Envoy), TLS
```

**Ab interviewer ko kya explain karna hai?**

> "LB traffic ko instances mein baantta hai. Yahan main sirf **coarse** per-IP flood protection rakhta hoon -- saste mein bada kachra rok do. Plan-aware limits (free vs pro) yahan nahi, kyunki uske liye API key -> plan ki knowledge chahiye jo app ke paas hai. Asli DDoS WAF/edge provider ka kaam hai."

**Abhi mat draw karo:** WAF vendor details, multi-region.

### Step 3 -- Node.js API with rateLimit middleware

```
[Clients]
    |
    v
[Edge: LB / API Gateway]
    |
    +----------------+----------------+
    v                v                v
[Node API]       [Node API]       [Node API]      stateless, N instances
 identify key -> rateLimit() -> auth-heavy work -> handler
                     |
                     +--> 429 + Retry-After + RateLimit-*
```

**Ab interviewer ko kya explain karna hai?**

> "Limiter ek Express middleware hai -- cheap API-key identification ke baad, heavy auth aur business logic se pehle. Allowed par `RateLimit-Limit/Remaining/Reset` headers, reject par 429 aur `Retry-After`. Ab problem: agar state instance ki memory mein hai toh 3 instances = 3x limit. Isliye shared store chahiye."

Side mein likh do: `429 { error: RATE_LIMITED, retryAfterSec }`.

### Step 4 -- Redis Cluster (token buckets)

```
[Node API] --EVALSHA tokenBucket--> [Redis Cluster: 3 primaries + 3 replicas]
                                     rl:<ruleId>:<identity> -> {tokens, ts}, PEXPIRE
                                     Lua: TIME -> refill -> consume -> HSET
```

**Ab interviewer ko kya explain karna hai?**

> "Har check ek round trip -- ek atomic Lua script. Token bucket: sirf 2 fields per key, 10M keys = ~1.5 GB. Time Redis `TIME` se, isliye clock skew nahi. 100K peak / ~50K safe per primary = 3 primaries. Single-key script hai toh hash tags nahi chahiye. Timeout 20 ms."

**Ek trick:** Redis box ke paas hi chhota likh do `down? -> local memory bucket (cap / N)` -- failure story ka hook board par ready rahega.

### Step 5 -- Postgres rules + RuleCache

```
[Node API]
  RuleCache (in-memory, refresh 30s, keep last good copy)
       ^
       | every 30s (NOT per request)
[Postgres]  rate_limit_rules(id PK, identifier, route_pattern, plan, capacity, refill_per_sec, fail_mode, enabled)
            rate_limit_overrides(client_id, rule_id) PK
       ^
[Admin API]  PUT /admin/v1/rate-limit-rules/:id
```

**Ab interviewer ko kya explain karna hai?**

> "Rules bina redeploy badalne chahiye, isliye Postgres -- chhota, relational, audited data. Lekin DB hot path par **kabhi nahi**: har instance rules memory mein rakhta hai, har 30 second refresh, DB down ho toh last good copy. Enterprise override alag table mein. Counters kabhi SQL mein nahi."

Dotted line use karo -- dikhata hai ye request path par nahi hai.

### Step 6 -- Backend services it protects

```
[Node API] --(only allowed requests)--> [Business services / Postgres app DB / 3rd-party APIs]
```

**Ab interviewer ko kya explain karna hai?**

> "Limiter ka poora point yahi hai -- ye downstream services aur DB bachte hain customer ke retry loops, scraping, aur brute force se. Reject request yahan tak pahunchti hi nahi. Isliye limiter ko pehle rakha."

### Step 7 -- Metrics / alerts

```
[Node API] ----> [Prometheus] ----> [Grafana + Alerts]
  rate_limit_checks_total{rule,result}
  rate_limit_check_duration_seconds
  rate_limiter_fallback_total
  rate_limit_rule_cache_age_seconds
```

**Ab interviewer ko kya explain karna hai?**

> "Teen alerts sabse important: fallback counter badh raha hai (Redis problem), check latency p99 > 2 ms, aur rule cache age 30s se bahut zyada (rules refresh nahi ho rahe). Plus kisi rule ka rejection rate achanak spike -- ya toh attack hai ya galat rule deploy hua."

### Step 8 -- Queue / Workers: **not needed**

```
(no queue, no workers)
```

**Ab interviewer ko kya explain karna hai?**

> "Queue yahan nahi hai, aur jaan boojh ke nahi hai. Limiter ko **synchronously** abhi ke abhi batana hai allow ya reject -- queue lagaunga toh decision late aayega aur request wait karegi. Rejection logs bhi sampled hain, metrics counters mein. Agar kabhi analytics chahiye toh rejections ko async bhej sakte hain, lekin woh limiter ka part nahi."

Interviewer ko ye bolna ki "queue nahi chahiye kyunki..." -- ye bhi ek strong signal hai. Har system mein Kafka daalna red flag hai.

### Final board (aisa dikhna chahiye)

```
               [Clients: API key | user | IP]
                           |
              [Edge LB / Gateway]  coarse per-IP limit
                           |
         +-----------------+-----------------+
         v                 v                 v
     [Node API]        [Node API]        [Node API]
   identify -> rateLimit() -> auth -> handler ---> [Business services / DB]
         |       |  \
         |       |   +--> 429 + Retry-After
         |       v
         |   [Redis Cluster 3P + 3R]  rl:<rule>:<id>  Lua token bucket
         |       (down? -> local memory bucket, cap / N)
         |
     RuleCache (30s) < - - - [Postgres rules + overrides] < - - [Admin API]
         |
         +----> [Prometheus -> alerts]

   Queue / workers: none (decision is synchronous)
```

### Kya **bilkul** draw nahi karna (jab tak pooche nahi)

- Kafka / queue -- limiter synchronous hai.
- Standalone rate-limit service, local token leasing, per-region limits -- ye **V3 / scaling discussion** mein aate hain, pehle diagram mein nahi.
- CDN -- koi static content nahi hai.
- Counters ke liye Postgres ya Cassandra -- har request par write, DB mar jaayega.

---

## PART 30 -- Final Cheat Sheet (5 minute revision)

### Problem

Public SaaS API (Stripe/GitHub style) + web/mobile app + anonymous endpoints. Har client ko uske **plan aur route** ke hisaab se limit karo taaki backend/DB bache: abuse, customer scripts ke retry loops, scraping, login brute force, aur free vs pro quotas. Output: allow, ya **429 + Retry-After**.

### Requirements

| Type | Points |
|---|---|
| Functional | Limit per identity (`apiKey` / `userId` / `ip`); rules per plan + route; 429 + `RateLimit-Limit/Remaining/Reset` + `Retry-After`; rules change without redeploy (Postgres, cached, 30s refresh); per-client overrides |
| Default rules | `api-free` 100/min (cap 100, refill ~1.67/s) - `api-pro` 1000/min (cap 1000, ~16.67/s) - `anon-ip` 60/min (cap 60, 1/s) - `login` 5/min per (IP + username) (cap 5, 5/60 per s) |
| NFR | < 2 ms p99 added, highly available (limiter fail != API down), accurate **enough** (small over-admission OK), distributed/global limits, scale to peak |
| Clarify first | Kisko limit (key/user/IP)? Global ya per instance? Burst allowed? Hard vs soft limit? Fail open ya closed? Per route? Cost per request same? |

### Numbers (yaad rakho)

| Metric | Value | Isse kya decide hua |
|---|---|---|
| Requests | 2B/day -> ~23,148/s avg -> ~92.6K peak (4x) -> **~100K/s** | Har request = 1 Redis round trip |
| Identities | 10M/day | Keys in Redis |
| Read:write | **1:1** -- har check read + write | Cache in front bekaar (URL shortener se ulta) |
| Memory | ~150 B/key x 10M = **~1.5 GB** | Memory bottleneck nahi |
| Redis budget | ~50K Lua ops/s per primary (safe) | **3 primaries (~33K each) + 1 replica each** |
| Sliding log | 10M x ~100 x ~60 B = **~60 GB** | Rejected |
| Network | ~300 B x 100K = ~30 MB/s | Fine |
| Rules | few hundred rows, KBs | Memory cache, refresh 30s |
| Rejections | ~1% -> ~20M 429s/day | Logs sampled, metrics count |
| Latency budget | < 2 ms p99; ioredis `commandTimeout: 20` | Timeout -> fallback |
| Key TTL | `PEXPIRE ceil(capacity x 1000 / rate) + 1000` ms, e.g. `api-free` = 61 s | Idle keys apne aap hatein |

### APIs

| API | Kya |
|---|---|
| (middleware, no public endpoint) | Every limited response: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (sec) |
| Reject | `429` + `Retry-After` (sec) + body `{ "error": "RATE_LIMITED", "message": "Too many requests", "retryAfterSec": 12 }` |
| `GET /admin/v1/rate-limit-rules` | Rules list (admin authn + authz) |
| `PUT /admin/v1/rate-limit-rules/:id` | Rule update (30s mein sab instances par) |
| `PUT /admin/v1/rate-limit-overrides/:clientId/:ruleId` | Enterprise custom limit |
| V3 only: `POST /v1/ratelimit/check { ruleId, identity, cost }` | `{ allowed, remaining, retryAfterMs }` -- standalone service (or gRPC, Envoy RLS style) |

### HLD

```
Client -> DNS -> LB / API Gateway (coarse per-IP) -> N stateless Node.js (Express 5)
                                                       |-- rateLimit() middleware (after cheap key id, before auth-heavy work)
                                                       |-- Redis Cluster (Lua token bucket; counters, ephemeral)
                                                       |-- RuleCache <- Postgres rate_limit_rules (every 30s)
                                                       |-- Prometheus metrics
```

No queue, no DB on hot path, no CDN.

### LLD

```
src/middleware/rate-limit.ts          rateLimit(ruleResolver): identity -> service -> headers / 429
src/services/rate-limiter.service.ts  RateLimiterService.check(rule, identityValue, cost = 1): Promise<RateLimitDecision>
src/stores/redis-token-bucket.store.ts   RedisTokenBucketStore.consume(key, rule, cost)
src/stores/memory-token-bucket.store.ts  MemoryTokenBucketStore (fallback, same algorithm)
src/rules/rule.repository.ts (Postgres) + src/rules/rule-cache.ts (RuleCache, 30s, last good copy)
src/lua/token-bucket.lua | src/utils/key-builder.ts | src/infra/{redis,postgres,logger,metrics}.ts
src/app.ts (composition root) | src/server.ts
```

- `RateLimitRule { id, identifier, routePattern, plan, capacity, refillPerSec, failMode, enabled }`
- `RateLimitDecision { allowed, limit, remaining, retryAfterMs, resetSec }`, `resetSec = ceil((capacity - remaining) / refillPerSec)`
- ioredis: `enableOfflineQueue: false, maxRetriesPerRequest: 1, commandTimeout: 20`; scale par `new Redis.Cluster([...])`.
- `redis.defineCommand('tokenBucket', { numberOfKeys: 1, lua })` -> `const [allowed, remaining, retryAfterMs] = await redis.tokenBucket(key, capacity, refillPerSec, cost)`.

### Database (rules only)

```sql
rate_limit_rules(id TEXT PK, description, identifier CHECK in (apiKey,userId,ip),
                 route_pattern, plan NULL, capacity INT > 0, refill_per_sec NUMERIC(12,4) > 0,
                 fail_mode DEFAULT 'open' CHECK (open|closed), enabled DEFAULT true, updated_at)
rate_limit_overrides(client_id, rule_id FK, capacity, refill_per_sec, expires_at NULL,
                     PK (client_id, rule_id))
```

Postgres kyun: chhota, relational, audited, rarely changes. **Counters kabhi SQL mein nahi.**

### Redis

| Cheez | Value |
|---|---|
| Role | Bucket state ka source of truth -- lekin **ephemeral** (loss = limits briefly reset, OK) |
| Key | `rl:<ruleId>:<identifierValue>` e.g. `rl:api-free:ak_live_9f2c`, `rl:login:203.0.113.7:priya@example.com` |
| Value | Hash `{ tokens, ts }` (~150 B) |
| Script | Lua: `TIME` -> `HMGET` -> refill (`min(capacity, tokens + elapsed x rate / 1000)`) -> consume or `retry_after` -> `HSET` -> `PEXPIRE` -> `{allowed, floor(tokens), retry_after}` |
| Atomicity | Lua script atomic -- GET-then-SET race khatam |
| Clock | Redis `TIME` -- Node servers ki clock skew irrelevant |
| Cluster | 3 primaries + 3 replicas; single-key script -> hash tags `{...}` nahi chahiye (sirf multi-key scripts mein) |
| Hot key | Ek bada customer = ek key = ek shard; fix: local token leasing (Part 4) |
| Failure | Timeout 20 ms -> `MemoryTokenBucketStore` fallback |

### Queue

**Nahi chahiye.** Limiter ka decision synchronous hai -- request abhi allow ya reject hogi. Queue decision ko late karegi. Rejections: metrics mein count, logs sampled. (Leaky bucket conceptually queue hai, lekin woh humara choice nahi.)

### Main Algorithm

**Token bucket** -- bucket mein max `capacity` tokens (burst), `refillPerSec` se lazily refill, har request `cost` tokens leti hai; kam hain toh 429 + `retryAfter = ceil((cost - tokens) x 1000 / rate)` ms.

| Algorithm | Plus | Minus | Kab |
|---|---|---|---|
| Fixed window | Simplest, 1 counter | Boundary par **2x burst** | Rough quotas, daily limits |
| Sliding window log | **Exact** | O(limit) memory, ~60 GB | Low-volume, strict (e.g. costly ops) |
| Sliding window counter | Good approx, 2 counters | Approximate | Jab smooth window chahiye, burst nahi |
| Leaky bucket | Smooth constant output | Queue-based, burst nahi, latency | Downstream ko steady rate chahiye |
| **Token bucket** | Burst-friendly, O(1) memory (2 fields), 1 atomic script, industry use (AWS API Gateway, Stripe) | Burst downstream par aa sakta hai | **Humara default** |

### Scaling

| Stage | Change |
|---|---|
| V1 (1 instance) | In-memory token bucket in the Node process -- correct only while there is exactly one instance |
| 2+ instances | Middleware + shared Redis (primary + replica) + Postgres rules |
| V2 -- our numbers (~100K/s peak) | **Redis Cluster, 3 primaries + 1 replica each**; more stateless Node instances; local fallback |
| V3 -- bigger | **Local token leasing** (instance ek batch tokens le, Redis calls kam), edge per-IP limits, **per-region** limits/Redis, **standalone rate-limit service** (`POST /v1/ratelimit/check` / gRPC, Envoy RLS style) for polyglot services |

### Consistency

| Where | Level | Why OK |
|---|---|---|
| Ek key ka update | **Atomic** (Lua on one shard) | Race nahi |
| Global limit | **Approximate** | Small over-admission acceptable (requirement) |
| Redis failover | Async replication -> last few updates lost -> brief over-admission | Counters ephemeral |
| Fallback mode | `max(1, floor(cap / N))` per instance -- LB uneven ho toh thoda off; login jaise chhote rules thode loose | Better than no limit / API down |
| Rules | Eventual, <= 30s stale | Rules rarely change |

### Failure Handling

| Failure | Behaviour |
|---|---|
| Redis down / timeout (20 ms) | **Fail open with local fallback**: `MemoryTokenBucketStore`, capacity + refill **divided by number of instances**; `rate_limiter_fallback_total++`; sampled warn log. Login bhi fallback use karta hai (still limits) |
| No decision possible (rules never loaded at startup, limiter bug) | `failMode`: `open` rules allow; `closed` rules (`login`) -> **503** |
| Postgres down | RuleCache keeps **last good copy**; `rate_limit_rule_cache_age_seconds` badhta hai -> alert |
| Bad rule deployed | Dry-run mode pehle (sirf metric, block nahi), rejection spike alert, rollback via admin API |
| Node instance crash | Stateless -- LB hata deta hai; state Redis mein |
| DDoS | App limiter kaafi nahi -- edge / WAF / provider |

### Security

- **Trust proxy** sahi set karo: IP sirf trusted LB ke `X-Forwarded-For` se, warna attacker header spoof karke har request par naya IP.
- **IPv6**: ek user ke paas poora /64 hota hai -> limit /64 prefix par.
- **Credential stuffing**: `login` rule per (IP + username), plus per-username limits across IPs.
- **Cost-based limits**: expensive endpoints ka `cost` zyada.
- Admin API: authn + **admin role** authz. Limiter khud DDoS protection nahi hai.

### Observability

`rate_limit_checks_total{rule,result="allowed|rejected"}`, `rate_limit_check_duration_seconds` (histogram), `rate_limiter_fallback_total`, `rate_limit_rule_cache_age_seconds`, Redis latency/ops.

### Top 5 Trade-offs

| Decision | Chosen | Kyun | Kab badlega |
|---|---|---|---|
| Algorithm | Token bucket | Burst-friendly, O(1) memory, 1 script | Strict exactness -> sliding log; smooth output -> leaky bucket |
| Where state lives | Shared Redis | Global limits, fast, atomic, TTL | Single instance / MVP -> in-memory; huge scale -> local leasing |
| Failure policy | Fail open + local fallback | Availability > strictness; limiter bug API na giraye | Security-critical (`login`) -> `failMode: closed` jab decision hi possible na ho |
| Accuracy | Approximate | Exact global count = har request par coordination, slow + fragile | Billing-grade quotas -> exact counting DB mein (async), limiter alag |
| Placement | In-app middleware + coarse edge limit | Plan/route aware, simple, no extra hop | Many polyglot services -> standalone RLS (V3) |

### Top 10 Follow-up Questions (one-line answers)

| # | Question | One-line answer |
|---|---|---|
| 1 | Redis down ho gaya? | Fail open with local `MemoryTokenBucketStore`, capacity/refill divided by instances, fallback metric alert -- API chalti rahe |
| 2 | Node mein GET phir SET kyun nahi? | Do parallel requests dono same tokens padhengi aur dono allow -- Lua script atomic hai |
| 3 | Alag servers ki clock alag ho toh? | Time Redis `TIME` se, Lua ke andar -- ek hi clock |
| 4 | Fixed window mein kya problem? | Window boundary par 2x limit -- 59th second par 100 + 61st par 100 |
| 5 | Sliding log kyun nahi? | Exact hai lekin ~60 GB memory hamare scale par; token bucket ~1.5 GB |
| 6 | 100K RPS kaise? | ~50K per primary budget -> Redis Cluster 3 primaries; aage local token leasing |
| 7 | Ek bahut bada customer (hot key)? | Ek key ek shard par -- local token leasing / override se capacity, shard load monitor |
| 8 | Client ko kaise pata kab retry kare? | 429 + `Retry-After` + `RateLimit-*` headers; client exponential backoff with jitter |
| 9 | Limit bina deploy kaise badlein? | Postgres rules + overrides, RuleCache 30s refresh, naya rule pehle dry-run |
| 10 | Kya ye DDoS rok dega? | Nahi -- volumetric attack edge/WAF par; ye limiter abuse + fairness + quotas ke liye hai |

### 30-second answer

PART 27 dekho. Skeleton: **token bucket -> Express middleware har instance mein -> shared Redis Cluster, atomic Lua with Redis TIME -> rules Postgres + 30s memory cache -> 429 + Retry-After + RateLimit headers -> ~100K/s = 3 primaries -> Redis down = fail open with local fallback.**

### 5-minute answer (skeleton -- full text PART 28 mein)

1. **0:00** Requirements: identities (key/user/IP), plan rules (100 / 1000 / 60 / login 5 per min), global, NFR = < 2 ms, available, approximate OK.
2. **0:45** Numbers: 2B/day -> 23K avg -> ~100K peak; 10M keys x 150 B = 1.5 GB; **not read-heavy -> throughput bottleneck**.
3. **1:30** HLD + flow: middleware -> identity -> rule -> Redis Lua -> headers / 429; "in-memory = N x limit, isliye Redis".
4. **2:30** Token bucket vs fixed/sliding; GET-then-SET race -> Lua; Redis `TIME`.
5. **3:15** "Bottleneck Redis throughput -> Cluster 3 primaries"; leasing / edge / RLS; rules Postgres + RuleCache + overrides + dry-run.
6. **4:15** "Redis down -> fail-open with local fallback"; `failMode`; security (trust proxy, /64, login key); trade-off (approximate, burst); "deep dive kahan?"

### MOST IMPORTANT RULE -- 5 sawaal, 3 key decisions par

| Sawaal | Token bucket | Redis + Lua | Fail-open with local fallback |
|---|---|---|---|
| **Hum ye kyun kar rahe hain?** | Real API clients burst mein aate hain; burst up to capacity + steady refill; sirf 2 fields per key (~1.5 GB for 10M) | Limits global chahiye (N instances != N x limit); Lua read-modify-write ko atomic banata hai; `TIME` se clock skew khatam; TTL se cleanup | Limiter support system hai, product nahi -- uski failure se API down nahi honi chahiye; fallback phir bhi approximately limit karta hai |
| **Agar ye nahi kiya toh?** | Fixed window -> boundary par 2x burst; sliding log -> ~60 GB; leaky bucket -> legit bursts bhi queue/reject | In-memory -> har instance ki alag limit; GET-then-SET -> race, over-admission; Node clock -> skew se galat tokens | Fail closed -> Redis blip = poori API 503; plain fail open (no fallback) -> Redis down = zero protection, abuse seedha DB par |
| **Iska alternative kya hai?** | Fixed window, sliding log, sliding window counter, leaky bucket | In-process memory, sticky sessions, Postgres counters, Memcached, standalone RLS | Fail closed; plain fail open; circuit breaker + static limits at edge |
| **Alternative kab choose karenge?** | Strict exact limit, low volume -> sliding log; steady output to fragile downstream -> leaky bucket; simple daily quota -> fixed window | Single instance / MVP -> in-memory; polyglot services / central team -> standalone RLS (gRPC) | Security-critical with no decision possible (`login`, `failMode: closed`) -> 503; payments-style hard quotas -> fail closed |
| **Scale badhne par kya change hoga?** | Same algorithm; cost-based tokens for heavy endpoints; per-region buckets | Single Redis -> Cluster 3 primaries -> local token leasing -> per-region Redis -> standalone RLS | Fallback divisor N = live instance count (autoscaling ke saath update); alerts on `rate_limiter_fallback_total`; edge limits as second layer |

### Most Important Things To Remember

1. **Not read-heavy** -- har check read + write; bottleneck **Redis throughput**, memory nahi.
2. **Token bucket = 2 fields, burst + steady refill**; lazy refill, koi timer nahi.
3. **Atomic Lua + Redis `TIME`** -- race aur clock skew dono ek saath khatam.
4. **Global limit ke liye shared state** -- in-memory sirf single instance ya fallback.
5. **Fail open with local fallback (cap / N)** -- availability over strictness; `failMode` sirf jab decision hi possible na ho.
6. **Rules Postgres mein, hot path memory se** (30s refresh, last good copy); counters kabhi SQL mein nahi.
7. Reject = **429 + Retry-After + RateLimit-* headers**, taaki clients sahi backoff karein.
8. **Approximate is OK** -- exactness ki keemat latency aur availability hai.
9. Numbers bolo: **2B/day, 23K avg, ~100K peak, 10M keys, 1.5 GB, 50K per primary -> 3 primaries, < 2 ms, 20 ms timeout.**
10. **Queue nahi**, CDN nahi, DB hot path par nahi -- aur ye bolna ki "kyun nahi" bhi answer ka part hai.

---

## Remember

> **Coding round mein: clarify (per key? burst? limit?) -> logic bolo (lazy refill) -> clean code with injectable clock -> edge cases (cost, clock, floats, memory, concurrency) -> complexity. Design round mein: requirements -> numbers ("not read-heavy") -> simple diagram -> bottleneck (Redis throughput) -> failure policy.** Rate limiter ka dil ek line hai: "Tokens lazily refill karo, ek atomic script mein consume karo, aur limiter ki failure ko kabhi API ki failure mat banne do."

## Quick Self-Test

1. Tumhari in-memory `TokenBucketLimiter` class 10 Node instances par chala di -- effective limit kya ho jaayegi, aur production design mein ye kaise solve hua? Redis down hone par yahi class kaise wapas kaam aati hai?
2. Output ki line **D** mein `EPSILON` ke bina request reject kyun hoti? Kaun sa exact float value aata hai aur kyun?
3. `refill` mein `lastRefillMs = Math.max(lastRefillMs, nowMs)` ki jagah `lastRefillMs = nowMs` likh dein toh clock peeche jaane par kaunsa bug aayega?
4. Token bucket O(1) space per key aur sliding log O(limit) per key -- hamare numbers par dono ki total memory kitni aati hai?
5. Whiteboard par queue kyun nahi draw kiya, aur 5-minute answer mein "fail-open with local fallback" wali line kis minute mein aati hai -- uske saath `failMode: closed` ka kaunsa nuance batana zaruri hai?

---

**Rate Limiter complete.** Next system: **Payment System / Idempotent API**. "next" bolo.
