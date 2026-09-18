# News Feed -- HLD + LLD (Part 4: Scaling -> Failures -> Consistency -> Security -> Observability)

> Is file mein prompt ke **Parts 16-20** hain: scaling (1x se 1000x), failure scenarios, consistency, security, aur observability.
> Pichle parts ka recap: Part 1 mein numbers nikale (**100M DAU, ~35K feed reads/s peak, 10M posts/day (~350/s peak, 1K/s spikes ke liye plan), pure fan-out = 2B feed inserts/day (~69K/s peak), feed cache ~1.28 TB Redis (~20 shards of 64 GB), posts ~3.65 TB/year**). Part 2 mein APIs, post create -> outbox -> Kafka `posts.created` -> fan-out workers, aur hybrid feed read (push `feed:{me}` + pull `timeline:{celebId}` + `timeline:{me}` -> k-way merge -> filter -> hydrate) likha. Part 3 mein Snowflake IDs, fan-out push vs pull vs hybrid (threshold 10,000 followers), Redis ZSET feed, cursor pagination aur ranking ka deep dive kiya. Ab dekhenge ye system **users badhne par, Redis/Kafka/DB marne par, aur spammers/attackers aane par** kaise behave karta hai.

**Ek baat pehle se yaad rakho:** File Storage mein sawaal tha "kya koi byte chupchaap kho sakta hai?". News Feed mein sawaal ulta hai: **"kya feed khulegi -- chahe thodi purani ho?"** Feed ek **derived view** hai -- asli sach posts (Cassandra) aur follows (Postgres) mein hai. Redis ka `feed:{userId}` gaya toh dobara bana sakte hain. Isliye rule: **feed ke maamle mein fail open (degrade karo, dikhao kuch na kuch), posts ke maamle mein fail closed (post kabhi mat khoo).**

> Honest note: asli Twitter/X, Facebook, Instagram feeds isse kahin zyada complex hain -- ML ranking, dozens of candidate sources, ads, experiments. Unke internals ka sirf kuch hissa publicly described hai. Ye woh design hai jo interviewer "Design Twitter home timeline" ke jawab mein expect karta hai -- hamara app **Chirp**.

---

## PART 16 -- Scaling: 1x -> 10x -> 100x -> 1000x

### Pehle ek rule

Har level par teen sawaal:

1. **Sabse pehle kya tootega?** (bottleneck)
2. **Usko todne ka sabse sasta tareeka kya hai?**
3. **Kya abhi zarurat NAHI hai?**

**News feed ki khaas baat:** yahan scaling ke **chaar alag axes** hain:

| Axis | Kya todta hai |
|---|---|
| **Feed reads/s** | Feed service CPU, Redis reads, hydration |
| **Write amplification** (1 post x followers) | Fan-out workers, Redis writes, Kafka lag |
| **Feed cache memory** (users x 200 entries) | Redis RAM, shard count, cost |
| **Hot keys** (celebrities) | Ek Redis key par lakhon reads/s |

URL Shortener mein ek click = ek read. Yahan **ek post = 200 writes** (average), aur ek celebrity post = 50M writes (agar push kiya). Isliye "writes/s" ka matlab posts/s nahi, **feed inserts/s** hai.

### Levels define karte hain

Formula same hai jo Part 1 mein tha: 10 feed opens per DAU per day, 1 post per 10 DAU per day, 200 average followers, peak = 3x average.

| Level | DAU | Feed reads/s peak | Posts/s peak | Feed inserts/s peak (pure push) | Feed cache (200 x 64 B) | Posts/year (x3 RF) |
|---|---|---|---|---|---|---|
| **1x** (startup) | ~1M | ~350 | ~3.5 | ~700 | ~12.8 GB | ~36 GB (~0.11 TB) |
| **10x** | ~10M | ~3.5K | ~35 | ~6.9K | ~128 GB | ~0.37 TB (~1.1 TB) |
| **100x** (spec baseline) | **100M** | **~35K** | **~350** | **~69K** | **~1.28 TB** | **~3.65 TB (~10.95 TB)** |
| **1000x** | ~1B | ~350K | ~3.5K | ~690K | ~12.8 TB | ~36.5 TB (~110 TB) |

> Dhyaan do: yahan "1x" ek chhota startup hai aur **hamara spec 100x hai**. Interview mein bolo: "main 1M DAU se start karke dikhata hoon ki 100M tak kya badalta hai" -- interviewer ko evolution dekhna pasand hai.

### 1x -- ~1M DAU (startup): pull model, ek Postgres

```
Mobile/Web -> CDN (media) -> LB -> 2-3 stateless Node.js API instances
                                    -> PostgreSQL primary + 1 replica (users, follows, posts)
                                    -> 1 Redis (post cache, sessions, rate limits)
```

- **Feed = pull (fan-out on read).** Har feed open par ek query:

```sql
SELECT p.id, p.author_id, p.text, p.created_at
FROM posts p
WHERE p.author_id IN (SELECT followee_id FROM follows WHERE follower_id = $1)
  AND p.deleted = false
  AND p.id < $2                       -- cursor (Snowflake id, compared as bigint in SQL)
ORDER BY p.id DESC
LIMIT 20;
```

- **Kyun chal jaata hai:** ~350 reads/s peak, index `posts(author_id, id DESC)` ke saath har followee se latest rows -- Postgres ek replica ke saath aaram se. Posts table 1 saal mein ~36 GB -- chhota.
- **Redis ek instance:** `post:{postId}` hydration cache + rate limiter. Feed cache optional.
- **Kya NAHI chahiye:** Kafka, fan-out workers, Cassandra, Redis Cluster, celebrity logic. Is size par celebrity hi nahi hain (sabse bada account shayad 50K followers).
- **Simple push bhi option hai:** post create par ek in-process job (BullMQ jaisa) followers ke `feed:{id}` mein ZADD kare. 700 inserts/s ek Redis ke liye kuch nahi. Lekin pull zyada simple hai -- **pehle pull, dard ho tab push.**

> Interview line: "1M DAU par main pull model se start karunga -- ek Postgres query jo followees ke latest posts `(author_id, id)` index se laaye. 350 reads/s ke liye ek primary + replica kaafi hai. Kafka, Cassandra, fan-out -- abhi nahi. Jab followee count aur reads badhenge, woh query hi pehla bottleneck banegi."

### 10x -- ~10M DAU: push fan-out + Kafka + Redis Cluster

| Area | Kya tootega? | Change | Kyun |
|---|---|---|---|
| **Pull query** | 3.5K reads/s x "200 followees ka IN + sort" -- har read 200 index seeks; p99 200 ms tootega | **Fan-out on write (push)**: post create par followers ke `feed:{id}` ZSET mein postId daalo | Read = ek `ZREVRANGEBYSCORE`, O(log n) |
| **Post create latency** | Sync fan-out = author ka request 200 ZADD tak ruka | **Kafka `posts.created` + fan-out workers** (group `feed-fanout`) | Post API fast, fan-out async aur retryable |
| **Redis memory** | ~128 GB feed cache ek box mein nahi | **Redis Cluster**, 3-4 shards + replicas | Keys hash-slot se baant jaate hain |
| **Celebrities** | Pehle 100K-1M follower accounts aate hain | **Hybrid** with `CELEBRITY_THRESHOLD = 10_000` | Celebrity post push nahi, read par pull |
| **Posts DB** | 1 TB/year, write-heavy | Postgres + read replicas abhi bhi theek; Cassandra ka plan | Size ab bhi manageable |

- **Kya NAHI chahiye:** multi-region, ML ranking, cells, Cassandra (optional -- team ko aata ho toh abhi shift kar lo, warna 100x se pehle).

> Interview line: "10x par pull query ka cost har read par 200 seeks ho jaata hai, isliye main fan-out on write laata hoon -- Kafka ke through async, taaki post API fast rahe. Feed ZSETs Redis Cluster mein. Aur jaise hi 10K+ follower accounts aate hain, hybrid: unke posts push nahi, read time par pull."

### 100x -- 100M DAU: hamara spec baseline (sizing math)

Yahi woh architecture hai jo Part 2 mein banaya: Post / Graph / Feed / Like services (Node.js), Cassandra for posts + likes, Postgres for users + follows, Redis Cluster for feeds, Kafka + fan-out workers, hybrid with 10,000 threshold. Ab har component ka size nikalte hain.

#### 1. Fan-out workers

- Load: **~23K inserts/s average, ~69K/s peak**, aur 1K posts/s spikes par 1K x 200 = **~200K inserts/s**.
- **Assumption:** ek Node.js worker process `FANOUT_BATCH = 1_000` followers ka pipeline bhejta hai (har follower = `ZADD` + `ZREMRANGEBYRANK` = 2 commands). Follower list fetch + active filter + pipeline ke saath ek process **~10K inserts/s** (~20K Redis commands/s) conservatively maante hain. Benchmark karke confirm karo -- ye number hardware aur batch size par depend karta hai.
- Peak 69K / 10K = **~7 workers**. Spike 200K / 10K = **~20 workers**. Plan: **24 worker processes** (capacity ~240K inserts/s) + autoscaling on `kafka_consumer_lag`.
- **Asli number isse kam hai:** fan-out sirf un followers ko jo last `ACTIVE_DAYS = 30` mein active the. 69K pure-push upper bound hai.

#### 2. Kafka

- `posts.created` par ~350 msgs/s peak, 1K/s spike, ~1 KB each = **~1 MB/s**. Throughput ke liye Kafka ko kuch nahi.
- **Partitions throughput ke liye nahi, parallelism ke liye:** consumer group mein ek partition = max ek consumer. 24 workers ke liye kam se kam 24 partitions; headroom ke liye **48 partitions** (baad mein 48 workers tak scale). Key = `authorId` -> ek author ke posts order mein.
- RF 3, `min.insync.replicas = 2`, retention 7 din (replay ke liye -- feeds rebuild karne mein kaam aata hai).

#### 3. Redis (feed cache)

- Spec: **~1.28 TB** -> **~20 shards of 64 GB** + har shard ka ek replica = ~40 nodes.
- Production reality: Redis ko 100% memory tak nahi bharte (fork for snapshot, fragmentation). 75% target par 1.28 TB / 0.75 / 64 GB = **~27 shards**. Toh "~20 shards" data ka size hai; deploy **~24-30** karo.
- Commands: 69K inserts/s x 2 = ~138K commands/s / 20 shards = **~7K/s per shard** -- Redis ke liye bahut kam. Spike par ~20K/s per shard -- phir bhi theek.
- Aur keys bhi hain: `post:{postId}` (10M posts/day x 1 KB, TTL 24 h = ~10 GB), `timeline:{authorId}`, `likes:{postId}`, `following:{userId}`. Inko alag Redis cluster mein rakhna achha hai (feeds ka eviction policy alag, hydration cache ka alag).

#### 4. Cassandra (posts, likes)

- **Storage:** 3.65 TB/year x RF 3 = **~10.95 TB/year** raw (+ `posts_by_author`, `post_likes` -- chhote rows).
- Common guidance: ek Cassandra node par ~1-2 TB data rakho (compaction ke liye disk aadhi khaali). 2 TB per node -> **~6 nodes/year**, 3 saal = ~16-17 nodes.
- **Read load:** hydration = 35K reads/s x 20 posts = **700K post lookups/s**. `post:{id}` cache ka hit ratio 95% maano -> **~35K Cassandra reads/s** misses. LOCAL_QUORUM (RF 3) = 2 replicas per read = ~70K replica reads/s. ~10K reads/s per node maano -> ~7 nodes sirf reads ke liye.
- **Start: ~12 nodes** (6 per AZ-pair ya 3 racks x 4), storage aur reads dono cover. Linear scaling -- node add karo, data rebalance.

#### 5. Feed service (Node.js)

- 35K reads/s. Har read: 3-10 Redis calls + k-way merge + hydration MGET + ~20 KB JSON. **Assumption:** ek Node process ~1,000 feed reads/s (I/O bound; JSON serialize ~20 KB mein thoda CPU).
- 35K / 1K = 35 processes; 40% headroom (AZ failure, deploys) -> **~50 pods**.
- Bandwidth: **~5.6 Gbps** peak / 50 = ~110 Mbps per pod -- koi dikkat nahi.

#### 6. Naya bottleneck: celebrity hot keys

- Pull model ka matlab: har reader jo Virat/Shah Rukh jaisa 50M-follower account follow karta hai, woh `timeline:{celebId}` padhta hai. Maano average reader ~10 celebs follow karta hai -> 35K x 10 = **~350K timeline reads/s**, aur top celebs ki keys par sabse zyada.
- Ek key = ek Redis shard. Ek shard par lakhon reads/s = **hot key**.
- **Fix:** feed service ke andar **in-process LRU cache** of `timeline:{celebId}` with **1 s TTL**. 50 pods -> har hot celeb key par max ~50 reads/s. Celebrity ka naya post 1 s late -- acceptable (eventual consistency). Plus Redis read replicas for the timeline cluster.

> Interview line: "100M DAU par ~69K feed inserts/s peak -- maine ~10K inserts/s per worker maan ke 24 fan-out workers aur 48 Kafka partitions rakhe, taaki spikes par bhi 240K/s capacity ho. Feed cache 1.28 TB, yaani ~20 shards data ke hisaab se, 75% memory target par ~27. Cassandra 11 TB/year RF 3 ke saath ~12 nodes se start. Feed service ~50 Node pods. Naya bottleneck celebrity timelines ka hot key hai -- usko in-process 1 second cache se todta hoon."

### 1000x -- ~1B DAU: kya bottleneck banega?

Honest baat: 1B DAU sirf kuch hi companies (Facebook/Instagram level) ke paas hai. Interviewer yahan bottleneck thinking dekhna chahta hai.

| Bottleneck | Kyun | Kya karunga |
|---|---|---|
| **Geography** | Users har continent par; ek region se 200 ms p99 physically mushkil | **Multi-region**: har user ka home region; har region ke apne feed caches aur fan-out workers |
| **Cross-region fan-out** | India ke author ka follower US mein | `posts.created` region-to-region mirror (MirrorMaker jaisa); har region apne local followers ko push karta hai. Cassandra multi-DC async replication |
| **Feed cache** | ~12.8 TB x regions (+ replicas) | Sirf active users; entries chhote (postId + score packed); cold users ka feed on-demand rebuild |
| **Fan-out** | ~690K inserts/s pure push | Worker fleet ~100+ per region; **threshold dynamic** (load ke hisaab se 10K ko 5K kar do) |
| **Blast radius** | Ek bad deploy = 1B users ka feed down | **Cell architecture**: users ko cells mein baanto (har cell = apna feed service + Redis + workers); staged rollouts cell by cell |
| **Ranking** | Reverse-chron se engagement nahi; V2 simple score kaafi nahi | **Ranking infra**: candidate generation (~500) -> feature store -> ML model serving -> re-rank; alag team |
| **Celebrity** | 100M+ follower accounts | Celebrity timelines ka regional cache + CDN-like edge caching |

> Interview line: "1000x par software se zyada geography aur blast radius bottleneck hai. Users ka home region, per-region feed caches aur fan-out, cross-region post replication async. Cells taaki ek deploy sab ko na maare. Aur ranking ek poora infra ban jaata hai -- candidates, features, ML serving. Lekin honestly, 100M DAU tak ka design hi 99% companies ki reality hai."

### Har scaling tool -- kab lagana hai, kab nahi

| Tool | Hamare system mein kab | Kab NAHI |
|---|---|---|
| **Stateless Node + LB** | 1x se | -- |
| **CDN** | 1x se, media (StoreBox) | Feed JSON (personalized hai, cache nahi hota) |
| **Postgres read replicas** | 1x se, profile / follower counts | Follow ke turant baad "am I following?" check (lag) |
| **Redis** | 1x (post cache), 10x (feeds, Cluster) | Source of truth -- kabhi nahi |
| **Kafka + fan-out workers** | 10x | 1x (in-process job kaafi) |
| **Hybrid celebrity pull** | 10x (jab 10K+ follower accounts aayein) | 1x |
| **Cassandra** | 100x (optional 10x) | 1x -- Postgres kaafi |
| **Postgres sharding (follows)** | 100x+ (by follower_id) | 1x/10x |
| **Multi-region, cells, ML ranking** | 1000x | Ek country ka app |

---

## PART 17 -- Failure Scenarios (interviewer style)

Format: **Problem -> Impact -> Solution.** Golden rules:

> 1. **Posts sach hain, feeds derived hain.** Cassandra + Postgres se har feed dobara ban sakti hai. Redis gaya = slow, data loss nahi.
> 2. **Feed degrade ho sakti hai, down nahi.** Thodi purani ya thodi kam personalized feed > error screen.
> 3. **Fan-out idempotent hai.** `ZADD feed:{uid} <createdAtMs> <postId>` do baar = ek hi entry. Isliye Kafka ka at-least-once theek hai.
> 4. **Recovery khud ek attack na bane.** Rebuild, retry, cache warm -- sab rate limited. Warna recovery hi Cassandra ko gira degi (Redis-down stampede lesson).

### Failure map

```
Failure                         Feed reads?          New posts?         Data safe?   Kaise heal
One Redis feed shard down       Degraded (5% users)  Yes                Yes          Replica promote, lazy rebuild
Whole Redis cluster lost        Degraded, slow       Yes                Yes          Lazy rebuild + warm active users
Kafka down                      Yes (no new pushes)  Yes (outbox)       Yes          Outbox relay drains
Fan-out backlog (mega event)    Yes (stale)          Yes                Yes          Prioritise active, scale, shed
Cassandra node down             Yes (RF 3)           Yes                Yes          LOCAL_QUORUM, hinted handoff
Postgres (follows) down         Yes (cached sets)    Yes                Yes          Follow/unfollow fail -> 503
Post svc crash after DB write   --                   Yes                Yes          Outbox relay
Duplicate Kafka message         Yes                  Yes                Yes          Idempotent ZADD
Bad ranking deploy              Yes (chronological)  Yes                Yes          Feature flag fallback
```

### 1. "What if one Redis feed shard goes down?"

- **Problem:** 20 shards mein se ek shard ka primary mara.
- **Impact:** ~5% users (jinke `feed:{userId}` us shard par hain) ka pushed feed nahi mil raha. 35K x 5% = **~1,750 feed reads/s** ko "feed nahi hai" dikhega.
- **Galat solution:** "Feed missing hai -> pull se rebuild karo." Ek rebuild = ~200 followees ke `posts_by_author` reads. 1,750 x 200 = **~350K Cassandra queries/s** -- normal load ka 10x. Cassandra bhi gira = poora system gira. Ye **stampede** hai (lessons/83 wala Redis-down database stampede).
- **Sahi solution (layers):**
  1. **Replica promotion:** Redis Cluster ka replica seconds mein primary banta hai. Zyada tar users ko kuch pata bhi nahi chalta.
  2. **Failover window mein degrade:** feed service `feed:{me}` read par error/timeout (50 ms) paata hai -> **"latest from top followees"** mode: user ke top ~50 followees ke `timeline:{authorId}` (doosre shards par, Redis mein hi) padh ke merge. Cassandra ko chhua bhi nahi.
  3. **Rebuild rate limited:** agar key sach mein missing hai (replica bhi gaya), toh rebuild ek global token bucket (jaise 200 rebuilds/s) ke andar. Limit se upar = degrade mode.
  4. **Single-flight per user:** ek user ne app mein 5 baar pull-to-refresh kiya -> rebuild sirf ek baar.
- Response mein `degraded: true` (internal header / metric), user ko error nahi.

### 2. "What if the whole Redis feed cluster is lost?"

- **Problem:** bad config push / region-wide issue -> saare `feed:*` keys gaye (1.28 TB).
- **Impact:** har user ki feed missing. Agar sab rebuild karein -> Cassandra dead.
- **Solution:**
  - **Lazy rebuild on read**, rate limited (upar wala token bucket) -- baaki sab degrade mode (top followees ke timelines; agar timelines bhi gaye toh Cassandra `posts_by_author` se sirf top 20 followees, har ek ka ek partition read, strict limit).
  - **Warm the most active users first:** ek background job `last_active_at` desc order mein users le ke unki feed rebuild kare (jaise 5K users/s) -- jo agle ghante app kholenge, unki feed ready. Inactive users ki feed tab banegi jab woh aayenge.
  - Fan-out workers normal chalte rehte hain -- naye posts nayi keys mein jaate hain (lekin trim + "key exists?" check: missing feed par sirf ek entry push karke "complete feed" ka dhoka mat do -- rebuild flag rakho).
  - Recovery ek-do ghante mein, **data loss zero** -- golden rule #1.

### 3. "What if Kafka is down?"

- **Problem:** Kafka cluster unreachable.
- **Impact:**
  - **Post create chalta hai** -- post Cassandra mein save + outbox entry (Part 2). Author ko `201` milta hai aur `timeline:{me}` se apna post turant dikhta hai (read-your-own-writes).
  - **Fan-out ruk gaya** -- followers ki feed mein naye posts nahi. Celebrity posts phir bhi dikhte hain (woh pull hain, Kafka par depend nahi).
- **Solution:** outbox relay retry karta hai; Kafka wapas aate hi drain. `fanout_lag_seconds` badhega -- alert. Feed stale hai, down nahi. **Kabhi mat karo:** "Kafka down hai toh sync fan-out kar do" -- post API 200 ZADD tak ruki, aur Redis par achanak spike.

### 4. "What if fan-out falls behind during a mega event?"

- **Problem:** World Cup final, last over. Normal ~350 posts/s ki jagah **3K posts/s** 15 minute tak. Demand 3K x 200 = **600K inserts/s**; capacity 24 workers x 10K = **240K/s**.
- **Impact (verified):** backlog (600K - 240K) x 900 s = **~324M inserts**. Kafka FIFO hai -- naya post is backlog ke peeche: **~22 minute lag**. Match khatam, posts feed mein ab aa rahe. Event ke baad normal load (~69K/s) par spare capacity ~171K/s -> drain **~32 minute**.
- **Solution:**
  1. **Autoscale workers** on `kafka_consumer_lag` -- 48 partitions tak 48 workers (Redis per shard ~60K commands/s tak -- theek hai).
  2. **Prioritise active users:** fan-out do passes mein. Pass 1: followers jo **last 24 h** mein active (ya abhi online) -- maano 40%. 600K x 40% = 240K/s = capacity ke barabar. Pass 2 (baaki 30-day active): low-priority topic, jab time mile.
  3. **Shed:** jo follower abhi tak app nahi khola, uske liye feed ka push skip karo -- woh aayega toh rebuild ho jaayega.
  4. **Dynamic threshold:** load par `CELEBRITY_THRESHOLD` 10K se 2K kar do -> zyada authors pull mein, fan-out kam.
- Alert: `fanout_lag_seconds` p99 > 30 s.

### 5. "What if a user crosses the celebrity threshold?"

- **Problem:** ek creator viral hua, followers 9,990 -> 10,050. Ab woh "celebrity" hai -- naye posts push nahi honge.
- **Impact:** agar switch galat hua: purane pushed posts `feed:*` mein hain + naya post `timeline:{authorId}` se pull -> **duplicate** dikh sakte hain (same postId do sources se). Ya gap: kuch posts na push hue, na timeline mein.
- **Solution:**
  - `timeline:{authorId}` **har author ke liye** likha jaata hai (post service se) -- toh switch par koi gap nahi.
  - K-way merge mein **dedupe by postId** -- same post do sources se aaye toh ek.
  - **Hysteresis:** celeb banne par 10,000; wapas normal hone par 8,000 se neeche. Warna 9,999 <-> 10,001 par flapping.
  - `celebs:{userId}` cache (TTL 10 min) -> readers 10 min tak naye celeb ko pull nahi karenge. Isliye switch ke baad pehle 10 min dono karo (push bhi, timeline bhi) -- dedupe sambhal lega.

### 6. "What if a Cassandra node goes down?"

- **Problem:** 12 mein se ek node mara.
- **Impact:** RF 3 ke saath har row ki 2 copies zinda. `LOCAL_QUORUM` (2 of 3) reads/writes chalte hain. Latency thodi badhti hai.
- **Solution:** driver dead node ko skip karta hai (token-aware + speculative retry). Hinted handoff chhote outages (default 3 h) cover karta hai; lamba outage = `nodetool repair` / node replace. **Do nodes same token range ke gaye** -> LOCAL_QUORUM fail -> hydration misses fail -> jo posts `post:{id}` cache mein hain woh dikhenge, baaki skip (feed thodi chhoti).

### 7. "What if Postgres (follows DB) is down?"

- **Impact:**
  - **Feed reads chalte hain:** feed read ko follows ki zarurat sirf `following:{userId}` / `celebs:{userId}` (Redis, TTL 10 min) ke liye. Cache hit -> kuch nahi hua. Miss -> celebs merge skip (pushed feed phir bhi dikhegi).
  - **Fan-out:** followers list chahiye. Worker ka follower list cache (Redis) se chalta hai; miss par message retry (Kafka mein pada rahega) -- lag badhega, loss nahi.
  - **Follow / unfollow fail -> 503.** Ye write hai, source of truth down hai -- fake success mat do.
- **Solution:** sync standby promote (Patroni / RDS Multi-AZ jaisa), 30-60 s. Outage ke dauraan cache TTL badha do (stale follow list > no feed).

### 8. "What if the post service crashes after writing to Cassandra but before Kafka?"

- **Problem:** classic dual write. Post saved, `posts.created` publish nahi hua.
- **Impact (bina outbox):** post author ke timeline mein hai, lekin kisi follower ki feed mein nahi -- **chupchaap gayab**.
- **Solution: outbox pattern** (Payment System wala) -- post ke saath hi outbox row likhi jaati hai; relay use Kafka mein publish karta hai, crash ke baad bhi. Relay at-least-once hai -> duplicates possible -> agla point.

### 9. "What about duplicate Kafka messages?"

- **Problem:** worker ne 800 followers mein push kiya, offset commit se pehle crash. Rebalance ke baad naya worker same message dobara.
- **Impact:** kuch nahi. `ZADD feed:{uid} <createdAtMs> <postId>` -- same member, same score = no-op. Trim bhi idempotent.
- **Solution:** isliye fan-out ka design **naturally idempotent** rakha. Counter jaisa kuch mat karo (`INCR unread:{uid}`) fan-out mein -- woh duplicate par double hoga. Aur `Idempotency-Key` on `POST /v1/posts` client retry par duplicate *post* rokta hai (alag layer).

### 10. "What about a poison message?"

- **Problem:** ek `posts.created` message mein `authorId` corrupt / schema version unknown -> worker har baar throw karta hai.
- **Impact:** kafkajs retry karta rahega, **partition block** -- us partition ke saare authors (1/48 users) ki fan-out ruki.
- **Solution:** N retries (backoff ke saath) -> **retry topic** -> phir **DLQ** (`posts.created.dlq`) + alert. Schema validation (zod) message padhte hi. Partition aage badhta hai.

### 11. "What if hydration misses spike?"

- **Problem:** `post:{id}` cache flush ho gaya / naya deploy ne key format badla -> hit ratio 95% se 20%.
- **Impact:** Cassandra reads 35K/s se ~560K/s (700K x 80%). Cassandra slow -> feed p99 upar -> timeouts -> retries -> aur load.
- **Solution:** hydration par **per-request timeout (80 ms) + partial page** (jo mila woh dikhao, `nextCursor` sahi rakho); Cassandra reads ka concurrency limit (bulkhead) per pod; **request coalescing** (same postId ke concurrent misses = ek read -- viral post har feed mein hai); cache key format change ho toh dono formats padho (dual-read) during rollout. Alert: `hydration_cache_miss_total` rate baseline ka 3x.

### 12. "What if a bad ranking model is deployed?"

- **Problem:** V2 ranking ka naya weight deploy hua, feed mein 3 din purane posts upar, engagement 20% gira. Ya ranking service slow/down.
- **Impact:** errors nahi aaye, lekin product toot gaya -- **silent failure**.
- **Solution:** ranking **feature flag** ke peeche, % rollout (1% -> 10% -> 50%) aur product metrics (neeche PART 20) compare. Ranking call par **timeout (30 ms)**; fail/timeout -> **fallback to reverse-chronological** (V1). Flag flip = instant rollback, deploy nahi.

### 13. "What about a thundering herd after a push notification?"

- **Problem:** "India won!" push notification 50M users ko. 10% 60 s ke andar app kholte hain = **~83K feed reads/s** extra, normal peak ka 2.4x. Aur zyada tar inactive users -> feed missing -> rebuilds.
- **Impact:** feed service CPU full, rebuild stampede, Cassandra overload.
- **Solution:**
  - **Notification ko stagger karo** (Notification system: 50M ko 10 min mein baanto, ek second mein nahi).
  - Notification bhejne se pehle un users ki feeds **pre-warm** (rate limited).
  - Feed service autoscaling + **load shedding**: overload par degrade mode (no ranking, no celeb merge beyond top 20, smaller pages).
  - Client side: jitter + exponential backoff on 503.

### Code -- `getFeedEntries` with timeouts and degradation

```ts
// src/services/feed.service.ts (read path with fallbacks, simplified)
type Pushed = { state: 'HIT'; entries: FeedEntry[] } | { state: 'MISS' } | { state: 'DOWN' };

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timer = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); });
  try { return await Promise.race([p, timer]); } finally { clearTimeout(t); }
}

async function readPushed(d: FeedDeps, userId: string, cur: Cursor | null, n: number): Promise<Pushed> {
  try {
    const entries = await withTimeout(d.feedCache.read(userId, cur, n), 50);   // null = key missing
    return entries === null ? { state: 'MISS' } : { state: 'HIT', entries };
  } catch { return { state: 'DOWN' }; }                                          // shard down / timeout
}

export async function getFeedEntries(d: FeedDeps, userId: string, cur: Cursor | null, limit: number) {
  const [pushed, celebIds, mine] = await Promise.all([
    readPushed(d, userId, cur, limit),
    withTimeout(d.graph.getCelebs(userId), 30).catch(() => [] as string[]),
    withTimeout(d.timelines.read(userId, cur, limit), 30).catch(() => [] as FeedEntry[]),
  ]);

  let base: FeedEntry[];
  let degraded = false;
  if (pushed.state === 'HIT') {
    base = pushed.entries;
  } else if (pushed.state === 'MISS' && d.rebuildLimiter.tryTake()) {
    base = await d.singleFlight(`rebuild:${userId}`, () => d.rebuildFeed(userId));   // pull + write back
    d.metrics.feedRebuilds.inc();
  } else {
    degraded = true;                                                              // DOWN, or over rebuild budget
    const top = await withTimeout(d.graph.topFollowees(userId, 50), 30).catch(() => [] as string[]);
    base = (await d.timelines.readMany(top, cur, limit, 80)).flat();
  }

  const celebLists = await d.timelines.readMany(celebIds.slice(0, 100), cur, limit, 80);
  d.metrics.celebrityMergeSources.observe(celebLists.length);
  const entries = kwayMerge([base, ...celebLists, mine], limit * 2, cur);         // dedupe + cursor filter
  return { entries, degraded };
}
```

**Code Explanation:**

- `Pushed` type ke teen states -- `HIT` (feed mili), `MISS` (key hai hi nahi -> inactive user, rebuild chahiye), `DOWN` (shard down ya timeout). **MISS aur DOWN ko alag rakhna zaroori hai:** DOWN par rebuild karna = stampede (failure #1).
- `withTimeout` -- `Promise.race` ek timer ke saath. `finally { clearTimeout }` warna har request ek timer chhod jaata (35K/s par memory + event loop kaam). Note: race se asli Redis call cancel nahi hoti, sirf hum wait karna band karte hain.
- `readPushed` -- 50 ms budget. Pure 200 ms p99 mein se: pushed 50 + celebs 80 + hydration 80 -- har source ka apna budget, taaki ek slow source poori feed na roke.
- `Promise.all([...])` -- teen independent reads **parallel**. `getCelebs` (Redis `celebs:{userId}`, miss par Postgres) aur `timelines.read` (`timeline:{me}` = read-your-own-writes) apni galti par `[]` -- feed phir bhi banegi.
- `rebuildLimiter.tryTake()` -- global/per-pod token bucket. Budget khatam -> rebuild nahi, degrade. `singleFlight(key, fn)` -- same user ke parallel requests ek hi rebuild share karein.
- `rebuildFeed` Cassandra `posts_by_author` se pull karke `feed:{me}` mein wapas likhta hai; uske baad user normal push path par. `feedRebuilds` = spec ka `feed_rebuilds_total`.
- Degrade branch: top 50 followees ke `timeline:{authorId}` -- Redis ke doosre shards par, Cassandra ko nahi chhoota. `readMany(ids, cur, n, 80)` pipelined reads ek 80 ms budget ke saath; jo shard slow hai uski list skip.
- `celebIds.slice(0, 100)` -- koi 5,000 celebs follow kare toh 5,000 reads nahi. `timelines.readMany` celeb keys ke liye pehle **in-process 1 s cache** dekhta hai (hot key fix). `celebrityMergeSources.observe` = spec ka `celebrity_merge_sources` histogram.
- `kwayMerge(lists, limit * 2, cur)` -- min-heap merge (Part 3), dedupe by postId (threshold switch par duplicates), cursor se purane hi. `limit * 2` kyunki aage filter (deleted, blocked, unfollowed) kuch entries hataayega; phir hydration aur page of 20.
- `degraded` -- controller ise metric + log mein daalta hai (`feed_degraded_total` jaisa extra counter), user ko error nahi.

> Interview line: "Feed ek derived view hai, isliye Redis shard gira toh main fail open karta hoon: replica promote tak top followees ke Redis timelines se degraded feed, Cassandra ko chhue bina. Missing feed ka rebuild token bucket aur single-flight ke peeche, taaki recovery stampede na bane. Har source ka apna timeout -- pushed 50 ms, celebs 80 ms, hydration 80 ms. Kafka down ho toh post outbox mein safe, sirf fan-out late; aur fan-out ZADD idempotent hai toh duplicate messages harmless."

### Failure summary

| Failure | Detect kaise | Kya hota hai |
|---|---|---|
| Redis feed shard down | Redis health, `feed_cache_hit_ratio` drop | Replica promote, degrade mode, rate-limited rebuild |
| Redis cluster lost | `feed_rebuilds_total` spike | Lazy rebuild + warm active users |
| Kafka down / backlog | `kafka_consumer_lag`, `fanout_lag_seconds` | Outbox holds, prioritise active users, autoscale |
| Cassandra node down | Driver errors, Cassandra latency | RF 3 + LOCAL_QUORUM |
| Postgres down | Follow API 5xx | Cached follow sets, follows 503 |
| Hydration misses | `hydration_cache_miss_total` | Timeouts, partial page, coalescing |
| Poison message | Retry count, DLQ size | Retry topic -> DLQ |
| Bad ranking | Engagement drop, ranking latency | Flag off -> chronological |
| Push-notification herd | Feed RPS spike | Stagger, pre-warm, shed |

---

## PART 18 -- Consistency

### Teen words, simple Hinglish mein

- **Strong consistency:** jaise hi ek jagah value badli, **har** padhne wala turant nayi value dekhega. Jaise bank balance -- transfer ke baad koi bhi ATM purana balance nahi dikhayega.
- **Eventual consistency:** abhi kuch log purani value dekh sakte hain, thodi der (seconds) mein sab same. Jaise tumhara dost ka naya post -- tumhe 3 second baad dikha, kisi aur ko 1 second baad.
- **Read-after-write (read-your-own-writes):** **jisne likha** woh turant apna likha dekhe. Baaki log thoda baad dekhein toh chalega. Jaise tumne post kiya aur feed refresh ki -- tumhara post wahan hona hi chahiye, warna tum dobara post karoge.

### Is system mein kahan kya?

| Cheez | Kya chahiye | Kaise |
|---|---|---|
| **Post create (durability)** | Strong -- 201 = post saved | Cassandra write LOCAL_QUORUM, phir 201 |
| **Followers ki feed mein naya post** | Eventual (p99 < 5 s) | Kafka -> fan-out workers |
| **Author ka apna post** | Read-your-own-writes | `timeline:{me}` merge har feed read mein |
| **Follow / unfollow (graph)** | Strong for the actor | Postgres primary, unique PK |
| **Follow ka feed par effect** | Eventual | Async backfill last 20 posts |
| **Unfollow / block ka feed par effect** | Next read par (filter at read) | Feed read par following set se filter |
| **Delete** | "Jaldi" (seconds) -- legal cases mein strict | Tombstone + filter at hydration |
| **Like count** | Approximate, eventual | Redis `INCR likes:{postId}`, async flush |
| **viewerHasLiked** | Read-your-own-writes | `post_likes` / Redis set, user ne like kiya toh turant true |
| **Cross-region (1000x)** | Eventual (seconds) | Async replication |

**Rule of thumb:** jo cheez **user ne khud ki** (post, like, follow, delete) -- woh use turant dikhni chahiye. Jo **doosre ne ki** -- woh seconds late chalega.

### Timeline 1 -- read-your-own-writes toota (bina `timeline:{me}` ke)

```
t=0.00  Riya: POST /v1/posts "Got the job!" -> Cassandra saved -> 201
t=0.05  Outbox -> Kafka posts.created (fan-out lag starts)
t=0.30  Riya pulls to refresh: GET /v1/feed -> reads feed:{riya} -> her own post NOT there
        (fan-out never writes into the author's own feed, or it is 3 s behind)
t=0.40  Riya thinks "post fail ho gaya" -> posts again -> duplicate post
```

**Fix:** post service post create ke saath `timeline:{riya}` ZSET mein bhi ZADD karta hai (same request mein, sync). Feed read `timeline:{me}` ko merge karta hai -> Riya ka post t=0.30 par dikhta hai. Aur client ka retry `Idempotency-Key` se duplicate nahi banta.

### Timeline 2 -- follow aur unfollow

```
t=0     Aman follows @chef_rohan (non-celeb) -> Postgres row -> 204
t=0.1   Aman opens feed -> feed:{aman} has none of Rohan's posts yet
t=1.5   follows.changed consumer backfills Rohan's last 20 posts into feed:{aman}
t=2     Aman refreshes -> Rohan's posts appear (in correct time order, score = createdAtMs)

t=10    Aman unfollows Rohan -> Postgres delete -> following:{aman} invalidated
t=10.1  feed:{aman} still has 20 Rohan posts (cleanup is async)
        feed read filters entries whose author is not in following:{aman} -> not shown
t=60    cleanup job removes them from feed:{aman}
```

- **Follow par eventual theek hai** (1-2 s), unfollow par **turant** chahiye -- user ko "maine unfollow kiya phir bhi dikh raha" bura lagta hai. Isliye filter at read.
- **Gotcha:** `following:{aman}` cache TTL 10 min hai. Agar unfollow par invalidate nahi kiya toh 10 min tak posts dikhenge. Rule: **user ke apne action par uska cache turant invalidate** (write-through), TTL sirf safety net.

### Timeline 3 -- delete aur tombstone

```
t=0     Author deletes post 2100...464 -> Cassandra posts_by_id.deleted = true
t=0.01  post:{2100...464} in Redis overwritten with tombstone {"deleted":true} (TTL 24 h)
t=0.02  posts.deleted -> Kafka -> cleanup worker (ZREM from feeds, async, can take minutes)
t=0.5   Follower reads feed -> feed:{follower} still has the postId
        hydration: MGET post:{id} -> tombstone -> item dropped from page
```

- **DEL ki jagah tombstone kyun?** Race: ek feed read ne abhi Cassandra se purana (not-deleted) post padha aur cache mein likhne wala tha. Agar humne sirf DEL kiya, woh purana post dobara cache ho jaayega 24 h ke liye. Tombstone + "cache set only if not exists" (`SET ... NX`) ye race rokta hai.
- **Page chhota ho jaata hai** (20 mein se 19) -- isliye merge `limit * 2` laata hai.
- **Legal takedown** (court order, CSAM, doxxing): "seconds" kaafi nahi, **hard guarantee** chahiye. Tombstone ke saath CDN media purge (StoreBox key delete + CDN invalidation), aur audit log. Media URL agar kisi ke paas already hai toh CDN purge tak kaam karega -- isliye private media ke liye short-lived signed URLs.

### Timeline 4 -- like count

```
t=0     Post has like_count 1,000 in Cassandra; likes:{id} = 1,000 in Redis
t=1     500 users like in 2 s -> INCR likes:{id} x 500 -> 1,500 in Redis
t=1.5   User A sees 1,380 (response built mid-way), user B sees 1,500
t=30    Flush job writes counter delta to Cassandra post_counters
```

- Like count **approximate** hai aur ye theek hai -- koi "1,380 vs 1,500" par complaint nahi karta. **Lekin** `viewerHasLiked` exact hona chahiye (user ne like kiya, refresh par dil khaali = bug) -- woh `post_likes` / per-user set se aata hai, counter se nahi.
- Redis crash flush se pehle -> kuch increments gaye. Count ko `post_likes` rows se periodically **reconcile** karo (exact source).

### Timeline 5 -- cross-region lag (1000x)

```
t=0     Author (home region: ap-south) posts -> Cassandra DC ap-south
t=0.2   Friend in ap-south sees it (local fan-out)
t=0.8   posts.created mirrored to us-east -> us-east fan-out -> friend in US sees it
t=0.9   US friend likes it -> like written in us-east -> replicated to ap-south at t=1.3
```

- Region ke andar seconds, cross-region thoda aur. Anomaly: US friend ne post dekha, reply kiya, lekin author ke region mein reply post se pehle kuch ms dikh sakta hai (causal order). Feed ke liye acceptable; comments/DMs (Chat System) mein causal ordering zyada matter karta hai.

> Interview line: "Feed eventually consistent hai -- followers ko naya post p99 5 s mein, aur ye requirement mein hi likha hai. Lekin author ko read-your-own-writes chahiye, jo main `timeline:{me}` ko har read mein merge karke deta hoon. Unfollow aur block read time par filter hote hain taaki turant effect ho, cleanup async. Delete ke liye post cache mein tombstone likhta hoon, DEL nahi, taaki race mein purana post wapas cache na ho. Like count approximate hai, lekin viewerHasLiked exact. Post ka save hona strong hai -- 201 tabhi jab Cassandra quorum ne likh liya."

---

## PART 19 -- Security

News feed mein security ka matlab: **"kaun kiska post dekh sakta hai, kaun kya likh/mita sakta hai, aur bots platform ko spam se na bhar dein."** Ek private account ka post public feed mein leak hua = trust khatam + privacy law ka case.

### Threat -> defence map

| Threat | Defence |
|---|---|
| Private account ka post non-follower ko dikha | Visibility check at fan-out **aur** at read |
| Blocked user ka post / blocker ko dikhna | Block filter both directions, at read |
| Kisi aur ka post delete (IDOR) | Author check inside the write (LWT), 404 |
| Kisi aur ki media key attach karna | Media key prefix = `media/{myUserId}/`, ownership check |
| Spam / bot posting | Rate limits, account age, content checks |
| XSS in post text | Store raw, escape on render, URL allow-list |
| Follower list leak (private account) | Authz on follower APIs, no counts leak via errors |
| Follow-spam | Follow rate limits, velocity rules |
| Account deletion (GDPR-style) | Purge pipeline across DB + caches + feeds + media |
| Token theft, sniffing | TLS, short-lived JWT, secrets in a secret manager |

### 1. Authentication + authorization on visibility

- **AuthN:** API Gateway par JWT (access token ~15 min) verify; `userId` token se, **kabhi body/query se nahi**.
- **Private accounts:** fan-out worker private author ke posts sirf approved followers ko push karta hai (follows table mein woh already approved hi hote hain). Lekin **read par bhi check** -- follow request revoke hua, cache mein purana feed pada hai.
- **Blocks:** A ne B ko block kiya -> B ke posts A ko nahi, A ke posts B ko nahi. Fan-out: blocked followers ko skip (block = follow bhi toot jaata hai). Read: `blocked:{me}` set (chhota, cached) se filter.
- **Mutes:** sirf viewer side -- fan-out chalta hai, read par filter. (Mute ka author ko pata nahi chalna chahiye.)
- **User timeline** `GET /v1/users/:id/posts` -- private account + viewer follower nahi -> **403** (ya 404, taaki "account exist karta hai" bhi leak na ho -- product decision).
- **Defence in depth:** filter **read par hamesha**, kyunki push time ka check stale ho sakta hai.

### 2. IDOR on delete -- author check inside the write

**IDOR ka simple matlab:** Insecure Direct Object Reference -- URL mein id badal ke kisi aur ka object chhoo lena. `DELETE /v1/posts/2100...464` -- kya server check karta hai ki ye post mera hai?

```ts
// src/services/post.service.ts (delete, simplified)
import { types } from 'cassandra-driver';

export async function deletePost(d: PostDeps, userId: string, postId: string): Promise<void> {
  if (!/^\d{1,19}$/.test(postId)) throw new ApiError(404, 'NOT_FOUND');

  const rs = await d.cassandra.execute(
    'UPDATE posts_by_id SET deleted = true WHERE post_id = ? IF author_id = ?',
    [types.Long.fromString(postId), types.Long.fromString(userId)],
    { prepare: true, consistency: types.consistencies.localQuorum });
  if (!rs.wasApplied()) throw new ApiError(404, 'NOT_FOUND');          // not mine OR not found

  await d.postCache.setTombstone(postId);                               // post:{id} = {"deleted":true}
  await d.outbox.add('posts.deleted', postId, { postId, authorId: userId });
  d.logger.info({ userId, postId, action: 'post.delete' }, 'audit');
}
```

**Code Explanation:**

- Regex check -- Snowflake id sirf digits, max 19. Kachra input Cassandra tak nahi jaata. Id **string** hai (2^53 se bada -- JS `number` mein precision jaayegi, spec rule).
- `types.Long.fromString(...)` -- cassandra-driver ko bigint `Long` ke roop mein do, `Number(postId)` kabhi nahi (last digits badal jaate).
- `UPDATE ... IF author_id = ?` -- **Lightweight Transaction (LWT)**: condition aur update ek atomic step. "Pehle read karo, author match karo, phir update" mein check aur write ke beech gap hota hai; yahan nahi. LWT Paxos use karta hai -- slow (4 round trips), lekin delete rare hai, toh theek.
- `!rs.wasApplied()` -> **404, 403 nahi**. 403 bolna = "ye post exist karta hai, bas tumhara nahi" -- ye bhi info leak hai. Spec bhi "404 otherwise" kehta hai.
- `setTombstone` -- PART 18 wala race-safe delete for hydration cache.
- `outbox.add('posts.deleted', ...)` -- feeds se async cleanup ke liye event; key = postId. (Outbox yahan conceptual hai -- Part 2 mein uska implementation.)
- Audit log -- kisne kab kya delete kiya; moderation disputes mein kaam aata hai.

### 3. Media key ownership

- `POST /v1/posts` body mein `mediaKeys: ["media/u1/abc.jpg"]`. Attacker kisi aur ki private image key daal de -> hamare CDN se woh image uske post mein publicly dikhegi.
- **Fix:** keys sirf `media/{authUserId}/...` prefix wali accept; aur upload record (File Storage) se verify ki upload complete hua aur isi user ne kiya. Max 4, warna 400.

### 4. Spam and bots

- **Rate limits** (Rate Limiter system): per user posts (jaise 10/min, 300/day), follows (jaise 50/hour), likes. `429` + `Retry-After`.
- **Account age / trust score:** naya account (< 24 h) ke posts ki reach kam (sirf followers, no ranking boost), links wale posts par stricter limit.
- **Content checks async:** duplicate text across many accounts (bot ring), link reputation; spam flagged -> post tombstone + fan-out cleanup.
- **Idempotency-Key** accidental duplicates rokta hai, spam nahi -- dono alag problems.

### 5. XSS in post text

- **Store raw, escape on render.** DB mein user ka exact text (500 chars). HTML escaping client (React by default escape karta hai) / server-rendered pages par. Store karte waqt escape karoge toh mobile app mein `&lt;` dikhega aur double-escaping bugs.
- **`dangerouslySetInnerHTML` kabhi nahi** post text ke liye. Links/mentions ko parse karke **structured entities** banao (`{type:'url', start, end, href}`), string concat se HTML nahi.
- **URLs:** sirf `http`/`https` scheme allow (`javascript:` block), `rel="noopener noreferrer nofollow"`, aur optional link shortener/redirect page jo malicious domains block kare.
- Media: user uploads alag domain se (`chirp-usercontent.com` jaisa), `nosniff` -- File Storage lesson wala stored-XSS defence.

### 6. Privacy

- **Follower list of a private account:** `GET /v1/users/:id/followers` sirf owner + approved followers. Error messages aur counts se bhi leak mat karo.
- **Account deletion (GDPR-style right to erasure):** event `user.deleted` -> purge pipeline:
  - Postgres: user row anonymize/delete, follows delete (dono directions).
  - Cassandra: posts `deleted = true` (tombstone), phir hard delete job; likes remove.
  - Redis: `feed:{uid}`, `timeline:{uid}`, `following:{uid}`, `post:{id}` of their posts -> tombstones; doosron ki feeds mein unke postIds read-time filter se chhup jaate hain.
  - StoreBox media delete + CDN purge. Backups: retention window ke baad expire (policy mein likho).
  - Logs mein userId, raw text nahi -- warna logs se bhi erase karna padega.
- **Search/analytics copies** (Kafka topics, data warehouse) bhi purge list mein -- log compaction / TTL.

### 7. Follow abuse

- **Follow-spam:** bot 10K accounts ko follow karta hai taaki woh wapas follow karein. Fix: follow rate limit, "follow + unfollow churn" detection, suspicious accounts ka follow silently not delivered (shadow).
- Follow graph ki aur ek attack: fake followers se kisi ko **celebrity threshold** paar karwana -- sirf system behaviour badalta hai, security issue nahi; lekin follower counts bot-filtered rakho.

### 8. Secrets, TLS, API security

- TLS client se LB tak; internal services ke beech mTLS ya private network.
- DB passwords, Kafka creds, JWT signing keys -> **secret manager** (AWS Secrets Manager / Vault), env var mein inject; code/repo mein kabhi nahi. JWT keys rotate (kid header).
- **Cursor tampering:** cursor opaque base64 hai lekin encrypted nahi -- server decode karke validate kare (`s` number, `id` digits). Cursor se sirf "kahan se" milta hai, "kiska feed" nahi -- feed hamesha token ke `userId` ka.
- `limit` max 50 -- `limit=100000` se DoS nahi.
- SQL injection: Postgres par parameterized queries, Cassandra par prepared statements -- string concat kabhi nahi.

> Interview line: "Visibility sabse important security concern hai: private accounts, blocks aur mutes -- fan-out par skip karta hoon aur read par hamesha filter, kyunki push-time check stale ho sakta hai. Delete ek LWT se hota hai jismein author check write ke andar hai, aur galat owner ko 404 milta hai taaki existence leak na ho. Media keys sirf user ke apne prefix ki. Post text raw store, render par escape, URLs sirf http/https. Spam ke liye rate limits aur account-age based reach. Account delete ek purge pipeline hai jo DB, Redis, feeds, media aur analytics tak jaata hai."

---

## PART 20 -- Observability

Chirp ke baare mein teen log sawaal poochte hain:
- **On-call:** "Feed khul rahi hai? p99 200 ms ke andar? Redis/Cassandra/Kafka theek?"
- **Freshness owner:** "Naye posts followers tak kitni der mein pahunch rahe hain? Fan-out peeche toh nahi?"
- **Product team:** "Feed achhi hai? Empty feeds kitni? Engagement gira?"

Normal APIs sirf pehla sawaal poochte hain. Feed mein **doosra aur teesra** zaroori hai -- kyunki feed "200 OK" deti rahegi jab ki woh 20 minute purani ho ya ranking toot gayi ho.

### 1. Logs -- structured, sampled

```json
{"ts":"2026-09-18T20:14:03Z","level":"info","msg":"feed.read","requestId":"req_91ac","traceId":"7d3e0a...",
 "userId":"1839022","limit":20,"hasCursor":true,"pushedState":"HIT","celebSources":7,"returned":20,
 "filtered":2,"hydrationMisses":1,"degraded":false,"durationMs":64}
```

- **Volume:** 35K reads/s x ~500 bytes = **~1.5 TB/day** agar har read log kiya. Isliye **sample**: success reads ka ~1% (~15 GB/day), lekin **errors, degraded, aur slow (> 200 ms) hamesha**. Aggregates metrics se aate hain, logs se nahi.
- Post create, delete, follow, block -- har ek log (low volume, audit value).
- **Kabhi log nahi:** JWT, post text (PII ho sakta hai -- phone numbers, addresses), media URLs signed tokens ke saath, passwords.
- Library: `pino` (fast JSON logger) + `requestId`/`traceId` har line mein (AsyncLocalStorage se).

### 2. Metrics -- spec ki list + RED + infra

| Metric | Type | Kya batata hai |
|---|---|---|
| `feed_read_duration_seconds` | Histogram | Feed p50/p99 -- SLO 200 ms. **D** of RED |
| `http_requests_total{route,status}` | Counter | RPS + error rate per route -- **R** and **E** |
| `feed_cache_hit_ratio` | Gauge | Feed Redis mein mili vs rebuild. Drop = shard issue / cold users flood |
| `feed_rebuilds_total` | Counter | Pull rebuilds; spike = Redis loss ya push-notification herd |
| `fanout_lag_seconds` | Histogram | Post created -> last follower feed written. **Freshness ka main number** |
| `fanout_writes_total` | Counter | Feed inserts/s (~23K avg, ~69K peak) |
| `kafka_consumer_lag{group="feed-fanout"}` | Gauge | Kitne `posts.created` messages pending |
| `post_create_duration_seconds` | Histogram | Post API latency (Cassandra + outbox) |
| `hydration_cache_miss_total` | Counter | `post:{id}` misses -> Cassandra reads |
| `celebrity_merge_sources` | Histogram | Celeb timelines merged per read (fan-in cost) |
| Redis: `used_memory`, `evicted_keys`, ops/s, per shard | redis_exporter | Memory 75% target, evictions = feeds kat rahe |
| Cassandra: read/write p99, pending compactions, dropped mutations | Cassandra exporter | Hydration misses ka cost, node health |
| Node: CPU, memory, **event loop lag** | `collectDefaultMetrics` | JSON serialize / merge CPU bottleneck |

**Cardinality rule:** labels mein `userId`, `postId`, `authorId` **kabhi nahi** -- 100M users = 100M time series = Prometheus dead. `route`, `status`, `source` (pushed/celeb/own) chhote sets.

### Code -- prom-client

```ts
// src/infra/metrics.ts
import client from 'prom-client';

client.collectDefaultMetrics();

export const feedReadDuration = new client.Histogram({
  name: 'feed_read_duration_seconds', help: 'GET /v1/feed server time',
  labelNames: ['degraded'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 1, 2],
});
export const feedRebuilds = new client.Counter({ name: 'feed_rebuilds_total', help: 'Feeds rebuilt by pull' });
export const hydrationMisses = new client.Counter({ name: 'hydration_cache_miss_total', help: 'post:{id} misses' });
export const celebrityMergeSources = new client.Histogram({
  name: 'celebrity_merge_sources', help: 'Celebrity timelines merged per feed read',
  buckets: [0, 1, 2, 5, 10, 20, 50, 100],
});
export const fanoutLag = new client.Histogram({
  name: 'fanout_lag_seconds', help: 'Post created -> last follower feed written',
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 300, 1800],
});

// in the fan-out worker, after the last pipeline for a post is written:
export function recordFanoutDone(createdAtMs: number) {
  fanoutLag.observe((Date.now() - createdAtMs) / 1000);
}
```

**Code Explanation:**

- `collectDefaultMetrics()` -- CPU, memory, GC, **event loop lag**. Feed service mein event loop lag badha = k-way merge ya 20 KB JSON serialize CPU kha raha hai -> pods badhao ya kaam kam karo.
- `feed_read_duration_seconds` buckets **200 ms ke aas-paas ghane** (0.1, 0.15, 0.2, 0.3) -- kyunki SLO wahi hai; histogram_quantile ki accuracy bucket boundaries par depend karti hai.
- `labelNames: ['degraded']` -- sirf `true`/`false`. Degraded reads fast ho sakte hain (kam kaam) -- alag rakho taaki normal p99 ka sach dikhe.
- `celebrity_merge_sources` buckets 0-100 -- code mein `slice(0, 100)` cap hai. p99 badhta dikhe = users bahut celebs follow kar rahe -> threshold / cache tune karo.
- `fanout_lag_seconds` buckets 0.1 s se **1800 s** tak -- normal < 5 s, lekin mega event mein 22 min tak ja sakta hai (PART 17 #4); bucket nahi hoga toh sab "+Inf" mein dikhega.
- `recordFanoutDone(createdAtMs)` -- lag = ab - post ka `createdAtMs` (Kafka message mein). Worker aur post service ki clocks mein thoda farq (NTP) -- ms level ka error, seconds ke metric ke liye theek.
- `feed_cache_hit_ratio` spec mein gauge hai; practically do counters (`hit`, `miss`) rakho aur PromQL mein ratio nikalo -- har pod ka apna gauge average karna galat hota hai.
- `/metrics` internal port par, public nahi.

**PromQL:**

```
# feed p99 (non-degraded)
histogram_quantile(0.99, sum by (le) (rate(feed_read_duration_seconds_bucket{degraded="false"}[5m])))

# fan-out p99 lag
histogram_quantile(0.99, sum by (le) (rate(fanout_lag_seconds_bucket[5m])))

# is consumer lag growing? (positive slope for 10 min)
deriv(kafka_consumer_lag{group="feed-fanout"}[10m]) > 0

# feed inserts per second
sum(rate(fanout_writes_total[1m]))
```

### 3. Alerts -- example thresholds

| Alert | Condition (example) | Severity | Kyun |
|---|---|---|---|
| **Feed slow** | `feed_read_duration_seconds` p99 > 200 ms for 10 min | Page | SLO toota |
| **Feed errors** | 5xx > 1% for 5 min | Page | Users ko error screen |
| **Fan-out lag** | `fanout_lag_seconds` p99 > 30 s for 10 min | Page | Feeds stale (target < 5 s) |
| **Consumer lag growing** | `kafka_consumer_lag{group="feed-fanout"}` badhta ja raha 15 min | Page | Workers down / slow / poison message |
| **Cache hit drop** | `feed_cache_hit_ratio` < 0.9 (normal ~0.97) | Page | Shard down, ya Redis evicting feeds |
| **Hydration miss spike** | `rate(hydration_cache_miss_total)` > 3x baseline | Warn -> Page | Post cache flush -> Cassandra overload aane wala |
| Rebuild spike | `rate(feed_rebuilds_total)` > 3x baseline | Warn | Redis loss ya herd |
| Redis memory | `used_memory` > 80% of maxmemory on any shard | Warn | Evictions shuru honge |
| Redis evictions | `evicted_keys` > 0 on feed cluster | Warn | Feeds chupchaap kat rahe |
| Cassandra latency | read p99 > 20 ms | Warn | Hydration slow |
| DLQ | `posts.created.dlq` mein koi message | Ticket | Kisi ka post fan-out nahi hua |
| Empty feed rate | Empty feed % baseline se 2x | Page (product) | Bug: filter/graph/cache sab kuch kaat raha |

### 4. Tracing -- ek feed read across sources

```
trace 7d3e0a...  GET /v1/feed?limit=20                              142 ms
  |-- auth (JWT verify)                                              1 ms
  |-- parallel:
  |     |-- redis ZREVRANGEBYSCORE feed:{u} (shard-07)              3 ms
  |     |-- redis SMEMBERS celebs:{u}                                2 ms
  |     |-- redis ZREVRANGEBYSCORE timeline:{u}                     2 ms
  |-- celeb timelines x7 (4 from in-process cache, 3 from redis)    6 ms
  |-- kway merge + filter (40 -> 38 entries)                         1 ms
  |-- hydration MGET post:{...} x20 (1 miss)                         4 ms
  |     |-- cassandra SELECT posts_by_id (miss)                      98 ms   <- slow node
  |-- authors + likes MGET                                           3 ms
  |-- serialize 20 KB                                                2 ms
```

- Trace turant dikhata hai: **ek Cassandra read ne feed ko 142 ms tak khicha** -- isi liye hydration par timeout aur speculative retry.
- OpenTelemetry (`@opentelemetry/sdk-node`) auto-instrumentation: http, ioredis, cassandra-driver, kafkajs. Kafka message headers mein `traceparent` -> fan-out worker ka span post create trace se link. Tab ek trace mein: post create -> Kafka -> fan-out -> feed write.
- **Sampling:** 35K/s par sab store karna mehenga. Head sampling ~1% + **tail sampling** (errors aur > 200 ms hamesha).
- Span attributes: `feed.pushed_state`, `feed.celeb_sources`, `feed.degraded`, `redis.shard`. `userId` sirf trace attribute (logs/metrics labels nahi), post text kabhi nahi.

### 5. Product metrics -- feed "sahi" hai ya nahi?

| Metric | Matlab | Kyun |
|---|---|---|
| **Feed freshness** | Feed ke top item ki age (median) | Fan-out / celeb merge toota toh top item purana |
| **Empty feed rate** | % feed reads jahan 0 items (jin users ke followees hain) | Filter bug, graph cache bug, rebuild fail |
| **New-post visibility** | Post create -> pehle follower ne dekha (sample) | End-to-end freshness, `fanout_lag_seconds` se user-facing |
| Engagement per session | Likes, scroll depth | Ranking deploy ka asar (A/B) |
| Degraded read % | `degraded=true` share | Kitne users ko "kam achhi" feed mili |

- Ye metrics ranking/feature flag rollouts ka **guardrail** hain -- PART 17 #12 wala bad ranking deploy yahin pakda jaata hai, error rate mein nahi.

### 6. Dashboard

```
+----------------------------------+----------------------------------+
| Feed RPS + 5xx                   | Feed p50/p99 (SLO line 200 ms)   |
+----------------------------------+----------------------------------+
| feed_cache_hit_ratio, rebuilds/s | Hydration misses/s, Cassandra p99|
+----------------------------------+----------------------------------+
| fanout_lag_seconds p50/p99       | kafka_consumer_lag, workers      |
+----------------------------------+----------------------------------+
| Redis memory/evictions per shard | Freshness, empty feed rate       |
+----------------------------------+----------------------------------+
```

> Interview line: "Main Chirp ko teen angle se observe karunga: availability -- feed p99 200 ms SLO, 5xx, degraded share; freshness -- `fanout_lag_seconds` p99 (target 5 s, alert 30 s) aur `kafka_consumer_lag` ka trend; aur product -- feed freshness, empty feed rate, engagement, jo bad ranking deploy pakadte hain. Logs 35K/s par sampled, errors aur slow hamesha. Trace post create se Kafka, fan-out aur feed read tak linked. Labels mein userId kabhi nahi."

---

## Remember

> **Feed ek derived view hai -- posts aur follows sach hain, Redis feeds dobara ban sakti hain; isliye feed par fail open (degrade, timeouts per source, rate-limited rebuild) aur posts par fail closed (quorum write + outbox). Scaling ka asli number posts/s nahi, feed inserts/s aur celebrity hot keys hain. Followers ke liye eventual (p99 < 5 s), author ke liye read-your-own-writes (`timeline:{me}`), unfollow/block/delete read par filter. Aur `fanout_lag_seconds` hi freshness ki dhadkan hai.**

## Quick Self-Test

1. Ek Redis feed shard gira. "Missing feed -> pull se rebuild" karna kyun khatarnaak hai (numbers ke saath)? Uski jagah kya karoge, aur code mein MISS aur DOWN alag kyun hain?
2. World Cup final mein 3K posts/s 15 minute tak aaye. 24 workers (~10K inserts/s each) ke saath lag kitna ho jaayega, aur use kam karne ke chaar tareeke kya hain?
3. Riya ne post kiya aur turant refresh kiya -- post nahi dikha. Ye kaunsi consistency tooti, aur `timeline:{me}` ise kaise fix karta hai? Unfollow par effect "turant" kaise milta hai jab cleanup async hai?
4. Delete par `post:{id}` ko DEL karne ki jagah tombstone kyun likhte hain? `DELETE /v1/posts/:id` mein IDOR kaise rokte ho, aur galat owner ko 403 ki jagah 404 kyun?
5. `fanout_lag_seconds`, `kafka_consumer_lag` aur "empty feed rate" -- teeno kya alag-alag pakadte hain? Ek bad ranking deploy kaunsa metric pakdega, aur rollback kaise hoga?

---

**Next (Part 5):** Trade-offs, MVP -> Scalable -> Highly Scalable, Follow-up questions, What-ifs, Node.js questions. "next" bolo.
