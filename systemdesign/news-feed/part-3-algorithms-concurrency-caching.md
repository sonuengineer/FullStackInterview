# News Feed -- HLD + LLD (Part 3: Algorithms -> Concurrency -> Caching)

> Is file mein prompt ke **Parts 13-15** hain: Chirp ke important algorithms (zero se, numbers ke saath), concurrency (double-tap post, retried fan-out, like races, delete during fan-out), aur caching (feed cache, post hydration cache, hot keys, stampede).
> Part 1-2 recap: **Chirp** ek Twitter/Instagram-style app hai -- 100M DAU, ~35K feed reads/s peak, ~350 posts/s peak. Core problem: **feed padhna = sau-do sau followees ke posts merge karna**. Hamara answer **hybrid** hai: normal users (< 10,000 followers) ka post Kafka `posts.created` -> fan-out workers -> har active follower ke `feed:{userId}` (Redis ZSET, newest 200) mein **push**; celebrities (>= 10,000) ka post sirf `timeline:{authorId}` mein, readers use **pull** karte hain. Feed read = `feed:{me}` + celeb timelines + `timeline:{me}` -> k-way merge -> filter -> 20 ka page -> hydrate (`post:{postId}`). Posts Cassandra mein, follows Postgres mein, Redis sirf derived cache -- sab rebuild ho sakta hai.
> Ab dekhenge ye choices **kyun** hain -- 10,000 hi kyun, ZSET hi kyun, offset kyun toot'ta hai, merge andar se kaise chalta hai -- aur jab ek hi feed par do workers ek saath likhein toh kya hota hai.
> Honest note: real Twitter/Facebook/Instagram feeds isse kahin complex hain (ML ranking, dozens of candidate sources). Unke internals ke references "publicly described" level par hedged hain.

---

## PART 13 -- Important Algorithms: "sau followees, ek feed, 200 ms mein"

### Problem kya hai?

Priya Chirp kholti hai. Woh 500 logon ko follow karti hai -- kuch dost, kuch news pages, 40 celebrities. Usse 200 ms mein unke latest 20 posts, sahi order mein chahiye. Aur jab woh scroll kare, na koi post do baar dikhe, na koi chhoot jaaye -- chahe us beech 50 naye posts aa gaye hon. Aur jab Virat (50M followers) post kare, system baith na jaaye.

| # | Algorithm | Kaunsa problem solve karta hai |
|---|---|---|
| 1 | Snowflake IDs | Distributed servers par unique + time-sortable post IDs, bina central counter |
| 2 | Pull (fan-out on read) | Feed read time par banana -- simple, lekin read mehenga |
| 3 | Push (fan-out on write) | Feed pehle se bana ke rakhna -- read sasta, celebrity par write explosion |
| 4 | Hybrid (threshold 10,000) | Dono ka best: normal users push, celebrities pull |
| 5 | Redis ZSET feed | Sorted feed, range by score, trim to 200 -- sab O(log N) |
| 6 | Cursor pagination | Infinite scroll bina duplicates / missing items |
| 7 | K-way merge (heap) | Kai sorted lists (pushed feed + celeb timelines + own) ko ek sorted page mein |
| 8 | Ranking V2 | Chronological se "relevant" feed -- simple scoring formula |

---

### Algorithm 1 -- Snowflake IDs: post ID jo khud time batati hai

#### Naive approach -- auto-increment

`posts.id BIGSERIAL` -- Postgres khud 1, 2, 3 deta hai. Ek DB par perfect. Lekin hamare posts **Cassandra** mein hain (koi auto-increment nahi), aur 1K posts/s spike par har post ke liye ek central counter se ID lena = ek single point of failure + har write par extra network hop. Post Service ke 30 pods ek hi counter ke liye line mein.

#### Doosra option -- UUID v4

Har pod random 128-bit UUID bana le -- koi coordination nahi. Lekin **random** hai: `posts_by_author` mein `ORDER BY post_id DESC` ka matlab "newest first" nahi rahega, cursor mein time nahi, aur 128 bits = 36-char string. Feed ke liye sabse zaruri cheez -- **time order** -- kho gayi.

#### Snowflake -- 64 bits, teen hisse

URL Shortener Part 3 mein humne Snowflake dekha tha aur wahan **overkill** bola tha (~300 writes/s). Yahan woh sahi tool hai: posts ko time-sorted hona hi chahiye, aur writers bahut saare pods hain.

```
| 1 bit | 41 bits: ms since custom epoch | 10 bits: worker | 12 bits: sequence |
   0      ~69.7 saal tak                    1,024 workers     har ms mein 4,096 IDs
```

- **Custom epoch** -- time 1970 se nahi, apne chosen din se gino taaki 41 bits zyada saal chalein. Hum Twitter ka publicly known epoch `1288834974657` (2010-11-04) use kar rahe hain -> 41 bits **2080-07-10** tak chalenge.
- **Worker** -- har Post Service pod ka unique number (0-1023) -- e.g. Kubernetes StatefulSet ordinal, ya startup par Redis/ZooKeeper se lease. Do pods kabhi same ID nahi banayenge.
- **Sequence** -- same ms, same pod mein counter. 4,096/ms/pod = ~4M/s per pod. Hamare 1K/s ke liye kaafi se zyada.

#### Worked example -- ek real ID ko todo

Post ID `2100907437367382021` (node se decompose kiya):

```
id >> 22              = 500895366041      (ms since epoch)
+ epoch 1288834974657 = 1789730340698     -> 2026-09-18T11:19:00.698Z
(id >> 12) & 1023     = 37                (worker 37)
id & 4095             = 5                 (us ms ka 6th ID)
```

Aur 1 ms baad bani ID: `2100907437371576325` -- farak **4,194,304 = 2^22**. Yaani ID ka bada number = baad ka time. **Sort by id = sort by time.**

```ts
// src/utils/snowflake.ts
const EPOCH = 1288834974657n;                  // custom epoch (ms)
const WORKER_BITS = 10n, SEQ_BITS = 12n;
const MAX_SEQ = (1n << SEQ_BITS) - 1n;         // 4095

export class Snowflake {
  private lastMs = -1n;
  private seq = 0n;
  constructor(private readonly workerId: bigint) {
    if (workerId < 0n || workerId > 1023n) throw new Error('workerId must be 0..1023');
  }

  next(): string {
    let now = BigInt(Date.now());
    if (now < this.lastMs) {                                  // clock peeche gayi (NTP correction)
      if (this.lastMs - now > 5n) throw new Error('CLOCK_MOVED_BACKWARDS');
      now = this.lastMs;                                      // chhota drift: purane ms par hi chalo
    }
    if (now === this.lastMs) {
      this.seq = (this.seq + 1n) & MAX_SEQ;
      if (this.seq === 0n) {                                  // is ms ke 4096 khatam
        while (BigInt(Date.now()) <= this.lastMs) { /* agle ms ka wait */ }
        now = BigInt(Date.now());
      }
    } else {
      this.seq = 0n;
    }
    this.lastMs = now;
    return (((now - EPOCH) << (WORKER_BITS + SEQ_BITS)) | (this.workerId << SEQ_BITS) | this.seq).toString();
  }
}

export const createdAtMsOf = (id: string): number => Number((BigInt(id) >> 22n) + EPOCH);
```

**Code Explanation:**

- `1288834974657n` -- `n` suffix = **BigInt**. Poora calculation BigInt mein, kyunki 64-bit number JS `number` mein fit nahi hota (neeche).
- `now < this.lastMs` -- server ki clock NTP ne peeche kar di. 5 ms tak ka drift: purane ms par hi IDs banao (sequence badhta rahega, order safe). Zyada drift -> error; pod ko unhealthy mark karo, duplicate ID ka risk mat lo.
- `(this.seq + 1n) & MAX_SEQ` -- sequence 4095 ke baad 0 par wrap. 0 hua matlab is ms ke 4,096 IDs khatam -> agle ms tak spin (1 ms se kam).
- Last line -- bits jodna: timestamp ko 22 bits left shift, worker ko 12 bits, sequence as-is, `|` se combine. `.toString()` -- **string** return, number nahi.
- `createdAtMsOf` -- ID se hi `createdAtMs` nikal lo (`>> 22` + epoch). Fan-out worker ko alag timestamp field ki zarurat bhi nahi.
- Node se test: 20,000 IDs ek loop mein -> sab unique, sab strictly increasing.

#### Time-sortable IDs feed mein kahan kaam aate hain?

- **Cassandra `posts_by_author`** -- `CLUSTERING ORDER BY (post_id DESC)` = automatically newest first. User timeline ka query bina extra `created_at` index ke.
- **Tie-break** -- do posts ka `createdAtMs` same ho toh postId se order (Algorithm 6). Deterministic.

#### Bada jaal: 2^53

JS `number` ek **double** (IEEE 754) hai: 53 bits tak ke integers exactly. `2^53 = 9,007,199,254,740,992` (~9e15). Hamari IDs ~**2.1e18** -- 61 bits. Node se:

```
BigInt id             = 2100907437367382021
Number(id)            = 2100907437367382000     (last digits gaye!)
Number(id + 100n)     = 2100907437367382000     (do alag posts -> SAME number)
JSON.parse('{"id":2100907437367382021}').id  -> 2100907437367382000
```

2^60 aur 2^61 ke beech doubles ke beech ka gap **256** hai -- yaani 256 consecutive IDs ek hi double ban jaati hain. Agar API ne ID number ki tarah bheji, toh browser ka `JSON.parse` chupchaap galat ID bana dega -> user like karega kisi aur post ko.

**Redis ZSET score bhi double hai.** `ZADD feed:42 2100907437367382021 p1` karo toh score round ho jaata hai -- same ms ki alag posts ka order garbage, aur score se cursor exact nahi.

**Decision (spec):**

| Jagah | Kaise rakhte hain | Kyun |
|---|---|---|
| JSON API | `"id": "2100907437367382021"` (string) | Browser/JS precision loss nahi |
| Node code | `string`, math chahiye toh `BigInt(id)` | Same |
| Cassandra / Postgres | `bigint` (64-bit, exact) | DB ke liye koi problem nahi |
| Redis ZSET | **score = `createdAtMs`**, **member = postId string** | `1789730340698` ~1.8e12 -- 2^53 se bahut chhota, exact |

> **Interview line:** "Post IDs Snowflake hain -- 41 bits ms timestamp, 10 bits worker, 12 bits sequence -- toh har pod bina coordination unique IDs banata hai aur ID ka order hi time ka order hai; Cassandra mein post_id DESC clustering se timeline free mein sorted milti hai. Lekin IDs ~2.1e18 hain, 2^53 se bade, toh JS number aur Redis ZSET score (dono doubles) unhe exact nahi rakh sakte -- 256 IDs ek double par collapse hoti hain. Isliye API aur Node mein IDs strings hain, aur ZSET mein score createdAtMs, member postId string."

---

### Algorithm 2 -- Pull (fan-out on read)

**Fan-out on read ka matlab:** post likhte waqt kuch extra nahi; jab koi feed khole, **tabhi** uske saare followees ke posts laao aur merge karo.

```
GET /v1/feed (Priya)
  1. following = SELECT followee_id FROM follows WHERE follower_id = Priya      (500 rows)
  2. har followee ke liye: posts_by_author (author, current month) LIMIT 20    (500 queries)
  3. 500 sorted lists -> k-way merge -> top 20
  4. hydrate (post:{id}, author, likes) -> response
```

**Write cost:** post = 1 Cassandra write. Bas. Celebrity ho ya normal user -- same.

**Read cost -- numbers:**

| | Value |
|---|---|
| Followees per open (Priya jaisi) | 500 |
| Cassandra partition reads per open | ~500 (month boundary par ~1,000 -- do buckets) |
| Peak feed reads | 35K/s |
| Cassandra reads/s for feeds | 35K x 500 = **17.5M/s** (average 200 followees par bhi **7M/s**) |
| Latency | 500 parallel queries ka **max** -- tail latency sabse slow partition decide karta hai |

Sabse badi problem **waste** hai: Priya 10 baar/din feed kholti hai, aur har baar same 500 partitions dobara padhe jaate hain, jabki beech mein shayad 3 naye posts aaye. Aur p99 < 200 ms mein 500 queries ka tail -- mushkil.

**Pull kab theek hai:** chhota app (hazaaron users), ya celebrities ke liye (neeche) -- jahan ek author ke posts ko lakhon readers padhte hain, toh woh ek hi hot, cached timeline hai.

---

### Algorithm 3 -- Push (fan-out on write)

**Fan-out on write ka matlab:** post create hote hi uski ID **har follower ke precomputed feed** mein daal do. Read = apna feed padho, bas.

```
Rahul (200 followers) post karta hai
  -> posts.created (Kafka) -> fan-out worker
  -> 200 followers: ZADD feed:{followerId} <createdAtMs> <postId>  + trim to 200
Priya feed kholti hai -> ZREVRANGEBYSCORE feed:{Priya} ... LIMIT 0 20 -> 1 Redis call
```

**Read cost:** 1 Redis range query + hydration. 35K/s x 1 = trivial.

**Write cost -- numbers:**

| | Value |
|---|---|
| Posts/day | 10M |
| Avg followers | 200 |
| Feed inserts/day | 10M x 200 = **2B/day** -> ~23K/s avg, **~69K/s peak** |
| Ek 50M-follower celebrity post | **50M ZADDs** -- 1M inserts/s par bhi **~50 s**; 50M x 64 B = **~3.2 GB** Redis memory ek post ke liye |
| Celebrity 10 posts/day | 500M inserts/day -- akele ek account |

Do bade problems (memory ka hisaab Algorithm 5 mein):

1. **Celebrity explosion** -- Virat ka ek post 50 second tak fan-out workers ko ghere rakhta hai; us beech Rahul ke post ka fan-out queue mein atka (Kafka partition lag) -> "p99 fan-out lag < 5 s" toot gaya.
2. **Wasted work for inactive users** -- 300M registered mein se 100M DAU. Agar sabko push karein toh roughly **2/3 writes** aise feeds mein jaate hain jo aaj koi kholega hi nahi (assumption: followers ka active ratio overall ratio jaisa). Isliye spec: push sirf **last 30 days active** followers ko; baaki ka feed open par rebuild.

---

### Algorithm 4 -- Hybrid: threshold 10,000

**Rule (spec):**

```
author.followerCount <  10,000  -> PUSH: active followers ke feed:{id} mein ZADD
author.followerCount >= 10,000  -> NO push; post sirf timeline:{authorId} mein; readers pull karte hain
(har author ka post timeline:{authorId} mein jaata hi hai -- read-your-own-writes ke liye bhi)
```

Read:

```
feed:{me}  (pushed, normal followees)
+ timeline:{celebId} for each celeb in celebs:{me}
+ timeline:{me}      (mera apna post turant dikhe)
-> k-way merge -> dedupe -> filter (deleted, blocked, unfollowed) -> 20 -> hydrate
```

#### 10,000 hi kyun? -- ek simple model se

Hamare paas real follower distribution nahi hai, toh ek **assumption** lete hain (sirf intuition ke liye):

- Follower counts **power law** follow karte hain (thode accounts ke bahut followers, zyadatar ke kam): truncated Pareto, alpha = 1.3, mean ~200 (spec), max 50M.
- Har user **same rate** se post karta hai (real mein celebrities zyada post karte hain -- neeche).
- Har follow edge ek fan-out write hai jab author post kare.

Node simulation ka result:

| Threshold | Celebrity accounts (of 300M) | Fan-out writes jo push se hat gaye | Avg celeb timelines merged per read | Worst-case push per post |
|---|---|---|---|---|
| 1,000 | ~5.8M | 38.8% | ~78 | 999 |
| **10,000** | **~290K (~0.1%)** | **18.3%** | **~37** | **9,999** |
| 100,000 | ~14.6K | 8.0% | ~16 | 99,999 |
| 1,000,000 | ~750 | 2.9% | ~6 | 999,999 |

(Avg celebs merged = 200 x "writes hataye" share, kyunki ek follow edge = ek read-time source.) Agar celebrities normal users se **5x zyada** post karein, toh 10K threshold par push se hata hua hissa ~18% se **~53%** ho jaata hai.

**Is table ka asli sabak:**

- Threshold ka sabse bada fayda average savings nahi, **worst case** hai. 10K par ek post max **9,999 writes** = `FANOUT_BATCH` 1,000 ke **10 pipelines**. Rough estimate: ~10 ms per pipeline -> ~100 ms. 5 s lag target aaram se. 100K par ek post = 100 pipelines (~1 s), 1M par ~10 s -- ek hi post lag budget kha jaata.
- Threshold neeche karo (1K) -> push kam, lekin har read ~78 timelines merge karega -> Redis ops aur read latency badhte hain.
- Threshold upar karo (1M) -> reads saste, lekin 999K-follower accounts ka fan-out 10 s+ aur GBs memory.
- 10K beech ka point hai -- **tunable knob**, config mein rakho, `fanout_lag_seconds` aur `celebrity_merge_sources` metrics dekh ke adjust karo.

(Twitter ne publicly aisa hi mixed approach describe kiya hai -- zyadatar tweets fan-out, bahut bade accounts read time par merge. Exact threshold public nahi aur shayad fixed number bhi nahi.)

#### Read-time merge cost

Model ke hisaab se average reader ~37 celeb timelines follow karta hai (bahut logon ke liye 5-10, kuch ke liye 200+). Har read:

- 1 `ZREVRANGEBYSCORE feed:{me}` + 1 `timeline:{me}` + ~37 `timeline:{celeb}` -- sab **ek pipeline** mein (cluster mein node-wise grouped) -> ~1-2 network round trips.
- Har source se max 20 entries (page size) -> ~800 entries merge -> microseconds.
- 35K reads/s x ~39 range ops = **~1.4M Redis ops/s** cluster-wide -- aur ye celeb timelines **hot keys** hain (Part 15 mein in-process cache se ye 100x girta hai).

#### Threshold cross karna -- dono directions

**Upar (9,999 -> 10,000, "promotion"):**

- Naye posts ab push nahi hote, sirf `timeline:{author}`.
- Purane pushed posts followers ke feeds mein pade hain -- theek hai. Ab reader pull bhi karega -> wahi post do sources se aa sakta hai -> **merge dedupe by postId** (Algorithm 7) handle karta hai.
- Readers ka `celebs:{me}` cache 10 min TTL -- 10 min tak kuch readers is author ko pull nahi karenge aur naya post (jo push bhi nahi hua) nahi dikhega. Fix: promotion par `follows.changed`-style event se in followers ke `celebs:*` keys delete, ya 10 min tak **dono** karo (push bhi, timeline bhi).

**Neeche (10,000 -> 9,999, "demotion"):**

- Readers pull karna band karenge -> jo posts sirf timeline mein the (push kabhi hue hi nahi) woh feeds se **gayab**! Bug.
- Fix: demotion par **backfill job** -- author ke last 20 posts active followers ke `feed:{id}` mein ZADD (wahi job jo new-follow backfill karta hai), **uske baad** celeb flag hatao.
- **Hysteresis** (refinement): celebrity banna 10,000 par, wapas normal sirf 9,000 se neeche -- warna 9,999 <-> 10,000 par roz flapping aur baar baar backfill.

> **Interview line:** "Pure push celebrity par explode karta hai -- 50M-follower ka ek post 50M writes, ~50 s, 3.2 GB; pure pull har read ko 500 queries banata hai -- 35K/s par 17.5M reads/s. Hybrid: 10K se kam followers wale push, 10K+ wale pull, aur read par k-way merge. 10K is liye ki worst-case fan-out 9,999 writes -- 10 pipelines, 5 s lag target ke andar -- jabki power-law distribution mein ~0.1% accounts writes ka bada hissa banate hain. Ye tunable knob hai: kam threshold = zyada merge per read, zyada = zyada fan-out. Threshold cross karne par hysteresis aur demotion par backfill."

---

### Algorithm 5 -- Redis ZSET as the feed

**ZSET (sorted set) ka matlab:** Redis ka data type jismein har **member** unique hota hai aur uske saath ek **score** (number). Members hamesha score se sorted rehte hain. Andar se **skip list + hash table** (chhote sets ke liye compact listpack).

Kyun perfect fit:

| Feed ki zarurat | ZSET ka feature |
|---|---|
| Newest first | Score = `createdAtMs`, reverse range |
| "Is cursor se purane 20" | Range **by score** (`ZREVRANGEBYSCORE`) |
| Sirf latest 200 rakho | Trim **by rank** (`ZREMRANGEBYRANK`) |
| Same post do baar na aaye | Member unique -- dobara ZADD = sirf score update |
| Delete / unfollow cleanup | `ZREM feed:{id} <postId>` O(log N) |

Kyun nahi Redis **LIST** (`LPUSH` + `LTRIM`)? List insertion order rakhti hai, score nahi. Celebrity pull, backfill, rebuild -- ye sab **purane** posts beech mein daalte hain; list mein sahi jagah insert O(N). Aur duplicate check nahi. ZSET ye sab free deta hai.

**Commands (spec):**

```
ZADD feed:{uid} 1789730340698 2100907437367382021           # push
ZREMRANGEBYRANK feed:{uid} 0 -201                           # newest 200 rakho
ZREVRANGEBYSCORE feed:{uid} (1789730340698 -inf WITHSCORES LIMIT 0 20    # cursor se aage
```

- `ZREMRANGEBYRANK 0 -201` -- rank 0 = **sabse chhota score** (sabse purana). `-201` = end se 201th. Toh 0 se -201 tak = sab kuch **siwaay newest 200** ke. 205 entries -> 5 hate; 150 entries -> kuch nahi hata.
- `(1789730340698` -- `(` = **exclusive** (is score se strictly kam). `-inf` = neeche ki koi limit nahi. `LIMIT 0 20` = pehle 20.

**Complexity:**

| Command | Complexity | Hamare liye (N = 200) |
|---|---|---|
| `ZADD` | O(log N) | ~8 steps |
| `ZREMRANGEBYRANK` | O(log N + M), M = removed | Usually M = 0 ya 1 |
| `ZREVRANGEBYSCORE ... LIMIT 0 n` | O(log N + M), M = returned | log 200 + 20 |

**Memory:** spec ~64 bytes per entry (19-char member string + 8-byte score + skiplist/hash overhead). 200 x 64 = **12.8 KB/user**, 100M DAU = **~1.28 TB** -> ~20 shards of 64 GB + replicas. Isliye `FEED_MAX = 200`: 200 posts = ~10 screens of scrolling; usse aage koi jaaye toh fallback pull (rare, slow is OK).

> **Interview line:** "Feed Redis ZSET hai -- member postId string, score createdAtMs. ZADD O(log N), range by score cursor ke liye, ZREMRANGEBYRANK 0 -201 se newest 200 rakhta hoon, aur member unique hai toh retry par duplicate nahi. List nahi kyunki backfill aur celebrity merge purane posts beech mein daalte hain. ~64 bytes per entry, 12.8 KB per user, 100M DAU par ~1.28 TB -- sirf active users ke liye."

---

### Algorithm 6 -- Cursor pagination: offset kyun toot'ta hai

#### Naive approach -- `?page=2` (offset)

Priya ka feed (newest first): `p10 p9 p8 p7 p6 p5`. Page size 3.

```
t1  GET /feed?offset=0&limit=3   -> p10 p9 p8
t2  Rahul aur Amit ne post kiya  -> feed ab: p12 p11 p10 p9 p8 p7 p6 p5
t3  GET /feed?offset=3&limit=3   -> p9 p8 p7        <- p9, p8 DUBARA dikhe
```

Ulta case -- beech mein p10 delete hua:

```
t2' feed ab: p9 p8 p7 p6 p5
t3' GET /feed?offset=3&limit=3   -> p6 p5           <- p7 KABHI nahi dikha
```

Offset "kitne items skip karo" bolta hai, lekin list ka **shuru** badal raha hai (naye posts upar, trim neeche). 350 posts/s wale app mein feed har pal hilta hai.

#### Cursor -- "jahan chhoda tha, wahan se"

**Cursor ka matlab:** position number ki jagah **aakhri dekhi item ki pehchaan** bhejo: "is post se purane 20 do". Naye posts upar aayein ya kuch delete ho -- "p8 se purane" ka jawab nahi badalta. (Detail: [lesson 84](../../lessons/84-infinite-scroll-pagination-at-scale.md).)

```
page 1 -> last item p8 (score 80)  -> nextCursor = {s: 80, id: "p8"}
t2  p12, p11 aaye (score 120, 110) -- upar
page 2 -> score < 80 wale         -> p7 p6 p5         (koi duplicate nahi)
```

**Format (spec):** opaque base64url of `{ s: lastScoreMs, id: lastPostId }`.

```
{"s":1789730340698,"id":"2100907437367382021"}
-> eyJzIjoxNzg5NzMwMzQwNjk4LCJpZCI6IjIxMDA5MDc0MzczNjczODIwMjEifQ
```

(Node se encode + decode verify.) Opaque kyun? Client isse parse na kare -- kal hum format badal sakein (ranking snapshot id add karna) bina client update.

#### Tie-break -- same millisecond ke do posts

Do followees ne same ms mein post kiya: `pA (score 500, id ...0450)` aur `pB (score 500, id ...0449)`. Page boundary pA par gira. Agla query `(500` (exclusive) -> **pB skip ho gaya!** Kyunki pB ka score bhi 500 hai, strictly kam nahi.

**Rule:** order = `(score DESC, postId DESC)`. Cursor ke baad wala item woh hai jo: `score < s` **ya** `(score == s aur postId < id)`.

Redis mein: score **inclusive** range lo aur same-score wale already-seen entries khud skip karo. (Redis equal scores ko member ke lexicographic order se rakhta hai; hamari IDs sab 19 digits ki hain toh lexicographic = numeric -- phir bhi code mein sahi compare karo.)

```ts
// src/utils/cursor.ts
export interface Cursor { s: number; id: string }

export const encodeCursor = (c: Cursor): string =>
  Buffer.from(JSON.stringify(c)).toString('base64url');

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof c.s !== 'number' || typeof c.id !== 'string' || !/^\d{1,20}$/.test(c.id)) throw new Error();
    return c;
  } catch {
    throw new HttpError(400, 'INVALID_CURSOR');
  }
}

// postId compare: pehle length, phir string -- BigInt jaisa result, bina BigInt
export const cmpId = (a: string, b: string): number =>
  a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0;

// cursor ke "baad" (purana) hai?
export const isAfterCursor = (e: FeedEntry, c: Cursor | null): boolean =>
  !c || e.scoreMs < c.s || (e.scoreMs === c.s && cmpId(e.postId, c.id) < 0);
```

**Code Explanation:**

- `base64url` -- normal base64 ke `+ / =` URL mein gadbad karte hain; base64url `- _` use karta hai aur padding nahi. Query string mein seedha.
- `decodeCursor` -- client ka bheja data **untrusted** hai. Galat JSON, galat types, ID mein digits ke alawa kuch -> 400. Kabhi 500 nahi.
- `cmpId` -- `"999" < "1000"` string compare mein **true nahi** (`'9' > '1'`). Isliye pehle length compare: chhoti length = chhota number. Same length par string compare = numeric compare. (Node se check: `cmpId('999','1000') < 0`.)
- `isAfterCursor` -- tie-break rule ek jagah. Merge ke baad har source ki entries is filter se guzarti hain.
- Redis query mein hum `ZREVRANGEBYSCORE feed:{uid} <s> -inf WITHSCORES LIMIT 0 <n + 5>` (inclusive `s`, thodi extra entries) chala ke `isAfterCursor` se filter kar sakte hain. Spec ka `(s` form common case mein bilkul theek hai; inclusive + filter sirf same-ms tie ko bhi exact banata hai.

> **Interview line:** "Offset pagination live feed mein tootti hai -- upar naye posts aaye toh items dobara dikhte hain, kuch delete hua toh items chhoot jaate hain. Main cursor deta hoon: opaque base64 of last score aur last postId, aur agla page 'is (score, id) se strictly purane'. Same millisecond wale posts ke liye tie-break postId se, warna exclusive score boundary par post skip ho sakta hai. Cursor untrusted input hai -- validate karke 400."

---

### Algorithm 7 -- K-way merge with a heap

#### Problem

Read par hamare paas **k sorted lists** hain (sab newest first):

```
feed:{Priya}       : p10(100)  p7(70)  p4(40)
timeline:{Virat}   : p9(90)    p6(60)  p1(10)
timeline:{Priya}   : p8(80)    p7(70)  p5(50)       <- p7 dono mein (race / threshold cross)
```

Top 5 chahiye. **Naive:** sab jodo (9 items), sort karo, top 5. O(n log n). 40 lists x 20 = 800 items par bhi chalega -- lekin hum sirf 20 chahte hain aur har list pehle se sorted hai. Isse behtar:

**Idea:** har list ka **sabse naya** item ek "competition" mein rakho. Jo sabse naya, woh output mein; uski list ka **agla** item competition mein. Competition ko fast chalane ke liye **heap**.

**Heap ka matlab:** ek binary tree (array mein stored) jismein parent hamesha children se "bada" hota hai (max-heap). Top par hamesha maximum. Insert aur remove-top dono **O(log k)**. Hum "newest" chahte hain toh max-heap by score (spec isse "min-heap" bolta hai -- same algorithm, bas comparison ulta).

#### Worked example

```
Start heap: {p10(100), p9(90), p8(80)}              (har list ka head)
pop p10 -> out [p10]        ; feed list ka agla p7(70) push   -> heap {p9, p8, p7}
pop p9  -> out [p10 p9]     ; Virat ka agla p6(60) push       -> heap {p8, p7, p6}
pop p8  -> out [.. p8]      ; Priya ka agla p7(70) push       -> heap {p7, p7, p6}
pop p7  -> out [.. p7]      ; feed ka agla p4(40) push        -> heap {p7, p6, p4}
pop p7  -> already seen -> skip (dedupe) ; Priya ka agla p5    -> heap {p6, p5, p4}
pop p6  -> out [p10 p9 p8 p7 p6]  -> 5 ho gaye, STOP
```

Output: `p10 p9 p8 p7 p6` (node se verify). Sirf 6 pops, 9 items sort nahi kiye.

```ts
// src/utils/kway-merge.ts
import { cmpId } from './cursor';

const newer = (a: FeedEntry, b: FeedEntry): boolean =>
  a.scoreMs !== b.scoreMs ? a.scoreMs > b.scoreMs : cmpId(a.postId, b.postId) > 0;

interface Node { e: FeedEntry; li: number; idx: number }

class MaxHeap {
  private h: Node[] = [];
  get size() { return this.h.length; }
  push(n: Node) {
    const h = this.h; h.push(n);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!newer(h[i].e, h[p].e)) break;
      [h[i], h[p]] = [h[p], h[i]]; i = p;
    }
  }
  pop(): Node {
    const h = this.h; const top = h[0]; const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < h.length && newer(h[l].e, h[m].e)) m = l;
        if (r < h.length && newer(h[r].e, h[m].e)) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m], h[i]]; i = m;
      }
    }
    return top;
  }
}

export function kWayMerge(lists: FeedEntry[][], limit: number): FeedEntry[] {
  const heap = new MaxHeap();
  lists.forEach((list, li) => { if (list.length) heap.push({ e: list[0], li, idx: 0 }); });
  const out: FeedEntry[] = [];
  const seen = new Set<string>();
  while (heap.size > 0 && out.length < limit) {
    const { e, li, idx } = heap.pop();
    if (!seen.has(e.postId)) { seen.add(e.postId); out.push(e); }
    const next = lists[li][idx + 1];
    if (next) heap.push({ e: next, li, idx: idx + 1 });
  }
  return out;
}
```

**Code Explanation:**

- `newer` -- ordering rule: bada score pehle; score barabar toh bada postId pehle. Wahi rule jo cursor mein hai -- ek hi sach.
- `Node { e, li, idx }` -- entry ke saath yaad rakho woh **kaunsi list** (`li`) ke **kaunse index** (`idx`) se aayi, taaki agla item usi list se utha sakein.
- `push` -- array ke end mein daalo, phir parent se "newer" ho toh upar swap ("sift up"). `(i - 1) >> 1` = parent index.
- `pop` -- top nikalo, aakhri element ko top par rakho, phir neeche sift karo -- dono children mein jo newer, usse swap.
- `seen` -- **dedupe**. Same post pushed feed aur timeline dono se aa sakta hai (threshold cross, own post, rebuild race). Output mein ek hi baar.
- `out.length < limit` -- 20 mile toh ruk jao; baaki lists ko chhuna bhi nahi.
- Node test: 3-list example + 200 random tests (random k, random lists) ka result full sort se exactly match.

**Complexity:** har pop/push O(log k). n items output ke liye **O(n log k)** (plus skipped duplicates). k = 40, n = 20 -> ~20 x 6 = ~120 comparisons. Full sort of 800 items ~800 x 10 = 8,000. Page chhota ho toh farak chhota lagta hai, lekin rebuild (200 followees x 20 posts = 4,000 items, top 200) mein saaf dikhta hai.

> **Interview line:** "Read par pushed feed, celebrity timelines aur apna timeline -- k sorted lists. Main k-way merge karta hoon: har list ka head ek max-heap mein, top pop karo, us list ka agla push karo -- O(n log k), aur 20 milte hi ruk jaata hoon. Order rule (score, phir postId) wahi hai jo cursor ka, aur ek seen set dedupe karta hai kyunki threshold cross ya race mein same post do sources se aa sakta hai."

---

### Algorithm 8 -- Ranking V2: chronological se "relevant"

V1 reverse-chronological hai -- simple, predictable, cursor easy. Lekin Priya ki best friend ka post 3 ghante purana hai aur ek random acquaintance ka 1 ghanta -- chronological mein acquaintance upar. V2 mein ek **simple score** (spec: recency decay + engagement + affinity):

```
rank = (1 + 2 x log10(1 + likes) + 3 x affinity) / (ageHours + 2) ^ 1.5
```

- `log10(1 + likes)` -- engagement, lekin **log** mein: 10 likes -> ~1, 50,000 likes -> ~4.7. Viral post 5000x zyada likes se 5000x upar nahi jaata.
- `affinity` (0-1) -- Priya is author se kitna interact karti hai (likes, profile visits, replies) -- ek offline job compute karta hai.
- `(ageHours + 2) ^ 1.5` -- **gravity** (Hacker News jaisa idea): time ke saath score girta hai; `+2` taaki bilkul naya post infinity na ho.

**Worked numbers (node se):**

| Post | Kaun | Age | Likes | Affinity | Numerator | Denominator | Rank |
|---|---|---|---|---|---|---|---|
| A | random acquaintance | 1 h | 2 | 0.1 | 2.254 | 5.196 | **0.434** |
| B | celebrity | 6 h | 50,000 | 0.2 | 10.998 | 22.627 | **0.486** |
| C | best friend | 3 h | 12 | 0.9 | 5.928 | 11.180 | **0.530** |

- Chronological: **A, C, B**. Ranked: **C, B, A**.
- Gravity ka asar: B 24 h baad -> rank **0.083**. Viral post bhi dheere dheere neeche.

#### Pipeline

```
candidate generation  -> ~500 candidates (feed:{me} 200 + celeb timelines + timeline:{me})
filter                -> deleted, blocked, unfollowed, already-seen
score                 -> rank formula (features: likes from likes:{id}, affinity from cache)
sort + page           -> top 20
```

`ranking.service.ts` isi ko implement karta hai. V3 = ML model (click/like probability predict karta hai) -- sirf mention; real feeds (Facebook/Instagram) publicly ML ranking with thousands of features describe karte hain.

#### Ranking pagination ko mushkil kyun banata hai?

Chronological mein cursor `(score, id)` stable hai -- post ka time kabhi nahi badalta. Ranked feed mein **rank badalta hai** (likes aa rahe hain, age badh rahi hai). Page 1 par B rank 2 par tha; page 2 maangne tak B ki rank badal ke page 2 mein aa gaya -> duplicate. Ya koi post page 1 se upar khisak gaya -> missed.

**Snapshot cursor idea:** page 1 par ~500 candidates rank karke ordered ID list ek snapshot key mein rakho (e.g. 10 min TTL), cursor = `{ snapshotId, offset }`. Snapshot ke andar offset safe hai kyunki list **frozen** hai. Snapshot expire hua ya pull-to-refresh -> naya snapshot. Cost: har session ~500 x ~20 bytes = ~10 KB extra memory, short-lived. (Ye V2 refinement hai -- spec ke key names mein nahi; V1 chronological mein zarurat nahi.)

> **Interview line:** "V1 reverse-chronological hai. V2 mein ~500 candidates generate karke simple score -- log engagement plus affinity, divided by age ki gravity -- toh 3 ghante purana best friend ka post 1 ghante purane acquaintance se upar aata hai. Ranking pagination tod deti hai kyunki rank badalti rehti hai, toh main ranked list ka short-lived snapshot rakhta hoon aur cursor snapshot ke andar ka position hai. ML ranking V3 hai."

---

## PART 14 -- Concurrency: jab sab ek saath ho

### Pehle: Chirp mein concurrency kaise alag hai?

Yaad karo (Payment Part 3): Node.js mein **do `await` ke beech ka code atomic** hai, `await` ke aar-paar nahi, aur N instances ek doosre ki memory nahi dekhte.

Chirp ka simplification: **posts immutable hain** (edit nahi), aur Redis ka feed ek **derived cache** hai. Toh hamare zyadatar operations **idempotent** hain -- dobara karo toh same result. Isse locks ki zarurat lagbhag khatam.

**Idempotent ka matlab:** operation 1 baar karo ya 5 baar, final state same. `ZADD feed:42 500 p1` paanch baar = ek entry. `INCR` idempotent **nahi** -- paanch baar = +5.

### Scenario 1 -- Double-tap post

Priya ne slow network par "Post" do baar dabaya (ya app ne timeout par retry kiya). Do `POST /v1/posts` requests, same `Idempotency-Key: 7c1e...`.

- Payment System wala pattern: pehli request key ko **atomically claim** karti hai (e.g. `SET NX` / unique row) aur Snowflake ID banati hai; doosri ko claim fail -> pehli ka stored response (`201` + **same post id**) milta hai.
- Result: **ek post**, ek `posts.created` event (outbox ke through), ek fan-out.
- Key na ho toh? Do posts. Isliye client har compose-screen par ek UUID banata hai aur retry mein wahi bhejta hai.

### Scenario 2 -- Fan-out worker crash ho gaya, retry hua

Worker ne Rahul ke post ke 6 batches (6,000 followers) likhe, 7th par crash. Kafka offset commit nahi hua tha -> naya worker **poora event dobara** process karta hai.

- Pehle 6,000 followers ko `ZADD feed:{id} <sameScore> <samePostId>` dobara -> member already hai, same score -> **koi change nahi**. Duplicate impossible.
- `ZREMRANGEBYRANK ... 0 -201` dobara -> already 200 ya kam -> kuch nahi hata.
- **At-least-once delivery + idempotent consumer = effectively exactly-once result.** Yahi pattern baaki jagah (backfill, rebuild) bhi.

### Scenario 3 -- Do fan-outs ek hi feed par ek saath

Rahul aur Amit ne same second post kiya; do alag workers (alag Kafka partitions -- key authorId) Priya ke `feed:{Priya}` par likh rahe hain:

```
Worker R: ZADD feed:P 501 pR      Worker A: ZADD feed:P 502 pA
Worker R: ZREMRANGEBYRANK 0 -201  Worker A: ZREMRANGEBYRANK 0 -201
Interleaving: ZADD pR, ZADD pA, TRIM, TRIM   ya   ZADD pR, TRIM, ZADD pA, TRIM
```

- Redis commands **single-threaded** execute hote hain -- har command atomic, beech mein koi doosra nahi.
- **Pipeline atomic nahi** hai -- sirf network round trips bachata hai; doosre clients ke commands beech mein aa sakte hain.
- Kya farak padta hai? **Nahi**. Final set = saari entries ka union, sorted by score, newest 200. Koi bhi order ho, result same (ZADD commutative hai, trim "newest 200" deterministic).
- `MULTI/EXEC` (transaction) kab? Jab do commands ke **beech** koi aur state dekhna galat ho. Yahan nahi -- ek momentary 201 entries harmless hai. Faltu MULTI = extra cost.

### Scenario 4 -- Follow + unfollow race

Priya ne Rahul ko follow kiya aur galti samajh ke turant unfollow (do requests, alag pods).

- Truth = Postgres `follows` table. PK `(follower_id, followee_id)` -> follow = `INSERT ... ON CONFLICT DO NOTHING`, unfollow = `DELETE`. Jo **baad mein commit** hua, woh final state (last write wins). Do follows = ek row.
- `follower_count` update usi transaction mein (`UPDATE users SET follower_count = follower_count + 1` -- row lock, atomic) **sirf jab INSERT ne sach mein row banayi** (`RETURNING` se pata). Warna count drift.
- Feed side: follow ne async backfill (Rahul ke last 20 posts) queue kiya, aur usse pehle unfollow ho gaya -> backfill ke posts Priya ke feed mein aa gaye. **Read-time filter** bachata hai: merge ke baad har entry ka author `following:{Priya}` mein hai? Nahi -> hatao. Backfill job bhi likhne se pehle "abhi bhi follow karta hai?" check kare. Async cleanup job baad mein ZREM kar deta hai.

### Scenario 5 -- Delete jab fan-out chal raha ho

```
t0  Rahul post karta hai -> posts.created -> fan-out shuru (batch 1..10)
t1  Rahul DELETE /v1/posts/:id -> posts_by_id.deleted = true, post:{id} tombstone -> 204
t2  posts.deleted -> cleanup job: followers ke feed:{id} se ZREM
t3  fan-out batch 8, 9, 10 abhi likh rahe hain -> post wapas kuch feeds mein!
```

- Order guarantee: dono events Kafka key = authorId -> **same partition** -> `feed-fanout` consumer mein created pehle, deleted baad. Lekin cleanup alag consumer group ho ya retry ho toh race phir bhi possible.
- **Asli guard = read-time filter.** Hydration mein `post.deleted === true` -> item drop. Feed mein ek stale member pada hai toh sirf 64 bytes waste; user ko kabhi nahi dikhta.
- Isliye spec: "source of truth se turant hatao, feeds lazily saaf karo". Correctness read path par, cleanup sirf optimization.
- Fan-out worker bhi har batch se pehle (ya har 5 batches) `deleted` check kar sakta hai -- deleted mila toh ruk jao. Cheap bonus.

### Scenario 6 -- Like counter races

Virat ke post par ek second mein 20,000 likes. Aur Priya ne double-tap kiya (do `PUT /v1/posts/:id/like`).

**Galat:** `count = GET likes:{id}; SET likes:{id} count + 1` -- do requests same count padhenge -> ek like gaya (lost update).

**Theek (counter):** `INCR likes:{id}` -- Redis mein atomic. 20,000 concurrent INCR = exactly +20,000.

**Lekin idempotency?** Priya ke do PUTs = do INCR = +2. Galat. Like "per user ek baar" hai. Rule: **INCR sirf tab jab ye like naya ho.**

```lua
-- like.lua   KEYS[1] = likers:{<postId>}   KEYS[2] = likes:{<postId>}   ARGV[1] = userId
if redis.call('SADD', KEYS[1], ARGV[1]) == 1 then
  return redis.call('INCR', KEYS[2])
end
return tonumber(redis.call('GET', KEYS[2]) or '0')
```

**Code Explanation:**

- `SADD` return karta hai kitne **naye** members add hue: 1 = pehli baar like, 0 = already liked.
- Sirf 1 par `INCR`. Double-tap: pehla 1 -> INCR; doosra 0 -> sirf current count lautao.
- **Lua script Redis mein atomic chalti hai** -- SADD aur INCR ke beech koi doosra command nahi. Do alag round trips mein (SADD, phir app mein if, phir INCR) crash beech mein ho toh set mein user hai lekin count nahi badha.
- Redis Cluster mein script ki saari keys **same slot** mein honi chahiye. `likers:{123}` aur `likes:{123}` -- curly braces ke andar ka `123` **hash tag** hai, sirf wahi hash hota hai -> dono same slot. (Spec mein `{postId}` placeholder hai; yahan literal braces zaruri hain.)
- Unlike: mirror script -- `SREM` == 1 tabhi `DECR`.

Durable side: `post_likes` (Cassandra) mein `INSERT` -- PK `(post_id, user_id)` -> dobara insert = same row (upsert, idempotent). Redis ka `likes:{id}` periodically Cassandra `post_counters` mein flush hota hai.

**Kyun "exactly-once-ish":** Redis crash (last second ke INCRs AOF mein nahi) -> count thoda peeche. Liker sets bhi memory khaate hain (viral post = millions members) -> unhe TTL (e.g. 7 din) do; expire ke baad like path Cassandra se check kare. Isliye ek **reconciliation job**: kabhi kabhi `post_likes` partition count karke counter theek kare. Like count 12,431 vs 12,433 -- users ko farak nahi padta; **viewerHasLiked** sahi hona chahiye, aur woh `post_likes` / liker set se aata hai.

### Scenario 7 -- Threshold cross mid-fan-out

Rahul ke 9,999 followers; fan-out chal raha hai; beech mein 5 naye follows -> 10,004.

- Worker ne fan-out ke **shuru** mein `followerCount` padha (9,999) -> poora push karega. Us post ke liye decision fixed. Theek hai -- post already `timeline:{Rahul}` mein bhi hai.
- Agle post se Rahul celebrity -> pull. Jo readers promotion ke baad dono se padhein, unhe dedupe (Algorithm 7). Algorithm 4 ka hysteresis flapping rokta hai.
- Lesson: decision **ek baar per event** lo aur usi par tike raho. Beech mein re-check karke aadha push aadha pull mat karo.

### Scenario 8 -- Feed rebuild vs fan-out write

Priya 40 din baad aayi -> `feed:{Priya}` nahi hai -> rebuild shuru (followees ke recent posts Cassandra se, merge, write). Usi waqt Rahul ka naya post fan-out Priya ke feed mein ZADD karta hai (woh ab active hai).

- **Galat rebuild:** t0 rebuild ne Cassandra se list compute ki (Rahul ka naya post usmein nahi) -> t1 fan-out ne `ZADD feed:P ... pR` kiya -> t2 rebuild ne "saaf shuruaat" ke liye `DEL feed:P` + apni list ZADD ki -> **pR gayab**, aur fan-out dobara nahi aayega.
- **Theek rebuild:** kabhi `DEL` nahi, sirf `ZADD` (+ trim). Dono writers ZADD karte hain -> result = **union**. Order kuch bhi ho, koi entry nahi khoti.
- Do rebuilds ek saath (Priya ne do tabs khole)? Dono same entries ZADD karenge -- duplicate kaam, lekin safe. Kaam bachane ke liye `SET rebuild:{P} 1 NX EX 30` jaisa short guard (optional -- correctness ke liye nahi, cost ke liye).

### Scenario 9 -- Kafka ordering by authorId

`posts.created` aur `posts.deleted` ka message key = **authorId** -> ek author ke saare events ek partition mein, order mein. Toh "create" aur "delete" ka order ek author ke liye preserved. Alag authors ke beech order ki zarurat nahi -- unke posts ZSET score (time) se sort hote hain, arrival order se nahi. Isliye fan-out 100 partitions par parallel chal sakta hai. (Trade-off: ek bahut active author ek partition ko garam karta hai -- lekin celebrities fan-out karte hi nahi, toh unka event sirf 1 timeline write hai.)

### Scenario 10 -- Node.js angle: batching, Promise.all, backpressure

Fan-out worker I/O-bound hai: Postgres se followers padho, Redis mein likho. Node ka event loop isme achha hai -- lekin do galtiyan common hain:

- **Galti 1 -- sab memory mein:** `SELECT follower_id FROM follows WHERE followee_id = $1` -> 9,999 rows theek, lekin backfill / account-deletion cleanup / threshold kabhi 100K kiya toh? Poora result RAM mein, phir sab ek saath.
- **Galti 2 -- unbounded `Promise.all`:** `await Promise.all(followers.map(f => redis.zadd(...)))` -- 10K promises, 10K commands ek saath socket par, Redis ke output buffers bhar jaate hain, event loop memory spike. 100 workers ye karein toh Redis latency sab ke liye badh jaati hai.

**Theek -- keyset batches + ek pipeline per batch + await:**

```ts
// src/workers/fanout.worker.ts (core -- simplified)
async function fanOut(evt: { postId: string; authorId: string; createdAtMs: number }) {
  const { postId, authorId, createdAtMs } = evt;
  await redis.pipeline()
    .zadd(`timeline:${authorId}`, createdAtMs, postId)
    .zremrangebyrank(`timeline:${authorId}`, 0, -(FEED_MAX + 1))
    .exec();

  const followerCount = await userRepo.followerCount(authorId);
  if (followerCount >= CELEBRITY_THRESHOLD) return;                 // celebrity: readers pull

  let after = '0';
  for (;;) {
    const batch = await followRepo.activeFollowersPage(authorId, after, FANOUT_BATCH, ACTIVE_DAYS);
    if (batch.length === 0) break;
    if (await postCache.isDeleted(postId)) return;                   // delete ho gaya -> ruk jao
    for (const group of groupByRedisNode(batch.map((id) => `feed:${id}`))) {
      const p = redis.pipeline();
      for (const key of group) p.zadd(key, createdAtMs, postId).zremrangebyrank(key, 0, -(FEED_MAX + 1));
      await p.exec();
    }
    metrics.fanoutWrites.inc(batch.length);
    after = batch[batch.length - 1];
  }
  metrics.fanoutLag.observe((Date.now() - createdAtMs) / 1000);
}
```

**Code Explanation:**

- Pehla pipeline -- har post `timeline:{authorId}` mein (read-your-own-writes + celebrity pull ka source), newest 200 tak trim.
- `followerCount >= CELEBRITY_THRESHOLD` -- decision event ke shuru mein **ek baar** (Scenario 7).
- `activeFollowersPage(authorId, after, 1000, 30)` -- **keyset pagination** on `ix_follows_followee (followee_id, follower_id)`: `WHERE followee_id = $1 AND follower_id > $after ORDER BY follower_id LIMIT 1000`, join `users.last_active_at > now() - 30 days`. Memory mein kabhi 1,000 IDs se zyada nahi.
- `isDeleted` -- Scenario 5 ka cheap bonus check.
- `groupByRedisNode` -- ioredis Cluster mein ek pipeline ki saari keys **ek hi node** par honi chahiye (library ke docs ke mutabik; warna error). Toh 1,000 keys ko slot -> node ke hisaab se group karo (e.g. `cluster-key-slot` package se slot nikaal ke).
- `await p.exec()` -- har group ka wait, phir agla. Yahi **backpressure** hai: Redis slow hua toh worker khud slow; memory flat. Zyada throughput chahiye toh 2-4 groups parallel (bounded concurrency), unlimited nahi.
- `after = last id` -- agla page. Crash hua toh Kafka retry poora event dobara chalata hai -- ZADD idempotent (Scenario 2).
- `fanoutLag` -- `fanout_lag_seconds`: post create se aakhri feed write tak. p99 < 5 s target.

**Concurrency summary -- lock kahin nahi:**

| Race | Kaun bachata hai |
|---|---|
| Double-tap post | `Idempotency-Key` claim -> same postId |
| Fan-out retry | ZADD idempotent (same member, same score) + trim idempotent |
| Do fan-outs, same feed | Har Redis command atomic; result = union, order-independent |
| Follow/unfollow race | Postgres PK + last commit wins; read-time filter |
| Delete during fan-out | Tombstone + read-time filter; async ZREM |
| Like double-tap / concurrent likes | Lua: SADD == 1 tabhi INCR; Cassandra PK upsert; reconciliation |
| Threshold cross mid-fan-out | Decision ek baar per event; dedupe on merge |
| Rebuild vs fan-out | Rebuild sirf ZADD, kabhi DEL nahi -> union |
| Create vs delete order | Kafka key = authorId -> same partition |

> **Interview line:** "Feed side par main locks nahi lagata -- sab idempotent hai. Fan-out retry par same member same score ZADD koi duplicate nahi banata, aur do workers ek feed par likhein toh result union hai kyunki ZSET score se sort karta hai, arrival se nahi. Deletes aur unfollows ke liye read-time filter correctness deta hai, cleanup lazy hai. Likes mein INCR atomic hai lekin idempotent nahi, toh Lua script mein SADD == 1 tabhi INCR, aur ek reconciliation job drift theek karta hai. Node worker followers ko keyset batches of 1,000 mein padhta hai, ek pipeline per batch await karta hai -- unbounded Promise.all kabhi nahi."

---

## PART 15 -- Caching: feed, posts, hot keys, stampede

### Pehle: Chirp mein kya kya cache hai?

Feed Service ka ek read 20 posts, 20 authors, 20 like counts, 20 "viewer liked?" -- sab chahiye. Bina cache ke har read ~60+ DB lookups. 35K/s par impossible. Layers:

| Layer | Key / jagah | Value | TTL | Kyun ye TTL |
|---|---|---|---|---|
| Client (app) | Local storage | Last feed page + cursor | Pull-to-refresh tak | App khulte hi turant kuch dikhe, phir refresh |
| CDN | `cdn.../media/...` | Images/videos (StoreBox) | Long (immutable keys) | Media key kabhi nahi badalti (File Storage Part 3) |
| Feed cache | `feed:{userId}` ZSET | Newest 200 (postId, ms) | Koi TTL nahi; inactive (30 din) ke evict/skip | Derived store -- fan-out usse live rakhta hai |
| Timelines | `timeline:{authorId}` ZSET | Author ke latest 200 | Koi TTL nahi | Celebrity pull + read-your-own-writes |
| Post hydration | `post:{postId}` | Post JSON | **24 h** | Zyadatar feed items 1-2 din purane; immutable posts, stale ka risk sirf delete |
| Graph | `following:{userId}`, `celebs:{userId}` | ID sets | **10 min** | Follow/unfollow rare; 10 min stale filter acceptable (event par delete bhi) |
| Counters | `likes:{postId}` | Integer | Hot posts ke liye, flush ke baad expire | Truth Cassandra counter |
| Author profile | In-process LRU (+ Redis) | handle, displayName, avatarUrl | Minutes | Profile rarely badalti, har item mein chahiye |

(Author profile cache ka exact key naam spec mein nahi; LLD mein `user.repository` ke upar ek cache.)

### Cache-aside -- ek post, line by line

Single post (e.g. share link se `GET /v1/posts/:id`):

```ts
// src/cache/post-cache.ts
export async function getPost(id: string): Promise<Post | null> {
  const key = `post:${id}`;
  const cached = await redis.get(key);
  if (cached) {
    return JSON.parse(cached);
  }
  const post = await postRepo.findById(id);                          // Cassandra posts_by_id
  if (post) await redis.set(key, JSON.stringify(post), 'EX', ttlWithJitter(86_400), 'NX');
  return post;
}
const ttlWithJitter = (base: number) => base + Math.floor(Math.random() * 3_600);
```

**Code Explanation:**

- `key = post:${id}` -- **cache key**: jis cheez ko dhoondh rahe hain uski unique pehchaan. ID string hai, precision safe.
- `await redis.get(key)` -- Redis se value. ~0.5 ms. Nahi mila -> `null`.
- `if (cached)` -- **cache hit**: Cassandra ko chhua hi nahi.
- `JSON.parse(cached)` -- Redis mein string hai; object mein badlo. (IDs strings hain, isliye parse mein precision nahi jaata.)
- `postRepo.findById` -- **cache miss**: source of truth se padho.
- `redis.set(..., 'EX', ttl, 'NX')` -- wapas cache mein daalo (cache-aside = app khud bharta hai). `EX` = TTL seconds. **`NX`** = sirf tab likho jab key nahi hai -- delete ka tombstone overwrite na ho (neeche).
- `ttlWithJitter` -- 24 h + 0-1 h random. Ek viral event ke hazaaron posts ek hi second mein expire na hon.
- `if (post)` -- not found ko cache nahi kiya. Bots random IDs maar rahe hon toh chhota **negative cache** (`post:{id}` = `"null"`, 60 s) laga sakte ho.

### Hydration -- 20 posts ek saath

Feed read ke 20 IDs ke liye 20 alag `GET` round trips nahi. Spec: batch `MGET post:{id}...`.

**Cluster gotcha:** Redis Cluster mein `MGET` ki saari keys **same slot** mein honi chahiye, warna `CROSSSLOT` error. 20 random posts 20 alag slots mein. Isliye practice mein: keys ko node-wise group karo aur har node par ek pipeline of GETs (ya MGET per slot group) -- effectively 1 round trip per node, parallel.

```ts
export async function getPosts(ids: string[]): Promise<Map<string, Post>> {
  const out = new Map<string, Post>();
  const raws = await redisGetMany(ids.map((id) => `post:${id}`));   // node-wise pipelined GETs
  const misses = ids.filter((id, i) => {
    if (raws[i]) { out.set(id, JSON.parse(raws[i]!)); return false; }
    return true;
  });
  if (misses.length) {
    metrics.hydrationMiss.inc(misses.length);
    const rows = await postRepo.findByIds(misses);                    // Cassandra, parallel per partition
    const p = redis.pipeline();
    for (const post of rows) {
      out.set(post.id, post);
      p.set(`post:${post.id}`, JSON.stringify(post), 'EX', ttlWithJitter(86_400), 'NX');
    }
    await p.exec();
  }
  return out;                                  // caller: deleted / missing drop karo, order feed ka rakho
}
```

**Code Explanation:**

- `misses` -- jo Redis mein nahi mile. `hydration_cache_miss_total` metric yahi ginta hai.
- `postRepo.findByIds` -- Cassandra `posts_by_id` mein har post alag partition hai, toh `IN` ki jagah parallel single-partition queries usually behtar (coordinator par load kam). Spec dono allow karta hai.
- Wapas cache mein `NX` ke saath. `out` Map hai -- order caller feed ke order se banata hai, aur `post.deleted` wale drop karta hai.

**Hit ratio math:** 35K reads/s x 20 = **700K post lookups/s**.

| Hit ratio | Cassandra reads/s (hydration) |
|---|---|
| 90% | 70,000 |
| 95% | 35,000 |
| 99% | 7,000 |
| 99.5% | 3,500 |

Kyun 99%+ realistic hai: feed mein zyadatar posts last 24-48 h ke hain (FEED_MAX 200 + recency), aur ek post ko uske saare followers padhte hain -- Rahul ka post 200 feeds mein, ek baar miss, 199 baar hit. Memory: 10M posts/day x ~1 KB = **~10 GB** for 24 h -- sasta. Har 1% hit ratio = 7K Cassandra reads/s -- isliye `hydration_cache_miss_total` alert-worthy metric hai.

### Hot keys -- Virat ka post

**Hot key ka matlab:** ek single key par itna traffic ki uska ek Redis shard (single-threaded) bottleneck ban jaaye -- baaki 19 shards khaali, ek jal raha.

Virat (50M followers) ne post kiya. Maan lo agle kuch minute **30%** feed reads mein woh post hai (assumption):

- `post:{viratPostId}` -> 35K x 0.3 = **~10.5K GET/s** ek key par. Aur `timeline:{virat}` par bhi utne hi range reads. Virat jaise 20-40 celebs ke keys kuch hi shards par -> World Cup final jaisa event -> 10x.

**Asli fix -- in-process LRU (L1) in Feed Service:**

```ts
import { LRUCache } from 'lru-cache';
const l1 = new LRUCache<string, string>({ max: 50_000, ttl: 2_000 });   // 2 s
```

- Feed Service ke har instance ki RAM mein hot `post:*` aur `timeline:{celeb}` results 2 s ke liye.
- Math: 100 Feed Service instances, har ek ek hot key ke liye Redis ko max **1 baar per 2 s** -> 100 / 2 = **50 req/s** us key par, 10.5K/s ki jagah (~200x kam).
- Cost: 2 s staleness -- celebrity ka naya post 2 s late dikhe, chalega (spec: few seconds eventual OK). Posts immutable hain toh `post:*` L1 mein stale ka matlab sirf "delete ke baad 2 s tak dikha".
- Sirf **hot** keys L1 mein daalo (e.g. celebs ke timelines, ya jo key ek instance par N baar/sec maangi gayi). 50K entries x ~1-2 KB = ~50-100 MB per instance.

### Cache stampede -- viral post expire hua

(Repo lesson: [83 -- Redis down, database stampede](../../lessons/83-redis-down-database-stampede.md).)

`post:{viralId}` ka TTL khatam. Us millisecond 10K requests -> sab miss -> **10K Cassandra reads ek hi partition par** -> Cassandra node garam, timeouts, retries, aur bura.

Fixes (layered):

1. **Jitter** (upar) -- ek saath expiry kam.
2. **Single-flight / request coalescing** -- ek instance ke andar same key ka ek hi in-flight DB call; baaki usi promise ka wait:

```ts
const inflight = new Map<string, Promise<Post | null>>();
export function getPostOnce(id: string) {
  let p = inflight.get(id);
  if (!p) {
    p = getPost(id).finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  return p;
}
```

**Code Explanation:**

- `inflight.get(id)` -- is instance par already koi is post ko la raha hai? Wahi promise lautao.
- `get` aur `set` ke beech koi `await` nahi -> event loop mein atomic, do callers dono miss nahi dekh sakte.
- `.finally(delete)` -- success ya error, khatam hote hi map se hatao; agla request fresh.
- 100 instances -> Cassandra par max **100** reads, 10K nahi. L1 (2 s) ke saath milke aur kam.

### Invalidation -- delete (aur edit, agar aaya)

Posts **editable nahi** hain (requirement). Toh invalidation ka ek hi case: **delete**.

**Naive:** Cassandra mein `deleted = true`, phir `DEL post:{id}`. Race:

```
t0  Reader: miss -> Cassandra se post padha (deleted = false)   ... slow
t1  Writer: deleted = true; DEL post:{id}
t2  Reader: SET post:{id} <deleted=false wala JSON> EX 86400
    -> 24 h tak deleted post feeds mein dikhega!
```

**Theek -- tombstone + NX:**

- Delete par `DEL` ki jagah `SET post:{id} '{"id":"...","deleted":true}' EX 86400` -- **tombstone** likho.
- Readers hamesha `SET ... NX` karte hain -> tombstone ke upar overwrite nahi kar sakte. Race khatam.
- Hydration `deleted: true` dekhe -> item drop. Feeds mein pada member baad mein async ZREM (Part 14 Scenario 5).
- Aur L1 (2 s) -- max 2 s tak dikh sakta hai. Acceptable; strict chahiye toh Redis pub/sub se instances ko "evict post:{id}" broadcast.

**Agar edit aaya (V2):** post versioned karo (`post:{id}` value mein `version`), edit par naya value **SET (bina NX)** + L1 evict broadcast. Ya simple rule: edit window 5 min, TTL-based staleness accept. Interview mein bolo: "immutable posts ne invalidation ka 90% problem khatam kar diya."

### Feed cache kho gaya toh?

**Case A -- ek feed nahi hai** (inactive user, ya evicted): `feed_cache_hit_ratio` miss -> **rebuild on read**: `following:{me}` -> har non-celeb followee ka recent `posts_by_author` -> k-way merge (Algorithm 7) -> top 200 ZADD (kabhi DEL nahi) -> page serve. Cost ~200 Cassandra partition reads + 1 Postgres query -> ~50-150 ms. Rare hai toh theek.

**Case B -- ek poora shard gaya** (primary + replica dono, rare): 20 mein se 1 shard -> **~5M users** ke feeds gaye. Agle kuch minute unke reads sab rebuild maangenge.

**Case C -- poora feed cache gaya** (cluster wipe / galat flush): 35K reads/s, har ek rebuild -> 35K x 200 = **7M Cassandra reads/s**. Cassandra ye nahi jhelega -> **rebuild storm** -> posts writes bhi slow -> poora Chirp down.

Fix:

- **Rate-limit rebuilds** -- per Feed Service instance token bucket (e.g. 20 rebuilds/s -> 100 instances = 2K rebuilds/s = ~400K Cassandra reads/s -- capacity ke hisaab se tune). `feed_rebuilds_total` metric.
- Jo limit ke bahar -> **degraded feed**: sirf top ~20 most-interacted followees + celebs + own timeline se pull (chhota, sasta), response mein partial flag. User ko "thoda kam personalised" feed, error nahi. (Spec: "stale ya partial better than down".)
- Background job active users ke feeds dheere dheere pre-warm kare.
- **Single-flight per user** -- ek user ke do tabs = ek rebuild.

### Memory math -- sab caches

| Cache | Calculation | Size |
|---|---|---|
| `feed:{userId}` | 100M DAU x 200 x 64 B | **~1.28 TB** (~20 x 64 GB shards + replicas) |
| `timeline:{authorId}` | Worst case: last 30 din ke saare posts kisi timeline mein: 300M x 64 B | **~19 GB** |
| `post:{postId}` | 10M posts/day x ~1 KB x 24 h (+ purane hot) | **~10-15 GB** |
| `following:{userId}` | ~10M users active in any 10 min (assumption) x 200 IDs x ~8 B (intset) | **~16 GB** |
| `likes:{postId}` + liker sets | Hot posts only; liker sets TTL | Few GB (viral posts ke sets bade -- TTL zaruri) |
| L1 in-process | 50K entries x ~1-2 KB per instance | ~50-100 MB per instance |

Feed cache sabse bada -- baaki sab milke uska ~5%. Isliye optimization ka pehla target hamesha feed hai: `FEED_MAX` 200 se 100 kiya -> ~640 GB bachat; active window 30 se 14 din -> feeds kam.

### Kya cache NAHI karna

| Cheez | Kyun nahi |
|---|---|
| Poora hydrated feed page per user (`feedpage:{uid}:{cursor}`) | Har naye post / like par stale; hit ratio kam (har user ka alag), memory bahut |
| Snowflake IDs as ZSET scores | Double precision -- 256 IDs ek score par collapse |
| Liker sets bina TTL ke | Viral post = millions members, memory kabhi wapas nahi |
| Deleted post par `DEL` (bina tombstone) | Slow reader stale non-deleted wapas bhar deta hai |
| `celebs:{uid}` / `following:{uid}` bina TTL | Unfollow ke baad bhi purana set hamesha -- filter galat |

> **Interview line:** "Caching layers: CDN media ke liye, Redis mein pushed feeds aur celebrity timelines (ZSETs, ~1.28 TB), post hydration cache 24 h TTL jitter ke saath -- 700K post lookups/s par 99% hit ratio = sirf 7K Cassandra reads/s -- plus 10 min graph sets aur like counters. Posts immutable hain toh invalidation sirf delete hai, aur main DEL ki jagah tombstone likhta hoon, readers SET NX karte hain taaki slow reader deleted post wapas na bhare. Celebrity post hot key hai -- Feed Service mein 2 s in-process LRU aur single-flight, jisse ek key par 10K/s se ~50/s. Feed cache poora gaya toh rebuild storm Cassandra ko maar dega -- isliye rebuilds rate-limited aur baaki ko degraded pull feed."

---

## Remember

> **Precompute for the many, merge for the few.** Snowflake IDs time-sortable hain lekin 2^53 se bade -- strings mein rakho, ZSET score `createdAtMs`. Normal authors (< 10,000) push, celebrities pull, read par k-way merge (O(n log k)) + dedupe. Feed = Redis ZSET newest 200, cursor = `(score, postId)` kabhi offset nahi. Concurrency ke liye locks nahi -- **ZADD idempotent, union order-independent, correctness read-time filter mein**, likes ke liye `SADD == 1` tabhi `INCR`. Cache: post hydration 99%+ hit, hot keys ke liye in-process LRU + single-flight, delete par tombstone, rebuilds rate-limited.

## Quick Self-Test

1. Snowflake ID `2100907437367382021` ko timestamp, worker, sequence mein todo. JS `Number(id)` aur Redis ZSET score mein ise rakhne se kya galat hota hai, aur hamara fix kya hai?
2. Pure pull aur pure push ka cost 35K reads/s aur 10M posts/day par numbers ke saath batao. Threshold 10,000 hi kyun -- worst-case fan-out aur merge cost ka trade-off samjhao. Celebrity wapas 9,999 par aaya toh kya bug aata hai aur fix kya?
3. Offset pagination live feed mein kaise duplicate aur missing items deti hai (timeline banao)? Cursor mein postId tie-break kyun chahiye? Ranked feed mein pagination kyun aur mushkil hai?
4. 3 sorted lists ka k-way merge heap se step by step karo (ek post do lists mein ho). Complexity kya hai aur dedupe kyun zaruri hai?
5. Fan-out worker crash ke baad retry, do fan-outs ek hi feed par, aur like double-tap -- teeno mein duplicate kyun nahi hota (ya kaise rokte ho)? Deleted post ko `DEL post:{id}` karna kyun kaafi nahi?

---

**Next (Part 4):** Scaling (celebrities, hot keys, Redis Cluster, Cassandra), Failures (Redis down, Kafka lag, fan-out backlog), Consistency (read-your-own-writes), Security + privacy, Observability. "next" bolo.
