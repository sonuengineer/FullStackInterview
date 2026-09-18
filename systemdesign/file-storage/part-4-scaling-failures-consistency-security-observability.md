# File Storage (S3-style) -- HLD + LLD (Part 4: Scaling -> Failures -> Consistency -> Security -> Observability)

> Is file mein prompt ke **Parts 16-20** hain: scaling (1x se 1000x), failure scenarios, consistency, security, aur observability.
> Pichle parts ka recap: Part 1 mein numbers nikale (**~1,000 PUT/s aur ~7K GET/s peak, average object 500 KB, 10 TB/day ingest = 3.65 PB/year logical, 3x replication par ~10.95 PB/year raw, metadata ~7.3B objects aur ~7.3 TB per year**). Part 2 mein APIs, write path (8 MB chunks -> placement -> chain replication -> **W = 2 of 3** -> ek metadata commit) aur read path (Range, CRC32C verify, replica fallback) likha. Part 3 mein metadata tables, data node volumes, erasure coding 8+4, GC aur scrubber ka deep dive kiya. Ab dekhenge ye system **data badhne par, disks/nodes/AZ marne par, aur attack hone par** kaise behave karta hai.

**Ek baat pehle se yaad rakho:** Payment System mein sawaal tha "kya paisa do baar move ho sakta hai?". Yahan ek hi sawaal har decision ke peeche hai: **"kya koi byte chupchaap kho sakta hai?"** Storage system slow ho jaaye, 503 de de -- customer naraz hoga. Lekin ek invoice PDF hamesha ke liye gayab ho jaaye aur kisi ko pata bhi na chale -- ye **trust khatam** karta hai. Isliye rule: **durability ke maamle mein fail closed** -- shak ho toh "success" mat bolo.

> Honest note: asli AWS S3 isse kai orders of magnitude bada hai, aur uske internals sirf thode hi publicly described hain. Ye woh design hai jo interviewer "Design S3" ke jawab mein expect karta hai -- ShopKart ka apna **StoreBox**.

---

## PART 16 -- Scaling: 1x -> 10x -> 100x -> 1000x

### Pehle ek rule

Har level par teen sawaal:

1. **Sabse pehle kya tootega?** (bottleneck)
2. **Usko todne ka sabse sasta tareeka kya hai?**
3. **Kya abhi zarurat NAHI hai?**

**Storage system ki khaas baat:** yahan scaling ke **teen alag axes** hain, aur teeno alag cheezein todte hain:

| Axis | Kya todta hai |
|---|---|
| **Bytes** (PB per year) | Disks, racks, power, repair time, cost |
| **Objects count** (billions) | Metadata DB (rows, index size, LIST) |
| **Requests/s** (PUT/GET) | API nodes, metadata QPS, HDD IOPS, hot prefixes |

URL shortener mein sirf requests/s tha. Yahan 1 video (5 GB) aur 10,000 thumbnails (5 GB total) same bytes hain, lekin metadata par 10,000 guna alag load.

### Levels define karte hain

| Level | PUT/s peak | GET/s peak | Ingest/day | Logical/year | Objects/year | Metadata/year |
|---|---|---|---|---|---|---|
| **1x** (spec) | ~1K | ~7K | 10 TB | 3.65 PB | ~7.3B | ~7.3 TB |
| **10x** | ~10K | ~70K | 100 TB | 36.5 PB | ~73B | ~73 TB |
| **100x** | ~100K | ~700K | 1 PB | 365 PB | ~730B | ~730 TB |
| **1000x** | ~1M | ~7M | 10 PB | 3.65 EB | ~7.3T | ~7.3 PB |

**Raw disk (verified):** 20 TB HDD, ek storage node = 24 disks = 480 TB raw, 80% tak bharte hain (headroom repair aur compaction ke liye) = ~384 TB usable per node.

| Level | Raw/year, sab 3x | Raw/year, "30 din hot 3x + baaki COLD 1.5x" | Nodes/year (3x) | Nodes/year (mixed) |
|---|---|---|---|---|
| 1x | ~10.95 PB (~548 disks) | ~5.9 PB (~296 disks) | ~29 | ~15 |
| 10x | ~109.5 PB | ~59 PB | ~285 | ~154 |
| 100x | ~1,095 PB | ~593 PB | ~2,850 | ~1,540 |
| 1000x | ~10.95 EB | ~5.9 EB | ~28,500 | ~15,400 |

> "Mixed" column tab hai jab zyada tar buckets par 30-day lifecycle rule laga ho. Har bucket par rule nahi hoga, isliye asli number dono columns ke beech mein aayega.

### 1x -- ~1K PUT/s, ~7K GET/s (hamara spec)

```
Client / SDK
  -> CDN (public product images)          -> origin
  -> LB -> 4-6 stateless Node.js API nodes (streaming, never buffering)
       -> Postgres metadata: primary + sync standby (different AZs)
       -> Placement service: 2-3 instances, node list cached in every API node
       -> ~30 storage nodes / year (~10 per AZ), 24 x 20 TB HDD each
  Kafka: storage.events, storage.repair, storage.gc
  Workers: repair, GC + compaction, scrubber, lifecycle (EC to COLD), multipart cleanup
```

- **API nodes:** Node ka kaam yahan CPU nahi, **bytes ko ek socket se doosre socket tak pipe karna** hai (`stream.pipeline` + backpressure). Peak ingest ~0.93 x 3 = **~2.8 Gbps**, aur origin egress (CDN ke baad) kuch Gbps. Ek node ka 10-25 Gbps NIC aaram se chalega; 4-6 nodes HA + deploy + AZ spread ke liye.
- **Metadata:** ek PUT = `objects` row + `object_chunks` + 3 `chunk_locations` + `is_latest` flip + outbox = ~6 row writes. 1K PUT/s = **~6K row writes/s** -- tuned Postgres primary ke liye theek. **Asli problem QPS nahi, size hai:** 7.3 TB/year aur 7.3B rows/year. Pehla saal ek primary par nikal jaayega, lekin **range sharding ka plan day 1 se** (next section) -- kyunki ~1-2 saal mein size hi force karega.
- **Storage nodes:** ~30 per year, 3 AZs mein barabar. Placement har chunk ke 3 replicas **3 alag AZs** mein rakhta hai.
- **Bandwidth:**
  - **Egress:** ~9.3 Gbps average, **~28 Gbps peak** -- CDN public images ka bada hissa khata hai. Maan lo 80% CDN hit -> origin par ~5.6 Gbps peak.
  - **Internal replication:** chain replication mein har byte 3 hops karta hai (API -> primary node -> replica 2 -> replica 3) = **~3x ingest** internal network (~8.4 Gbps peak), aur 2 hops **cross-AZ** hain. Cloud par cross-AZ transfer ka paisa lagta hai -- bill mein ye line dikhti hai.
  - **Disk writes:** 116 MB/s x 3 = ~348 MB/s poore fleet par -- 500+ disks mein baanto toh har disk ko kuch bhi nahi.
- **HDD IOPS:** ~7K GET/s mein se origin ~30% = ~2,100 reads/s. Ek HDD ~100-150 random reads/s deta hai -> ~15-20 disks ki IOPS chahiye, hamare paas 500+ hain. **1x par IOPS problem nahi.**
- **Kya NAHI chahiye:** metadata sharding (plan haan, implement abhi nahi), Redis (optional, V1 mein nahi), multi-region, cells, SSD tier, custom hardware, FoundationDB.

> Interview line: "Spec scale par ~1K PUT/s aur 10 TB/day ingest hai. Stateless Node API nodes sirf bytes stream karte hain, metadata ek Postgres primary + sync standby par (~6K row writes/s), aur ~30 storage nodes per year 3 AZs mein. CDN public GETs khata hai. 1x par QPS problem nahi -- metadata ka size (7.3B rows/year) aur disks ka count planning ki cheez hai, isliye range sharding ka design pehle se ready rakhta hoon."

### 10x -- ~10K PUT/s, 100 TB/day

| Area | Kya tootega? | Change | Kyun |
|---|---|---|---|
| **Metadata DB** | ~60K row writes/s, 73 TB/year, index RAM mein fit nahi | **Range sharding by (bucket_id, key)** | Neeche detail |
| **Hot prefix** | Ek seller `logs/2026-09-18/...` jaise time-based keys likhta hai -> saare writes ek hi key range (ek shard) par | Hot range ko **split** karo (range ko do shards mein), aur tab tak us prefix par **`503 SLOW_DOWN`** -- SDK exponential backoff karega | Ek shard poore cluster ko slow na kare |
| **Storage cost** | 109.5 PB/year raw at 3x = ~5,475 disks/year | **Erasure coding 8+4 ab essential**: 30 din se purana data COLD -> ~59 PB/year | Disk bill lagbhag aadha |
| **Placement service** | 10K PUT/s -> 10K+ `pickNodes` calls/s; ek instance gira toh saare writes ruk jaayenge | 3 instances + leader election (membership ka ek hi owner); API nodes node list **cache** karke local pick karte hain | Placement hot path par ek single point of failure na ho |
| **Storage nodes** | ~285 nodes/year (3x) ya ~154 (mixed) | Racks, power, network planning; nodes **gradually** fleet mein aayein | Naye khaali nodes par saare writes jaane se hotspot |
| **Repair traffic** | Ab har hafte koi na koi disk / node marta hai | Repair bandwidth throttle + priority (1 replica wale chunks pehle) | Repair user traffic ko na khaaye |

**Range sharding ka simple matlab:** metadata ko keys ki **sorted ranges** mein baanto. Jaise dictionary ke volumes: "A-D" ek shard, "E-K" doosra.

```
shard map (in metadata service, cached in API nodes)
  (bucket 7, "")              .. (bucket 7, "invoices/2025/")   -> shard-01
  (bucket 7, "invoices/2025/") .. (bucket 7, "products/")       -> shard-02
  (bucket 7, "products/")     .. (bucket 9, "")                 -> shard-03
```

- **Range kyun, hash kyun nahi?** LIST prefix scan hai: `invoices/2026/` ke saare keys ek sorted range mein -> **ek ya do shards** padho. Hash sharding load barabar baant-ta hai, lekin tab har LIST ko **saare shards par fan-out** karna padega aur results merge. LIST storage mein bahut common hai (lifecycle, backups, UI).
- **Range ka nuksaan:** hot ranges. Time-based ya sequential keys ek hi range par girte hain. Fix: range split (automatic, load dekh ke), aur customers ko advice: key ke shuru mein high-cardinality part rakho (`sellerId/...`, na ki `2026-09-18/...`).
- S3 ne publicly bataya hai ki har prefix par kuch hazaar requests/s (docs mein ~3,500 PUT aur ~5,500 GET per second per prefix) milte hain aur load badhne par partitions khud split hote hain -- beech mein `503 Slow Down` dikh sakta hai. Hamara `503 SLOW_DOWN` wahi idea hai.
- **Redis ab (optional):** bucket metadata + API key/auth lookups ka short-TTL cache -- har request par ye Postgres se padhna 70K GET/s par wasteful hai. Source of truth kabhi nahi.
- **Kya NAHI chahiye:** multi-region, cells, distributed KV rewrite, tape.

> Interview line: "10x par metadata ko (bucket_id, key) ki range se shard karunga, taaki prefix LIST ek-do shards par rahe; hot ranges split hoti hain aur tab tak `503 SLOW_DOWN` se client backoff karta hai. Storage mein 3x replication ka bill ~110 PB/year ho jaata hai, isliye 30 din se purana data 8+4 erasure coding par -- 1.5x overhead. Placement service ko HA banaunga aur API nodes mein node list cache karunga."

### 100x -- ~100K PUT/s, 1 PB/day

| Bottleneck | Kyun | Kya karunga |
|---|---|---|
| **Metadata** | ~730B objects/year; hundreds of Postgres shards manage karna (resharding, failover, schema change) khud ek team ka full-time kaam | **Dedicated distributed metadata KV** -- FoundationDB / TiKV jaisa ordered, transactional KV. Ordered keys = range scan (LIST) same rehta hai, transactions = `is_latest` flip atomic rehta hai, aur splitting/rebalancing store khud karta hai |
| **HDD IOPS** | ~700K GET/s; naya data (jo sabse zyada padha jaata hai) naye, khaali disks par hai | Placement **capacity + load aware**; hot/small objects ke liye **SSD tier** / cache; naye nodes par writes ka rate limit |
| **Blast radius** | Ek bad deploy / metadata bug = sab buckets down | **Cells**: kai independent StoreBox copies (apne API nodes, metadata, storage nodes); har bucket ek cell mein. Thin cell router: bucket -> cell |
| **Repair** | ~2,850 nodes/year -> roz disks marte hain | Repair ek continuous background system hai, incident nahi |
| **Tiering** | Saara data HDD par bhi mehenga | STANDARD (HDD 3x) -> COLD (HDD EC 8+4) -> ARCHIVE (tape-jaisa / deep-archive HDD, retrieval minutes-hours) |

- FoundationDB publicly kai companies ki metadata layer mein use hota hai (jaise Apple aur Snowflake ne iske baare mein likha hai). Interview mein naam lena theek hai, lekin **"koi ordered + transactional distributed KV"** kehna asli point hai.
- **Kya NAHI chahiye (abhi bhi):** har object ke liye cross-region sync replication. Multi-region sirf un buckets ke liye jo maangein.

### 1000x -- ~1M PUT/s, exabytes: kya bottleneck banega?

Honest baat: **3.65 EB/year** hyperscaler territory hai. AWS ne publicly **100+ trillion objects** aur peak par **millions of requests/s** jaise numbers share kiye hain (ye numbers time ke saath badalte rahe hain). Koi e-commerce company apne liye ye nahi banati -- interviewer bottleneck thinking dekhna chahta hai.

| Bottleneck | Kyun | Kya karunga |
|---|---|---|
| **Physical world** | ~15,000-28,000 nodes **har saal** -- disk supply, racks, datacenter power, cooling | Capacity planning quarters pehle; denser drives; hardware ops ek poori org |
| **Egress** | 1000x = ~9.3 Tbps average | CDN mandatory, multiple CDNs, regional origins |
| **Regions** | Global customers, latency, data residency laws | **Multi-region**: bucket ka ek home region; **cross-region replication async** (opt-in, per bucket) |
| **Metadata** | Trillions of keys | Cells x distributed KV; har cell ka apna metadata cluster |
| **Repair + scrub** | Har din hazaaron disks marte hain; scrubber ko EBs padhne hain | Repair aur scrub ka apna bandwidth budget; zyada data EC par (repair sasta per byte) |
| **Software bugs** | Scale par ek GC bug = millions of objects | Guardrails (PART 17 #10), staged rollouts per cell |

> Interview line: "100x par Postgres shards ki jagah ek ordered, transactional distributed KV jaise FoundationDB, cells for blast radius, aur SSD/HDD/archive tiering. 1000x par bottleneck software se zyada physical ho jaata hai -- disks, power, egress -- aur multi-region buckets with async cross-region replication. Lekin honestly, ShopKart jaise company ke liye 1x-10x hi reality hai."

### Har scaling tool -- kab lagana hai, kab nahi

| Tool | Hamare system mein kab | Kab NAHI |
|---|---|---|
| **Stateless Node + LB** | 1x se | -- |
| **CDN** | 1x se, public GETs | Private objects (presigned GET CDN-cacheable nahi by default) |
| **Postgres sync standby** | 1x se (metadata = sach) | -- |
| **Read replicas (async)** | Analytics, billing reports, usage dashboards | GET-after-PUT, LIST, GC decisions -- kabhi nahi (PART 18) |
| **Range sharding** | 10x (plan 1x se) | 1x pehla saal |
| **Erasure coding** | 10x se essential (1x par bhi COLD ke liye) | Hot, chhote, baar-baar padhe jaane wale objects |
| **Redis** | 10x, auth + bucket metadata cache | Object bytes, "latest version" ka source of truth |
| **Kafka** | 1x se (events, repair, gc) | Upload ke data path par (bytes Kafka se nahi jaate) |
| **Distributed KV (FDB/TiKV)** | 100x | 1x/10x -- Postgres kaafi |
| **Cells / multi-region** | 100x / 1000x, ya residency law | Single-country ShopKart |

---

## PART 17 -- Failure Scenarios (interviewer style)

Format: **Problem -> Impact -> Solution.** Golden rules:

> 1. **Commit hi sach hai.** Metadata commit se pehle object exist nahi karta; commit ke baad woh durable hai (W = 2 fsynced). Beech ka koi bhi crash = "object bana hi nahi".
> 2. **Data chunks immutable hain.** Koi chunk kabhi overwrite nahi hota -- naya PUT = naye chunk ids. Isliye replicas "alag version" mein kabhi nahi hote; ya chunk hai (CRC sahi), ya nahi hai.
> 3. **Failures normal hain, incident nahi.** Hazaaron disks mein roz koi marega. Repair ek hamesha chalne wala system hai.
> 4. **Delete karne wala code sabse khatarnaak code hai.** Bytes likhne mein galti = retry. Bytes delete karne mein galti = hamesha ke liye.

### Failure map

```
Failure                         Reads?          Writes?          Data safe?   Kaise heal
Single disk dies                Yes (other AZ)  Yes              Yes          Parallel repair
Storage node dies               Yes             Yes (others)     Yes          10 min -> declare dead -> repair
Whole AZ down                   Yes (2 left)    Yes (W=2, 2 AZ)  Yes, thin    Wait, then repair backlog
Bit rot                         Yes (fallback)  --               Yes          CRC + scrubber + repair
Client/API crash mid-upload     --              Retry            Yes          Orphans -> GC after 24 h
Metadata primary down           Yes (standby)   No (~failover)   Yes          Promote sync standby
Kafka down                      Yes             Yes              Yes          Outbox + sweeper
GC bug                          Maybe not       Yes              AT RISK      Guardrails (#10)
Disk full                       Yes             Yes (elsewhere)  Yes          Placement skips, add nodes
```

### 1. "What if a single disk dies?"

- **Problem:** ek 20 TB HDD mar gaya (disks ka marna routine hai -- badi fleet mein har hafte kuch).
- **Impact:** us disk ke saare chunks ab 3 ki jagah 2 replicas par. Reads turant doosre replica par (read path fallback). User ko kuch nahi dikhta.
- **Solution:** data node disk error report karta hai -> us disk ke chunks ke liye `storage.repair` tasks -> repair workers surviving replicas se copy karke naye nodes par likhte hain.
- **Parallel repair ki math (verified):** disk 70% bhara = ~14 TB.
  - Ek replacement disk mein rebuild (RAID jaisa, ~200 MB/s): 14 TB / 200 MB/s = **~19.4 ghante**. Is poore time chunks sirf 2 copies par.
  - Hamare design mein us disk ke chunks ke doosre replicas **poore fleet mein bikhre** hain (har chunk ka placement alag). Toh 100 disks mil ke, har ek sirf 50 MB/s (5 GB/s total) -> **~47 minute**.
- **Lesson:** replicas ko randomly spread karna sirf load ke liye nahi, **repair speed** ke liye hai. Repair window chhota = do aur failures ek saath hone ka chance bahut kam = 11 nines ke kareeb.

### 2. "What if a whole storage node dies?"

- **Problem:** node `node-az2-031` (24 disks, ~336 TB data at 70%) ka power supply gaya.
- **Impact:** lakhon-crore chunks ek saath under-replicated. Writes: placement is node ko nahi chunega (heartbeat miss), W=2 baaki nodes se.
- **Solution:**
  - Heartbeat har 5 s. Node **10 min** tak chup -> placement use **dead** declare karta hai -> repair scheduler `chunk_locations WHERE node_id = 'node-az2-031'` se tasks banata hai.
  - **10 min wait kyun, 30 s kyun nahi?** Node reboot / kernel update / network blip mein 2-5 min lagte hain. Har reboot par 336 TB repair shuru kar diya toh network aur disks repair storm mein doob jaayenge -- aur node wapas aaya toh sab bekaar. 10 min = "sach mein mara hai" ka reasonable signal.
- **Math (verified):**

| Repair style | Bandwidth | 336 TB kitne time mein |
|---|---|---|
| Ek naye node ko saara data (10 Gbps NIC) | ~1.25 GB/s | **~75 ghante (~3 din)** |
| 29 surviving nodes (1x fleet), har ek 200 MB/s | ~5.8 GB/s | **~16 ghante** |
| 300 nodes (10x fleet), har ek 200 MB/s | ~60 GB/s | **~1.6 ghante** |

- **Lesson:** fleet jitna bada, repair utna tez -- badi fleet ka ek chhupa fayda. Aur **node density trade-off:** 24 x 20 TB ka dense node sasta hai, lekin marne par repair ka kaam bhi utna bada.
- **Production reality:** ek node par ~750M chunk replicas ho sakte hain (1x par, 500 KB average). Itne Kafka messages aur metadata updates bhaari hain. Publicly described systems (jaise Facebook ke Haystack/f4 papers) volume level par replicate karte hain -- ek node mara = kuch hazaar volumes repair, crore chunks nahi. Hamare design mein chunk-level placement simple hai; scale par **volume-level repair** ek natural next step hai.

### 3. "What if a whole AZ goes down?"

- **Problem:** AZ-2 ka power / network poora gaya. Fleet ka 1/3 gayab.
- **Impact on reads:** har STANDARD chunk ke 3 replicas 3 AZs mein the -> **har chunk ki abhi bhi 2 copies** hain. Reads chalte hain (thoda latency).
- **Impact on writes:** placement ko 3 AZs chahiye, 2 hi hain. **W = 2 of 3 abhi bhi possible** -- 2 replicas 2 alag AZs mein fsync. Writes chalte hain, har naya chunk 3rd replica "owe" karta hai -> `chunks_under_replicated` bahut upar.
- **Metadata:** agar Postgres primary AZ-2 mein tha -> sync standby (doosre AZ) promote. Isliye primary aur standby hamesha alag AZs mein.
- **COLD (EC 8+4) data:** 12 fragments, 4 per AZ. AZ gaya = 4 fragments gaye -> abhi bhi readable (8 chahiye), lekin **zero margin**. Ek aur fragment gaya toh object unreadable (jab tak AZ wapas na aaye).
- **Sabse important decision -- mass repair MAT karo:** 10 min baad AZ-2 ke saare nodes "dead" dikhenge. Agar repair ne 1/3 fleet (1x par ~3.65 PB) ko baaki 2 AZs mein copy karna shuru kiya: disks bhar jaayengi, network choke, aur AZ 2 ghante mein wapas aa gaya toh sab bekaar. Fix: **repair circuit breaker** -- agar ek saath > ~5% nodes (ya poora AZ) dead, toh auto-declare roko, insaan decide kare. Sirf woh chunks prioritize jo **1 copy** par aa gaye (AZ outage + kisi aur AZ mein disk failure).
- **Real-world yaad:** 2017 mein AWS S3 us-east-1 ka bada outage publicly ek operator command ki wajah se bataya gaya tha jisne intended se zyada servers hata diye. Lesson: **bulk removal / bulk repair par rate limits aur guardrails**.

### 4. "What about bit rot / silent corruption?"

- **Problem:** disk ne error nahi diya, lekin ek sector ke bits chupchaap badal gaye (magnetic decay, firmware bug, bad cable). **Silent** -- koi exception nahi.
- **Impact:** agar bina check ke serve kiya, customer ko corrupt invoice mila. Aur agar corrupt copy se repair kiya, toh corruption **phail** gaya.
- **Solution (teen layers):**
  1. **Read par CRC32C:** har read chunk ka CRC compute karke metadata wale `crc32c` se match. Mismatch -> next replica se padho, user ko sahi data, aur `storage.repair` task + us location ko `CORRUPT` mark.
  2. **Scrubber:** har disk ka har chunk **~2 hafte** mein ek baar padh ke verify -- taaki kabhi-kabhi padhe jaane wale objects (purane backups) ka corruption bhi pakda jaaye, **doosri copy marne se pehle**. Math (verified): 20 TB / 14 din = **~16.5 MB/s per disk** background read -- bearable, lekin user traffic ke peak par throttle.
  3. **Repair hamesha verified source se:** repair worker source copy ka CRC check karta hai (neeche code).
- End-to-end: client `Content-MD5` bheje toh upload ke waqt hi network corruption pakdi jaati hai.

### 5. "What if the client disconnects mid-upload?"

- **Problem:** 80 MB PUT ka 50 MB gaya, user ka Wi-Fi gaya.
- **Impact:** kuch chunks storage nodes par likhe gaye (6 chunks), lekin **metadata commit nahi hua**.
- **Solution:** golden rule #1 -- object exist hi nahi karta. GET par purana version (ya 404). Likhe hue chunks **orphans** hain: GC `object_chunks` mein reference na ho aur **24 h** se purane chunks ko delete karta hai. Client pura PUT retry kare. Bade files ke liye yahi wajah hai multipart ki -- sirf failed **part** retry.

### 6. "What if an API node crashes mid-stream?"

- **PUT ke beech:** same as #5 -- client ko connection reset, retry; orphans GC.
- **GET ke beech:** client ko adhoora body mila. `Content-Length` match nahi hoga -> client ko pata chal jaata hai. Achha SDK **resume** karta hai: `Range: bytes=<received>-` + `If-Match: <etag>` (taaki beech mein object badla toh galat bytes na jude). Isliye Range support sirf video seeking ke liye nahi, **resumable downloads** ke liye bhi hai.
- LB health check crash node ko nikaal deta hai; API stateless hai toh kuch khoya nahi.

### 7. "What if the metadata DB primary goes down?"

- **Problem:** Postgres primary crash (ya range sharding mein ek shard ka primary).
- **Impact:** koi commit nahi -> **PUT / DELETE / multipart complete fail**.
- **Solution:**
  - **Writes fail closed -> 503.** "Bytes likh do, metadata baad mein commit kar denge" -- **bilkul nahi**: tab humne client ko 200 bola aur GET 404 dega (read-after-write toota), aur crash hua toh object kho gaya. Client SDK retry karega.
  - **Reads chalte rehte hain:** sync standby ke paas har committed row hai (isi liye sync). Failover ke dauraan standby se read-only mode mein GET/HEAD/LIST serve karo -> 99.99% read availability bachi.
  - HA tool (Patroni / RDS Multi-AZ jaisa) standby ko promote karta hai -- seconds se ek-do minute.
  - Sharded world mein sirf **us shard ki key ranges** affected, baaki buckets normal.

### 8. "What if metadata committed but one replica is missing?"

- **Problem:** W = 2 ke baad commit ho gaya, 3rd replica ka async write fail hua (node busy / mara).
- **Impact:** ye **normal case** hai, bug nahi -- object durable hai (2 AZs), lekin 3 ka target poora nahi.
- **Solution:** writer `storage.repair` task publish karta hai. Agar writer khud crash ho gaya publish se pehle? Ek **sweeper** periodically `chunk_locations` mein `WRITING` state wale purane rows ya < 3 `DURABLE` wale chunks dhoondhta hai aur tasks banata hai. `chunks_under_replicated` gauge ko **0 ki taraf trend** karna chahiye -- 30 min se upar atka = alert.

### 9. "What if Kafka is down?"

- **Impact:**
  - `object.created` events (thumbnailer, malware scanner) **late**. Data safe -- events **outbox** table mein commit ke saath hi likhe gaye; Kafka wapas aaya toh relay drain karega.
  - `storage.repair` bhi ruk gaya -> repair late. Isliye sweeper Kafka par depend nahi karta -- direct DB scan karke jitna ho sake repair kare.
  - PUT/GET par **zero impact** -- bytes kabhi Kafka se nahi jaate.

### 10. "What if the garbage collector has a bug and deletes live data?"

**Sabse darawna failure.** Disk failure se 3 replicas bachaate hain. Lekin GC bug **teeno replicas** ko delete karega -- replication yahan kuch nahi bachaati. Industry mein bade data loss aksar hardware se nahi, **software bugs aur operator mistakes** se hote hain.

Kaise ho sakta hai:
- GC ne orphan check ek **async read replica** se kiya jo 2 sec peeche tha -> abhi commit hua object replica par nahi dikha -> uske chunks "orphan" lage -> delete.
- Multipart upload ke parts `object_chunks` mein nahi, `upload_parts.chunk_ids` mein hain -- GC ne sirf `object_chunks` dekha -> 3 din se chal rahi upload ke parts delete.
- Ek migration ne `chunk_id` format badla, GC ka join match nahi hua -> "sab orphan".

**Defences (layers):**

| Layer | Kya |
|---|---|
| **Grace period** | Sirf 24 h se purane unreferenced chunks candidate; multipart parts **tab tak reference** jab tak upload `IN_PROGRESS` (7 din abort tak) |
| **Two-phase GC** | Phase 1: candidates mark (`storage.gc`). Phase 2 (ghanton baad): delete se theek pehle **primary par reference dobara check** -- `object_chunks` + `upload_parts` dono |
| **Soft delete** | Location `DELETED` mark, bytes volume mein pade rehte hain; **compaction** hi asli space reclaim karta hai, aur woh kuch din baad. Galti pakdi gayi toh `DELETED -> DURABLE` wapas |
| **Rate limit + circuit breaker** | GC ek din mein fleet ka X% se zyada delete nahi karega; normal se 10x zyada candidates mile -> GC khud ruk jaaye aur page kare |
| **Never from a replica** | GC decisions sirf primary (ya sync standby) ke data par |
| **Canary** | Naya GC code pehle ek cell / kuch nodes par, `gc_reclaimed_bytes_total` ko baseline se compare |

> Interview line: "Sabse khatarnaak failure disk nahi, GC bug hai -- kyunki woh teeno replicas ek saath mita sakta hai. Isliye GC two-phase hai: candidates mark karo, grace period ke baad primary par references dobara check karo (object_chunks aur in-progress multipart parts dono), phir sirf soft-delete; bytes compaction se din baad jaate hain. Upar se GC par rate limit aur anomaly circuit breaker."

### 11. "What if a disk / node gets full?"

- **Problem:** `node_disk_used_ratio` 0.95 par.
- **Impact:** writes fail, aur ulta jhatka -- **compaction ko bhi free space chahiye** (volumes rewrite karne ke liye). Disk 100% = compaction nahi chal sakta = garbage kabhi reclaim nahi = deadlock.
- **Solution:** 0.85 par placement us node ko **naye writes ke liye skip** karta hai (read-only), 0.95 par page. Har node par reserve space (compaction + repair ke liye). Fleet level par capacity forecast (PART 20) taaki naye nodes weeks pehle order hon -- hardware lead time mahino ka ho sakta hai.

### 12. "What about a hot object / thundering herd?"

- **Problem:** ek product image viral hua / sale ka banner -- lakhon GETs ek hi chunk par. Ya CDN cache expire hua aur 10,000 requests ek saath origin par (**thundering herd**).
- **Impact:** us chunk ke 3 replica disks par saara load; HDD ~150 reads/s deta hai -> queue, timeouts.
- **Solution:**
  - **CDN** (public objects) -- pehli line.
  - **Request coalescing** (CDN aur API dono par): same object ke 1,000 concurrent misses -> origin ko sirf **1** fetch, baaki uska wait karein. (Redis-down stampede lesson wala idea.)
  - **Read from all replicas**, sirf nearest se nahi -- load 3 disks par baanto.
  - **Small hot-object cache** API nodes mein (LRU, < 1 MB objects), key = `versionId` -- versionId ka content **immutable** hai, toh cache kabhi stale nahi hota.

### 13. "What about abandoned multipart uploads?"

- **Problem:** mobile app ne 2 GB video ki upload shuru ki, 40 parts bheje, user ne app band kar diya. Ye hazaaron baar.
- **Impact:** parts ke chunks disk par hain, kisi object mein nahi -- chupchaap storage kha rahe (aur customer ko bill?).
- **Solution:** lifecycle rule: `IN_PROGRESS` aur **7 din se purana** -> `ABORTED` (`ix_mpu_stale` index se sasta scan) -> parts ke chunks GC ko. Gauge `multipart_incomplete_uploads` dashboard par.

### Code -- repair worker (ek chunk ko wapas 3 replicas tak)

```ts
// src/workers/repair.worker.ts
import type { Pool } from 'pg';
import { crc32c } from '../utils/crc32c';
import { REPLICAS } from '../storage/chunker';     // = 3
const azOf = (nodeId: string) => nodeId.split('-')[1];   // 'node-az1-017' -> 'az1'

export async function repairChunk(d: RepairDeps, chunkId: string): Promise<'OK' | 'REPAIRED' | 'LOST'> {
  const { rows: [chunk] } = await d.pool.query<{ crc32c: string; size_bytes: number }>(
    'SELECT crc32c, size_bytes FROM object_chunks WHERE chunk_id = $1 LIMIT 1', [chunkId]);
  if (!chunk) return 'OK';                                  // no object references it: GC's job, not ours

  const { rows } = await d.pool.query<{ node_id: string }>(
    `SELECT node_id FROM chunk_locations WHERE chunk_id = $1 AND state = 'DURABLE'`, [chunkId]);
  const holders = rows.map(r => r.node_id).filter(n => d.liveNodes.has(n));
  if (holders.length >= REPLICAS) return 'OK';             // idempotent: already repaired by someone

  let data: Buffer | undefined;
  const good: string[] = [];
  for (const src of holders) {
    try {
      const buf = await readAll(await d.nodes.getChunk(src, chunkId), chunk.size_bytes);
      if (crc32c(buf) !== Number(chunk.crc32c)) { await markCorrupt(d.pool, chunkId, src); continue; }
      good.push(src); data ??= buf;
    } catch (err) {
      d.logger.warn({ chunkId, src, err }, 'repair: source read failed');
    }
  }
  if (!data) {
    if (holders.length === 0) { d.metrics.chunksLost.inc(); d.logger.fatal({ chunkId }, 'chunk has no live copy'); return 'LOST'; }
    throw new Error(`no verified copy of ${chunkId} right now`);   // retry later
  }

  const usedAzs = new Set(good.map(azOf));
  const targets = (await d.placement.pickNodes(chunkId, 3))
    .filter(n => !good.includes(n) && !usedAzs.has(azOf(n)))
    .slice(0, REPLICAS - good.length);
  if (targets.length < REPLICAS - good.length) throw new Error('not enough AZs/nodes, retry later');

  for (const target of targets) {
    const ack = await d.nodes.putChunk(target, chunkId, data, []);   // [] = no chain forwarding
    if (ack.crc32c !== Number(chunk.crc32c)) throw new Error(`crc mismatch writing to ${target}`);
    await d.chunkLocations.upsertDurable(chunkId, target);           // volume/offset from the node's ack
  }
  return 'REPAIRED';
}
```

**Code Explanation:**

- `azOf(...)` -- node id mein AZ encoded hai (`node-az1-017`), taaki naya replica us AZ mein na jaaye jahan pehle se copy hai.
- Pehli query `object_chunks` se expected `crc32c` aur size laati hai. **Iske liye `object_chunks(chunk_id)` par index chahiye** (PK `(version_id, seq)` hai) -- GC ko bhi yahi index chahiye.
- `if (!chunk) return 'OK'` -- chunk kisi object ka nahi (object delete ho gaya ya orphan). Repair **zinda data** ke liye hai; orphan GC ka kaam. (In-progress multipart parts ke liye bhi same logic `upload_parts` se -- yahan chhota rakhne ke liye skip.)
- `holders` -- sirf `DURABLE` locations jo **abhi live** nodes par hain (`liveNodes` placement ki membership se). Dead node ka row abhi DB mein ho sakta hai, isliye filter.
- `holders.length >= REPLICAS` -> `'OK'` -- same chunk ke 5 duplicate repair tasks aa jaayein (sweeper + writer + scrubber) toh bhi kaam ek hi baar. **Repair idempotent hai.**
- Source loop: har live copy padho aur **CRC verify** -- corrupt copy se repair = corruption phailana. Mismatch -> `markCorrupt` (state `CORRUPT`), aur woh `good` mein nahi gini jaayegi, toh uski jagah bhi naya replica banega.
- `readAll(stream, size)` -- 8 MB max chunk ko memory mein lena theek hai (poora object nahi, ek chunk). Size limit se malicious/buggy bada stream memory na khaaye.
- `data` nahi mila aur `holders` bhi 0 -> **LOST**: `chunksLost` counter + fatal log = sabse bada page. Holders the lekin sab fail/corrupt -> `throw` -> message retry (node shayad temporarily slow hai).
- `pickNodes(chunkId, 3)` se candidates, phir filter: jo pehle se copy rakhte hain nahi, aur **used AZs nahi**. Jitni kami hai (`REPLICAS - good.length`) utne targets.
- `putChunk(target, chunkId, data, [])` -- khaali replicas list = node aage forward nahi karega (normal write ki chain replication yahan nahi chahiye). Node fsync karke CRC lautata hai; hum match karte hain.
- `upsertDurable` -- `chunk_locations` mein naya `DURABLE` row. Note: spec ka `putChunk` sirf `{ crc32c }` lautata hai; asli ack mein node apna `volumeId` + `offsetBytes` bhi bhejta hai (uske local index se) -- wahi yahan save hota hai.
- **Loop:** ye function Kafka consumer (`storage.repair`, group `repair-workers`) ke `eachMessage` mein chalta hai. Throw hua toh offset commit nahi -> retry; baar baar fail ho toh retry topic / DLQ taaki ek poison message partition ko na roke. **Priority:** 1-copy chunks ka alag high-priority topic/queue, aur poore repair par bandwidth throttle.

> Interview line: "Repair worker idempotent hai: pehle dekhta hai kitni live DURABLE copies hain, 3 hain toh kuch nahi. Source copy ka CRC32C verify karta hai taaki corrupt copy se repair na ho, aur naye replica un AZs mein rakhta hai jahan copy nahi hai. Node death par repair poore fleet mein parallel hota hai -- isliye 336 TB ka node 1x par ~16 ghante mein aur 10x par ~1.6 ghante mein heal hota hai, ek naye node mein copy karne ke 3 din ki jagah."

### Failure summary

| Failure | Detect kaise | Kya hota hai |
|---|---|---|
| Disk / node dead | `placement_live_nodes{az}`, disk errors | Reads fallback, parallel repair |
| AZ down | `placement_live_nodes{az}` drop | W=2 on 2 AZs, repair circuit breaker |
| Bit rot | `scrubber_corrupt_chunks_total`, read CRC mismatch | Fallback + repair from verified copy |
| Under-replication | `chunks_under_replicated`, `repair_queue_lag_seconds` | Repair queue + sweeper |
| Metadata primary down | 5xx on PUT, DB health | Writes 503, reads from sync standby |
| GC bug | `gc_reclaimed_bytes_total` anomaly | GC circuit breaker, soft delete |
| Disk full | `node_disk_used_ratio` | Placement skips node, add capacity |
| Abandoned multipart | `multipart_incomplete_uploads` | 7-day abort |

---

## PART 18 -- Consistency

### Teen words, simple Hinglish mein

- **Strong consistency:** jaise hi ek jagah value badli, **har** padhne wala turant nayi value dekhega. Jaise ek hi register -- sab usi ko dekhte hain.
- **Eventual consistency:** abhi kuch log purani value dekh sakte hain, thodi der mein sab same. Jaise WhatsApp profile photo badli -- kuch doston ko thodi der purani dikhti hai.
- **Read-after-write consistency:** **jisne likha** woh turant apna likha hua dekhe (aur strong model mein, baaki sab bhi). Jaise seller ne product image upload ki aur turant "preview" khola -- nayi image dikhni chahiye, 404 ya purani nahi.

### Is system mein consistency ka ek hi point hai: metadata commit

Data aur metadata alag karne ka sabse bada fayda yahan dikhta hai:

```
Data chunks:   ch_01A.., ch_01B..  -> immutable, written once, never modified
                                     (replicas can't disagree about content: CRC or nothing)
Metadata row:  (bucket 7, "products/42/main.jpg") -> is_latest version 01J8.. -> [ch_01A.., ch_01B..]
                                     ^ the ONLY mutable thing = the pointer
```

- Naya PUT purane chunks ko **kabhi nahi chhoota**; naye chunks likhta hai, phir **ek transaction** mein pointer (`is_latest`) badalta hai. Pointer ek single DB (primary) mein hai -> **strong read-after-write** mil jaata hai.
- Data layer ko distributed consistency protocol (Paxos / quorum reads) ki zarurat hi nahi -- kyunki data kabhi badalta nahi. Ye design ka sabse elegant hissa hai.

### Kahan kya?

| Cheez | Kya chahiye | Kaise |
|---|---|---|
| **GET after PUT** (same ya doosra client) | Strong | GET metadata primary / sync standby se; commit = visibility |
| **Overwrite** (same key par naya PUT) | Strong, last writer wins | Later commit `is_latest` banta hai; unique partial index `ux_objects_latest` do "latest" hone nahi deta |
| **DELETE** | Strong | Metadata se turant gayab (ya delete marker); bytes baad mein GC |
| **LIST** | Strong | Prefix scan primary / sync standby par -- naya PUT turant LIST mein |
| **Data chunks** | "Problem hi nahi" | Immutable + CRC |
| **CDN cached copies** | Eventual (TTL) | TTL / invalidation / versioned keys |
| **Event notifications** | Eventual (seconds) | Outbox -> Kafka -> consumers |
| **3rd replica, repair** | Eventual (seconds-minutes) | W=2 ke baad async |
| **Lifecycle (STANDARD -> COLD), EC** | Eventual (hours-days) | Background worker; object ka content same, sirf `storage_class` + locations badle (ek naya metadata commit) |
| **Cross-region replication** (100x+) | Eventual (seconds-minutes) | Async, per bucket opt-in |
| **Usage / billing dashboards** | Eventual | Async read replica / warehouse |

### Async replica ka bug (kyun GET primary / sync standby se)

Maano GET ko **async** read replica par bhej diya, jo 2 sec peeche hai:

```
t=0.00  Seller app: PUT products/42/main.jpg (new image) -> commit on primary -> 200
t=0.05  Seller app: GET products/42/main.jpg -> async replica -> OLD image (or 404 if first upload)
t=0.10  Thumbnailer gets object.created event -> GET -> replica -> 404 -> marks job failed
t=0.20  Seller sees old image in preview, uploads again ("upload fail ho gaya shayad")
```

- Isliye spec ka rule: **"never an async replica for GET-after-PUT correctness"**. Sync standby theek hai -- lekin sirf tab jab woh commit **apply** bhi kar chuka ho (`synchronous_commit = remote_apply`), sirf WAL receive nahi. Warna standby par bhi ek chhota window ho sakta hai.
- **LIST ke liye bhi same:** backup tool "PUT kiya, phir LIST karke verify" karta hai -- lagging replica par missing file = false alarm, ya worse, tool dobara upload karta rahe.
- **Redis cache ka trap:** "latest version of key" ko 60 s TTL se cache kiya toh wahi bug wapas. Rule: **mutable pointer** (key -> latest version) cache mat karo (ya commit par invalidate, jo distributed mein tricky hai); **immutable cheezein** (versionId -> chunk list, versionId -> bytes) freely cache karo -- woh kabhi nahi badalti.

### S3 ka example -- eventual se strong

Public history: S3 pehle overwrite / delete ke baad kuch der tak purana data dikha sakta tha (eventual consistency), aur tools ko workarounds likhne padte the (jaise extra consistency layers). **December 2020** mein AWS ne announce kiya ki S3 ab saare GET, PUT, LIST ke liye **strong read-after-write consistency** deta hai, bina extra cost ke. Andar kaise kiya, uska sirf high-level public description hai -- lekin lesson clear hai: **users strong consistency expect karte hain, aur storage mein ye metadata layer par solve hota hai.**

### CDN ke saath consistency

- Public product image `products/42/main.jpg` overwrite kiya, CDN 1 din tak purani dikhayega.
- **Best fix: versioned / content-hashed keys** -- `products/42/main-9b2c1f.jpg`. Naya image = naya key = naya URL. Purana URL ka content kabhi nahi badalta, toh CDN TTL 1 saal bhi safe. (URL Shortener mein jaise short code kabhi reuse nahi hota.)
- Doosra option: CDN invalidation API on overwrite -- slow (minutes) aur costly at scale.

### Concurrent PUTs -- last writer wins

```
Client A: PUT key (v1 chunks written)  ............ commit at t=5 -> versionId 01J8..A
Client B: PUT key (v2 chunks written)  ..... commit at t=3 -> versionId 01J8..B
Result: latest = A (committed later), B's version exists only if versioning is on
```

- Koi data node lock nahi, koi distributed lock nahi. Metadata commit order hi faisla. Versioning off hai toh B ka `objects` row purana version ban ke GC ho jaata hai; on hai toh history mein rehta hai.
- `If-None-Match: *` (create-only) chahiye toh check bhi **commit ke andar** -- unique partial index par conflict = `412`.

> Interview line: "Is design mein data chunks immutable hain, toh data layer par consistency problem hi nahi -- ya chunk CRC ke saath hai ya nahi. Mutable cheez sirf metadata pointer hai (key -> latest version), aur woh ek transaction mein ek primary par flip hota hai. Isliye PUT, DELETE aur LIST ke liye strong read-after-write milta hai, jaise S3 ne Dec 2020 se diya. Reads primary ya remote_apply wale sync standby se; async replica kabhi nahi. CDN, events, 3rd replica, lifecycle aur cross-region replication eventual hain, aur woh acceptable hai."

---

## PART 19 -- Security

Storage service mein security ka matlab: **"kaun kaunsa byte padh / likh / mita sakta hai, aur agar disk chori ho jaaye ya URL leak ho jaaye toh kya?"** Yahan invoices (GST, addresses), return-request photos, DB backups hain -- ek leak = news headline.

### Threat -> defence map

| Threat | Defence |
|---|---|
| Fake / tampered API request | HMAC request signing over canonical request (payload hash included) |
| Captured request replay | `x-sbx-date` +-15 min skew + TLS |
| Presigned URL leak | Short expiry, method + key bound, least privilege |
| Public bucket galti se | **Block public access by default** |
| Chori hua disk / backup | Encryption at rest (envelope, KMS) |
| Network sniffing (internal bhi) | TLS outside, mTLS inside |
| Malware upload, stored XSS | Async scan + separate download domain + `Content-Disposition` |
| Weird keys, injection | Key validation, parameterized SQL, keys never touch filesystem |
| Hotlinking / bandwidth abuse | Rate + bandwidth limits per key, presigned for private |
| Galti / attacker se delete | Versioning, object lock (WORM), legal hold |

### 1. Request signing -- HMAC over canonical request

Payment System mein webhook ka HMAC dekha tha. Yahan har API request signed hai:

```
canonical = METHOD \n PATH \n SORTED_QUERY \n SIGNED_HEADERS(host, x-sbx-date, content-type) \n SHA256(payload)
Authorization: SBX1-HMAC-SHA256 Credential=<keyId>, SignedHeaders=..., Signature=hex(HMAC(secret, canonical))
```

- **Secret kabhi wire par nahi jaata** -- sirf signature. Attacker request pakad bhi le, toh doosri request (alag key/body) sign nahi kar sakta.
- **Payload hash signed** -> body badli toh signature toota. Bade streaming uploads ke liye client `UNSIGNED-PAYLOAD` bol sakta hai (TLS + `Content-MD5` par bharosa) -- S3 bhi aisa option deta hai.
- **Replay:** `x-sbx-date` signed hai; server ke clock se **15 min se zyada farq** -> `403 REQUEST_EXPIRED`. Window ke andar replay possible hai, lekin TLS ke andar request capture karna mushkil, aur PUT/DELETE waise bhi repeat-safe hain.
- **Canonicalization bugs** classic hain: path ka URL-encoding (`%2F` vs `/`), query sorting, header case. Client aur server ka ek hi `src/utils/signature.ts` jaisa shared implementation + test vectors.
- **HMAC secret server par plaintext mein chahiye** (verify karne ke liye), password ki tarah hash nahi kar sakte -> DB mein **KMS se encrypted** store karo.

### 2. Presigned URLs

```ts
// src/middleware/sigv-auth.ts (presigned branch, simplified)
const MAX_PRESIGN_SEC = 604_800;   // 7 days

export async function verifyPresigned(req: Request, apiKeys: ApiKeyLookup): Promise<AuthContext> {
  const q = req.query as Record<string, string | undefined>;
  const keyId = q['X-Sbx-KeyId'], expiresRaw = q['X-Sbx-Expires'], sig = q['X-Sbx-Signature'];
  if (!keyId || !expiresRaw || !sig) throw new ApiError(403, 'SIGNATURE_MISMATCH');

  const expires = Number(expiresRaw);                        // absolute unix seconds
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(expires) || expires < now || expires - now > MAX_PRESIGN_SEC)
    throw new ApiError(403, 'REQUEST_EXPIRED');

  const key = await apiKeys.findActive(keyId);               // revoked / rotated key -> null
  if (!key) throw new ApiError(403, 'SIGNATURE_MISMATCH');

  const canonical = [req.method, req.path, keyId, expiresRaw].join('\n');
  const expected = crypto.createHmac('sha256', key.secret).update(canonical).digest();
  const given = Buffer.from(sig, 'hex');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected))
    throw new ApiError(403, 'SIGNATURE_MISMATCH');

  return { keyId, scopes: key.scopes, presigned: true };   // scopes still checked by the route
}
```

**Code Explanation:**

- Teen query params spec wale: `X-Sbx-KeyId`, `X-Sbx-Expires`, `X-Sbx-Signature`. Koi missing -> 403.
- `expires` ko **absolute time** maana (presign API `expiresAt` lautata hai). `expires < now` -> expired. `expires - now > MAX_PRESIGN_SEC` -> koi 7 din se lamba URL claim kare toh reject (signer ne bhi max 604800 enforce kiya tha).
- `apiKeys.findActive(keyId)` -- URL jis key se sign hua, woh abhi active hai? **Presigned URL ko individually revoke nahi kar sakte** (server par koi record nahi) -- revoke ka ek hi tareeka: signing key rotate/disable. Isliye presign ke liye **alag, narrow-scope key** use karo, master key nahi.
- `canonical = method + path + keyId + expires` -- **method bound**: GET ke liye bana URL se PUT nahi ho sakta (signature match nahi karega). **Key bound**: `path` mein bucket + key hai, toh doosri file nahi.
- `Buffer.from(sig, 'hex')` + length check + `timingSafeEqual` -- Payment System wala timing-attack defence; `timingSafeEqual` alag length par throw karta hai, isliye pehle length.
- `scopes` -- signature sahi hai iska matlab ye nahi ki key ko us bucket ki permission hai; route phir bhi scope check karega.
- **Upload size limit:** presigned PUT mein `Content-Length` sign nahi hota, toh URL wala 100 MB tak kuch bhi daal sakta hai. Fix: presign ke waqt ek `X-Sbx-Max-Bytes` (aur `Content-Type`) bhi canonical mein daalo, aur API streaming ke dauraan bytes gin ke limit par connection kaat de.

**Presigned URL ke risks:**
- URL = bearer token. Logs, browser history, `Referer` header, WhatsApp forward -- jahan bhi gaya, expiry tak kaam karega.
- **Expiry chhoti rakho:** download ke liye 5-15 min, upload ke liye upload time + buffer. 7 din sirf max hai, default nahi.
- **Least privilege:** ek URL = ek method + ek key. "Pure bucket ka URL" jaisa kuch nahi.

### 3. Authorization -- keep it simple

- Har bucket ka ek `owner_id`. API keys ke **scopes**: `{ buckets: ['shopkart-invoices'], ops: ['GET','PUT'], prefix: 'sellers/42/' }` -- IAM-jaisa, lekin simple. Seller portal ki key sirf apne prefix tak.
- **Block public access default ON.** Bucket public karne ke liye explicit, audited flag. Public buckets hi CDN ke peeche.
- Real world mein bahut saare publicized data leaks **galti se public chhode gaye cloud buckets** ki wajah se hue hain (voter data, customer records, backups). AWS ne 2018 mein "Block Public Access" setting laayi aur baad mein naye buckets ke liye isko default banaya. Lesson: **secure default > documentation**.
- `DELETE /v1/buckets/:bucket` sirf owner scope + bucket empty (409 `BUCKET_NOT_EMPTY`).

### 4. Encryption at rest -- envelope encryption

**Envelope encryption ka simple matlab:** har object ka apna chhota **data key (DEK)**, jisse bytes encrypt hote hain. DEK ko ek **master key (KEK)** se encrypt (wrap) karke metadata mein rakhte hain. Master key **KMS** ke andar rehti hai, kabhi bahar nahi aati.

```
PUT:  API -> KMS.GenerateDataKey(masterKeyId) -> { plaintextDEK, wrappedDEK }
      chunks = AES-256-GCM(plaintextDEK, bytes)  -> storage nodes (ciphertext only)
      metadata row stores wrappedDEK             -> plaintextDEK wiped from memory
GET:  metadata -> wrappedDEK -> KMS.Decrypt -> plaintextDEK -> decrypt chunks while streaming
```

- **Disk chori hua / data node hack hua** -> sirf ciphertext. **DB dump chori hua** -> sirf wrapped keys, KMS ke bina bekaar. Dono chahiye + KMS access.
- **Master key rotate** karna sasta: sirf wrapped DEKs dobara wrap, PBs data re-encrypt nahi.
- **Crypto-shredding:** kisi tenant ka data "turant aur pakka" mitana hai (compliance) -> uski master key delete -> saare replicas, backups bekaar.
- **KMS cost/latency:** 1K PUT/s = 1K KMS calls/s. Fix: per-bucket intermediate key cache (S3 ka "Bucket Keys" feature publicly isi problem ke liye hai).
- **CRC32C ciphertext par** -- scrubber aur repair ko keys ki zarurat nahi, woh bina decrypt kiye verify karte hain. ETag (MD5) plaintext ka, jo client ne bheja.
- `objects` table mein `wrapped_dek` column add karna hoga (spec ke schema mein abhi nahi).
- **SSE vs client-side encryption:** SSE (server-side) = hum encrypt karte hain, humein trust karna padta hai. Client-side = client khud encrypt karke bhejta hai, hum sirf ciphertext dekhte hain -- bahut sensitive data (DB backups) ke liye; lekin tab server-side features (thumbnailer, malware scan, Range par partial decrypt) nahi chalte.

### 5. In transit -- TLS + internal mTLS

- Client -> CDN/LB: TLS. LB -> API: TLS ya private network.
- **API -> storage nodes, node -> node replication: mTLS** (dono taraf certificate). Kyun? Data node ka `putChunk` endpoint agar network par koi bhi call kar sake, toh ek compromised machine chunks overwrite/delete kar sakti hai. mTLS = sirf hamare API nodes aur data nodes baat kar sakte hain.

### 6. Malware scanning + safe serving

- `object.created` event -> scanner service (ClamAV jaisa) -> object par tag `scan=clean|infected`. **Async** -- upload latency par asar nahi.
- User-upload buckets (return photos) ke consumers (thumbnailer, support panel) sirf `clean` process karein; infected -> quarantine + alert.
- **Stored XSS:** attacker `return.html` ya SVG with JavaScript upload kare, aur hum `shopkart.com` domain se serve karein -> uski script hamari cookies ke saath chalegi. Fix: user content **alag domain** se (jaise `files.shopkart-usercontent.com`), `Content-Disposition: attachment` for non-images, `X-Content-Type-Options: nosniff`, aur `Content-Type` allow-list.

### 7. Key / input validation

- Bucket name regex (DB CHECK: `^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`). Key: valid UTF-8, <= 1024 bytes, NUL / control characters reject.
- **Path traversal ka khatra nahi** -- key `../../etc/passwd` bas ek string hai, kyunki data nodes par files **chunk ids** se hain, keys se kabhi nahi. Ye separation ka ek security fayda bhi hai.
- **SQL injection:** parameterized queries. LIST prefix ke liye `LIKE $1 || '%'` mat karo (user `%` ya `_` bheje toh galat results + slow scan) -- range use karo: `key >= $prefix AND key < $prefixUpperBound`, jo B-tree index par bhi perfect hai.
- Limits: `Content-Length` required, 100 MB max single PUT (`413 USE_MULTIPART`), user metadata size cap, part numbers 1-10,000.

### 8. Abuse -- rate limits, hotlinking

- **Rate Limiter system se:** per API key PUT/GET limits (`429`). Storage mein **bandwidth limit** bhi -- 10 req/s x 5 GB = bahut bytes. Bytes/s ka alag token bucket.
- **Hotlinking:** koi doosri site hamari public images embed karke hamara egress bill badhaaye. Fix: CDN par Referer rules / signed CDN URLs, private data ke liye presigned only.
- Free-tier abuse (storage ko free file host banana) -> quotas per owner.

### 9. Deletion safety + compliance (brief)

- **Versioning:** galti se overwrite/delete -> purana version wapas. DELETE sirf delete marker.
- **Object lock (WORM = write once, read many):** invoices jaise records ko N saal tak koi delete/overwrite nahi kar sakta, admin bhi nahi (compliance mode). Ransomware jo backups mitana chahta hai, fail.
- **Legal hold:** court case chal raha hai -> object tab tak lock jab tak hold hat na jaaye.
- GC aur lifecycle dono ko ye flags **respect** karne chahiye -- aur tests mein ye case zaroor.

> Interview line: "Har request HMAC-SHA256 se canonical request (method, path, query, headers, payload hash, date) par signed hai, 15 min skew ke saath. Presigned URLs method aur key se bound, chhoti expiry, narrow-scope key se sign -- kyunki leak hone par individually revoke nahi ho sakte. Block public access default on. Bytes envelope encryption se -- per-object data key, KMS master key se wrapped; internal traffic mTLS. User uploads async malware scan hote hain aur alag domain se `nosniff` ke saath serve. Keys kabhi filesystem path nahi bante, isliye path traversal ka khatra nahi."

---

## PART 20 -- Observability

StoreBox ke baare mein teen log sawaal poochte hain:
- **On-call:** "PUT/GET chal rahe hain? Latency theek hai? Koi node / AZ gira?"
- **Durability owner:** "Kya koi chunk khatre mein hai? Repair peeche toh nahi? Corruption badh raha?"
- **Capacity planner:** "Disks kab khatam honge? Kitne nodes order karne hain?"

Normal APIs sirf pehla sawaal poochte hain. Storage mein **doosra sawaal sabse important** hai -- kyunki durability ka loss chupchaap hota hai; 200 OK aata rehta hai jab tak ek din 404 na aaye.

### 1. Logs -- access logs + app logs

Har request ek **access log** line (S3 jaisa):

```json
{"ts":"2026-09-18T10:02:11Z","requestId":"req_7f3a","traceId":"4bf92f...","keyId":"ak_seller_42",
 "bucket":"shopkart-returns","keyHash":"a91c03e7","op":"GET","range":"bytes=0-1048575",
 "status":206,"bytesOut":1048576,"ttfbMs":38,"totalMs":212,"versionId":"01J8X...","cdn":false}
```

- `keyHash` -- key ka hash, raw key nahi. Kyun? Keys mein PII hota hai: `returns/rahul.sharma@gmail.com/aadhaar.jpg`. Full key ek alag, restricted access-log store mein (billing / security investigation ke liye), general logs mein nahi.
- `ttfbMs` + `totalMs` -- dono alag. 2 GB download ka total 2 min normal hai; TTFB 2 s nahi.
- **Volume:** ~220M requests/day x ~300 bytes = **~66 GB/day** access logs. Inhe kahan rakhein? **StoreBox mein hi** (compressed, lifecycle ke saath) -- apna khana khud khao. Search ke liye Elasticsearch nahi, zarurat par batch query.
- **Kabhi log nahi:** `Authorization` header, presigned URL ka `X-Sbx-Signature`, API secret, wrapped/plain DEK, object content.

### 2. Metrics -- spec ki list + RED + durability

| Metric | Type | Kya batata hai |
|---|---|---|
| `storage_requests_total{op,status}` | Counter | RPS + error rate per op (PUT/GET/HEAD/DELETE/LIST/multipart) -- **R** and **E** of RED |
| `storage_request_duration_seconds{op}` | Histogram | Time to first byte + total -- **D** of RED |
| `storage_bytes_in_total`, `storage_bytes_out_total` | Counter | Ingest / egress throughput (Gbps), billing |
| `chunks_under_replicated` | Gauge | **Must trend to 0.** Upar = durability khatre mein |
| `repair_queue_lag_seconds` | Gauge | Sabse purana pending repair task kitna purana |
| `scrubber_corrupt_chunks_total` | Counter | Bit rot rate; achanak spike = kharab disk/batch/firmware |
| `node_disk_used_ratio{node}` | Gauge | Full disk, capacity forecast |
| `placement_live_nodes{az}` | Gauge | Node / AZ health |
| `metadata_query_duration_seconds` | Histogram | Metadata DB latency (per shard label at 10x) |
| `gc_reclaimed_bytes_total` | Counter | GC health; **anomaly = GC bug ka early signal** |
| `multipart_incomplete_uploads` | Gauge | Abandoned uploads |
| Node: CPU, memory, **event loop lag**, open sockets; Postgres: connections, repl lag | Default exporters | Infra health |

**Cardinality rule:** labels mein `bucket`, `key`, `versionId` **kabhi nahi** (ya sirf top-N buckets ke liye alag system). `node` label theek hai (hazaaron tak), `op` aur `status` chhote sets.

**Redis hit ratio / queue lag** (prompt ke list se): Redis 10x par hi aata hai -- tab `auth_cache_hit_ratio`. Queue lag = Kafka consumer lag for `storage.events` (thumbnailer late) aur `repair_queue_lag_seconds`.

### Code -- prom-client

```ts
// src/infra/metrics.ts
import client from 'prom-client';
import type { Request, Response, NextFunction } from 'express';

client.collectDefaultMetrics();

export const requestsTotal = new client.Counter({
  name: 'storage_requests_total', help: 'Requests by op and status', labelNames: ['op', 'status'],
});
export const requestDuration = new client.Histogram({
  name: 'storage_request_duration_seconds', help: 'TTFB and total time by op',
  labelNames: ['op', 'phase'],                               // phase = ttfb | total
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 10, 60, 300],
});
export const bytesOut = new client.Counter({ name: 'storage_bytes_out_total', help: 'Bytes sent to clients' });
export const underReplicated = new client.Gauge({
  name: 'chunks_under_replicated', help: 'Chunks with fewer than 3 durable replicas (set by repair scheduler)',
});

export function observe(op: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const endTtfb = requestDuration.startTimer({ op, phase: 'ttfb' });
    const endTotal = requestDuration.startTimer({ op, phase: 'total' });
    const writeHead = res.writeHead;
    res.writeHead = function (this: Response, ...args: any[]) {
      endTtfb();                                             // headers leaving = first byte
      return writeHead.apply(this, args as any);
    } as typeof res.writeHead;
    res.on('finish', () => {
      endTotal();
      requestsTotal.inc({ op, status: String(res.statusCode) });
      const len = Number(res.getHeader('content-length') ?? 0);
      if (res.statusCode < 300) bytesOut.inc(len);
    });
    next();
  };
}
```

**Code Explanation:**

- `collectDefaultMetrics()` -- CPU, memory, GC, **event loop lag**. Streaming server mein event loop lag badha = kahin sync kaam (jaise badi JSON parse ya sync crypto) bytes ko rok raha hai.
- `labelNames: ['op', 'status']` -- `op` ~8 values, `status` ~15 -> chhota time-series count. Bucket label nahi.
- `requestDuration` mein extra `phase` label -- spec kehta hai "time to first byte + total"; ek histogram mein do phases rakhe. Buckets 10 ms se 300 s tak kyunki ek hi metric chhote HEAD (ms) aur 1 GB GET (minutes) dono naapta hai. **Alert TTFB par lagao**, total par nahi (total object size par depend karta hai).
- `res.writeHead` wrap -- Node mein headers bhejne ka moment = client ke liye pehla byte. Wahan TTFB timer band. TTFB mein metadata lookup + pehle chunk ka pehla byte shamil hai -- yahi user ka "wait" hai.
- `res.on('finish')` -- poora body bhej diya gaya; total timer + counter. Client beech mein bhaag gaya toh `finish` nahi, `close` aata hai -- production mein `close` par bhi `status="client_abort"` count karo.
- `bytesOut.inc(len)` -- simple version `Content-Length` se. Exact bytes ke liye streaming pipeline mein ek counting `Transform` lagao (206 / abort ke case mein zyada sahi).
- `underReplicated` -- ise SQL `COUNT(*) ... GROUP BY chunk_id HAVING count(*) < 3` se har scrape par mat nikalo -- billions of rows scan. Repair scheduler apne pending-task state se set karta hai.
- `/metrics` internal port par, public nahi.

**PromQL:**

```
# 5xx rate per op
sum by (op) (rate(storage_requests_total{status=~"5.."}[5m])) / sum by (op) (rate(storage_requests_total[5m]))

# p99 TTFB for GET
histogram_quantile(0.99, sum by (le) (rate(storage_request_duration_seconds_bucket{op="GET",phase="ttfb"}[5m])))

# egress Gbps
rate(storage_bytes_out_total[5m]) * 8 / 1e9

# days until a node hits 85%: linear forecast from last 7 days
predict_linear(node_disk_used_ratio[7d], 90 * 86400) > 0.85
```

### 3. Alerts -- example thresholds

| Alert | Condition (example) | Severity | Kyun |
|---|---|---|---|
| **Chunk lost** | chunk with 0 live copies (repair `LOST`) | **Page immediately** | Durability promise toota |
| **Under-replication stuck** | `chunks_under_replicated` > 0 for 30 min (aur trend neeche nahi) | Page | Repair nahi ho raha; ek aur failure = loss |
| Repair lag | `repair_queue_lag_seconds` > 1 h | Page | Repair workers / Kafka / bandwidth issue |
| **Corruption spike** | `increase(scrubber_corrupt_chunks_total[1h])` baseline se 10x | Page | Kharab disk batch / firmware / bug |
| AZ / nodes down | `placement_live_nodes{az}` 10% se zyada drop | Page | AZ issue -- repair circuit breaker check |
| Disk full | `node_disk_used_ratio` > 0.85 | Warn (0.95 Page) | Placement skip; compaction ko space chahiye |
| GC anomaly | `gc_reclaimed_bytes_total` rate baseline se 5x | Page + GC auto-pause | GC bug ka early signal |
| GET TTFB | p99 TTFB > 500 ms for 10 min | Page | Users ko slow |
| 5xx rate | > 1% for 5 min per op | Page | PUT 5xx = metadata ya storage issue |
| `503 SLOW_DOWN` spike | ek prefix / shard par | Warn | Hot range -- split karo |
| Metadata latency | `metadata_query_duration_seconds` p99 > 50 ms | Warn | Shard overload / vacuum / index |
| Multipart backlog | `multipart_incomplete_uploads` badhta hi ja raha | Ticket | Cleanup worker toota |

**Durability metrics ka rule:** availability alerts "users dukhi hain" batate hain. Durability alerts "users **dukhi honge**, kuch hafton mein, agar abhi fix nahi kiya" -- isliye inko page karna padta hai jabki users ko abhi kuch nahi dikh raha.

### 4. Tracing -- API -> metadata -> data nodes

```
trace 4bf92f...  PUT /v1/buckets/shopkart-returns/objects/r/991.jpg     184 ms
  |-- auth (sigv verify, key lookup)                                    2 ms
  |-- placement.pickNodes                                                1 ms
  |-- chunk 0 write (primary node-az1-017)                             140 ms
  |     |-- node-az1-017 fsync                                          30 ms
  |     |-- forward -> node-az2-031 (fsync)                            45 ms   <- W=2 reached here
  |     |-- forward -> node-az3-008 (async 3rd)                        (linked)
  |-- pg commit (objects + chunks + locations + is_latest + outbox)    9 ms
```

- API node se data node tak `traceparent` HTTP header; primary node chain forward karte waqt aage pass kare. Tab dikhta hai "slow PUT = az2 ka ek node slow".
- **Sampling:** 1K PUT/s + 7K GET/s par har trace store karna mehenga. Head sampling ~1% + **tail sampling**: saare errors aur slow (p99 se upar) requests hamesha rakho.
- Span attributes: `bucket`, `op`, `size_bytes`, `chunk_count`, `node_id`, `storage_class`. Signature, secret, full key kabhi nahi.

### 5. Dashboards -- on-call, durability, capacity

```
+----------------------------------+----------------------------------+
| RPS + 5xx by op                  | p50/p99 TTFB by op               |
+----------------------------------+----------------------------------+
| Ingest / egress Gbps, CDN hit %  | Metadata p99, per shard          |
+----------------------------------+----------------------------------+
| chunks_under_replicated (-> 0)   | Repair lag, repair throughput    |
+----------------------------------+----------------------------------+
| Live nodes per AZ                | Scrubber progress + corrupt/day  |
+----------------------------------+----------------------------------+
```

**Capacity dashboard:** fleet raw used vs total (STANDARD vs COLD split), daily growth (TB/day), **days until 80% full** (`predict_linear`), nodes needed next quarter, GC reclaimed/day vs deleted/day (gap = garbage jama ho raha), EC transition backlog. Hardware order ka lead time weeks-months hai -- ye dashboard 90 din aage dekhta hai, aaj ka nahi.

> Interview line: "Main StoreBox ko teen angle se observe karunga: availability -- per-op RED, GET ka p99 TTFB (total nahi, kyunki woh size par depend karta hai), 5xx aur `503 SLOW_DOWN`; durability -- `chunks_under_replicated` jo 0 ki taraf jaana chahiye, repair lag, scrubber corruption rate, aur GC reclaimed bytes ka anomaly jo GC bug pakadta hai; aur capacity -- `node_disk_used_ratio` ka 90-day forecast. Access logs mein key ka hash, secrets kabhi nahi. Trace API se metadata commit aur har data node ke fsync tak jaata hai, taaki slow PUT ka exact node dikhe."

---

## Remember

> **Storage teen axes par scale hota hai -- bytes (disks, EC), objects (metadata sharding by key range), requests (API, hot prefixes); data chunks immutable hain toh consistency sirf metadata commit par hai, jo strong read-after-write deta hai; failures (disk, node, AZ, bit rot) routine hain aur parallel, CRC-verified repair se heal hote hain -- lekin sabse bada khatra GC bug hai, isliye delete hamesha slow, two-phase aur soft; aur `chunks_under_replicated` hamesha 0 ki taraf.**

## Quick Self-Test

1. 336 TB data wala node mara. Ek naye node mein copy karne mein ~3 din aur fleet-wide parallel repair mein ~16 ghante kyun lagte hain? Isse 11 nines ka kya lena dena hai, aur node mara declare karne ke liye 10 min kyun wait karte hain?
2. Poora AZ down hai. Reads aur writes kya chalte hain (W = 2 of 3)? COLD 8+4 data ka kya haal hai? Aur 10 min baad mass repair kyun nahi karna chahiye?
3. Metadata ko range se shard kiya, hash se kyun nahi? `logs/2026-09-18/...` keys likhne wale customer ke saath kya hoga, aur `503 SLOW_DOWN` kaise madad karta hai?
4. GET ko async read replica se serve kiya, aur "latest version" ko Redis mein 60 s cache kiya. Dono se read-after-write kaise toota? Kaunsi cheez freely cache kar sakte ho aur kyun?
5. GC bug teeno replicas kyun mita sakta hai jabki disk failure nahi? GC ke kaunse chaar guardrails live data bachaate hain -- aur `gc_reclaimed_bytes_total` alert mein kaise kaam aata hai?

---

**Next (Part 5):** Trade-offs, MVP -> Scalable -> Highly Scalable, Follow-up questions, What-ifs, Node.js questions. "next" bolo.
