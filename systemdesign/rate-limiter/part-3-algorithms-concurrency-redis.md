# Rate Limiter -- HLD + LLD (Part 3: Algorithms -> Concurrency -> Redis State)

> Is file mein prompt ke **Parts 13-15** hain: rate limiting ke algorithms (zero se), concurrency (race conditions), aur Redis state ka deep dive (rate limiter ke liye "caching" ka matlab yahi hai).
> Part 1-2 recap: humne **token bucket** choose kiya, jo ek **atomic Redis Lua script** mein chalta hai. Har request = 1 `EVALSHA` = 1 Redis round trip. Key format `rl:<ruleId>:<identifierValue>`, rules Postgres mein (30 sec refresh), counters sirf Redis mein. Redis down -> `MemoryTokenBucketStore` fallback. Ab dekhenge ye choices **kyun** sahi hain, baaki algorithms kahan fail hote hain, aur production mein Redis state kaise tootti hai.

---

## PART 13 -- Important Algorithms: "kitni requests allow karein?" ka hisaab kaise rakhein

### Problem kya hai?

Rule simple lagta hai: **"ek client 1 minute mein 5 login attempts kar sakta hai"**. Lekin isko code mein likhne ke liye 4 sawaal ka jawab chahiye:

1. **"1 minute" kaunsa?** Clock ka minute (10:00:00 - 10:00:59) ya "pichle 60 seconds"?
2. **Burst allowed hai?** Client ne 1 second mein 5 bhej diye -- theek hai ya galat?
3. **Memory kitni?** 10M client identities hain. Har ek ke liye kitna data rakhein?
4. **Distributed?** Hamare N Node.js instances hain. Sab ko same count dikhna chahiye.

Paanch famous algorithms hain. Har ek in sawaalon ka alag jawab deta hai. Hum sab ko ek hi example se samjhenge:

> **Running example:** limit = **5 requests / minute** (hamara `login` rule: capacity 5, refillPerSec 5/60).

### Naive approach -- har server apna counter rakhe

Sabse pehla idea jo har developer likhta hai:

```ts
// BUGGY for production -- sirf samajhne ke liye
const counts = new Map<string, number>();
setInterval(() => counts.clear(), 60_000);   // har minute sab reset

function allow(clientId: string): boolean {
  const n = (counts.get(clientId) ?? 0) + 1;
  counts.set(clientId, n);
  return n <= 5;
}
```

Teen problem turant:

- **Per instance count:** 10 Node instances hain toh load balancer requests baant deta hai -> har instance ko sirf ~1/10 dikhta hai -> client asal mein **50/min** kar sakta hai.
- **Restart = reset:** deploy hua, counter gaya.
- **Window edge problem:** ye actually "fixed window" hi hai -- aur uska ek bada bug hai. Chalo wahi dekhte hain.

Distributed wale problem ka jawab = **shared store (Redis)**. Ab algorithm choose karna hai.

---

### Algorithm 1 -- Fixed Window Counter

**Simple idea:** time ko fixed dabbon (windows) mein kaato: 10:00-10:01, 10:01-10:02... Har window ka ek counter. Counter limit se upar gaya toh reject. Naya minute -> naya counter (0 se).

**Real-life analogy:** gym register jismein har ghante ka ek page hai -- "is ghante max 5 entries". 10:59 par page bhar gaya? 11:00 par naya page, phir se 5. Guard ko fark nahi padta ki 10:59 wale log abhi andar hi hain.

**Engineering connection:** "page" = Redis key jismein window number hai, "entries" = `INCR`.

```
key = rl:login:<ip:user>:<windowNumber>      windowNumber = floor(nowSec / 60)

INCR key            -> n   (atomic, naya counter)
if n == 1: EXPIRE key 60   (window khatam -> key khud delete)
allow if n <= 5
```

#### Worked example -- boundary burst (asli bug)

```
Window A = 0:00 - 0:59        Window B = 1:00 - 1:59

Time    Request   Window   Counter   Result
0:59    #1-#5     A        1..5      ALLOW  (5/5)
1:00    #6-#10    B        1..5      ALLOW  (naya window, counter 0 se)

=> 0:59 se 1:00 ke beech (~2 seconds) mein 10 requests allow
=> limit "5 per minute" tha, mila 2x
```

(Simulation mein bhi yahi aaya: 5 requests at 0:59 + 5 at 1:00 = **10 admitted**.)

Login ke liye iska matlab: attacker window edge par timing karke **double password guesses** kar sakta hai. API ke liye: backend ko limit ka 2x spike ek saath mil sakta hai.

- **Memory per key:** ek integer counter + key -- roughly ~70-90 bytes. Sabse sasta.
- **Accuracy:** window ke andar exact, edge par **2x tak** galat.
- **Burst:** window edge par 2x burst possible.
- **Achha:** bahut simple, ek `INCR` = atomic, samajhna aasaan.
- **Bura:** boundary burst; aur window shuru hote hi saare clients ek saath aate hain (sab ka counter 10:00:00 par reset hota hai -> traffic spike).
- **Kab sahi hai:** **calendar quotas** -- "1000 calls per month, 1st ko reset". Wahan customer khud "calendar month" hi expect karta hai.

> URL Shortener Part 4 ka simple Redis limiter yahi tha. Ab samajh aaya woh "simple" kyun tha.

---

### Algorithm 2 -- Sliding Window Log

**Simple idea:** fixed dabbe mat banao. Har request ka **exact timestamp** likh lo. Nayi request aaye toh dekho: "pichle 60 seconds mein kitne timestamps hain?" 5 se kam -> allow.

**Real-life analogy:** society ka security guard jo har visitor ka **exact time** notebook mein likhta hai. Naya visitor aaya toh guard pichle 60 minute ki entries ginta hai. Bilkul fair -- lekin notebook bahut bhar jaati hai.

**Engineering connection:** notebook = Redis **sorted set (ZSET)**, score = timestamp.

```
now = 1:10 (70,000 ms)
ZREMRANGEBYSCORE key 0 (now - 60000)     # 60 sec se purani entries hatao
ZCARD key                                 # abhi kitni bachi? -> count
if count < 5:
    ZADD key now <uniqueRequestId>        # apni entry likho
    PEXPIRE key 60000
    ALLOW
else REJECT
```

(Ye 3-4 commands ek atomic Lua script mein hone chahiye -- warna Part 14 wala race.)

#### Worked example -- boundary burst gayab

```
0:59   #1-#5  -> log = [59,59,59,59,59]          ALLOW
1:00   #6     -> pichle 60s (0:00-1:00) mein 5   REJECT
1:58   #7     -> abhi bhi 0:58-1:58 mein 5       REJECT
1:59.001 #8   -> 0:59 wali entries 60s purani ho gayin, count 0   ALLOW
```

**Kisi bhi** 60-second window mein 5 se zyada nahi. Exact.

- **Memory per key:** har request ki ek entry (~60 bytes). Hamare scale par: 10M keys x ~100 entries x ~60 bytes = **~60 GB**. Counter wale algorithms ~1.5 GB mein kaam kar dete hain.
- **Accuracy:** 100% exact.
- **Burst:** koi window-edge burst nahi.
- **Bura:** memory aur CPU (ZREMRANGEBYSCORE har request par). Aur **rejected requests ko log mein daala toh** attacker jitna maarega utna hi block rahega (kuch implementations yahi galti karti hain).
- **Kab sahi hai:** chhota scale, bahut strict limit (e.g. "5 OTP per hour per phone"), jahan entries kam hain.

**Hamare liye rejected** -- 60 GB sirf counters ke liye, wo bhi "small over-admission OK" requirement ke saath, overkill hai.

---

### Algorithm 3 -- Sliding Window Counter (approximation)

**Simple idea:** log ki exactness chahiye, fixed window ki memory chahiye. Toh **2 fixed window counters** rakho (pichla minute + current minute) aur pichle minute ko **weight** do -- ki uska kitna hissa abhi bhi "pichle 60 seconds" mein aata hai.

```
estimate = prevCount x (1 - elapsedInCurrentWindow / 60) + currCount
allow agar estimate + 1 <= limit    (yaani estimate < limit)
```

Assumption: pichle window ki requests **evenly** spread thi.

**Real-life analogy:** restaurant manager jisko pichle ghante ka total yaad hai (40 customers), exact times nahi. 10:15 par woh sochta hai: "pichle ghante ka 3/4 hissa abhi bhi 'last 60 min' mein hai, toh ~30 + is ghante ke 12 = ~42 log." Exact nahi, lekin kaafi achha.

#### Worked example (limit 5/min)

Pichle window (0:00-0:59) mein **4** requests, current window (1:00-) mein ab tak **2**.

```
Time   elapsed   prev weight        estimate            Next request?
1:15   15 s      1 - 15/60 = 0.75   4 x 0.75 + 2 = 5    5 + 1 > 5 -> REJECT
1:30   30 s      0.50               4 x 0.50 + 2 = 4    4 + 1 = 5 -> ALLOW
1:45   45 s      0.25               4 x 0.25 + 2 = 3    ALLOW
```

**Boundary burst case:** 0:59 par 5 requests (prev = 5), 1:00 par nayi request:

```
elapsed 0 s:  5 x 1.00 + 0 = 5       -> REJECT
elapsed 1 s:  5 x (59/60) + 0 = 4.92 -> REJECT (4.92 + 1 > 5)
```

Fixed window ne yahan 5 aur allow kar di thi. Sliding counter ne rok diya.

(Saare numbers node se verify kiye: 5, 4, 3, 4.92.)

- **Memory per key:** 2 counters -> ~2 x fixed window. Bahut sasta.
- **Accuracy:** approximate. Agar pichle window ki requests uske end mein cluster thin, toh estimate thoda kam ya zyada ho sakta hai. **Cloudflare** ne apne rate limiting blog mein bataya ki unke traffic analysis mein galat decision bahut hi kam (~0.003% requests) the.
- **Burst:** smooth -- window edge par 2x burst nahi.
- **Achha:** O(1) memory, near-exact, samjhana easy ("pichle 60 seconds").
- **Bura:** approximation; 2 keys ya 2 fields padhne padte hain.

---

### Algorithm 4 -- Leaky Bucket

**Simple idea:** ek balti jismein neeche chhota ched hai. Requests (paani) upar se aati hain, balti mein **queue** hoti hain, aur ched se **fixed rate** par nikalti hain (process hoti hain). Balti full -> nayi request gir jaati hai (reject).

**Real-life analogy:** doctor ka clinic. Waiting room mein 5 chairs (capacity), doctor har 12 minute mein ek patient dekhta hai (leak rate). Kitne bhi log ek saath aayein, doctor ki speed same. Chairs full -> "kal aana".

**Engineering connection:** chairs = queue (buffer), doctor = worker jo fixed rate par process karta hai. Output **perfectly smooth** hota hai.

#### Worked example (capacity 5, leak 1 per 12 s)

```
t=0     7 requests aayin -> 5 queue mein, 2 REJECT (balti full)
Processing:  #1 at t=0, #2 at t=12s, #3 at t=24s, #4 at t=36s, #5 at t=48s
```

Dekho problem: **5th request ko 48 seconds wait**. API client ka HTTP timeout usse pehle hi ho jaayega.

- **Memory per key:** queue ka size (queue-based) -- ya sirf 2 numbers ("leaky bucket as a meter" variant, jo GCRA kehlata hai aur math mein token bucket jaisa hi hai).
- **Accuracy:** exact rate.
- **Burst:** **koi burst nahi** -- output hamesha steady. Yahi iski khoobi bhi hai aur kami bhi.
- **Achha:** downstream ko constant rate chahiye toh best (e.g. third-party SMS provider jo 10 msg/sec se zyada nahi leta; ya nginx `limit_req` jo requests ko delay karke smooth karta hai).
- **Bura:** queue = latency + memory; synchronous API ke liye requests ko rok ke rakhna bura UX. Real API clients naturally bursty hote hain (page load par 5 calls ek saath).
- **Kahan use hota hai:** nginx `limit_req`, Shopify REST API (leaky bucket model), outgoing call throttling.

---

### Algorithm 5 -- Token Bucket (hamara choice)

**Simple idea:** har client ki ek balti mein **tokens** hain (max = `capacity`). Har request ek token kharch karti hai. Tokens ek **fixed rate** (`refillPerSec`) se wapas bharte hain, lekin capacity se zyada nahi. Token nahi hai -> reject.

**Real-life analogy:** metro card jismein max 5 rides store ho sakti hain, aur har 12 second mein automatically 1 ride recharge hoti hai (card full ho toh recharge waste). Tum ek saath 5 rides use kar sakte ho (**burst**), uske baad har 12 sec mein sirf 1 (**steady rate**).

**Engineering connection:** card = Redis hash `{ tokens, ts }`. "Automatic recharge" ke liye koi background timer **nahi** chalta -- jab bhi request aati hai, hum calculate karte hain ki pichli baar (`ts`) se ab tak kitne tokens bane. Isko **lazy refill** kehte hain.

```
refilled = min(capacity, tokens + elapsedMs x refillPerSec / 1000)
```

Leaky bucket se farak ek line mein: **leaky bucket output ko smooth karta hai (queue), token bucket input ko limit karta hai aur burst allow karta hai (no queue, turant yes/no).**

#### Worked example (capacity 5, refillPerSec 5/60 = 0.0833..., yaani 1 token har 12 sec)

Ye numbers humne Lua script ko JS mein port karke **node simulation** se nikale hain:

```
Time      Event           tokens (before -> after)      Result    remaining  retryAfterMs
t=0       req #1          5 (naya bucket) -> 4           ALLOW     4          0
t=0       req #2..#5      4 -> 3 -> 2 -> 1 -> 0          ALLOW     3,2,1,0    0
t=0.5s    req #6          0 + 500 x 0.0833/1000
                          = 0.0417 -> 0.0417             REJECT    0          11501
t=11.999s req #7          0.0417 + 11499 x 0.0833/1000
                          = 0.99992                      REJECT    0          1
t=12s     req #8          0.99992 + 0.0000833 = 1.0 -> 0 ALLOW     0          0
t=12s     req #9          0                              REJECT    0          12000
t=30s     req #10         0 + 18000 x 0.0833/1000 = 1.5
                          -> 0.5                         ALLOW     0          0
t=90s     6 requests      0.5 + 60 s refill -> capped 5  5 ALLOW, 1 REJECT (retry 12000)
```

Dhyan do:

- **t=0 par 5 ek saath allow** -- burst up to capacity. Real clients ke liye friendly.
- **t=0.5s ka retryAfterMs = 11501**, 11500 nahi. Kyun? `(1 - 0.041666...) x 1000 / 0.08333...` floating point mein 11500.000...1 aata hai, aur `ceil` usko 11501 bana deta hai. 1 ms ka farak -- koi issue nahi, bas "exact" numbers expect mat karo. Header mein `Retry-After = ceil(11501 / 1000) = 12` sec (Part 2 ka 429 body `"retryAfterSec": 12` yahi hai).
- **t=90s:** 60 sec idle rahne par bucket poora bhar gaya (5 par cap). Isse zyada store nahi hota -- raat bhar idle rehne se subah 1000 tokens nahi milte.
- **Long-term rate:** kitna bhi try karo, average 5/min se zyada nahi (capacity ek baar ka burst, phir refill rate).

#### TypeScript sketch (single process, samajhne ke liye)

```ts
interface Bucket { tokens: number; ts: number }

function consume(b: Bucket | undefined, capacity: number, ratePerSec: number, nowMs: number, cost = 1) {
  const bucket = b ?? { tokens: capacity, ts: nowMs };
  const elapsed = Math.max(0, nowMs - bucket.ts);
  bucket.tokens = Math.min(capacity, bucket.tokens + (elapsed * ratePerSec) / 1000);
  bucket.ts = nowMs;
  if (bucket.tokens >= cost) {
    bucket.tokens -= cost;
    return { allowed: true, bucket, retryAfterMs: 0 };
  }
  return { allowed: false, bucket, retryAfterMs: Math.ceil(((cost - bucket.tokens) * 1000) / ratePerSec) };
}
```

**Code Explanation:**

- `b ?? { tokens: capacity, ts: nowMs }` -- naya client = full bucket.
- `Math.max(0, nowMs - bucket.ts)` -- clock peeche gayi toh negative elapsed se tokens kam nahi karne.
- `Math.min(capacity, ...)` -- refill capacity se upar nahi.
- `tokens >= cost` -- `cost` usually 1; expensive endpoint (e.g. bulk export) ke liye 10 rakh sakte ho.
- `retryAfterMs` -- kitne ms baad itne tokens ban jaayenge ki ye request pass ho.

- **Memory per key:** 2 numbers (`tokens`, `ts`) -> ~150 bytes with key + Redis overhead -> 10M x 150 B = **~1.5 GB**.
- **Accuracy:** exact rate (lazy refill math), atomic script ke saath.
- **Burst:** capacity tak allowed, phir steady.
- **Achha:** burst-friendly, O(1) memory, 1 atomic script, `cost` support free mein, industry-used (AWS API Gateway, Stripe).
- **Bura:** "5 per minute" customer ko samjhana thoda tricky -- asal mein "5 ka burst + 1 har 12 sec". Burst ek saath backend par aata hai (capacity chhoti rakho toh theek).

---

### Final decision table

| Algorithm | Memory / key | Accuracy | Burst behaviour | Redis ops | Kab choose karunga |
|---|---|---|---|---|---|
| Fixed window | 1 counter (~80 B) | Edge par 2x galat | 2x burst at edge | `INCR` (+ `EXPIRE`) | Calendar quotas (monthly/daily), quick v0 |
| Sliding log | Har request (~6 KB for 100) | Exact | None | ZSET + Lua | Chhota scale, strict security limits (OTP) |
| Sliding counter | 2 counters | ~Exact (tiny error) | Smooth | 2 keys/fields + Lua | Strict "N per rolling minute" promise (Cloudflare-style) |
| Leaky bucket | Queue ya 2 numbers | Exact rate | No burst (smooth output) | Queue / Lua | Downstream ko constant rate chahiye |
| **Token bucket** | **2 fields (~150 B)** | **Exact rate** | **Burst up to capacity, phir steady** | **1 Lua script** | **API rate limiting (hamara)** |

### Token bucket kyun, aur kab sliding window counter better hota?

**Token bucket kyun:**

1. **Real API clients bursty hain** -- dashboard load par 8 calls ek saath, phir 30 sec kuch nahi. Token bucket isko allow karta hai, average rate phir bhi control mein.
2. **O(1) memory** -- 2 fields, 10M clients = ~1.5 GB. Sliding log ka 60 GB nahi.
3. **Ek atomic script** -- 1 round trip, koi race nahi (Part 14).
4. **Do knobs, do alag cheezein** -- `capacity` (burst kitna) aur `refillPerSec` (long-term rate). Enterprise override mein dono alag set kar sakte ho.
5. **`cost` natural hai** -- heavy endpoint = zyada tokens.

**Sliding window counter better kab hota:**

- Contract mein strict likha ho: **"kisi bhi 60 seconds mein 100 se zyada nahi"** -- token bucket 100 ka burst + turant refill deta hai, toh kisi rolling 60 sec mein ~100 + refill (~200 tak) dikh sakta hai. Sliding counter isko tighter pakadta hai.
- Aap Cloudflare jaisa product bana rahe ho jahan customer khud rule likhta hai "100 req per minute" aur exact wahi semantics expect karta hai.
- Calendar quotas (per day / per month billing) -- wahan toh **fixed window** hi sahi hai.

**Interview line:**

> "Main token bucket use karunga -- har client ke liye sirf do numbers, tokens aur last refill timestamp, aur refill lazily calculate hota hai, koi background timer nahi. Isse burst up to capacity allow hota hai aur long-term rate refill rate se bound rehta hai. Fixed window ka edge par 2x burst problem hai, sliding log exact hai lekin hamare scale par ~60 GB lega. Agar product strict 'N per rolling minute' promise karta, toh main sliding window counter lunga -- do counters, weighted estimate."

---

### Canonical Lua script -- line by line

Ye wahi script hai jo Part 2 mein `src/lua/token-bucket.lua` mein hai. Verbatim:

```lua
-- KEYS[1] = bucket key
-- ARGV[1] = capacity, ARGV[2] = refill tokens per second, ARGV[3] = cost
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])

local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil then
  tokens = capacity
  ts = now
end

local elapsed = math.max(0, now - ts)
tokens = math.min(capacity, tokens + elapsed * rate / 1000)

local allowed = 0
local retry_after = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry_after = math.ceil((cost - tokens) * 1000 / rate)
end

redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity * 1000 / rate) + 1000)

return { allowed, math.floor(tokens), retry_after }
```

**Code Explanation:**

- `KEYS[1]` -- bucket key, e.g. `rl:login:203.0.113.7:priya@example.com`. Key ko `KEYS` mein dena zaruri hai (ARGV mein nahi) -- Redis Cluster isi se decide karta hai script kis node par chalegi.
- `tonumber(ARGV[1])` ... -- Redis ko har argument **string** mein milta hai. ioredis JS number `5/60` ko `"0.08333333333333333"` bana ke bhejta hai; `tonumber` wapas number (double) banata hai. Lua 5.1 mein saare numbers double hain -- decimals chalte hain.
- `redis.call('TIME')` -- Redis server ka time, 2 strings: `[seconds, microseconds]`. **Node server ka `Date.now()` nahi** -- 10 servers ki clocks thodi alag ho sakti hain (Part 14 mein detail). Ek hi clock = consistent math.
- `now = seconds x 1000 + floor(micro / 1000)` -- milliseconds mein time. (~1.7 x 10^12 -- double mein exact fit hota hai.)
- `HMGET key tokens ts` -- ek call mein dono fields.
- `tonumber(state[1])` -- key nahi hai toh Redis nil reply deta hai, jo Lua mein **`false`** banta hai (nil nahi). `tonumber(false)` Lua 5.1 mein `nil` return karta hai -- isliye agli line ka check kaam karta hai.
- `if tokens == nil then tokens = capacity; ts = now` -- naya client (ya key TTL se expire ho gayi) -> **full bucket**. Isliye expire hona safe hai (neeche PEXPIRE dekho).
- `elapsed = math.max(0, now - ts)` -- pichli request se ab tak kitne ms. `max(0, ...)` -- Redis failover ke baad naye primary ki clock thodi peeche ho toh negative nahi.
- `tokens = math.min(capacity, tokens + elapsed * rate / 1000)` -- **lazy refill**. `rate` per second hai, `elapsed` ms mein, isliye `/ 1000`. `min` -- capacity se upar nahi. Bonus: admin ne capacity 100 se 50 ki, toh purane bucket ke 100 tokens bhi yahin 50 par cap ho jaate hain.
- `if tokens >= cost` -- itne tokens hain? Haan -> kaato, `allowed = 1`.
- `else retry_after = ceil((cost - tokens) * 1000 / rate)` -- kitne tokens kam hain / rate = kitne ms baad itne ban jaayenge. Example: 0.0417 tokens hain, 1 chahiye -> 0.9583 kam -> 0.9583 x 1000 / 0.0833 = ~11500 ms (float ki wajah se 11501). `ceil` -- thoda zyada wait bolna safe hai, kam bola toh client jaldi aayega aur phir 429 khayega.
- `HSET key tokens <n> ts <now>` -- naya state likho. **Reject par bhi likhte hain** -- refill ka checkpoint aage badh gaya (refilled tokens + naya ts), math phir bhi sahi rehta hai. (Multi-field HSET Redis 4.0+ mein hai.)
- `PEXPIRE key ceil(capacity * 1000 / rate) + 1000` -- **"empty bucket ko poora bharne ka time + 1 second"**. Hamare saare default rules 60 sec mein poora refill hote hain -> `60000 + 1000 = 61000 ms` (simulation mein chaaron rules ka 61000 aaya). Matlab: client 61 sec idle raha toh bucket waise bhi full ho chuka hota -- key delete karo, next request par "naya = full" same result dega. **Koi information loss nahi, memory free.** `ceil` isliye ki PEXPIRE ko integer chahiye; fraction gaya toh Redis "value is not an integer" error dega.
- `return { allowed, math.floor(tokens), retry_after }` -- Lua table -> Redis **array reply**. Important: Redis Lua **number ko integer reply mein convert karta hai aur decimal part kaat deta hai** (3.9 -> 3). `math.floor` wahi explicit kar deta hai taaki koi confuse na ho ki `remaining` fractional aayega. Decimal chahiye hota toh `tostring(tokens)` return karna padta. `retry_after` pehle hi `ceil` se integer hai.

Node side (Part 2 recap):

```ts
redis.defineCommand('tokenBucket', { numberOfKeys: 1, lua: TOKEN_BUCKET_LUA });
const [allowed, remaining, retryAfterMs] = await redis.tokenBucket(key, capacity, refillPerSec, cost);
```

- `numberOfKeys: 1` -- pehla argument KEYS[1], baaki ARGV.
- Return `[1, 4, 0]` jaisa array -- `allowed === 1` check karo.

> Ek chhoti precision note: Postgres mein `refill_per_sec NUMERIC(12,4)` hai, toh `5/60` store hoga `0.0833` (exact 0.08333... nahi). Tab 1 token ~12,005 ms mein banega aur PEXPIRE 61025 ms. Rate limiter ke liye 0.04% farak irrelevant hai, lekin interview mein "numbers exact kyun nahi aa rahe" ka jawab yahi hai.

---

## PART 14 -- Concurrency: ek hi client ki 2 requests ek saath 2 servers par

### Pehle: race kahan se aata hai?

URL Shortener Part 3 se yaad karo:

1. Node.js mein **do `await` ke beech ka code atomic** hai (single thread).
2. **`await` ke aar-paar koi guarantee nahi**, aur 10 alag Node processes ek doosre ki memory dekhte hi nahi.

Rate limiter mein har check **read + modify + write** hai (tokens padho -> kaato -> likho). Ye exactly "lost update" wala pattern hai.

### Scenario 1 -- GET-then-SET across 2 Node instances

Galat approach (Redis use kar rahe hain, phir bhi bug):

```ts
// BUGGY -- mat karna
const raw = await redis.hmget(key, 'tokens', 'ts');           // 1. read
const tokens = refill(raw, Date.now());                      // 2. modify (JS mein)
if (tokens < 1) return reject();
await redis.hset(key, 'tokens', tokens - 1, 'ts', Date.now()); // 3. write
return allow();
```

Client ke paas **1 token** bacha hai. Uski 2 requests load balancer ne 2 instances par bhej di:

```
Time   Instance A                          Instance B
t1     HMGET -> tokens = 1
t2                                         HMGET -> tokens = 1
t3     1 >= 1 -> ALLOW, HSET tokens = 0
t4                                         1 >= 1 -> ALLOW, HSET tokens = 0
Result: 1 token tha, 2 requests allow. Over-admission.
```

Aur ye sirf 2 ka case hai. Retry-loop wala buggy customer script 10 instances par ek saath 50 requests bheje -> sab ek hi purana value padhein -> **limit ka kai guna** pass. Login par ye brute-force ka raasta hai.

### Scenario 2 -- INCR fixed window mein kaafi kyun hai, token bucket mein kyun nahi?

**Fixed window** mein poora "read + modify + write" ek hi command hai:

```
INCR rl:login:x:28333333   -> 6     (atomic: Redis andar hi padh ke +1 karke likhta hai)
```

Do instances ek saath `INCR` karein toh ek ko 5 milega, doosre ko 6. Koi race nahi. Decision (`n <= 5`) **INCR ke result** par hota hai, jo already atomic hai.

(Ek chhota trap: `INCR` phir alag se `EXPIRE` -- beech mein process crash hua toh key **bina TTL** reh jaayegi aur counter kabhi reset nahi hoga. Fix: dono ek Lua script / MULTI mein, ya `SET key 0 EX 60 NX` pehle.)

**Token bucket** mein koi single Redis command nahi hai jo "time ke hisaab se refill karo, capacity par cap karo, cost kaato agar kaafi ho" kare. Logic hai -- condition (`if tokens >= cost`) aur math (`min`, `elapsed * rate`). Isliye custom atomic step chahiye.

### Scenario 3 -- MULTI/EXEC kaafi kyun nahi?

**MULTI/EXEC ka matlab:** commands ko queue karo, `EXEC` par sab ek saath bina interruption chalo.

```
MULTI
HMGET key tokens ts       -> QUEUED   (result abhi nahi milta!)
HSET key tokens ??? ts ?? -> QUEUED   (??? kya likhein? Read ka result hi nahi pata)
EXEC
```

Problem: MULTI ke andar **read ka result beech mein nahi milta**, toh uske basis par decide karke likh nahi sakte. MULTI "batch atomic" deta hai, "read -> decide -> write" nahi.

**WATCH + retry (optimistic locking) possible hai:**

```
WATCH key
HMGET key tokens ts          -> JS mein calculate karo
MULTI
HSET key tokens 0 ts ...
EXEC                         -> null aaya = beech mein kisi ne key badli -> dobara try
```

- Kaam karta hai, lekin **ek request = 3-4 round trips** (WATCH, HMGET, MULTI+HSET+EXEC).
- **Contention mein sabse bura:** jis key par sabse zyada traffic (abusive client) hai, wahi sabse zyada conflict karegi -> retry par retry -> latency badhti hai exactly jab system pressure mein hai. Hamara budget < 2 ms p99 hai.

### Scenario 4 -- Lua script atomic kyun hai?

Redis **commands ko ek thread par ek-ek karke** execute karta hai. Script chal rahi ho toh Redis beech mein **koi doosra command nahi chalata** -- poori script ek bade command jaisi hai.

```
Instance A: EVALSHA tokenBucket rl:login:x  --\
Instance B: EVALSHA tokenBucket rl:login:x  ---> Redis queue: [A ki script] [B ki script]
                                                   A: tokens 1 -> 0, ALLOW
                                                   B: tokens 0     -> REJECT
```

Read, math, write -- sab ek step. **1 round trip, 0 race, 0 retry.**

Trade-off: script chalte waqt Redis blocked hai. Isliye script **chhoti aur O(1)** honi chahiye -- hamari ~10 lines, microseconds. Kabhi loop over thousands of keys wali script mat likho (`busy script` -> saare clients latak jaate hain).

### Scenario 5 -- Distributed lock kyun nahi?

"Race hai -> lock lagao" pehla instinct hai. Dekho kya hota:

```
per request:
  SET lock:rl:x token NX PX 100   (1 round trip)
  HMGET ...                       (2)
  HSET ...                        (3)
  DEL lock (Lua check-and-del)    (4)
```

- **4 round trips** vs 1 -> latency ~4x, Redis ops ~4x (100K RPS -> 400K ops/sec -> 3 primaries ki jagah ~8+).
- **Hot key par lock contention:** abusive client ki 1000 requests ek hi lock ke liye line mein -- lock na mile toh wait/retry. Ye limiter khud DoS ban jaata hai.
- **Lock holder crash / GC pause** -> lock TTL tak sab atke.

Lua script same guarantee deta hai (mutual exclusion on that key) **bina lock ke**, kyunki Redis khud serialize karta hai. URL Shortener wala rule yahan bhi: **"distributed lock last option -- pehle dekho atomic operation kaam kar sakta hai kya."**

| Approach | Round trips | Race-safe? | Contention mein | Verdict |
|---|---|---|---|---|
| GET then SET | 2 | No | Over-admission | Bug |
| INCR (fixed window) | 1-2 | Yes | Fine | Sirf fixed window ke liye |
| MULTI/EXEC | 1 | Read-decide-write nahi kar sakta | -- | Kaam ka nahi |
| WATCH + retry | 3-4+ | Yes | Retry storm | Slow |
| Distributed lock | 4 | Yes | Lock queue | Terrible |
| **Lua script** | **1** | **Yes** | **Fine (Redis serializes)** | **Hamara** |

### Scenario 6 -- Node.js event loop: in-process fallback ko lock kyun nahi chahiye?

Redis down hone par `MemoryTokenBucketStore` chalta hai. Ek Node process mein 500 concurrent requests -- race?

```ts
consume(key: string, rule: RateLimitRule, cost = 1): StoreResult {
  const now = Date.now();
  const b = this.buckets.get(key) ?? { tokens: this.capacity(rule), ts: now };
  b.tokens = Math.min(this.capacity(rule), b.tokens + (Math.max(0, now - b.ts) * this.rate(rule)) / 1000);
  b.ts = now;
  // ... tokens >= cost ? allow : reject
  this.buckets.set(key, b);
}
```

**Code Explanation:**

- Function **synchronous** hai -- ek bhi `await` nahi.
- JavaScript single-threaded hai, toh `get -> math -> set` ke beech **koi doosri request nahi ghus sakti**. Event loop ek callback poora khatam karke hi agla uthata hai.
- Isliye bina lock, bina mutex -- automatically atomic (**sirf is process ke andar**).
- **Rule:** is function mein kabhi `await` mat daalna (e.g. "log to remote before set"). Ek `await` aaya aur race wapas aa gaya -- bilkul Scenario 1 jaisa, bas ek process ke andar.

(Poora `MemoryTokenBucketStore` Part 15 ke failure section mein.)

### Scenario 7 -- Clock skew: Redis `TIME` kyun?

**Clock skew ka matlab:** do servers ki ghadiyaan thodi alag time batati hain (NTP sync ke bawajood 10-100 ms, kabhi seconds).

Agar script ko `now` Node se bhejte (`ARGV[4] = Date.now()`):

```
Instance A clock: 10:00:00.000     Instance B clock: 10:00:00.800 (800 ms aage)

B ki request:  ts = ...00.800 likha
A ki request:  now = ...00.000 -> elapsed = now - ts = -800 ms -> max(0, ...) = 0
               lekin A ne ts = ...00.000 likh diya (ts PEECHE chala gaya)
Phir B ki request (now = ...00.810): elapsed = 810 ms, asal mein sirf ~10 ms beeta
               -> 800 ms ke free tokens mil gaye
```

Skew ki wajah se tokens galat bante hain -- kabhi extra, kabhi kam. Aur ek bigdi clock wala server (5 sec aage) us client ko baar baar free refills deta rahega.

**Fix:** script ke andar `redis.call('TIME')` -- har decision **ek hi clock** (Redis primary) se. Us key ke saare checks usi primary par hote hain, toh consistent.

Bache hue edge cases:

- **Failover:** naya primary (purana replica) ki clock thodi alag ho sakti hai. `math.max(0, now - ts)` negative elapsed ko 0 kar deta hai -- worst case thodi der refill slow. Acceptable.
- **Replication:** Redis 5+ scripts ko **effects replication** se replicate karta hai (script ke commands nahi, uske final `HSET`/`PEXPIRE` replica ko jaate hain), isliye `TIME` jaisa non-deterministic call script mein allowed hai. Bahut purane Redis (3.2-4.x) mein script ke shuru mein `redis.replicate_commands()` chahiye tha.

### Scenario 8 -- Redis Cluster: CROSSSLOT aur hash tags

**Redis Cluster basics:** 16,384 **hash slots**. Har key ka slot = `CRC16(key) mod 16384`. Har primary kuch slots ka owner. Hamare 3 primaries -> har ek ~5461 slots.

**Rule:** ek script / MULTI ke saare keys **same slot** mein hone chahiye, warna error: `CROSSSLOT Keys in request don't hash to the same slot`.

**Hamara script single-key hai** (`KEYS[1]` sirf ek) -> ye problem aati hi nahi. `rl:api-free:ak_live_9f2c` jis slot mein ho, script wahin chalti hai.

**Hash tags kab chahiye?** Maan lo requirement aayi: "API key par **10 per second AND 1000 per minute** dono -- aur dono ek atomic step mein check karo (ek pass hua aur doosra fail, toh pehle wale ka token bhi waste na ho)". Ab script 2 keys touch karegi:

```
rl:ak_123:sec   -> slot 4211  (primary 1)
rl:ak_123:min   -> slot 12876 (primary 3)    -> CROSSSLOT error
```

**Hash tag ka matlab:** key mein `{...}` ke andar ka hissa hi slot decide karta hai.

```
rl:{ak_123}:sec   -> CRC16("ak_123") -> same slot
rl:{ak_123}:min   -> CRC16("ak_123") -> same slot    -> ek script mein dono OK
```

(Upar ke slot numbers sirf illustration hain.)

Trade-off: ek client ki saari keys ek hi node par -> woh client hot hua toh wahi node garam (Part 15 hot key). Isliye hash tag **client-level** rakho (`{ak_123}`), kabhi `{rl}` jaisa common tag mat lagao -- warna **saari** keys ek slot mein, cluster ka fayda khatam.

> Interview line: "Race condition se bachne ke liye main poora read-refill-decide-write ek Lua script mein rakhunga. Redis commands ek thread par serially chalata hai, toh script atomic hai -- 1 round trip, na WATCH retries, na distributed lock. Time Redis ke `TIME` se lunga taaki Node servers ka clock skew math na bigaade. Script single-key hai toh Redis Cluster mein CROSSSLOT ka issue nahi; multi-key limits chahiye toh hash tags `{clientId}` se keys ek slot mein rakhunga."

---

## PART 15 -- Redis State Deep Dive (ye cache nahi hai)

### Pehle farak samjho: cache vs state

URL Shortener mein Redis **cache** tha: data asal mein Postgres mein tha, Redis sirf copy. Miss hua -> DB se laao.

Rate limiter mein Redis **source of truth** hai counters ka. Koi "DB se laao" nahi hai. Aur har check **read + write** hai -> "read-heavy, cache lagao" wala trick yahan kaam nahi karta.

| | URL Shortener | Rate Limiter |
|---|---|---|
| Redis role | Cache (copy) | State (source of truth, ephemeral) |
| Operation | Mostly `GET` | Har baar read + write (Lua) |
| Miss ka matlab | DB se laao | Naya client -> full bucket |
| Data gaya toh | DB se wapas | Limits reset (thodi der zyada allow) |
| Staleness issue | Stale URL | Nahi -- har baar fresh compute |

Toh "cache hit/miss/invalidation" ki jagah yahan ye sawaal hain: key design, value, TTL, eviction, hot key, restart, failure, persistence.

### Key design

```
rl:<ruleId>:<identifierValue>

rl:api-free:ak_live_9f2c
rl:api-pro:ak_live_77aa
rl:anon-ip:203.0.113.7
rl:login:203.0.113.7:priya@example.com
```

- `rl:` -- namespace. Redis mein aur kuch bhi ho, `SCAN MATCH rl:*` se sirf limiter keys.
- `ruleId` -- **key mein rule hona zaruri hai**: same API key par 2 rules lag sakte hain (per-key + per-route), alag buckets chahiye.
- `identifierValue` -- API key id / user id / IP. Login mein IP + username dono (ek IP se kai users try, ya ek user par kai IPs -- dono ka alag bucket).
- **Plan key mein nahi** (`api-free` rule id hi plan batata hai). Customer free se pro gaya -> naya rule -> naya bucket (full) -- chalta hai.
- **Raw user input key mein daalne se pehle** normalize karo (email lowercase, trim; bahut lamba ho toh hash) -- warna `Priya@x.com` aur `priya@x.com` alag buckets = attacker ko double attempts.

### Value -- Redis hash

```
HGETALL rl:login:203.0.113.7:priya@example.com
1) "tokens"  2) "3.4166666666666665"
3) "ts"      4) "1700000030000"
```

- **Hash kyun, 2 alag keys kyun nahi?** Ek key = ek slot = ek TTL; 2 keys hote toh 2 TTL manage karo aur Cluster mein alag slots.
- **JSON string kyun nahi?** Lua mein JSON parse (`cjson`) extra CPU; hash fields seedhe padh lo.
- `tokens` fractional store hota hai (lazy refill ka math), `ts` ms mein.
- Chhote hash Redis internally compact encoding (listpack) mein rakhta hai -- isliye ~150 bytes per key.

### TTL -- idle clients ka auto cleanup

```
PEXPIRE key ceil(capacity * 1000 / rate) + 1000     -> 61000 ms for our rules
```

- Har check TTL ko **aage badha deta hai**. Active client ki key kabhi expire nahi hoti.
- Client 61 sec chup raha -> key gayi -> memory free. Wapas aaya -> "naya = full bucket", jo waise bhi full hi hota. **Correctness par zero asar.**
- Memory math (spec): **10M identities x ~150 bytes = ~1.5 GB**. Aur asal mein kisi bhi pal sirf **pichle ~61 sec mein active** clients ki keys hoti hain, toh usually isse kam. **Memory bottleneck nahi hai, throughput hai** (~100K checks/sec).

### Eviction policy -- sabse chupa hua bug

Redis memory `maxmemory` tak pahunchi toh kya kare? `maxmemory-policy` decide karta hai.

URL Shortener mein `allkeys-lru` sahi tha (cache hai, koi bhi key hatao, DB se wapas aa jaayegi). **Rate limiter mein ye silently limits reset kar sakta hai:**

```
Attacker ka bucket: tokens = 0  (block hai)
Redis memory full -> allkeys-lru ne kuch keys hataayi -> attacker ki key bhi gayi
Agli request: key nahi -> "naya client" -> FULL bucket -> 5 aur attempts
```

Koi error nahi, koi log nahi. Bas limits chup-chaap dheele.

| Policy | Kya hota | Rate limiter ke liye |
|---|---|---|
| `allkeys-lru` | Koi bhi kam-use key hatao | Risky -- busy-but-blocked keys bhi ja sakti hain; limits silently reset |
| `volatile-ttl` | TTL wali keys mein se **sabse kam TTL** bachi wali hatao | **Best trade-off (dedicated Redis):** sabse kam TTL = sabse zyada der se idle = bucket lagbhag full ho chuka -> hataane se almost kuch nahi khota |
| `noeviction` | Naye writes fail (`OOM` error) | Script error -> hamara fallback (memory store) chalega. Safe, lekin fallback par limits approx |

**Practical choice:**

1. Rate limiter ke liye **alag Redis cluster** (URL cache ya sessions ke saath share mat karo -- unka memory spike limiter ko evict karega).
2. Memory ko 2-3x headroom ke saath size karo (1.5 GB data -> har primary par kaafi RAM).
3. `volatile-ttl` (ya `noeviction` + alert). Humari saari keys par TTL hai, toh volatile policy sab keys ko cover karti hai.
4. **Alert** `used_memory` 70% par aur `evicted_keys > 0` par -- eviction ho raha hai matlab sizing galat hai.

### Hot key -- ek client, ek shard

Redis Cluster mein **ek key hamesha ek hi primary** par. Hamara budget ~50K script ops/sec per primary (3 primaries -> ~33K each at peak).

**Normal clients hot nahi hain:** api-pro = 1000/min = ~17 req/sec. Kuch nahi.

**Problem cases:**

1. **DDoS / scraper IP:** ek IP 30,000 req/sec maar raha hai anonymous search par. `anon-ip` limit 60/min hai, toh 99.9% rejected -- **lekin har rejected request bhi ek Redis script call hai!** 30K calls/sec ek hi key par = us primary ka ~60% budget. Baaki saare clients jinki keys us primary par hain, slow.
2. **Enterprise customer** jiska override 3,000,000/min (50K/sec) hai -- ek key par ek primary ki poori capacity.

**Mitigations (simple se complex):**

**(a) Edge / gateway par coarse IP limits.** nginx / API gateway / Cloudflare pehle hi flood kaat de (e.g. 100 req/sec per IP), Node tak pahunche hi nahi. Architecture mein ye already hai -- DDoS ka pehla jawab yahi hai, app-level limiter nahi.

**(b) Local deny cache.** Redis ne bola "reject, retryAfterMs = 11501" -> ye instance agle 11.5 sec us key ke liye **Redis ko call hi na kare**, seedha 429:

```ts
const denyUntil = new Map<string, number>();   // key -> epoch ms
const MAX_DENY_KEYS = 100_000;

export async function checkWithDenyCache(key: string, rule: RateLimitRule, cost = 1) {
  const until = denyUntil.get(key);
  if (until !== undefined) {
    if (Date.now() < until) return { allowed: false, remaining: 0, retryAfterMs: until - Date.now() };
    denyUntil.delete(key);
  }
  const [allowed, remaining, retryAfterMs] = await redis.tokenBucket(key, rule.capacity, rule.refillPerSec, cost);
  if (allowed === 0 && retryAfterMs > 0 && denyUntil.size < MAX_DENY_KEYS) {
    denyUntil.set(key, Date.now() + retryAfterMs);
  }
  return { allowed: allowed === 1, remaining, retryAfterMs };
}
```

**Code Explanation:**

- `denyUntil` -- is process ki memory: "is key ko kab tak seedha mana karna hai".
- `if (Date.now() < until)` -- abhi bhi blocked -> Redis call nahi, turant 429. Attacker ki 30K req/sec mein se ~10 instances x 1 call per ~retry window hi Redis tak jaati hain.
- `denyUntil.delete(key)` -- time khatam, entry saaf, ab Redis se asli decision.
- `allowed === 0 && retryAfterMs > 0` -- sirf reject par cache karo. Allowed ko cache **mat** karo -- warna tokens count hi nahi honge.
- `MAX_DENY_KEYS` -- botnet ke lakhon IPs se map bina limit na badhe (memory safety). Production mein TTL wala LRU (`lru-cache`) better.
- **Correctness safe hai?** Haan -- Redis ne khud kaha tha itne ms tak token nahi banega, toh local deny wahi answer de raha hai. `Date.now()` vs Redis `TIME` ka chhota skew bas kuch ms ka farak laata hai.

**(c) Local token lease (batching) -- bade allowed traffic ke liye.** Enterprise client 50K/sec *allowed* hai toh deny cache kaam nahi aayega. Har instance Redis se ek saath **50 tokens** le le (`cost = 50` -- script ka `cost` param yahi kaam deta hai) aur apni memory se serve kare. Redis calls 50x kam. Trade-off: 10 instances x 50 = **500 tokens tak** kisi instance mein "phanse" reh sakte hain -> thoda over/under admission. Bade limits par ye error negligible hai.

**(d) Key splitting.** `rl:ent:ak_x:0 ... :3` -- 4 sub-buckets, har ek capacity/4 aur rate/4, request random sub-key par. Alag keys -> alag slots -> alag primaries. Complex; bahut rare cases ke liye.

### "Stampede" equivalent -- Redis restart = sab buckets full

Cache mein stampede = TTL expire -> sab DB par. Rate limiter mein iska cousin:

**Redis restart / failover data loss -> saare keys gaye -> har client ka bucket FULL.**

- Har client **ek extra burst** (capacity tak) le sakta hai: free = 100, pro = 1000, login = 5 attempts.
- Worst case, jo clients abhi blocked the (tokens = 0), unblock ho jaate hain -- ek baar.
- **Acceptable?** Normal API ke liye **haan** -- ek baar ka burst, phir refill rate lagoo. Spec bhi kehta hai "small over-admission OK". Login ke liye: 5 extra attempts ek baar -- password lockout / CAPTCHA jaise doosre layers bhi hain.
- Isliye AOF/fsync ka cost dene layak nahi (neeche).

**Asli stampede ek aur hai -- synchronized retries.** 10,000 clients ko 10:00:00 par 429 mila, sab ko `Retry-After: 12`. 10:00:12 par sab ek saath wapas. Fix client side hai: SDK / docs mein **retry with jitter** (12 sec + random 0-3 sec). Hamara `Retry-After` minimum wait batata hai, client jitter jode.

### Redis failure -> local memory fallback

Spec ka policy: Redis error/timeout (`commandTimeout: 20`) -> **`MemoryTokenBucketStore`, capacity aur refill ko instance count se divide karke**.

**Kyun divide?** Load balancer requests ko roughly barabar baant ta hai. 10 instances, har ek apna local bucket:

```
api-free: capacity 100, refill 1.667/s  (global)
Per instance (10 instances): capacity 10, refill 0.1667/s
10 instances x 10 = ~100 global   -> approx wahi limit
```

Simulation: 10 instances wala store, t=0 par 12 requests ek instance par -> **10 allow**, 11th reject with `retryAfterMs = 6000` (1 / 0.1667 = 6 sec).

```ts
export class MemoryTokenBucketStore {
  private buckets = new Map<string, { tokens: number; ts: number }>();

  constructor(private readonly instanceCount: number, private readonly maxKeys = 100_000) {}

  consume(key: string, rule: RateLimitRule, cost = 1) {
    const capacity = Math.max(1, Math.floor(rule.capacity / this.instanceCount));
    const rate = rule.refillPerSec / this.instanceCount;
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: capacity, ts: now };
    b.tokens = Math.min(capacity, b.tokens + (Math.max(0, now - b.ts) * rate) / 1000);
    b.ts = now;

    let allowed = false;
    let retryAfterMs = 0;
    if (b.tokens >= cost) {
      b.tokens -= cost;
      allowed = true;
    } else {
      retryAfterMs = Math.ceil(((cost - b.tokens) * 1000) / rate);
    }

    this.buckets.delete(key);
    this.buckets.set(key, b);
    if (this.buckets.size > this.maxKeys) {
      this.buckets.delete(this.buckets.keys().next().value!);
    }
    return { allowed, remaining: Math.floor(b.tokens), retryAfterMs };
  }
}
```

**Code Explanation:**

- `instanceCount` -- config se (deployment ka replica count). Autoscaling mein ye badalta hai -- approx hi rahega, aur yahi accept kiya hai.
- `Math.max(1, Math.floor(capacity / instanceCount))`, `refillPerSec / instanceCount` -- global limit ko instances mein baanto. `Math.max(1, ...)` chhote limits ke trap se bachata hai (neeche dekho).
- Baaki math **bilkul Lua script jaisa** -- same algorithm, isliye behaviour predictable.
- `Date.now()` -- yahan local clock theek hai, kyunki bucket isi process ka hai (skew ka sawaal hi nahi).
- Koi `await` nahi -> Part 14 Scenario 6: event loop ki wajah se atomic.
- `delete` phir `set` -- JS `Map` insertion order yaad rakhta hai; delete+set se ye key "sabse naya" ban jaati hai. `keys().next()` = sabse purana -> simple **LRU** eviction. Botnet ke lakhon IPs se memory na phate.
- `remaining: Math.floor(...)` -- Lua jaisa integer.

**Limitations (interview mein bolo):**

- Traffic barabar nahi baanta (sticky connections, ek instance naya) -> kisi client ko thoda zyada/kam.
- **Chhote limits ka trap:** login = capacity 5. 10 instances par 5 / 10 = **0.5 capacity per instance**. Bucket kabhi 0.5 se upar nahi jaata (`min(capacity, ...)`), aur har request ko 1 token chahiye -> **fallback mein har login attempt reject** (aur `retryAfterMs` jhootha wait batayega). Isliye code mein per-instance capacity `Math.max(1, Math.floor(capacity / instanceCount))` hai: login ko har instance par kam se kam 1 token. Trade-off: outage ke time poori fleet mil ke ~10 login attempts/min (instances x 1) allow kar sakti hai -- 2x loose, lekin phir bhi limited. (Part 2 aur Part 4 mein same rule.)
- Redis wapas aaya -> seedha Redis state par switch; local state phenk do.

Aur ye hamesha yaad rakho: **fail open (with fallback) for normal API** -- limiter girne se API nahi girni chahiye.

### Persistence -- AOF chahiye?

| Option | Kya deta | Rate limiter ke liye |
|---|---|---|
| No persistence | Restart = sab gaya | Chalta hai (upar "stampede" wala one-time burst) |
| RDB snapshot | Har kuch minute ka snapshot | Useless -- 5 min purane buckets waise bhi refill ho chuke hote |
| AOF `everysec` | ~1 sec tak ka data bachta hai | Har write AOF file mein append + har sec fsync (100K writes/sec!) + rewrite ka kaam -- cost zyada, fayda kam |
| **Replica + auto failover** | Primary gaya -> replica promote, data mostly bacha | **Haan** -- availability ke liye |

- Counters **ephemeral** hain. Kho gaye toh limits kuch der reset -- acceptable.
- Replication **async** hai: failover par last kuch ms ke updates kho sakte hain -> kuch requests extra allow. Acceptable.
- Asli zarurat **availability** ki hai (replica + Sentinel / Cluster failover / ElastiCache Multi-AZ), durability ki nahi.

### EVALSHA + NOSCRIPT

**EVAL** har baar poori script text bhejta hai (~700 bytes). **EVALSHA** sirf script ka SHA1 hash (40 chars) bhejta hai; Redis apne script cache se chalata hai.

**Problem:** Redis restart / failover ke baad script cache **khaali** hota hai (scripts persist nahi hote). Tab EVALSHA -> error `NOSCRIPT No matching script`.

**ioredis `defineCommand` ye khud sambhalta hai:**

```
redis.tokenBucket(...)
  -> EVALSHA <sha> ...        (normal path, chhota payload)
  -> NOSCRIPT error aaya?
  -> EVAL <poori script> ...  (Redis script cache mein bhi load ho jaati hai)
  -> agli baar se phir EVALSHA
```

Isliye hum raw `redis.evalsha()` khud nahi likhte. (Redis 7 mein **Functions** (`FUNCTION LOAD`) bhi hain jo persist + replicate hote hain -- naya alternative, lekin `defineCommand` simple aur kaafi hai.)

### Pipelining -- ek request par 2 rules

Kabhi ek request par 2 limits lagti hain: per-IP (`anon-ip`) + per-route (`login`). Sequentially:

```ts
// 2 round trips (~2 x 0.5 ms)
const a = await redis.tokenBucket(ipKey, ...);
const b = await redis.tokenBucket(loginKey, ...);
```

Better:

```ts
const redis = new Redis.Cluster(nodes, {
  enableAutoPipelining: true,
  redisOptions: { enableOfflineQueue: false, maxRetriesPerRequest: 1, commandTimeout: 20 },
});

const [ipResult, loginResult] = await Promise.all([
  redis.tokenBucket(ipKey, ipRule.capacity, ipRule.refillPerSec, 1),
  redis.tokenBucket(loginKey, loginRule.capacity, loginRule.refillPerSec, 1),
]);
```

**Code Explanation:**

- `enableAutoPipelining: true` -- ioredis same event loop tick mein bheje gaye commands ko **ek hi network write** mein bhejta hai (per node). 100K RPS par ye syscalls aur packets kaafi kam karta hai.
- `redisOptions: { ... commandTimeout: 20 ... }` -- spec ke options: offline queue band (Redis down -> turant error -> fallback), 1 retry, 20 ms timeout.
- `Promise.all([...])` -- dono checks parallel. Latency ~1 round trip, 2 nahi.
- Dono keys alag slots par ho sakti hain -- koi problem nahi, kyunki ye **2 alag scripts** hain (CROSSSLOT sirf ek command ke andar multi-key par aata hai). Trade-off: ye 2 checks atomic nahi -- IP bucket se token kat gaya aur login reject hua. Chalta hai; strict chahiye toh hash tag + 2-key script (Part 14 Scenario 8).

### Redis state ka final picture

```
Request
  |
  v
[Edge/Gateway]  coarse per-IP flood limit (Node tak pahunche hi nahi)
  |
  v
[Node: local deny cache]   ~0.01 ms   blocked keys ke liye Redis call skip
  | not denied
  v
[Redis Cluster: Lua token bucket]   ~0.5-1 ms   source of truth, TTL 61 s, volatile-ttl
  | Redis error / 20 ms timeout
  v
[Node: MemoryTokenBucketStore]   capacity / instanceCount   approx limit, metric + warn log
```

### Interview mein Redis state kaise explain karun

> "Rate limiter mein Redis cache nahi, ephemeral state store hai -- har check read + write hai, isliye 'cache in front' kaam nahi karta. Key `rl:<ruleId>:<identifier>`, value ek hash `{tokens, ts}`, aur PEXPIRE 'full refill time + 1 second', toh idle clients ki key khud hat jaati hai bina correctness change kiye -- 10M clients par ~1.5 GB. Dedicated cluster rakhunga, eviction `volatile-ttl` ya noeviction, kyunki `allkeys-lru` blocked clients ke bucket delete karke silently limits reset kar sakta hai. Hot keys ke liye edge par IP limits, local deny cache, aur bahut bade limits ke liye token leasing. Persistence nahi chahiye -- restart par ek baar burst acceptable hai; replica availability ke liye. Redis down ho toh local memory bucket with limit divided by instance count."

---

## Remember

> **Rate limiter ka dil ek atomic "read-refill-decide-write" step hai: token bucket ke 2 numbers, Redis ke andar ek Lua script, Redis ki ghadi se time.** Redis yahan cache nahi, state hai -- TTL se khud saaf hoti hai, kho jaaye toh bas ek baar ka burst, aur Redis gire toh local bucket se kaam chalao.

## Quick Self-Test

1. Limit 5/min, fixed window. 0:59 par 5 aur 1:00 par 5 requests -- kitni allow hongi aur kyun? Sliding window counter same case mein kya karega (formula se)?
2. Token bucket capacity 5, refillPerSec 5/60. t=0 par 5 requests kharch, t=30s par kitne tokens honge? Retry-after formula batao.
3. `MULTI/EXEC` token bucket ke liye kaafi kyun nahi, aur Lua script atomic kyun hai?
4. Script mein `Date.now()` pass karne ki jagah `redis.call('TIME')` kyun? Aur `PEXPIRE` = "full refill time + 1s" rakhne se correctness par asar kyun nahi padta?
5. `allkeys-lru` rate limiter ke Redis par kaunsa silent bug la sakta hai? Ek DDoS IP ek key par 30K req/sec maare toh aap kya karoge?

---

**Next (Part 4):** Scaling (1x -> 10x -> 100x -> 1000x), Failure scenarios (Redis down, slow, failover, rules DB down, instance count change), Consistency (global vs local limits, approximate admission), Security, Observability (metrics, logs, tracing). "next" bolo.
