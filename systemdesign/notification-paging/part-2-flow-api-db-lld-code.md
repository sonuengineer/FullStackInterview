# Notification / Paging System -- HLD + LLD (Part 2: Request Flow -> API -> Database -> LLD -> Code)

> Is file mein prompt ke **Parts 7-12** hain: poora request flow (event se lekar sote hue insaan ke phone tak), API design (`202` kyun, idempotency, webhooks), database design (Postgres schema + partial unique index), LLD folder structure, aur Node.js/TypeScript code line-by-line explanation ke saath.
> **Part 1 mein humne decide kiya tha:** problem kya hai ("ek machine ka alert, sote hue insaan ke phone tak, guaranteed, minutes mein"), requirements (dedup, routing, multi-channel, escalation, ack, quiet hours, grouping), numbers (**50M events/day = 579 eps avg, 6,000 eps peak; 95% dedup -> 2.5M incidents/day = 29/s; 7.5M notifications/day = 87/s avg, 1,000/s peak**), SLO (**page latency p95 < 5 s, p99 < 10 s**, ingest availability 99.99%), aur core principle: **"duplicate page is OK, missed page is NOT."** Architecture: Ingest API -> Kafka `incident-events` -> Incident Service -> Kafka `notifications` -> Notification Workers -> providers, plus Scheduler (Redis ZSET timers) aur Postgres source of truth.
> **Part 3 mein aayega:** dedup aur idempotency ki internals, escalation timer ke saare design options, retries/backoff/circuit breaker, concurrency (ack race, duplicate consumers), Redis state deep dive.

---

## PART 7 -- HLD Request Flow (event se page tak, step by step)

Pehle ek baat clear karo: is system mein "request" ka matlab **user ka click nahi**, ek **machine ka event** hai. Prometheus Alertmanager ya Datadog ya customer ka cron script bolta hai "CPU 95% on web-3", aur hamara kaam hai us baat ko **ek insaan ke phone tak** pahunchana -- 5 second ke andar pehla notification provider ko handover ho jaana chahiye.

Aur yahan ek aur baat khaas hai: **request khatam ho jaati hai, kaam nahi.** Client ko hum `202 Accepted` 30 ms mein de dete hain, lekin asli kaam (incident banana, on-call nikalna, SMS bhejna, timer lagana) uske baad **background mein** hota hai. Isliye "request flow" do hisson mein hai:

```
Synchronous hissa  (client wait karta hai)   : ~30 ms   -> 202 Accepted
Asynchronous hissa (client ja chuka hai)     : ~400 ms  -> phone bajta hai
```

Char flows dekhenge:

- **Flow A** -- naya `trigger` event (happy path, poora raasta).
- **Flow B** -- wahi alert dobara aaya (dedup hit, **koi page nahi**). Ye 95% traffic hai.
- **Flow C** -- 5 minute ho gaye, ack nahi aaya -> **escalation timer fire**, level 2 ko page.
- **Flow D** -- responder ne **acknowledge** kiya -> saare timers aur queued notifications cancel.

### Flow A -- Naya trigger event (happy path)

Scenario: Raat 2:14 baje, customer "ShopKart" ke checkout service ka Prometheus Alertmanager firing state mein chala gaya. Wo hamare paas POST karta hai `routingKey = "R0ZY8K3QWERTY12345678"`, `dedupKey = "cpu-high-web-3"`, `severity = "critical"`.

```mermaid
sequenceDiagram
    participant AM as Alertmanager
    participant LB as Load Balancer
    participant IN as Ingest API (Node.js)
    participant RD as Redis
    participant KF as Kafka incident-events
    participant IS as Incident Service
    participant PG as Postgres
    participant KN as Kafka notifications
    participant NW as Notification Worker
    participant TW as Twilio
    participant PH as Amit ka phone
    AM->>LB: POST /v2/enqueue (routingKey, dedupKey, trigger)
    LB->>IN: forward
    IN->>RD: GET svc:R0ZY8K3Q... (routingKey -> serviceId)
    RD-->>IN: serviceId, accountId, policyId
    IN->>RD: token bucket rl:events:R0ZY8K3Q...
    RD-->>IN: allowed
    IN->>KF: produce (key=serviceId, acks=all)
    KF-->>IN: committed to 3 replicas
    IN-->>AM: 202 Accepted { status, dedupKey }
    KF->>IS: consume (group incident-service)
    IS->>PG: BEGIN; INSERT incidents ON CONFLICT ...
    PG-->>IS: inserted = true (naya incident)
    IS->>PG: INSERT incident_events (triggered), escalation_timers; COMMIT
    IS->>RD: ZADD sched:escalations dueAt timerId
    IS->>KN: produce NotificationTask (push, sms)
    KN->>NW: consume (group notification-workers)
    NW->>PG: notification row (task_id unique)
    NW->>TW: POST Messages (10 s timeout)
    TW-->>NW: 201 queued, providerMessageId
    TW->>PH: SMS bajta hai
```

**Step by step (Hinglish mein):**

1. **DNS** -- Alertmanager `events.pagerlike.com` resolve karta hai. Anycast / Route53 se nearest region ke Load Balancer ka IP milta hai. Ingest ko **multi-region** rakhna yahan zaroori hai: customer ka ek DC jal raha ho toh uska alert kisi aur region se nikalna chahiye.
2. **TLS + Load Balancer** -- TLS LB par terminate hota hai. LB request kisi bhi healthy Ingest instance ko bhejta hai. Ingest **stateless** hai (koi session, koi local state nahi), isliye koi bhi instance chalega.
3. **Ingest API: body parse + shape validation** -- `express.json({ limit: '64kb' })`. `customDetails` mein customer 5 MB ka JSON bhej sakta hai; cap zaroori hai warna ek client sabka memory kha jaayega. Phir zod se shape check: `eventAction` teen values mein se ek, `payload.summary` non-empty, `severity` chaar values mein se ek.
4. **`routingKey` -> `serviceId` lookup (auth step)** -- `GET svc:<routingKey>` Redis se. Hit (99%+) -> 0.3 ms. Miss -> Postgres `SELECT ... FROM services WHERE routing_key = $1` -> Redis mein **TTL 300 s** ke saath cache. Key mila hi nahi -> **`401 INVALID_ROUTING_KEY`**.
   > Note: `routingKey` hi is API ka **poora authentication** hai. Koi Bearer token nahi, koi user login nahi. Kyun? Kyunki client ek machine hai jo shell script se `curl` chala rahi hai -- OAuth flow uske liye impossible hai. Isliye routing key ko **API key jaisa secret** treat karo (Part 5 mein rotation + scoping).
5. **Rate limit** -- token bucket `rl:events:<routingKey>` (Rate Limiter lesson ka wahi Lua script). Kyun? Ek customer ka buggy script 50,000 events/sec bhej sakta hai; usko throttle karo, **baaki 19,999 customers ko nahi**. Bucket khaali -> **`429 RATE_LIMITED`** + `Retry-After`.
6. **`dedupKey` compute (agar nahi bheja)** -- client ne `dedupKey` nahi diya toh `sha256(summary + '|' + source).slice(0, 32)`. Kyun? Dedup hamara sabse important guarantee hai; usko client ki mehnat par nahi chhod sakte.
7. **Idempotency check (optional header)** -- `Idempotency-Key` header aaya ho toh `idempotency_keys` table dekho (detail PART 8 mein).
8. **Kafka produce** -- topic `incident-events`, **key = `serviceId`**, `acks: 'all'`. Broker tab tak `ack` nahi karta jab tak message **3 replicas** par nahi likha jaata. Yahi hamari **durability guarantee** hai: `202` bolne se pehle event kahin durable ho chuka hai.
   - Key `serviceId` kyun? Taaki ek service ke saare events **ek hi partition** mein jaayein aur **order** mein rahein. Warna `trigger` aur uske 200 ms baad aaya `resolve` ulta process ho sakta hai -> incident resolve hone ke baad dobara triggered dikhega.
9. **`202 Accepted`** -- body: `{ "status": "accepted", "dedupKey": "cpu-high-web-3" }`. Client ka kaam khatam. Total sync time: **~25-35 ms** (jisme ~15-25 ms Kafka `acks=all` ka hai).
10. **Kafka -> Incident Service consumer** -- consumer group `incident-service`, 24 partitions, `enable.auto.commit = false`. Message fetch hone mein normally 20-80 ms.
11. **Dedup upsert (ek transaction ke andar)** -- `INSERT INTO incidents ... ON CONFLICT (service_id, dedup_key) WHERE status <> 'resolved' DO UPDATE SET occurrence_count = incidents.occurrence_count + 1, last_seen_at = now() RETURNING (xmax = 0) AS inserted`. `inserted = true` mila -> **naya incident**, aage badho. `false` -> Flow B.
12. **Timeline row** -- usi transaction mein `INSERT INTO incident_events (incident_id, type, actor, detail) VALUES (..., 'triggered', 'monitoring', ...)`. Timeline **immutable audit** hai -- postmortem mein "kaun, kab, kya" yahin se milta hai.
13. **Routing (kisko page karein?)** -- `service -> policy_id -> escalation_rules WHERE level = 1 -> target_type/target_id`. Target `schedule` hai toh `resolveOnCall(scheduleId, now)` chalao: layers + rotation index + overrides -> Amit. Ye saara data **chhota aur slow-changing** hai, isliye process memory mein 60 s cache -- hot path par Postgres se policy padhna pure waste hai.
14. **Escalation timer** -- usi transaction mein `INSERT INTO escalation_timers (incident_id, level, due_at, state) VALUES (..., 1, now() + interval '5 minutes', 'pending')`. **Ye Postgres wali row durable copy hai.**
15. **COMMIT** -- ab incident, timeline aur timer teeno ek saath durable hain. Ya teeno hue, ya ek bhi nahi.
16. **Commit ke BAAD: Redis ZSET + Kafka produce** -- `ZADD sched:escalations <dueAtMs> <timerId>` aur `notifications` topic par tasks produce (key = `incidentId`). Ye do cheezein transaction ke **bahar** kyun hain -- neeche "Transaction boundary" box mein.
17. **Notification tasks banana** -- Amit ke `notification_rules` (urgency `high`) padho: `delay_min = 0 -> push`, `delay_min = 1 -> sms`, `delay_min = 5 -> voice`. `delay_min = 0` wala **abhi** produce hota hai; baaki `scheduledFor` timestamp ke saath (worker unhe hold karta hai / alag delayed path -- Part 3).
18. **Notification Worker** -- consumer group `notification-workers`, 48 partitions. Task uthaya.
19. **Cancelled check** -- "kya beech mein koi ack kar chuka?" `SELECT status FROM incidents WHERE id = $1`. `acknowledged` ya `resolved` -> **send mat karo**, `notifications.status = 'cancelled'`. Ye last-moment check isliye ki task already queue mein pada tha.
20. **Quiet hours / urgency check** -- `severity = critical` -> urgency `high` -> full paging allowed. Agar `warning`/`info` hota toh sirf email/digest, raat ko phone nahi bajta.
21. **Grouping check** -- `INCR grp:<serviceId>:<minuteBucket>`. Count <= 10 -> individual notification. Count > 10 -> **storm**: individual page rok do, 5 min mein ek grouped page.
22. **Notification row insert** -- `INSERT INTO notifications (task_id, ...) ON CONFLICT (task_id) DO NOTHING`. Duplicate task (Kafka at-least-once) yahin marta hai.
23. **Provider send** -- `contact_methods.address_enc` decrypt (KMS envelope) -> `+9198765XXXXX`. Twilio ko POST, **10 s timeout**, `Idempotency-Key: <taskId>` header. Response `201` + `providerMessageId`.
24. **Attempt row + metrics** -- `INSERT INTO notification_attempts (notification_id, attempt, result, latency_ms)`. Metric `page_latency_seconds` observe hota hai (event accept -> first provider handover -- **North Star SLI**).
25. **Manual Kafka commit** -- ab jaake `consumer.commitOffsets(...)`. Pehle kaam, phir commit. Crash ho gaya toh message dobara aayega (duplicate SMS ka risk) -- aur wahi hamari policy hai.
26. **Phone bajta hai** -- Amit uthata hai. `202` se lekar yahan tak: **p50 ~400 ms, p95 ~2.5 s**. Budget 5 s ka hai.

> **Transaction boundary (interview mein ye poocha jaata hai):**
> ```
> BEGIN
>   INSERT incidents ... ON CONFLICT ... RETURNING (xmax = 0)
>   INSERT incident_events (triggered)
>   INSERT escalation_timers (level 1, due_at)
> COMMIT
> -- ab, transaction ke BAAHAR:
>   ZADD sched:escalations
>   producer.send(notifications)
> ```
> **Kyun bahar?** Kafka aur Redis Postgres transaction ka hissa ban hi nahi sakte (ye do alag systems hain, 2-phase commit ki koi practical support nahi). Agar hum commit se **pehle** Kafka par bhejein aur phir transaction rollback ho jaaye, toh **ek page chala gaya jiska incident exist hi nahi karta** -- ye jhooth hai, debug karna namumkin.
> **Commit ke baad bhejne ka risk kya hai?** Commit ho gaya aur usi microsecond mein process crash -> Kafka par task gaya hi nahi -> **page miss**. Isse bachne ke do standard ilaaj: (a) **transactional outbox** (task ko usi transaction mein `outbox` table mein likho, ek relay use Kafka par bhejta hai), ya (b) **escalation timer hi safety net hai** -- timer Postgres mein durable hai, 5 min baad fire hoga aur level 1 ko dobara page karega. v1 mein hum (b) par bharosa karte hain aur (a) ko Part 4 mein discuss karte hain.
> Ulta case: Kafka par bhej diya aur phir consumer crash hua **commit se pehle** -> message dobara process -> `ON CONFLICT` ki wajah se naya incident nahi banega, sirf `occurrence_count` badhega. **Yahi dedup index ka doosra fayda hai: wo idempotency bhi de raha hai.**

### Flow B -- Wahi alert dobara (dedup hit, koi page nahi)

Ye **95% traffic** hai. Alertmanager har 30 second wahi alert dobara bhejta hai jab tak problem zinda hai. Agar hum har event par page karein toh Amit ko 2 minute mein 4 SMS aa jaayenge.

```
2:14:00  trigger cpu-high-web-3  -> naya incident INC-8891 -> Amit ko page
2:14:30  trigger cpu-high-web-3  -> dedup hit -> occurrence_count = 2 -> koi page nahi
2:15:00  trigger cpu-high-web-3  -> dedup hit -> occurrence_count = 3 -> koi page nahi
2:15:30  trigger cpu-high-web-3  -> dedup hit -> occurrence_count = 4 -> koi page nahi
```

**Step by step:**

1. Steps 1-9 **bilkul same** -- ingest ko pata hi nahi ki ye duplicate hai. Ingest ka kaam sirf "accept + durable + 202" hai. Wo DB dekhega hi nahi (warna latency budget aur DB load dono barbaad).
2. **Fast path (optional optimization):** Incident Service pehle `GET dedup:<serviceId>:<dedupKey>` Redis se maar sakta hai (TTL 6 h). Hit -> "ye khula incident hai" -> seedha `UPDATE occurrence_count` + timeline, poora upsert bhi skip. Ye **sirf ek optimization** hai (Postgres round trips bachane ke liye); **source of truth hamesha Postgres ka partial unique index hai**, kyunki Redis eviction ya failover par ye key gayab ho sakti hai aur tab duplicate incident ban jaayega.
3. **Upsert chala** -- `ON CONFLICT` branch hit hua: `occurrence_count = occurrence_count + 1`, `last_seen_at = now()`. `RETURNING (xmax = 0)` ne **`false`** diya.
4. **`inserted === false` -> yahin ruk jao.** Koi routing nahi, koi notification task nahi, koi naya escalation timer nahi. Metric `dedup_hits_total` +1.
5. **Timeline mein kya?** Har repeat ke liye ek timeline row banaoge toh 95% dedup ratio par `incident_events` table `incidents` se **20x badi** ho jaayegi. Practical rule: repeat par timeline row **mat** banao; `occurrence_count` aur `last_seen_at` hi kaafi kahani keh dete hain ("63 baar aaya, aakhri baar 2 min pehle"). Sirf **pehla** trigger aur har state change timeline mein.
6. **Purana escalation timer?** Wo **waisa hi chalta rehta hai**. Repeat event par timer reset **nahi** karna -- warna alert har 30 s aata rahega, timer har baar 5 min aage khisakta rahega, aur **escalation kabhi fire hi nahi hoga**. Ye ek classic bug hai.
7. Consumer offset commit. Total processing: ~3-6 ms (ek UPDATE).

> **Interview line:** "Dedup ingest par nahi, consumer par hota hai -- aur wo bhi Redis par nahi, Postgres ke **partial unique index** par. Redis sirf latency bachata hai; correctness ka zimma database ka hai."

### Flow C -- Escalation timer fire hua (level 2 ko page)

Scenario: 2:19:00 -- Amit so raha hai, SMS nahi dekha. Timer `due_at = 2:19:00` aa gaya.

```
Scheduler (har 1 s tick)
   |
   +--> EVALSHA claim.lua  KEYS[1]=sched:escalations  ARGV=[nowMs, 500]
   |       ZRANGEBYSCORE -inf nowMs LIMIT 0 500   -> due timer ids
   |       ZREM <wahi ids>                        -> atomic claim
   |    (ek hi atomic step -- do scheduler instance same timer do baar nahi uthayenge)
   |
   +--> har timer id ke liye: produce to Kafka `escalations` (key = incidentId)
   |
   v
Escalation consumer (group escalation-consumer)
   |-- SELECT timer FOR UPDATE; state = 'pending' hai? nahi -> drop (cancelled ho chuka)
   |-- SELECT incident; status abhi bhi 'triggered'? nahi -> drop (ack ho gaya)
   |-- UPDATE escalation_timers SET state = 'fired'
   |-- incident.escalation_level = 2 (ya round++ agar level khatam)
   |-- routing: escalation_rules WHERE level = 2 -> Priya
   |-- timeline: type = 'escalated'
   |-- naya timer: level 3 ka due_at = now + ackTimeoutMin
   |-- produce notification tasks (Priya ke rules se)
```

**Step by step:**

1. **Scheduler tick** -- har **1 second** ek Lua script. Granularity 1 s, acceptable lag budget **10 s** (metric `timer_lag_seconds`, alert > 10 s).
2. **Atomic claim** -- `ZRANGEBYSCORE` + `ZREM` **ek hi Lua script** mein. Do steps mein karte (pehle range, phir remove) toh do scheduler instances same timer uthake **do baar page** kar dete.
3. **Batch cap 500** -- storm mein 50,000 timers ek saath due ho sakte hain. 500 ka batch = ek tick ka kaam bounded, event loop block nahi hota, aur backlog agle ticks mein nikal jaata hai (~100 ticks = 100 s -- isliye storm ke waqt batch size aur scheduler instances dono badhane padte hain).
4. **Kafka `escalations` topic** -- scheduler khud DB/routing kaam nahi karta. Uska kaam sirf **"time ho gaya"** bolna hai. Kyun? Scheduler ko fast aur simple rakhna hai; bhaari kaam consumers par, jo horizontally scale karte hain.
5. **Consumer: state check (do baar)** -- timer `pending` hai? Incident abhi bhi `triggered` hai? Dono check isliye ki ack aur timer-fire **ek hi second** mein ho sakte hain (race). `FOR UPDATE` row lock se do consumers ek hi timer par race nahi karte.
6. **Level badhao** -- `escalation_level = 2`. Agar level 2 exist hi nahi karta (policy mein sirf 2 levels the aur hum 2 par the) toh `escalation_round + 1` karke **wapas level 1 se** shuru -- `repeat_count` (default **2**) rounds tak. Rounds khatam -> timeline mein `escalation exhausted` + koi naya timer nahi + (optional) account admin ko notify.
7. **Naya target** -- level 2 ka target `schedule` -> `resolveOnCall` -> Priya (backup on-call).
8. **Naya timer** -- level 3 ke liye `now + ackTimeoutMin`. Escalation ek **chain** hai, ek-ek kadi banti jaati hai.
9. **Notification tasks** -- Priya ke rules se push + SMS. Metric `escalations_fired_total{level="2"}` +1.
10. Priya ka phone bajta hai, 2:19:00 + ~300 ms.

> **Recovery job (60 s):** `SELECT id, due_at FROM escalation_timers WHERE state = 'pending' AND due_at < now() + interval '5 minutes'` -> `ZADD NX sched:escalations`. Ye Redis wipe/failover ke baad timers wapas laata hai. `NX` isliye ki already-present timer ka score na badle (idempotent). **Timers ko sirf Redis mein rakhna is system ki sabse badi galti hogi** -- Redis ek `FLUSHALL` ya failover mein 50,000 pending pages chup-chaap gayab kar dega aur kisi ko pata bhi nahi chalega.

### Flow D -- Acknowledge aaya (sab kuch cancel)

Scenario: 2:19:40 -- Priya ke phone par SMS aaya, usne reply kiya `4`.

```
Priya ka phone --SMS "4"--> Twilio --webhook--> POST /webhooks/twilio/inbound
                                                   |
                                                   |-- X-Twilio-Signature verify (HMAC)
                                                   |-- From number -> contact_method -> user Priya
                                                   |-- body "4" -> acknowledge intent
                                                   |-- last open incident for Priya (ya short link ka id)
                                                   v
                                        POST /api/v1/incidents/:id/acknowledge (internal call)
                                                   |
                                    UPDATE incidents SET status='acknowledged', ...
                                      WHERE id=$1 AND status='triggered' AND version=$3
                                                   |
                                       rowCount = 1 ---> cancel sab kuch
                                       rowCount = 0 ---> koi aur pehle kar gaya -> 200 (current state)
```

**Step by step:**

1. **Twilio inbound webhook** -- Twilio hamare public endpoint par POST karta hai: `From`, `Body`, `MessageSid`.
2. **Signature verification** -- `X-Twilio-Signature` header = HMAC-SHA1 of (URL + sorted params) with auth token. Verify **fail -> 403, turant**. Bina verification ke koi bhi banda `From=+919876543210&Body=4` POST karke **kisi ka bhi incident ack** kar sakta hai. Ye ek real security hole hai.
3. **Number -> user** -- `From` number se `contact_methods` dhundo (encrypted column par lookup ke liye deterministic hash column ya blind index chahiye -- Part 5).
4. **Intent parse** -- `"4"` = acknowledge (PagerDuty convention; voice call mein DTMF "4" bhi wahi). `"6"` = resolve. Kuch aur -> help message wapas.
5. **Kaunsa incident?** -- sabse achha: SMS mein bheja gaya **short link** (`sho.rt/i/abc` -- URL Shortener lesson) us user ke us page se bandha hota hai. Fallback: us user ka sabse recent `triggered` incident.
6. **Optimistic-lock UPDATE** -- `WHERE id = $1 AND status = 'triggered' AND version = $3`. `rowCount = 1` -> Priya ne jeeta.
7. **Timers cancel** -- `UPDATE escalation_timers SET state = 'cancelled' WHERE incident_id = $1 AND state = 'pending'` **aur** Redis se `ZREM sched:escalations <timerId>`. Dono karo: Redis se hata diya toh scheduler uthayega hi nahi; DB mein `cancelled` kar diya toh **recovery job usko wapas ZSET mein nahi daalega**. Sirf ek kiya toh timer zombie ban ke wapas aa jaayega.
8. **Queued notifications cancel** -- `UPDATE notifications SET status = 'cancelled' WHERE incident_id = $1 AND status = 'queued'`. Priya ka "5 min par voice call" wala task ab nahi jaayega.
9. **Last-moment check** -- lekin kuch tasks **already Kafka queue mein** ho sakte hain. Unhe wapas nahi le sakte. Isliye worker send karne se **theek pehle** dobara check karta hai (Flow A step 19). Ye "belt and suspenders" hai -- do jagah check, kyunki 3 baje raat ko galat page bhejna user ka trust todta hai.
10. **Timeline** -- `type = 'acknowledged'`, `actor = 'priya@shopkart.com'`, `detail = { via: 'sms' }`.
11. **Response** -- `200` + incident ka current state. Twilio ko `<Response></Response>` (empty TwiML) ya 204.

### Latency budget -- p95 < 5 s kahan kharch hota hai?

| Step | p50 | p95 | Kyun itna / kya bigaad sakta hai |
|---|---|---|---|
| TLS + LB + network (client -> ingest) | 5 ms | 25 ms | Client kahin bhi ho sakta hai; multi-region ingest isi liye |
| Body parse + zod validation | 0.3 ms | 1 ms | 64 KB cap; bada `customDetails` ise bigaadta hai |
| `svc:<routingKey>` Redis lookup | 0.4 ms | 1 ms | Cache miss -> Postgres -> ~5 ms (TTL 300 s se miss rare) |
| Rate limit (token bucket Lua) | 0.4 ms | 1 ms | Rate Limiter lesson wala hi ek round trip |
| Kafka produce `acks=all` | 12 ms | 30 ms | 3 replicas par fsync/replication. **Sync path ka sabse bada hissa** |
| **-> 202 Accepted (client ka wait khatam)** | **~20 ms** | **~60 ms** | |
| Kafka fetch lag (broker -> incident-service) | 25 ms | 120 ms | Consumer lag badhe toh yahi pehle phoolta hai |
| Dedup upsert + timeline + timer (1 txn) | 6 ms | 20 ms | `commit_delay`, WAL fsync; partition pruning se bachta hai |
| Routing (policy + schedule, 60 s cache) | 1 ms | 8 ms | Cache miss par 2-3 Postgres queries |
| Produce `notifications` task | 8 ms | 25 ms | Yahan `acks=1` bhi chal jaata (timer safety net hai) |
| Kafka fetch lag (notification worker) | 25 ms | 120 ms | 48 partitions = zyada parallelism |
| Cancelled + quiet hours + grouping checks | 2 ms | 10 ms | 1 Postgres read + 1 Redis INCR |
| `notifications` row insert | 3 ms | 12 ms | Unique index par upsert |
| Address decrypt (KMS data key, cached) | 0.2 ms | 3 ms | Data key cache na ho toh KMS call = 20 ms |
| **Provider handover (Twilio API POST)** | **180 ms** | **900 ms** | Bahar ka system. **Yahin hamara SLI khatam hota hai** |
| **Total (event accept -> provider handover)** | **~290 ms** | **~1.4 s** | **Budget 5 s -- 3.5 s headroom** |
| Provider -> carrier -> handset (hamare control mein nahi) | 2 s | 15 s | Isliye SLI provider handover par measure hota hai |

**Headroom kyun chahiye?** Kyunki hamara p95 normal din ka hai. **Storm ke din** Kafka consumer lag 120 ms se badhkar 2-3 second ho jaata hai (yahi wo jagah hai jahan budget khatam hota hai). Isliye:

- `kafka_consumer_lag{topic,group}` par alert -- ye hamara **early warning** hai, `page_latency_seconds` ke phoolne se pehle dikhta hai.
- Consumer instances peak se **2x** provisioned rakho (24 aur 48 partitions ka poora matlab hi ye hai ki 24/48 consumers tak scale kar sako).
- Provider call par **10 s timeout** -- warna ek slow provider poore worker pool ko block karke lag ko minutes tak le jaata hai.

> **Interview line:** "Mera SLI `page_latency_seconds` hai: event accept se lekar **first provider handover** tak. Carrier ki delivery mere control mein nahi hai, isliye usko SLO mein nahi daalunga -- lekin delivery webhook se uska alag metric zaroor rakhunga."

---

## PART 8 -- API Design

Is system ki API **teen alag duniyaon** ke liye hai, aur teeno ka auth model alag hai. Ye distinction interview mein bahut achha lagta hai:

| API group | Kaun call karta hai | Auth model | Kyun wahi |
|---|---|---|---|
| `POST /v2/enqueue` | Machines (Alertmanager, cron, scripts) | **`routingKey` body mein** (shared secret) | Machine OAuth flow nahi kar sakti; ek string chahiye jo `curl` mein paste ho jaaye |
| `/api/v1/*` (dashboard, mobile app) | Insaan | **Session cookie / JWT** + account scoping | Insaan login karta hai, permissions hote hain, MFA hota hai |
| `/webhooks/*` | Providers (Twilio, SendGrid) | **HMAC signature verification** | Provider ke paas hamara token nahi hona chahiye; wo request ko **sign** karta hai |

```
POST /v2/enqueue                                  # Events API (machines)
GET  /api/v1/incidents?status=&serviceId=&cursor= # keyset pagination
GET  /api/v1/incidents/:id                        # incident + timeline
POST /api/v1/incidents/:id/acknowledge
POST /api/v1/incidents/:id/resolve
POST /api/v1/incidents/:id/notes
GET  /api/v1/oncall?scheduleId=&at=
POST /webhooks/twilio/status                      # delivery status
POST /webhooks/twilio/inbound                     # SMS reply "4" = ack
GET  /health    GET /ready
```

### 8.1 `POST /v2/enqueue` -- Events API

**Ye endpoint kyun hai?** Poore system ka **ek hi darwaza**. 100,000 services, 20,000 accounts -- sab yahin aate hain. Shape jaan-boojh kar **PagerDuty-compatible** rakhi hai, taaki customer ka existing Alertmanager config bina badle kaam kare (migration friction = business risk).

**Request:**

```http
POST /v2/enqueue HTTP/1.1
Host: events.pagerlike.com
Content-Type: application/json
Idempotency-Key: 2f1c9b8e-4a7d-4c11-9f3e-6b2a5d8c1e40

{
  "routingKey": "R0ZY8K3QWERTY12345678",
  "eventAction": "trigger",
  "dedupKey": "cpu-high-web-3",
  "payload": {
    "summary": "CPU above 95% on web-3 for 5m",
    "source": "web-3.prod.shopkart.internal",
    "severity": "critical",
    "customDetails": { "cpu": 96.4, "region": "ap-south-1", "runbook": "https://wiki/rb/cpu" }
  }
}
```

**Response (202):**

```http
HTTP/1.1 202 Accepted
Content-Type: application/json

{ "status": "accepted", "dedupKey": "cpu-high-web-3" }
```

**Request mein kya hai?**

| Field | Zaroori? | Matlab |
|---|---|---|
| `routingKey` | Haan | Service ka secret -- ye hi batata hai "kis service ka alert hai" aur "tum authorized ho" |
| `eventAction` | Haan | `trigger` / `acknowledge` / `resolve` -- monitoring khud resolve bhej sakta hai (auto-resolve) |
| `dedupKey` | Nahi | Same problem ki pehchaan. Na ho toh `sha256(summary + '|' + source)` |
| `payload.summary` | Haan | Jo SMS mein dikhega. **160 char** SMS limit isliye truncate hota hai |
| `payload.source` | Haan | Kaunsi machine/host. Dedup key aur grouping dono mein kaam aata hai |
| `payload.severity` | Haan | `critical`/`error` = high urgency (phone bajega), `warning`/`info` = low (sirf email) |
| `payload.customDetails` | Nahi | Kuch bhi JSON -- incident page par dikhta hai. **Yahan 64 KB cap** |
| `Idempotency-Key` (header) | Nahi | Client retry safe banane ke liye |

**Response mein kya hai?** Sirf `status` aur `dedupKey`. **`incidentId` kyun nahi?** Kyunki abhi wo bana hi nahi hai -- hum ne sirf event ko Kafka mein daala hai. Client ko `dedupKey` isliye wapas dete hain taaki (a) hum ne jo compute kiya (agar usne nahi bheja tha) wo usko pata chale, aur (b) wahi key `resolve` bhejne ke liye use kare.

**Validation (zod se, hot path par saste checks):**

| Field | Rule | Kyun |
|---|---|---|
| `routingKey` | `^[A-Za-z0-9]{20,64}$` | Redis key ka hissa banta hai; `:` ya space allowed nahi. Length cap = attacker 1 MB key nahi bhej sakta |
| `eventAction` | enum (3 values) | Typo `triggered` chup-chaap ignore nahi hona chahiye |
| `dedupKey` | max 255 chars | Ye Postgres unique index mein jaata hai; bada key index bloat karega |
| `payload.summary` | 1-1024 chars | Khaali summary wala page bekaar hai |
| `payload.source` | 1-255 chars | -- |
| `payload.severity` | enum (4 values) | Galat severity = galat urgency = raat 3 baje ki galat call |
| `customDetails` | JSON object, body total <= 64 KB | Memory safety; ek client sabka ingest nahi khaa sakta |

**Auth chahiye?** Haan, lekin **sirf `routingKey`**. Koi `Authorization` header nahi. Iske security implications (Part 5 mein detail): key rotation support, key sirf **ek service** ko scope hoti hai (leak hui toh us ek service par fake alerts, poore account par nahi), leak detection ke liye per-key metrics, aur key kabhi logs mein nahi jaati.

**Error cases:**

| Status | Code | Kab | Body |
|---|---|---|---|
| `400` | `VALIDATION_ERROR` | Shape galat, enum galat, body > 64 KB | `{ "error": "VALIDATION_ERROR", "message": "payload.severity must be one of critical, error, warning, info" }` |
| `401` | `INVALID_ROUTING_KEY` | Key exist nahi / disabled | `{ "error": "INVALID_ROUTING_KEY", "message": "Routing key not found" }` |
| `409` | `IDEMPOTENCY_KEY_REUSED` | Same key, **alag** body | `{ "error": "IDEMPOTENCY_KEY_REUSED", "message": "This Idempotency-Key was used with a different request body" }` |
| `429` | `RATE_LIMITED` | Token bucket khaali | `{ "error": "RATE_LIMITED", "retryAfterSec": 3 }` + `Retry-After: 3` |
| `503` | `INGEST_UNAVAILABLE` | Kafka down **aur** local disk spool full | `{ "error": "INGEST_UNAVAILABLE", "message": "Retry shortly" }` + `Retry-After: 5` |

> **`401` ka message kya ho?** "Routing key not found" -- bas. **"Key expired on 2026-03-01 for account ShopKart"** jaisa detailed message mat do: ye ek unauthenticated endpoint hai, attacker isse account enumerate kar lega.

### 8.2 Deep dive: `202 Accepted` kyun, `201 Created` kyun nahi?

Ye is system ka sabse important API decision hai. Dono option honestly dekhte hain.

**Option A -- Synchronous `201 Created` (tempting, aur galat):**

```
POST /v2/enqueue
  -> routingKey validate
  -> Postgres: dedup upsert (incident bana)
  -> Postgres: timeline + timer
  -> on-call resolve (2-3 queries)
  -> Twilio ko SMS bhejo (180-900 ms!)
  -> 201 Created { "incidentId": "INC-8891" }
```

Ye "achha" lagta hai kyunki client ko `incidentId` mil jaata hai. Lekin:

| Problem | Kya hota hai |
|---|---|
| **Latency** | Client ka request ab **200-1000 ms** rukega, 25 ms nahi. 6,000 eps peak par ye 6,000 concurrent open connections. |
| **Coupling** | Postgres slow -> ingest slow -> Alertmanager timeout -> **client ko lagta hai alert gaya hi nahi** -> wo retry karta hai -> aur load. Death spiral. |
| **Storm mein collapse** | 50x spike par ingest ke paas koi buffer hi nahi. Kafka ek **shock absorber** hai; usko hata do toh spike seedha Postgres par girta hai. |
| **Availability** | Ingest ki availability ab Postgres **aur** Twilio ki availability se multiply hoti hai. 99.99% ka target khatam. |
| **Blast radius** | Ek buggy customer ka storm sabke liye ingest slow kar dega. |

**Option B -- Asynchronous `202 Accepted` (hamari choice):**

```
POST /v2/enqueue -> validate -> Kafka (acks=all) -> 202 { status, dedupKey }
```

| Fayda | Detail |
|---|---|
| **Fast + predictable** | ~25 ms, aur ye time sirf validation + Kafka par depend karta hai |
| **Durable** | `acks=all` matlab 202 bolne se pehle event **3 replicas** par hai. Ye jhooth nahi hai |
| **Decoupled** | Postgres 2 minute ke liye down? Ingest chalta rahega, backlog Kafka mein bhar jaayega, DB aate hi drain ho jaayega. **Kuch bhi nahi khoya** |
| **Replayable** | Bug fix karne ke baad 7 din ka topic dobara consume kar sakte ho |
| **Storm absorbent** | Spike Kafka mein soak hota hai, consumers apni raftaar se pite hain |

**Trade-off jo hum sweekar kar rahe hain:**

- Client ko `incidentId` nahi milta. **Ilaaj:** `dedupKey` hi client ka handle hai -- wo usi se resolve bhej sakta hai, aur `GET /api/v1/incidents?dedupKey=` se dhoondh sakta hai.
- `202` ka matlab "accept kiya", "process ho gaya" nahi. Agar consumer mein bug ho toh client ko turant pata nahi chalta. **Ilaaj:** consumer lag + DLQ depth par hard alerts, aur dashboard par "last event received at" per service.

> **`202` ka honest matlab:** "Maine teri baat **sun li aur likh li**. Ab main ise nibhaunga." `200` ka matlab hota "ho gaya" -- jo jhooth hota. Yahi difference interview mein bolna hai.

**Aur `Kafka down ho toh?`** Yahan hum **fail closed** hain -- ye Rate Limiter lesson se **ulta** hai:

```
Kafka produce fail
   |
   +--> local disk spool (bounded, ~60 s worth, fsync'd)   -> 202 (abhi bhi durable, sirf hamari disk par)
   |
   +--> spool bhi full?  -> 503 INGEST_UNAVAILABLE + Retry-After: 5
```

**Rate limiter mein hum "fail open" the (shak ho toh allow karo), yahan "fail closed" (shak ho toh mana karo) -- kyun?** Kyunki rate limiter ka fail-open sirf thoda extra traffic deta hai. Yahan fail-open ka matlab hota "`202` bol do aur event phenk do" -- yaani **customer ko bharosa dilana ki uska page jaayega, jab ki jaayega hi nahi**. Ye is product ka sabse bada paap hai. **Accepting a page you cannot deliver is worse than rejecting it loudly** -- `503` dekhkar Alertmanager retry karega, ya customer ka secondary route (email) chalega. Chup-chaap drop karne par koi kuch nahi kar sakta.

### 8.3 `Idempotency-Key` header -- teen cases

**Problem:** Alertmanager ne POST kiya, hamara `202` network mein kho gaya. Alertmanager retry karta hai. Ab do events. Dedup index isko pakad lega (same `dedupKey`), lekin:

- `occurrence_count` galat badh jaayega (2 dikhega jab ki asli 1 event tha).
- `eventAction = resolve` jaise cases mein ye zyada khatarnaak hai.
- Aur agar client ne `dedupKey` nahi bheja aur summary mein timestamp hai, toh dedup key hi alag ban jaayegi -> **do incidents**.

Isliye ek aur layer: `Idempotency-Key` header (UUID v4, client generate karta hai, **per logical request ek**).

```sql
CREATE TABLE idempotency_keys (
  account_id UUID NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL,
  response_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, key)
);
```

| Case | Kya milta hai | HTTP | Kyun |
|---|---|---|---|
| **1. Naya key** | Request process hota hai, response `(account_id, key, request_hash, response_json)` ke saath store hota hai (24 h TTL) | `202` | Pehli baar hai, normal kaam karo |
| **2. Same key + same body** | Stored `response_json` **wapas** (dobara Kafka par nahi bhejte) | `202` (header `Idempotent-Replay: true`) | Ye ek **retry** hai. Client ko wahi jawab milna chahiye jo pehli baar mila tha -- aur side effect dobara **nahi** hona chahiye |
| **3. Same key + alag body** | Kuch process nahi hota | `409 IDEMPOTENCY_KEY_REUSED` | Client ke code mein bug hai (key reuse kar raha hai). Chup-chaap pehli response wapas denge toh wo **galat** hoga -- doosra alert nigal jaayega. Loudly fail karo |

**`request_hash` kya hai?** `sha256(canonicalJson(body))`. Canonical matlab keys sorted, whitespace normalized -- warna `{"a":1,"b":2}` aur `{"b":2,"a":1}` alag hash de denge aur har retry `409` khaayega.

**24 h TTL kyun?** Client ka retry window kabhi 24 h se lamba nahi hota. Aur ye table warna 50M rows/day se phool jaayegi. Cleanup: `DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours'` (batched, ya partition drop).

**Race condition:** do retries **ek hi waqt** aa gayin. Ilaaj: pehle `INSERT ... ON CONFLICT DO NOTHING` karo ek `in_progress` marker ke saath. Insert nahi hua = koi aur chala raha hai -> `409 Conflict` ya thoda wait + poll. Detail Part 3 mein.

> **`dedupKey` vs `Idempotency-Key` -- confuse mat karo:**
> - `dedupKey` = "**ye wahi problem hai**" (business concept). 2 ghante tak wahi key aati rahegi, jaan-boojh kar.
> - `Idempotency-Key` = "**ye wahi HTTP request hai**" (transport concept). Har naye event par nayi honi chahiye; sirf retry par same.

### 8.4 Dashboard APIs (`/api/v1/*`)

**`GET /api/v1/incidents?status=triggered&serviceId=<uuid>&cursor=<opaque>&limit=50`**

```json
{
  "items": [
    {
      "id": "8f2c1a4e-...", "serviceId": "c3d1...", "dedupKey": "cpu-high-web-3",
      "status": "triggered", "severity": "critical",
      "summary": "CPU above 95% on web-3 for 5m", "source": "web-3.prod.shopkart.internal",
      "occurrenceCount": 63, "escalationLevel": 2, "escalationRound": 0,
      "acknowledgedBy": null,
      "createdAt": "2026-09-18T02:14:00.412Z", "lastSeenAt": "2026-09-18T02:45:10.004Z"
    }
  ],
  "nextCursor": "eyJjIjoiMjAyNi0wOS0xOFQwMjoxNDowMFoiLCJpIjoiOGYyYzFhNGUifQ=="
}
```

- **Kyun:** on-call dashboard ki main screen -- "abhi kya jal raha hai".
- **Auth:** session/JWT. **Har query mein `account_id` filter server-side lagta hai** (client se nahi aata). Warna ek customer doosre ka incident dekh lega -- classic IDOR bug.
- **Pagination:** **keyset/cursor** (`created_at DESC, id DESC`), offset nahi. Kyun? `OFFSET 100000` Postgres se ek lakh rows padhwa ke phenkwata hai; aur naya incident aane par rows shift ho jaati hain -> user ko same incident do baar dikhta hai ya ek miss ho jaata hai. Cursor ek opaque base64 hai jisme last row ka `(created_at, id)` hai (URL Shortener Part 4 ka rule).
- **`limit`:** default 50, **max 200** (cap na ho toh `limit=1000000` = DB DoS).
- **Read replica se** -- dashboards primary par load nahi daalte.
- **Errors:** `400` (galat `status` enum, `limit > 200`, kharab cursor), `401`, `403` (doosre account ka `serviceId`).

**`GET /api/v1/incidents/:id`** -- incident + poori timeline (`incident_events` ascending) + notifications ki summary ("push sent 02:14:01, sms delivered 02:15:03, voice failed"). Postmortem ka main page. `404` agar id account ka nahi hai (`403` mat do -- `403` se attacker ko pata chal jaata hai ki wo id exist karti hai).

**`POST /api/v1/incidents/:id/acknowledge`**

```json
// Request
{ "userId": "9a1f-...", "version": 3 }

// Response 200
{ "id": "8f2c...", "status": "acknowledged", "acknowledgedBy": "9a1f-...", "version": 4 }
```

- **`200`, `204` kyun nahi?** Kyunki hum **current state** wapas dete hain -- mobile app usi se apni screen update karta hai, ek extra GET nahi karna padta.
- **`409` kab?** **Kabhi nahi** (concurrent ack par). Ye is API ka sabse important decision hai -- neeche PART 11 mein code ke saath.
- **`version` optional hai** -- na bheje toh server current version padh kar use karega (thoda kamzor, lekin mobile app ke liye simple).
- **Errors:** `401`, `403` (user us account/service ka responder nahi), `404`, `422` agar incident `resolved` hai (resolved ko ack nahi kar sakte -- ya ise bhi idempotent `200` bana do, dono valid; hum `200` + current state dete hain kyunki user ko raat 3 baje error dikhana bekaar hai).

**`POST /api/v1/incidents/:id/resolve`** -- body `{ "userId", "note" }`. `status = 'resolved'`, `resolved_at = now()`. **Yahan ek zaroori side effect hai:** resolve hote hi `incidents_open_dedup_uniq` partial index se ye row **nikal jaati hai** (`WHERE status <> 'resolved'`), matlab wahi `dedupKey` ab **naya incident** bana sakti hai. Yahi sahi behaviour hai: problem wapas aayi = naya incident.

**`POST /api/v1/incidents/:id/notes`** -- `{ "userId", "note" }` -> timeline mein `type = 'note'`. Incident ke doran log yahin coordinate karte hain.

**`GET /api/v1/oncall?scheduleId=<uuid>&at=2026-09-18T02:14:00Z`**

```json
[{ "userId": "9a1f-...", "name": "Amit", "until": "2026-09-18T09:00:00Z" }]
```

- **Kyun:** "abhi kaun on-call hai" har dashboard, Slack bot aur schedule preview mein chahiye.
- `at` optional (default `now`), **ISO 8601 with timezone**. Bina timezone wala string reject karo -- warna server apne local timezone mein parse karke galat banda nikaalega.
- Array kyun? Ek schedule mein **kai layers** ho sakti hain (primary + secondary dono on-call).
- `until` client ko batata hai ki kab tak. Handoff ke waqt ye UI mein dikhta hai.

### 8.5 Webhooks (providers se aane wale)

**`POST /webhooks/twilio/status`** -- delivery status.

```http
POST /webhooks/twilio/status
X-Twilio-Signature: 9f2c8b1e4a7d...

MessageSid=SM9f2c...&MessageStatus=delivered&To=%2B919876543210
```

```
Signature verify -> notifications WHERE provider_message_id = $1
  -> status mapping: queued|sent|delivered|failed|undelivered
  -> delivered -> notifications.delivered_at = now()
  -> failed/undelivered -> metric + (agar ye aakhri channel tha) escalate/alert
-> 204 No Content
```

- **Idempotent hona chahiye:** Twilio same webhook **kai baar** bhejta hai (uska bhi at-least-once hai). `UPDATE ... WHERE provider_message_id = $1 AND status <> 'delivered'` -- dobara aaya toh 0 rows, koi nuksaan nahi.
- **Fast respond karo:** Twilio ka timeout chhota hai (few seconds); slow respond karoge toh wo retry storm bana dega. Bhaari kaam queue mein daalo.
- **Ordering nahi hai:** `delivered` webhook `sent` se pehle aa sakta hai. Isliye status ko ek **state machine** ki tarah treat karo (`delivered` ko `sent` se downgrade mat karo).
- **Errors:** `403` signature fail, `404` unknown `MessageSid` (log karo -- ya toh purana hai ya koi galat account ka), `204` sab theek.

**`POST /webhooks/twilio/inbound`** -- SMS reply `"4"` = acknowledge (Flow D). Signature verification ke baad number -> user -> intent -> internal acknowledge call.

**Signature verification -- WHY format:**

- **Kya hai?** Provider request ko apne shared secret se HMAC karta hai; hum wahi HMAC dobara compute karke compare karte hain.
- **Kyun?** Webhook URL **public internet** par hai. Bina signature ke koi bhi POST karke kisi ka bhi page ack kar sakta hai ya fake "delivered" bhej sakta hai.
- **Hata dein toh?** Ek attacker script se sabke incidents ack kar de -> escalation ruk jaaye -> outage par koi na aaye. **Ye "notification system" ka sabse pyaara attack hai.**
- **Kab zarurat nahi?** Kabhi nahi. Agar provider signature support hi na kare toh mTLS ya URL mein ek lamba random token (`/webhooks/twilio/inbound/<64-char-secret>`) -- lekin wo kamzor hai (URL logs mein aata hai).
- **Interview mein:** "Webhook ek unauthenticated inbound endpoint hai. Main hamesha HMAC signature verify karunga, **constant-time compare** se (`crypto.timingSafeEqual`), aur raw body par -- parsed body se dobara serialize karke hash banaoge toh byte-level farak se signature match hi nahi karega."

---

## PART 9 -- Database Design

### 9.1 Postgres kyun? (aur MongoDB / DynamoDB kyun nahi)

> "Main **PostgreSQL** choose kar raha hoon kyunki is system ka core data **deeply relational** hai aur correctness latency se zyada important hai."

Teen thos wajahein:

1. **Routing ek chain hai.** `service -> escalation_policy -> escalation_rule(level) -> schedule -> schedule_layer -> user -> contact_method -> notification_rule`. Ye saat hop ka join hai. Document DB mein isko denormalize karoge toh ek user ka phone number badalne par **100 documents** update karne padenge -- aur beech mein crash hua toh kuch incidents purane number par page karenge.
2. **Transactions.** Incident + timeline + escalation timer **ek saath** durable hone chahiye. Agar incident ban gaya aur timer nahi bana, toh wo incident **kabhi escalate nahi hoga** -- yaani outage par koi nahi aayega aur kisi ko pata bhi nahi chalega. Ye silent failure sabse khatarnaak hai.
3. **Partial unique index.** Hamara poora dedup guarantee ek line ka DB constraint hai: `UNIQUE (service_id, dedup_key) WHERE status <> 'resolved'`. Ye "conditional uniqueness" MongoDB ke partial indexes mein hai lekin DynamoDB mein bilkul nahi -- wahan yahi kaam conditional writes + ek alag "open incidents" table se manually banana padta.

**Alternatives honestly:**

| Option | Verdict | Kyun |
|---|---|---|
| **PostgreSQL** | **Hamari choice** | Relational chain, transactions, partial unique index, `ON CONFLICT`, partitioning, JSONB (`customDetails` ke liye) |
| **MySQL** | Chal jaata | Lekin partial (filtered) unique index nahi hai. Workaround: ek generated column `dedup_active = CASE WHEN status <> 'resolved' THEN dedup_key ELSE NULL END` par unique index (NULLs unique nahi ginte). Kaam karta hai, par Postgres wala tareeka saaf hai |
| **MongoDB** | Nahi | Multi-document transactions hain (4.0+) lekin ye hamara **default** pattern ban jaata, aur schema flexibility ki yahan zarurat hi nahi -- hamara schema fixed aur constraint-heavy hai |
| **DynamoDB** | Nahi (v1 mein) | Write scale shandaar (29 incidents/sec toh kuch bhi nahi), lekin "kisi bhi service ke open incidents `created_at DESC` mein do" jaise queries ke liye GSI par GSI banane padenge, aur conditional uniqueness khud handle karni padegi. Haan -- agar hum 100x badhein aur ingest hi ingest ho, tab worth revisiting |
| **Cassandra** | Nahi | Write-heavy ke liye banaya gaya hai, lekin yahan read-modify-write (dedup upsert, optimistic lock) core hai -- last-write-wins model isko todta hai |

**Write load check:** 29 incidents/sec avg (peak 300), plus ~87 notifications/sec (peak 1,000), plus timeline aur attempts. Total **~1,500 writes/sec peak** -- ek decent Postgres primary ke liye ye aaram ka kaam hai. Yaani hum **scale ke liye nahi, correctness ke liye** DB choose kar rahe hain. Interview mein ye line bolna: "Yahan mera bottleneck DB throughput nahi hai, isliye main NoSQL ke scale ke liye correctness nahi bechunga."

### 9.2 Schema chunk 1 -- routing chain (service se policy tak)

```sql
CREATE TABLE escalation_policies (
  id UUID PRIMARY KEY, account_id UUID NOT NULL, name TEXT NOT NULL,
  repeat_count INT NOT NULL DEFAULT 2
);

CREATE TABLE services (
  id            UUID PRIMARY KEY,
  account_id    UUID NOT NULL,
  name          TEXT NOT NULL,
  routing_key   TEXT NOT NULL UNIQUE,           -- secret, treated like an API key
  policy_id     UUID NOT NULL REFERENCES escalation_policies(id),
  auto_resolve_min INT NOT NULL DEFAULT 0,      -- 0 = never auto resolve
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE escalation_rules (            -- one row = one level
  policy_id UUID NOT NULL REFERENCES escalation_policies(id),
  level     INT  NOT NULL,                 -- 1, 2, 3
  ack_timeout_min INT NOT NULL DEFAULT 5,
  target_type TEXT NOT NULL CHECK (target_type IN ('schedule','user')),
  target_id   UUID NOT NULL,
  PRIMARY KEY (policy_id, level)
);
```

**Column by column:**

- **`escalation_policies.repeat_count = 2`** -- saare levels khatam hone ke baad kitne **round** dobara chalein. Default 2. Ye "infinite paging" ko rokta hai: 3 levels x 2 rounds x 5 min = **30 minute** baad system haar maan leta hai aur timeline mein `escalation exhausted` likhta hai. Infinite rakhoge toh ek chhoda hua incident hafton tak raat ko log jagata rahega.
- **`services.routing_key TEXT NOT NULL UNIQUE`** -- `UNIQUE` yahan **do kaam** karta hai: business rule (ek key = ek service) aur ek **B-tree index** jo hamara auth lookup fast banata hai (`WHERE routing_key = $1`). Ye lookup Redis cache miss par har 300 s mein chalta hai -- index ke bina 100,000 rows ka seq scan.
- **`services.auto_resolve_min`** -- "agar is service ka incident X minute tak koi event na bheje toh khud resolve kar do". `0` = kabhi nahi. Ye zaroori hai kyunki bahut monitoring tools `resolve` event bhejte hi nahi.
- **`escalation_rules` PK `(policy_id, level)`** -- ek policy mein ek level ek hi baar. Aur ye **composite PK ek index bhi hai**, jisse hamari sabse common routing query -- `WHERE policy_id = $1 AND level = $2` -- ek index lookup ban jaati hai. Alag se koi index nahi chahiye.
- **`target_type` + `target_id` (polymorphic)** -- level ka target ya toh ek schedule hai ya seedha ek user. **Foreign key yahan nahi lag sakti** (ek column do tables ko point kar raha hai) -- ye polymorphic FK ka classic trade-off hai. `CHECK` constraint enum ko toh pakadta hai, lekin "ye UUID sach mein exist karta hai" application ya trigger ko dekhna padega. Alternative: do nullable columns (`target_schedule_id`, `target_user_id`) + `CHECK` ki exactly ek non-null ho -- ye FK-safe hai aur bada schema ho toh better. Spec polymorphic use karta hai, isliye hum bhi.
- **`ack_timeout_min DEFAULT 5`** -- **per level** hai, policy par nahi. Kyun? Level 1 (primary on-call) ko 5 min do, lekin level 3 (manager) ko 15 min -- alag-alag urgency.

### 9.3 Schema chunk 2 -- schedules aur on-call (sabse tricky hissa)

```sql
CREATE TABLE schedules (
  id UUID PRIMARY KEY, account_id UUID NOT NULL, name TEXT NOT NULL,
  timezone TEXT NOT NULL                   -- IANA, e.g. 'Asia/Kolkata'
);
CREATE TABLE schedule_layers (
  id UUID PRIMARY KEY, schedule_id UUID NOT NULL REFERENCES schedules(id),
  rotation_type TEXT NOT NULL CHECK (rotation_type IN ('daily','weekly','custom')),
  rotation_length_sec INT NOT NULL,
  handoff_at TIMESTAMPTZ NOT NULL,         -- rotation anchor, stored UTC
  member_ids UUID[] NOT NULL,              -- ordered rotation
  restriction JSONB                        -- optional "only 09:00-18:00 on weekdays"
);
CREATE TABLE schedule_overrides (
  id UUID PRIMARY KEY, schedule_id UUID NOT NULL REFERENCES schedules(id),
  user_id UUID NOT NULL, starts_at TIMESTAMPTZ NOT NULL, ends_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX ON schedule_overrides (schedule_id, starts_at, ends_at);
```

**Column by column:**

- **`schedules.timezone` IANA string (`'Asia/Kolkata'`), offset (`'+05:30'`) nahi.** Ye is schema ka sabse important decision hai. Offset store karoge toh DST wale timezones (`America/New_York`) mein saal mein do baar tumhara handoff **ek ghanta galat** ho jaayega, aur wo raat ko silently galat banda page karega. IANA name "rules ka naam" hai, "current offset" nahi.
- **`schedule_layers` -- layers kyun, seedha "kaun on-call hai" column kyun nahi?** Kyunki asli teams aise kaam karti hain: Layer 1 = weekday business hours (4 log), Layer 2 = nights/weekends (2 senior log), Layer 3 = permanent fallback (team lead). Upar wali layer jeetti hai. Ek "current on-call" column rakhoge toh har handoff par kisi ko manually badalna padega -- aur wo Diwali ki raat ko bhoola jaayega.
- **`rotation_length_sec INT`, `rotation_type` alag kyun?** `rotation_type` **UI aur intent** ke liye hai ("weekly"), `rotation_length_sec` **math** ke liye (604800). Custom rotation (e.g. 12-hour shifts = 43200) ke liye seconds hi chahiye. Dono rakhna thoda redundant hai, par UI ko "weekly" dikhana aur code ko seconds dena dono easy ho jaata hai.
- **`handoff_at TIMESTAMPTZ` -- "rotation anchor"** -- ye ek fixed point hai jahan se ginti shuru hoti hai. Rotation index ka poora formula isi par khada hai: `floor((at - handoff_at) / rotation_length) % member_ids.length`. **UTC instant** store hota hai (`TIMESTAMPTZ` Postgres mein hamesha UTC mein store hota hai, sirf display par convert hota hai).
- **`member_ids UUID[]` -- array kyun, junction table kyun nahi?** Kyunki yahan **order hi meaning hai** (rotation ka kram), aur array order preserve karta hai. Junction table mein `position` column rakhna padta aur har read par `ORDER BY position` join. Array chhota hai (5-20 log), poora ek saath padha jaata hai, aur kabhi individually query nahi hota. **Ye us rare case mein se hai jahan array sahi choice hai.** (Trade-off: "Amit kis-kis schedule mein hai?" query ke liye `WHERE $1 = ANY(member_ids)` chahiye, jo GIN index ke bina slow hai.)
- **`restriction JSONB`** -- "sirf Mon-Fri 09:00-18:00". Ye shape har customer ka alag ho sakta hai aur ispar hum kabhi query nahi karte (sirf padhte hain aur code mein evaluate karte hain) -- **JSONB ka perfect use case**. Agar ispar `WHERE` lagana padta toh columns banate.
- **`schedule_overrides`** -- "Amit chhutti par hai, 20-25 Sept Ravi dekhega". Ye rotation ke **upar** lagta hai. Alag table isliye ki override ek **temporary exception** hai, rotation ka hissa nahi -- mix karoge toh rotation math mein ganda `if` aa jaayega.
- **`INDEX (schedule_id, starts_at, ends_at)`** -- hamari query hai `WHERE schedule_id = $1 AND starts_at <= $2 AND ends_at > $2`. Index pehle `schedule_id` par equality se range ko chhota karta hai, phir `starts_at` par range scan. Ek schedule ke overrides usually kuch sau hi hote hain, isliye ye kaafi hai. (Perfect solution ek **GiST index on `tstzrange`** hota -- `EXCLUDE USING gist` se overlapping overrides bhi rok sakte the. v2 ka improvement.)

### 9.4 Schema chunk 3 -- users, contact methods, notification rules

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY, account_id UUID NOT NULL, name TEXT, email TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC'
);
CREATE TABLE contact_methods (
  id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id),
  channel TEXT NOT NULL CHECK (channel IN ('push','sms','voice','email','slack')),
  address_enc BYTEA NOT NULL,              -- encrypted phone / email / device token
  verified BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE notification_rules (          -- per user: "0 min push, 1 min sms, 5 min voice"
  id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id),
  urgency TEXT NOT NULL CHECK (urgency IN ('high','low')),
  delay_min INT NOT NULL, contact_method_id UUID NOT NULL REFERENCES contact_methods(id)
);
```

- **`users.timezone`** -- `schedules.timezone` se alag hai. Schedule ka timezone rotation handoff ke liye, user ka timezone uske **quiet hours** aur UI ke liye ("raat 11 se subah 7 mere local time mein").
- **`contact_methods.address_enc BYTEA`** -- phone number aur email **encrypted at rest** (envelope encryption: KMS se ek data key, us data key se AES-GCM). `TEXT` nahi, `BYTEA` -- kyunki ciphertext binary hai.
  - **Kyun encrypt?** 500,000 responders ke phone numbers ek jagah = ek bahut attractive target. DB backup leak hua, ya koi analyst read replica par `SELECT *` chala gaya -- plaintext numbers nahi dikhne chahiye.
  - **Cost:** ispar `WHERE address = '+919876543210'` query **nahi** kar sakte (inbound SMS webhook ko ye chahiye!). Ilaaj: ek aur column `address_hash TEXT` = `hmac_sha256(address, pepper)` + uspar index -- ye **blind index** kehlata hai. Deterministic hai isliye lookup chalta hai, aur pepper ke bina reverse nahi hota.
  - **Logs mein hamesha masked:** `+91XXXXXX1234`.
- **`verified BOOLEAN`** -- unverified number par page bhejna do tarah se bura hai: (a) galat insaan ko raat 3 baje call, (b) attacker kisi ka number daalke usse harass kar sakta hai (SMS bombing via hamara system). **Verified nahi toh channel skip karo.**
- **`notification_rules` -- `delay_min` ka matlab:** incident assign hone ke kitne minute **baad** ye channel chalega. `0 -> push`, `1 -> sms`, `5 -> voice`. Ye ek **escalation within a person** hai: pehle sasta aur chup (push), phir SMS, phir wo cheez jo insaan ko neend se uthati hai (voice call).
  - **Cost angle:** push free hai, SMS $0.0075, voice $0.013/min. 7.5M notifications/day par ye order **$17K/day SMS + $5K/day voice** hai. Agar pehla hi channel voice hota toh bill 5x ho jaata. **Isliye channel order latency + cost dono ka trade-off hai, sirf UX ka nahi.**
- **`urgency` per rule** -- ek user ke do set of rules: `high` ke liye push+sms+voice, `low` ke liye sirf email. Yahi quiet hours ka asli implementation hai.

### 9.5 Schema chunk 4 -- incidents (dil)

```sql
CREATE TABLE incidents (
  id UUID PRIMARY KEY,
  service_id UUID NOT NULL REFERENCES services(id),
  dedup_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('triggered','acknowledged','resolved')),
  severity TEXT NOT NULL, summary TEXT NOT NULL, source TEXT NOT NULL,
  occurrence_count INT NOT NULL DEFAULT 1,
  escalation_level INT NOT NULL DEFAULT 1,
  escalation_round INT NOT NULL DEFAULT 0,
  acknowledged_by UUID NULL REFERENCES users(id),
  version INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ NULL
) PARTITION BY RANGE (created_at);            -- monthly partitions
CREATE UNIQUE INDEX incidents_open_dedup_uniq ON incidents (service_id, dedup_key) WHERE status <> 'resolved';
CREATE INDEX incidents_open_by_service ON incidents (service_id, created_at DESC) WHERE status <> 'resolved';
```

- **`occurrence_count`** -- "ye alert 63 baar aaya". Ye 95% dedup ratio ka **poora fayda** ek number mein rakh deta hai -- 63 timeline rows banaye bina.
- **`escalation_level` aur `escalation_round` alag kyun?** `level` = policy ki kaunsi kadi (1, 2, 3). `round` = poori chain kitni baar dohrai gayi. Ek column mein mila doge (level 4, 5, 6...) toh `repeat_count` ka logic aur UI dono gande ho jaayenge.
- **`acknowledged_by UUID NULL REFERENCES users(id)`** -- kisne uthaya. Nullable kyunki triggered incident ka koi ack karne wala nahi hota.
- **`version INT NOT NULL DEFAULT 0`** -- **optimistic lock.** Har state change ispar `version + 1` karta hai aur `WHERE version = $old` lagata hai. Ye do responders ke ek saath ack karne wali race ko bina kisi lock ke handle karta hai (code PART 11 mein).
- **`last_seen_at` vs `created_at`** -- `created_at` = problem pehli baar kab dikha, `last_seen_at` = aakhri baar kab. `now() - last_seen_at > 10 min` = shayad problem khud theek ho gayi (auto-resolve isi par chalta hai).
- **`CHECK (status IN (...))`** -- application mein bug ho toh bhi `status = 'akcnowledged'` (typo) DB reject karega. Aur ye poora dedup index isi column par khada hai.

**`PARTITION BY RANGE (created_at)` -- monthly partitions:**

```
incidents_2026_07   (1 Jul - 1 Aug)
incidents_2026_08   (1 Aug - 1 Sep)
incidents_2026_09   (1 Sep - 1 Oct)   <- saare naye inserts yahan
```

- **Numbers:** 2.5M incidents/day x ~2 KB = **5 GB/day**, 90-day hot retention = **~450 GB**. 90 din ek hi table mein rakhoge toh wo ~225M rows ki hogi -- index bade, `VACUUM` lamba, aur query planner ka kaam mushkil.
- **Retention ka asli fayda:** 90 din purana data hatana hai. Ek `DELETE FROM incidents WHERE created_at < ...` **225M rows** delete karega: ghanton chalega, WAL phaad dega, table bloat karega, aur live traffic ko block karega. `ALTER TABLE incidents DETACH PARTITION incidents_2026_06` = **milliseconds**, kyunki wo sirf ek catalog entry badal raha hai. Phir detached partition ko S3 par Parquet mein dump karke `DROP` kar do.
- **Partition pruning:** dashboard ki query `WHERE created_at > now() - interval '7 days'` par planner sirf 1-2 partitions padhta hai, 90 din ke saare nahi.
- **Gotcha:** partitioned table mein har unique index mein **partition key shaamil honi chahiye**. `UNIQUE (service_id, dedup_key)` mein `created_at` nahi hai! Iska matlab Postgres ise **global unique** nahi bana sakta -- wo per-partition unique banega. Practical asar: theoretically month boundary par (31 Aug 23:59:59 aur 1 Sep 00:00:00) same `(service_id, dedup_key)` ke do open incidents ban sakte hain. Is real trade-off ke teen ilaaj: (a) sweekar karo (mahine mein ek baar, ek extra incident -- "duplicate page is OK"), (b) `incidents` ko un-partitioned rakho aur ek alag `incidents_archive` table mein purana data move karo, (c) ek chhoti `open_incidents (service_id, dedup_key, incident_id)` un-partitioned table rakho jismein asli unique constraint ho. **Interview mein is gotcha ko khud uthana bahut strong signal hai.**

**Index 1 -- `incidents_open_dedup_uniq` (poora dedup isi par khada hai):**

```sql
CREATE UNIQUE INDEX incidents_open_dedup_uniq
  ON incidents (service_id, dedup_key) WHERE status <> 'resolved';
```

- **`WHERE status <> 'resolved'` (partial) kyun?** Kyunki uniqueness hum **sirf khule incidents** par chahte hain. Ek service ka `cpu-high-web-3` pichhle 6 mahine mein 400 baar hua hoga -- wo saare `resolved` rows table mein hain. Full unique index unhe bhi duplicate maanke naya incident banne hi nahi deta. Partial index se: resolved rows index se **bahar** ho jaati hain, wahi key dobara use ho sakti hai.
- **Size ka fayda:** index mein sirf **open** incidents hain -- typical ~3,500, storm mein ~50,000. Yaani **450 GB table par ek few-MB ka index**. Wo poora RAM mein rehta hai, lookup ~microseconds.
- **Ye index hata dein toh?** `ON CONFLICT (service_id, dedup_key)` ka koi arbiter hi nahi milega -- query **error** degi. Aur agar hum `ON CONFLICT` hi hata dein aur code mein `SELECT` phir `INSERT` karein, toh do consumers same millisecond mein do incidents bana denge (race). Result: **Amit ko do SMS, do timers, do escalation chains.**

**Index 2 -- `incidents_open_by_service`:**

```sql
CREATE INDEX incidents_open_by_service ON incidents (service_id, created_at DESC) WHERE status <> 'resolved';
```

Dashboard ki main query:

```sql
SELECT id, dedup_key, status, severity, summary, occurrence_count, created_at
  FROM incidents
 WHERE service_id = $1 AND status <> 'resolved'
   AND (created_at, id) < ($2, $3)         -- keyset cursor
 ORDER BY created_at DESC, id DESC
 LIMIT 50;
```

**`EXPLAIN`-style reasoning (index ke saath):**

```
Limit (rows=50)
  -> Index Scan Backward using incidents_open_by_service on incidents_2026_09
       Index Cond: (service_id = $1) AND (created_at < $2)
       Filter: (status <> 'resolved')   <- partial index ne pehle hi saaf kar diya
     rows read from heap: ~50
```

- `service_id` equality index ke pehle column par hai -> seedha uss service ke block par jump.
- `created_at DESC` index ke order se **exactly match** karta hai -> koi `Sort` node nahi. Yahi `DESC` likhne ka poora point hai.
- `LIMIT 50` -> planner 50 rows milte hi ruk jaata hai. **Pura 450 GB kabhi chhua hi nahi.**
- Partial `WHERE` ki wajah se index mein resolved rows hain hi nahi -> kam I/O.

**Index ke bina kya hota?**

```
Limit (rows=50)
  -> Sort  (Sort Key: created_at DESC, id DESC)   <- disk par spill
       -> Append (90 partitions ka Seq Scan)
            Filter: (service_id = $1) AND (status <> 'resolved')
          rows scanned: ~225,000,000
```

Yaani 450 GB disk se padho, 225M rows filter karo, lakhon match karo, unhe **sort** karo (memory se bada -> disk spill), aur phir upar se 50 lo. Ye query **minutes** legi aur poore DB ka I/O kha jaayegi. 50 rows ke liye. Dashboard har 10 second refresh hota hai. **Isse ek dashboard poore production DB ko gira sakta hai.**

> **Rule of thumb:** "Index tab banao jab ek query **bahut saare rows mein se thode rows** **bahut baar** dhoondhti ho." Yahan dono sach hain: 225M mein se 50, har 10 second, har on-call user ke liye.

### 9.6 Deep dive: `ON CONFLICT ... RETURNING (xmax = 0) AS inserted`

Ye is poore system ka **sabse chalaak ek line** hai. Isko theek se samajh lo.

**Problem:** Upsert chal gaya. Ab hum kaise jaanein ki row **naya insert** hua (-> page karo) ya **existing update** hua (-> chup raho)?

```sql
INSERT INTO incidents (id, service_id, dedup_key, status, severity, summary, source)
VALUES ($1, $2, $3, 'triggered', $4, $5, $6)
ON CONFLICT (service_id, dedup_key) WHERE status <> 'resolved'
DO UPDATE SET occurrence_count = incidents.occurrence_count + 1,
              last_seen_at = now()
RETURNING id, status, version, escalation_level, (xmax = 0) AS inserted;
```

**`xmax` kya hai?** Postgres MVCC (multi-version concurrency control) mein har row ke do chhupe system columns hote hain:

- **`xmin`** = kis transaction ne is row version ko **banaya**.
- **`xmax`** = kis transaction ne is row version ko **delete/update** kiya (abhi zinda row ke liye `0`).

Upsert mein:

| Kya hua | `xmax` ki value | `(xmax = 0)` |
|---|---|---|
| **INSERT chala** (naya incident) | `0` -- ye ek bilkul naya row version hai, kisi ne ise abhi tak touch nahi kiya | **`true`** |
| **DO UPDATE chala** (dedup hit) | hamare current transaction ka id (non-zero) -- kyunki update = purani row version ko "mark deleted" + nayi banana | **`false`** |

Yaani `(xmax = 0)` ek **bilkul free** signal hai jo Postgres waise bhi row par rakhta hai. Koi extra column nahi, koi extra query nahi, koi race nahi.

**Iske bina log kya karte hain (aur kyun har tareeka toota hua hai):**

```ts
// GALAT #1 -- SELECT phir INSERT
const found = await db.query('SELECT id FROM incidents WHERE service_id=$1 AND dedup_key=$2 AND status<>$3', ...);
if (found.rowCount === 0) {
  await db.query('INSERT INTO incidents ...');   // <- do consumers yahan ek saath aa sakte hain
  await page();
}
```

**Race:** consumer A aur consumer B dono ka `SELECT` khaali aaya (same millisecond). Dono `INSERT` karenge. Ek ko unique violation milega (**agar index hai**) -- lekin agar index nahi hai toh **do incidents, do pages, do escalation chains**. Aur ek extra DB round trip bhi laga.

```ts
// GALAT #2 -- try INSERT, catch unique violation
try {
  await db.query('INSERT INTO incidents ...');
  await page();
} catch (e) {
  if (e.code === '23505') await db.query('UPDATE incidents SET occurrence_count = ...');
}
```

Ye **correct** hai (race-free, kyunki index constraint enforce kar raha hai), lekin: (a) 95% requests **exception path** se jaati hain -- exceptions normal flow nahi hone chahiye; (b) Postgres mein failed INSERT transaction ko **abort** kar deta hai, toh savepoint lagana padta hai (ya har baar naya transaction), jo dheema hai; (c) do round trips.

```ts
// GALAT #3 -- occurrence_count se andaza lagana
// "agar RETURNING occurrence_count === 1 toh naya hoga"
```
Ye **lagbhag** kaam karta hai, lekin todna aasaan hai: koi manual `UPDATE` ne count reset kar diya, ya default badal gaya, ya ek incident resolve hoke wahi row... Signal indirect hai. `xmax` seedha Postgres ke engine se aata hai.

```ts
// SAHI -- ek statement, atomic, ek round trip
const { rows } = await db.query(UPSERT_SQL, params);
if (rows[0].inserted) { /* naya incident -> route + page + timer */ }
else { /* dedup hit -> bas counter badha, chup raho */ }
```

- **Ek statement = ek atomic operation.** Postgres andar row-level lock leta hai; do consumers ek saath aaye toh ek insert karega, doosra **update** dekhega (`inserted = false`). **Koi race nahi.**
- **Ek round trip** -- 29/sec (peak 300) par ye latency budget mein dikhta hai.
- **Idempotent** -- Kafka ne message dobara diya? Dobara upsert, `inserted = false`, koi duplicate page nahi.

> **Caveat (honest rakho):** `xmax` ek **internal system column** hai, Postgres ka documented public API nahi. Practice mein ye pattern widely use hota hai aur versions ke beech stable raha hai, lekin technically ye implementation detail par bharosa kar raha hai. Ek portable alternative hai `MERGE ... RETURNING merge_action()` (Postgres 17+). Interview mein dono jaanna achha lagta hai.

### 9.7 Schema chunk 5 -- timeline, notifications, timers, idempotency

```sql
CREATE TABLE incident_events (              -- immutable timeline / audit
  id BIGSERIAL, incident_id UUID NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now(),
  type TEXT NOT NULL,                       -- 'triggered','notified','escalated','acknowledged','resolved','note'
  actor TEXT, detail JSONB
);
CREATE INDEX ON incident_events (incident_id, at);

CREATE TABLE notifications (
  id UUID PRIMARY KEY, task_id TEXT NOT NULL, incident_id UUID NOT NULL, user_id UUID NOT NULL,
  channel TEXT NOT NULL, contact_method_id UUID NOT NULL,
  status TEXT NOT NULL, escalation_level INT NOT NULL,
  provider TEXT, provider_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), delivered_at TIMESTAMPTZ NULL
);
CREATE INDEX ON notifications (incident_id);
CREATE UNIQUE INDEX notifications_task_uniq ON notifications (task_id);  -- at-least-once dedup

CREATE TABLE notification_attempts (
  id BIGSERIAL, notification_id UUID NOT NULL, attempt INT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now(), result TEXT NOT NULL, error TEXT, latency_ms INT
);

CREATE TABLE escalation_timers (            -- durable copy of the Redis ZSET
  id UUID PRIMARY KEY, incident_id UUID NOT NULL, level INT NOT NULL,
  due_at TIMESTAMPTZ NOT NULL, state TEXT NOT NULL DEFAULT 'pending'  -- pending|fired|cancelled
);
CREATE INDEX escalation_timers_due ON escalation_timers (due_at) WHERE state = 'pending';

CREATE TABLE idempotency_keys (
  account_id UUID NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL,
  response_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, key)
);
```

- **`incident_events` -- `BIGSERIAL` id, UUID kyun nahi?** Ye ek append-only log hai jo **hamesha `incident_id` se** padha jaata hai, kabhi id se nahi. `BIGSERIAL` sequential hai -> B-tree ke right edge par insert -> kam page splits, kam WAL. UUID v4 random hota hai -> har insert index ke random page par -> write amplification. (UUID v7 hota toh sequential bhi hota aur UUID bhi.)
- **`incident_events` mein koi PK kyun nahi?** Spec mein `BIGSERIAL` hai lekin `PRIMARY KEY` nahi -- ye jaan-boojh kar ho sakta hai (pure append log, replication ke liye `REPLICA IDENTITY FULL` chahiye hoga). Production mein main `PRIMARY KEY (id)` lagane ki salah dunga; cost ~zero hai aur logical replication aasaan ho jaata hai.
- **`INDEX (incident_id, at)`** -- incident detail page ki query: `WHERE incident_id = $1 ORDER BY at`. Composite index mein `incident_id` equality + `at` order -> index scan, **koi sort nahi**.
- **`detail JSONB`** -- har timeline type ka detail alag shape ka hai (`escalated` mein `{from: 1, to: 2}`, `notified` mein `{channel, provider, address_masked}`). Ispar query nahi karte, sirf UI par dikhate hain -> JSONB perfect.
- **`notifications.task_id TEXT` + `notifications_task_uniq`** -- **ye at-least-once ka bachav hai.** Kafka ne task dobara deliver kiya? `INSERT ... ON CONFLICT (task_id) DO NOTHING` -> 0 rows -> worker samajh jaata hai "ye pehle ho chuka hai" -> **doosra SMS nahi jaata.** Ye unique index hi hamare "duplicate mostly nahi hoga" wale claim ka poora aadhaar hai.
- **`notifications.provider_message_id`** -- Twilio ka `SM...` id. Status webhook isi se row dhoondhta hai, isliye production mein ispar bhi index chahiye (`CREATE INDEX ON notifications (provider_message_id)`) -- 7.5M rows/day par iske bina webhook handler seq scan karega.
- **`notification_attempts` alag table kyun, `notifications` mein `attempt_count` kyun nahi?** Kyunki har attempt ka apna **result, error, latency** hai. "SMS 3 baar fail hua: pehli baar timeout 10s, doosri 429, teesri 21610 unsubscribed" -- ye debugging gold hai. Ek counter se ye kahani nahi banti. Volume: ~4 GB/day, **30-day retention**.
- **`escalation_timers_due` partial index** -- `WHERE state = 'pending'`. Recovery job ki query `WHERE state='pending' AND due_at < now() + interval '5 minutes'` isi par chalti hai. Partial isliye ki 99.9% timers `fired`/`cancelled` ho chuke hain aur unhe index mein rakhna bekaar hai. Index size = sirf pending timers (~3,500 typical, 50,000 storm mein).
- **`idempotency_keys` PK `(account_id, key)`** -- `account_id` pehle kyun? Kyunki key client generate karta hai; do alag customers same UUID bhej dein (ya jaan-boojh kar bhejein) toh unke requests **mix nahi hone chahiye**. Account-scoping ek tenant isolation boundary hai.

**Retention summary:**

| Table | Volume | Hot retention | Uske baad |
|---|---|---|---|
| Kafka `incident-events` | 50 GB/day | 7 days (350 GB, x3 replication = ~1 TB) | Broker khud purge karta hai; parallel S3 archive consumer |
| `incidents` | 5 GB/day | 90 days (~450 GB) | Monthly partition DETACH -> S3 Parquet -> DROP |
| `incident_events` | ~incidents ke saath | 90 days | Same partition strategy |
| `notifications` + `notification_attempts` | ~4 GB/day | 30 days (~120 GB) | Partition drop |
| `idempotency_keys` | chhota | 24 hours | Batched delete / partition drop |

---

## PART 10 -- LLD: Node.js project structure

```
paging-system/
+-- src/
|   +-- routes/
|   |   +-- events.routes.ts          # POST /v2/enqueue
|   |   +-- incidents.routes.ts       # /api/v1/incidents/*
|   |   +-- webhooks.routes.ts        # /webhooks/twilio/*
|   +-- controllers/
|   |   +-- events.controller.ts
|   |   +-- incidents.controller.ts
|   |   +-- provider-webhook.controller.ts
|   +-- services/
|   |   +-- incident.service.ts       # dedup + state machine (dil)
|   |   +-- routing.service.ts        # policy -> level -> target
|   |   +-- oncall.service.ts         # rotation math + overrides
|   |   +-- notification.service.ts   # rules, quiet hours, task banana
|   |   +-- escalation.service.ts     # timer fire -> next level
|   |   +-- grouping.service.ts       # storm control counters
|   +-- repositories/
|   |   +-- incident.repository.ts    service.repository.ts   policy.repository.ts
|   |   +-- schedule.repository.ts    notification.repository.ts   timer.repository.ts
|   +-- providers/
|   |   +-- provider.interface.ts     # NotificationProvider
|   |   +-- twilio-sms.provider.ts    twilio-voice.provider.ts
|   |   +-- fcm.provider.ts           sendgrid.provider.ts   slack.provider.ts
|   |   +-- provider-registry.ts      # channel -> provider (+ failover)
|   +-- workers/
|   |   +-- incident.consumer.ts      # incident-events topic
|   |   +-- notification.worker.ts    # notifications topic
|   |   +-- scheduler.ts              # Redis ZSET tick
|   |   +-- dlq.worker.ts             # notifications-dlq
|   +-- middleware/
|   |   +-- auth.ts  rate-limit.ts  idempotency.ts  validate.ts
|   +-- infra/
|   |   +-- kafka.ts  redis.ts  postgres.ts  logger.ts  metrics.ts  tracing.ts
|   +-- utils/
|   |   +-- dedup-key.ts  backoff.ts  circuit-breaker.ts  time.ts
|   +-- app.ts        # composition root: sab objects yahan jodte hain
|   +-- server.ts     # HTTP listen + graceful shutdown
+-- migrations/
+-- tests/
```

**Har folder ka kaam (aur kya yahan NAHI hona chahiye):**

| Folder | Kaam | Yahan NAHI |
|---|---|---|
| `routes/` | URL -> controller ki wiring, middleware chain ka order | Business logic, SQL |
| `controllers/` | HTTP ki duniya: `req` se data nikalo, validate karo, service bulao, status code + JSON banao | SQL, Kafka, Redis, business rules |
| `services/` | **Sara business logic**: dedup decision, routing, rotation math, retry policy. Yahi "system" hai | `req`/`res`, raw SQL strings, provider SDK calls |
| `repositories/` | **Sirf SQL.** Ek method = ek query (ya ek transaction). `snake_case` -> `camelCase` mapping bhi yahin | Business decisions (`if (inserted) page()` yahan nahi) |
| `providers/` | Bahar ke systems se baat: Twilio, FCM, SendGrid. Sab ek hi **interface** implement karte hain | DB, business logic, retry policy (wo worker ka kaam) |
| `workers/` | Alag **entrypoints** (alag processes/pods). Kafka se consume karo -> wahi services bulao | Duplicate business logic |
| `middleware/` | Cross-cutting: auth, rate limit, idempotency, validation | Domain logic |
| `infra/` | Connections aur singletons: Kafka client, Redis, `pg.Pool`, logger, metrics | Koi bhi business logic |
| `utils/` | Chhote **pure functions**: dedup key hash, backoff math, circuit breaker | State, I/O |

**Layering rule (ek line mein):**

```
controller  ->  service  ->  repository  ->  Postgres
                   |
                   +------->  provider (interface)  ->  Twilio / FCM / SendGrid
                   |
                   +------->  infra (kafka, redis)

Ulta kabhi nahi: repository service ko nahi bulata, service controller ko nahi jaanta.
```

**Workers HTTP server ke saath kyun nahi?**

```
Process 1: server.ts            -> Express (ingest + dashboard + webhooks)
Process 2: incident.consumer.ts -> Kafka incident-events
Process 3: notification.worker.ts -> Kafka notifications
Process 4: scheduler.ts         -> Redis ZSET tick (2+ instances, HA)
Process 5: dlq.worker.ts
```

**Alag entrypoints, ek hi codebase (modular monolith).** Kyun?

- **Alag scaling:** storm mein notification workers ko 5 se 40 karna hai; ingest ko sirf 2x. Ek hi process hota toh dono ek saath scale karne padte.
- **Alag failure domain:** ek worker memory leak se crash ho jaaye toh ingest API zinda rahe. Ingest ka 99.99% target isi par depend karta hai.
- **Event loop protection:** Node **single-threaded** hai. Agar notification worker ka JSON parsing + crypto usi process mein chale jisme HTTP server hai, toh wo HTTP latency ko seedha kha jaayega.
- **Lekin ek hi codebase** -- `incident.service.ts` HTTP path aur worker path dono use karte hain. **Zero duplicate business logic.** Microservices mein isi service ko do baar likhna padta ya ek internal RPC banana padta.

**Composition root (`app.ts`) ka idea:**

```ts
// app.ts -- yahan aur SIRF yahan "kaun sa concrete class" decide hota hai
const db = new Pool({ connectionString: config.databaseUrl, max: 20 });
const redis = new Redis(config.redisUrl, { enableOfflineQueue: false, commandTimeout: 50 });
const kafka = buildKafka(config);

const incidentRepo = new IncidentRepository(db);
const timerRepo    = new TimerRepository(db);
const oncall       = new OnCallService(new ScheduleRepository(db));
const routing      = new RoutingService(new PolicyRepository(db), oncall);

const registry = new ProviderRegistry({
  sms:   [new TwilioSmsProvider(twilioClient), new MessageBirdSmsProvider(mbClient)],  // failover order
  voice: [new TwilioVoiceProvider(twilioClient)],
  push:  [new FcmProvider(fcmClient)],
  email: [new SendGridProvider(sgClient)],
  slack: [new SlackProvider(slackClient)],
});

const incidentService = new IncidentService(db, incidentRepo, timerRepo, routing, redis, producer);
```

**Code Explanation:**

- **Har class apni dependencies constructor se leti hai** (dependency injection). Koi class andar `new Pool()` ya `new Redis()` nahi karti. Isse test mein fake dependency dena trivial ho jaata hai: `new IncidentService(fakeDb, fakeRepo, ...)`.
- **`app.ts` hi ek jagah hai jahan "Twilio" naam likha hai** (registry banate waqt). Baaki poore codebase ko sirf `NotificationProvider` interface pata hai.
- `registry` mein har channel ke liye **array** hai -- pehla primary, doosra failover. Circuit breaker khulne par worker `providers[1]` uthata hai (Part 3/4).
- `commandTimeout: 50` -- yahan Rate Limiter ke 20 ms se dheela hai, kyunki ye path har HTTP request par nahi chalta.

**`NotificationProvider` interface itna important kyun hai?**

```ts
interface NotificationProvider {
  name: string; channel: Channel;
  send(task: NotificationTask, address: string, incident: Incident): Promise<ProviderResult>;
}
```

- **Business logic provider ko jaanta hi nahi.** `notification.worker.ts` bolta hai "`registry.get('sms')` se jo mila, uspar `send()` chala do". Usko Twilio ka SDK, uske error codes, uske auth headers -- kuch nahi pata.
- **Twilio ka outage?** `app.ts` mein array ka order badal do ya env flag se MessageBird ko pehle kar do. **Business logic ki ek line nahi badalti.** Ye ek raat 3 baje wala change hai -- wo jitna chhota ho, utna achha.
- **Test:** `FakeSmsProvider` jo hamesha `{ status: 'failed', permanent: false }` deta hai -> poora retry + DLQ path bina kisi network call ke test ho gaya.
- **Naya channel (WhatsApp) jodna?** Ek nayi file `whatsapp.provider.ts`, registry mein ek entry. Worker, service, DB -- kuch nahi badla.
- **`ProviderResult` mein `permanent?: boolean`** -- ye interface ka sabse soch-samajh kar rakha gaya field hai. Har provider ke error codes alag hain (Twilio `21610`, FCM `UNREGISTERED`). Us gandagi ko **provider adapter ke andar** rakha, aur bahar sirf ek boolean nikala: "retry karne ka fayda hai ya nahi". Worker ka retry logic isi se simple rehta hai.

---

## PART 11 + 12 -- Node.js / TypeScript Code (line-by-line explanation ke saath)

Stack: **Express 5**, **kafkajs**, **pg**, **ioredis**, **zod**, **luxon** (timezones), **pino**, **prom-client**.

Order: pehle ingest (bahar se andar), phir infra, phir dil (incident service + repository), phir on-call math, phir delivery, phir ack.

### 1. `controllers/events.controller.ts` -- ingest ka poora sync path

```ts
import type { Request, Response } from 'express';
import { z } from 'zod';
import { randomUUID, createHash } from 'node:crypto';
import type { ServiceRepository } from '../repositories/service.repository';
import type { RateLimiterService } from '../services/rate-limiter.service';
import type { IdempotencyStore } from '../middleware/idempotency';
import type { EventProducer } from '../infra/kafka';
import { eventsIngested } from '../infra/metrics';

const eventSchema = z.object({
  routingKey: z.string().regex(/^[A-Za-z0-9]{20,64}$/),
  eventAction: z.enum(['trigger', 'acknowledge', 'resolve']),
  dedupKey: z.string().min(1).max(255).optional(),
  payload: z.object({
    summary: z.string().min(1).max(1024),
    source: z.string().min(1).max(255),
    severity: z.enum(['critical', 'error', 'warning', 'info']),
    customDetails: z.record(z.unknown()).optional(),
  }),
});

export class EventsController {
  constructor(
    private readonly services: ServiceRepository,
    private readonly limiter: RateLimiterService,
    private readonly idempotency: IdempotencyStore,
    private readonly producer: EventProducer,
  ) {}

  enqueue = async (req: Request, res: Response): Promise<void> => {
    const parsed = eventSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: parsed.error.issues[0].message });
      return;
    }
    const body = parsed.data;

    const service = await this.services.findByRoutingKey(body.routingKey);
    if (!service) {
      res.status(401).json({ error: 'INVALID_ROUTING_KEY', message: 'Routing key not found' });
      return;
    }

    const decision = await this.limiter.check(`rl:events:${body.routingKey}`, service.eventsPerSec);
    if (!decision.allowed) {
      res.set('Retry-After', String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))));
      res.status(429).json({ error: 'RATE_LIMITED', retryAfterSec: Math.ceil(decision.retryAfterMs / 1000) });
      return;
    }

    const dedupKey = body.dedupKey
      ?? createHash('sha256').update(`${body.payload.summary}|${body.payload.source}`).digest('hex').slice(0, 32);

    const idemKey = req.header('Idempotency-Key');
    if (idemKey) {
      const replay = await this.idempotency.check(service.accountId, idemKey, req.body);
      if (replay.kind === 'conflict') {
        res.status(409).json({ error: 'IDEMPOTENCY_KEY_REUSED', message: 'Key used with a different body' });
        return;
      }
      if (replay.kind === 'replay') {
        res.set('Idempotent-Replay', 'true').status(202).json(replay.response);
        return;
      }
    }

    const event = {
      ...body,
      dedupKey,
      serviceId: service.id,
      accountId: service.accountId,
      eventId: randomUUID(),
      receivedAt: new Date().toISOString(),
    };

    try {
      await this.producer.send('incident-events', service.id, event);
    } catch (err) {
      req.log.error({ err, serviceId: service.id }, 'ingest produce failed');
      res.set('Retry-After', '5');
      res.status(503).json({ error: 'INGEST_UNAVAILABLE', message: 'Retry shortly' });
      return;
    }

    const response = { status: 'accepted', dedupKey };
    if (idemKey) await this.idempotency.save(service.accountId, idemKey, req.body, response);

    eventsIngested.inc({ action: body.eventAction });
    res.status(202).json(response);
  };
}
```

**Code Explanation:**

- `const eventSchema = z.object({...})` -- schema **module level** par banaya, handler ke andar nahi. zod schema banana sasta nahi hai; 6,000 eps par har request mein banaoge toh GC par bewajah pressure.
- `routingKey: z.string().regex(/^[A-Za-z0-9]{20,64}$/)` -- ye string Redis key aur metrics label dono mein jaati hai. `:` allow karoge toh attacker `rl:events:abc:def` bana ke doosri bucket mein ghus sakta hai. Length cap = 1 MB key nahi.
- `dedupKey: ...max(255).optional()` -- ye Postgres unique index mein jaata hai. Bada key = fat index = slow lookups. Optional isliye ki hum khud generate kar lenge.
- `customDetails: z.record(z.unknown())` -- "koi bhi object". Hum ismein jhaankte nahi, sirf aage bhej dete hain. Size cap `express.json({ limit: '64kb' })` se aata hai, schema se nahi.
- `constructor(services, limiter, idempotency, producer)` -- chaaron dependencies bahar se. Controller ke andar ek bhi `new` nahi -- yahi testability ka poora raaz hai.
- `enqueue = async (req, res)` -- **arrow function property**, method nahi. Kyun? Taaki `router.post('/v2/enqueue', controller.enqueue)` likhne par `this` na khoye. Method hota toh `.bind(controller)` karna padta.
- `safeParse` (not `parse`) -- `parse` exception throw karta hai; 6,000 eps par exception ek **mehnga** raasta hai (stack capture). `safeParse` ek object deta hai.
- `parsed.error.issues[0].message` -- **sirf pehla** issue. Poora zod error dump karoge toh internal field structure leak hoga aur response bada ho jaayega.
- `await this.services.findByRoutingKey(...)` -- repository ke andar Redis `svc:<routingKey>` (TTL 300 s) hai, miss par Postgres. **Controller ko ye pata nahi** -- usko sirf "service mila ya nahi" chahiye.
- `res.status(401).json({ error: 'INVALID_ROUTING_KEY', message: 'Routing key not found' })` -- message jaan-boojh kar bland. Ye endpoint unauthenticated hai; detailed message se attacker keys ki validity aur accounts enumerate karega.
- `this.limiter.check(\`rl:events:${routingKey}\`, service.eventsPerSec)` -- **per routing key** bucket, per account nahi aur per IP toh bilkul nahi. Ek service ka buggy script sirf **apni** service ko throttle kare. Rate Limiter lesson ka wahi Lua script, key format wahi.
- `Math.max(1, Math.ceil(retryAfterMs / 1000))` -- `Retry-After` kabhi `0` nahi jaana chahiye, warna client turant wapas aake dobara 429 khaayega.
- `createHash('sha256').update(\`${summary}|${source}\`)` -- `dedupKey` fallback. `|` separator isliye ki `("ab", "c")` aur `("a", "bc")` alag hash dein. `.slice(0, 32)` -- 32 hex chars (128 bits) collision ke liye kaafi hai aur index chhota rehta hai.
  > **Gotcha:** agar `summary` mein timestamp ya changing number ho (`"CPU at 96.4%"`) toh har event ka hash alag hoga -> **har 30 second naya incident**. Isliye docs mein `dedupKey` explicitly bhejne ko strongly recommend karna chahiye, aur `summary` se number strip karne wali normalization consider karni chahiye.
- `const idemKey = req.header('Idempotency-Key')` -- optional. 99% clients nahi bhejte; unke liye ek bhi extra DB call nahi hoti.
- `replay.kind === 'conflict'` -> `409` -- same key, alag body = client ka bug. **Loudly fail** karo, warna doosra alert chup-chaap nigal jaayega.
- `replay.kind === 'replay'` -> stored response + `Idempotent-Replay: true` -- **Kafka par dobara nahi bhejte.** Yahi idempotency ka poora point hai.
- `eventId: randomUUID()` -- **server** stamp karta hai, client nahi. Ye tracing (OpenTelemetry) aur duplicate debugging ke liye hai; client par chhodenge toh wo sabko `"1"` bhej dega.
- `receivedAt: new Date().toISOString()` -- yahan se `page_latency_seconds` ka clock shuru hota hai. Client ka `timestamp` bharosemand nahi (uski clock 3 ghante peeche ho sakti hai).
- `this.producer.send('incident-events', service.id, event)` -- **key = `service.id`**, `routingKey` nahi. Kyun? Key secret hai (Kafka logs/metrics mein nahi jaani chahiye) aur `serviceId` hi wo cheez hai jiske liye hum **ordering** chahte hain (ek service ke `trigger` aur `resolve` ek hi partition, sahi order mein).
- `catch (err) { ... 503 INGEST_UNAVAILABLE }` -- **fail closed.** Kafka nahi le paaya toh hum `202` ka jhooth nahi bolenge. (Production mein yahan pehle local disk spool try hota hai, tab jaake 503.)
- `if (idemKey) await this.idempotency.save(...)` -- response store **Kafka success ke baad**. Pehle store karte aur Kafka fail hota, toh retry ko cached `202` mil jaata aur event kabhi process hi nahi hota -- **silent page loss**.
- `res.status(202)` -- `201` nahi (kuch create nahi hua), `200` nahi (kuch complete nahi hua). "Maine likh liya, ab nibhaunga."

### 2. `infra/kafka.ts` -- producer aur consumer config (har option ka WHY)

```ts
import { Kafka, Partitioners, CompressionTypes, logLevel } from 'kafkajs';
import type { Consumer, Producer } from 'kafkajs';
import { config } from '../config';

export const kafka = new Kafka({
  clientId: 'paging-system',
  brokers: config.kafkaBrokers,
  ssl: true,
  sasl: { mechanism: 'scram-sha-512', username: config.kafkaUser, password: config.kafkaPass },
  connectionTimeout: 3_000,
  requestTimeout: 30_000,
  retry: { initialRetryTime: 100, retries: 8 },
  logLevel: logLevel.WARN,
});

export async function buildProducer(): Promise<Producer> {
  const producer = kafka.producer({
    createPartitioner: Partitioners.DefaultPartitioner,
    idempotent: true,
    maxInFlightRequests: 5,
    allowAutoTopicCreation: false,
    transactionTimeout: 30_000,
  });
  await producer.connect();
  return producer;
}

export class EventProducer {
  constructor(private readonly producer: Producer) {}

  async send(topic: string, key: string, value: unknown): Promise<void> {
    await this.producer.send({
      topic,
      acks: -1,                                  // -1 = 'all'
      timeout: 10_000,
      compression: CompressionTypes.Gzip,
      messages: [{ key, value: JSON.stringify(value), headers: { v: '1' } }],
    });
  }
}

export async function buildConsumer(groupId: string, topic: string): Promise<Consumer> {
  const consumer = kafka.consumer({
    groupId,
    sessionTimeout: 30_000,
    heartbeatInterval: 3_000,
    maxBytesPerPartition: 1_048_576,
    maxWaitTimeInMs: 100,
  });
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: false });
  return consumer;
}
```

**Code Explanation -- producer:**

- `ssl: true` + `sasl: scram-sha-512` -- Kafka traffic mein customer ke alerts hain (hostnames, error messages, kabhi-kabhi PII). Plaintext inter-service traffic 2026 mein acceptable nahi.
- `connectionTimeout: 3_000` -- broker se connect 3 s mein nahi hua toh agla broker try karo. Ingest ko latkaana nahi hai.
- `retry: { initialRetryTime: 100, retries: 8 }` -- kafkajs ka **internal** retry (exponential). Transient leader election (~few seconds) isse chhup jaata hai aur ingest ko 503 nahi bhejna padta.
- `idempotent: true` -- **ye ek line duplicate events ko rokti hai.** Producer har message ko ek sequence number deta hai; network timeout par producer retry karta hai, aur broker sequence dekh kar **duplicate likhta nahi**. Iske bina: hamne bheja -> broker ne likha -> ack network mein kho gaya -> producer retry -> **do copies** -> do incidents (ya kam se kam do dedup hits).
- `maxInFlightRequests: 5` -- idempotent producer ke saath 5 tak parallel requests safe hain (broker sequence se order maintain karta hai). Bina idempotence ke `> 1` rakhna **ordering tod deta** hai (message 2 pehle likh jaata, message 1 retry par baad mein).
- `allowAutoTopicCreation: false` -- ek typo (`'incident-event'`) se ek naya topic **default 1 partition** ke saath ban jaayega, events silently usmein jaayenge, aur koi consumer unhe padhega hi nahi. **Pages gayab, error zero.** Isliye topics infra-as-code se banao.
- `acks: -1` (= `'all'`) -- **hamari durability ki jaan.** Leader tab tak `ack` nahi karta jab tak saare in-sync replicas (min.insync.replicas = 2 of 3) ne message le na liya. `acks: 1` (sirf leader) rakhte toh leader crash hone par wo event gayab -- aur hum `202` bol chuke hote. `acks: 0` toh criminal hai.
  > **Cost:** `acks: all` latency ~5 ms se ~15-25 ms kar deta hai. Ye hamare 5 s budget ka 0.5% hai. **Ek page ki keemat se sasta.**
- `timeout: 10_000` -- broker ko ack ke liye 10 s. Iske baad error -> 503 path.
- `compression: Gzip` -- `customDetails` mein JSON hota hai jo bahut compress hota hai. 50 GB/day network aur disk par ~5-10x bachat. CPU thoda lagta hai, par ingest CPU-bound nahi hai. (Snappy/lz4 faster hain par ratio kam -- 7-day retention ke liye Gzip theek hai.)
- `key` -- `serviceId`. kafkajs `murmur2(key) % partitions` se partition chunta hai -> ek service hamesha ek hi partition -> **per-service ordering**.
- `headers: { v: '1' }` -- schema version. Kal event shape badle toh consumer purane aur naye dono handle kar sake (rolling deploy ke doran dono chal rahe honge).

**Code Explanation -- consumer:**

- `groupId` -- `incident-service` / `notification-workers` / `escalation-consumer`. **Alag groups matlab har group ko poori stream milti hai.** Yahi Kafka ka RabbitMQ par bada fayda hai: kal analytics team ek naya group bana ke same events padh sakti hai, hamare consumers par zero asar.
- `sessionTimeout: 30_000` + `heartbeatInterval: 3_000` -- consumer har 3 s heartbeat bhejta hai; 30 s tak na bheje toh group use **dead** maan ke uski partitions kisi aur ko de deta hai (rebalance). Ratio ~1:10 standard hai. Session timeout bahut chhota rakhoge toh ek GC pause par bewajah rebalance (aur rebalance ke doran consumption **rukti** hai).
- `maxBytesPerPartition: 1 MB` -- ek fetch mein kitna. Bada rakhoge toh ek batch process karne mein `sessionTimeout` se zyada lag sakta hai -> consumer kick out -> rebalance loop (ye ek classic production bug hai).
- `maxWaitTimeInMs: 100` -- broker 100 ms tak data ikattha karega. Ye latency vs throughput ka knob hai: 100 ms hamare 5 s budget mein aaram se fit hai aur broker par fetch requests kam rakhta hai.
- `fromBeginning: false` -- naya consumer group aaj se padhe, 7 din purane events dobara nahi. Replay **jaan-boojh kar** karna hai (alag group id ya offset reset se), galti se nahi.

**`autoCommit` kahan hai?** `consumer.run()` mein, aur yahi sabse important line hai:

```ts
await consumer.run({
  autoCommit: false,                      // hum khud commit karenge
  partitionsConsumedConcurrently: 4,
  eachMessage: async ({ topic, partition, message, heartbeat }) => {
    await handle(JSON.parse(message.value!.toString()));   // pehle kaam
    await consumer.commitOffsets([                          // phir commit
      { topic, partition, offset: (Number(message.offset) + 1).toString() },
    ]);
    await heartbeat();
  },
});
```

**Code Explanation:**

- `autoCommit: false` -- **at-least-once ki neev.** Auto-commit hota toh kafkajs har 5 s offset commit kar deta -- chahe hamara handler kaam poora kar paya ho ya nahi. Crash hone par wo messages **kabhi wapas nahi aate** = **pages chup-chaap kho jaate**. Hamari policy ulti hai: "duplicate page is OK, missed page is NOT".
- **Order matters:** pehle `handle()` (DB write), phir `commitOffsets`. Ulta karoge toh at-most-once ho jaayega (message lost on crash). Is order se worst case = **dobara process** -- jise `ON CONFLICT` aur `task_id` unique index sambhal lete hain.
- `Number(message.offset) + 1` -- Kafka mein commit "**agli** padhne wali offset" hoti hai, current nahi. `+1` bhoolna = restart par har baar aakhri message dobara process. Ye ek bahut common bug hai.
- `partitionsConsumedConcurrently: 4` -- ek consumer instance 4 partitions **parallel** chalaye. Ek hi partition ke andar order maintained rehta hai; alag partitions ke beech order ki hamein parwah nahi (wo alag services hain).
- `await heartbeat()` -- lamba kaam karte waqt broker ko batao "main zinda hoon". Warna `sessionTimeout` par kick out -> rebalance -> wahi messages kisi aur ko -> duplicate work.
- **Per-message commit mehenga hai** (har message ek network round trip). Production optimization: batch ke end mein ek commit, ya har N messages / har 1 s. Trade-off: crash par zyada duplicates. Interview mein bolna: "Main batch commit karunga kyunki mere sab operations idempotent hain."

### 3. `services/incident.service.ts` -- dil (dedup + transaction + tasks)

```ts
import type { Pool } from 'pg';
import type { IncidentRepository } from '../repositories/incident.repository';
import type { TimerRepository } from '../repositories/timer.repository';
import type { RoutingService } from './routing.service';
import type { NotificationService } from './notification.service';
import type { EventProducer } from '../infra/kafka';
import type Redis from 'ioredis';
import { dedupHits, incidentsCreated } from '../infra/metrics';
import { logger } from '../infra/logger';

export class IncidentService {
  constructor(
    private readonly db: Pool,
    private readonly incidents: IncidentRepository,
    private readonly timers: TimerRepository,
    private readonly routing: RoutingService,
    private readonly notifications: NotificationService,
    private readonly redis: Redis,
    private readonly producer: EventProducer,
  ) {}

  async handleEvent(event: IngestedEvent): Promise<void> {
    if (event.eventAction !== 'trigger') return this.handleNonTrigger(event);

    const level1 = await this.routing.firstLevel(event.serviceId);   // cached 60s

    const client = await this.db.connect();
    let outcome: { incidentId: string; timerId: string } | null = null;

    try {
      await client.query('BEGIN');

      const row = await this.incidents.upsertOpenIncident(client, event);

      if (!row.inserted) {
        await client.query('COMMIT');
        dedupHits.inc();
        return;                                   // repeat alert -- koi page nahi
      }

      await this.incidents.insertTimelineEvent(client, {
        incidentId: row.id, type: 'triggered', actor: 'monitoring',
        detail: { source: event.payload.source, severity: event.payload.severity, eventId: event.eventId },
      });

      const timerId = await this.timers.insertPending(client, {
        incidentId: row.id, level: 1, dueAtMs: Date.now() + level1.ackTimeoutMin * 60_000,
      });

      await client.query('COMMIT');
      outcome = { incidentId: row.id, timerId };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;                                  // offset commit nahi hoga -> Kafka dobara dega
    } finally {
      client.release();
    }

    incidentsCreated.inc({ severity: event.payload.severity });

    // --- transaction ke BAAHAR: side effects ---
    await this.redis
      .zadd('sched:escalations', Date.now() + level1.ackTimeoutMin * 60_000, outcome.timerId)
      .catch((err) => logger.error({ err, timerId: outcome!.timerId }, 'ZADD failed; recovery job will fix'));

    const tasks = await this.notifications.buildTasksForLevel(outcome.incidentId, event, 1);
    for (const task of tasks) {
      await this.producer.send('notifications', outcome.incidentId, task);
    }
  }
}
```

**Code Explanation:**

- `if (event.eventAction !== 'trigger') return this.handleNonTrigger(event)` -- `acknowledge`/`resolve` ka raasta alag hai (wahan optimistic-lock update hota hai, upsert nahi). Ek hi function mein teeno rakhoge toh wo 200-line ka `if-else` ban jaayega.
- `const level1 = await this.routing.firstLevel(event.serviceId)` -- **transaction ke bahar aur pehle.** Kyun? Ye ek cached read hai (60 s), aur ise transaction ke andar rakhne se transaction ki umar badhti hai. **Lamba transaction = lamba row lock = kam concurrency.** Rule: transaction ke andar sirf wo kaam jo atomically hona hi chahiye.
- `const client = await this.db.connect()` -- pool se ek **dedicated connection**. Transaction ke saare statements ek hi connection par hone chahiye; `pool.query()` har baar koi bhi connection de dega aur `BEGIN` doosre connection par chala jaayega -- silently toota hua transaction.
- `await client.query('BEGIN')` -- transaction shuru. Yahan se `COMMIT` tak sab kuch **all or nothing**.
- `const row = await this.incidents.upsertOpenIncident(client, event)` -- repository ko `client` **pass kiya** (pool nahi). Ye pattern zaroori hai taaki repository transaction ka hissa ban sake aur phir bhi SQL sirf repository mein rahe.
- `if (!row.inserted) { COMMIT; dedupHits.inc(); return; }` -- **95% traffic yahin se wapas jaata hai.** `COMMIT` isliye karna hai (ROLLBACK nahi) kyunki `occurrence_count` aur `last_seen_at` ka update hum **rakhna** chahte hain. Aur yahan se `return` = koi routing, koi notification, koi naya timer.
- `insertTimelineEvent(... type: 'triggered' ...)` -- usi transaction mein. Agar ye bahar hota aur beech mein crash hota, toh ek incident hota jiski timeline khaali hoti -- postmortem mein "ye kaise shuru hua?" ka jawab hi na milta.
- `insertPending(... dueAtMs: Date.now() + ackTimeoutMin * 60_000 ...)` -- **timer bhi usi transaction mein.** Ye sabse zaroori line hai: incident bana lekin timer nahi bana = wo incident **kabhi escalate nahi hoga**. Ek insaan so gaya toh outage ka kisi ko pata hi nahi chalega. Atomicity yahan optional nahi hai.
- `await client.query('COMMIT')` -- ab teeno rows durable hain.
- `catch { ROLLBACK; throw err; }` -- **`throw` bahut important hai.** Error upar `eachMessage` tak jaata hai -> `commitOffsets` chalta hi nahi -> Kafka ye message **dobara** dega. Yahan error nigal lete (`catch { log }`) toh offset commit ho jaata aur event **hamesha ke liye gayab**.
- `.catch(() => undefined)` `ROLLBACK` par -- connection already toota ho toh `ROLLBACK` bhi throw karega; wo error asli error ko chhupa dega.
- `finally { client.release() }` -- **connection wapas pool mein, hamesha.** Ye line bhoolna = pool leak = kuch minutes baad "timeout exceeded when trying to connect" aur poora system thap.
- `redis.zadd('sched:escalations', dueAtMs, timerId)` -- **commit ke baad.** ZSET score = `dueAtMs`, member = `timerId`. Scheduler isi ZSET se due timers uthata hai.
- `.catch((err) => logger.error(...))` -- **Redis fail hua toh throw nahi karte.** Kyun? Kyunki timer Postgres mein durable hai, aur **recovery job har 60 s** pending timers ko ZSET mein wapas daal deta hai. Yahan throw karte toh message dobara process hota, `ON CONFLICT` se `inserted = false` aata, aur **notification tasks kabhi nahi bhejte** -- yaani Redis ki chhoti si dikkat ek page miss kar deti. Degrade karo, giro mat.
- `buildTasksForLevel(incidentId, event, 1)` -- notification service on-call user, uske `notification_rules`, urgency aur quiet hours dekhkar tasks ki list banata hai (`delay_min = 0` wala abhi).
- `for (const task of tasks) await this.producer.send('notifications', incidentId, task)` -- key = `incidentId` taaki ek incident ke saare notifications **ek partition** mein, order mein rahein (push pehle, SMS baad mein).
- **Duplicate risk jo bachta hai:** `COMMIT` ke baad aur `producer.send` se pehle crash. Incident ban chuka, task nahi gaya. **Bachav:** escalation timer 5 min baad fire karega aur level 1 ko dobara page karega. Ek missed page **5 min late** ho jaata hai, poori tarah gum nahi hota. 100% chahiye toh **transactional outbox** (task ko usi transaction mein `outbox` table mein likho, relay bheje) -- v2 ka kaam.

### 4. `repositories/incident.repository.ts` -- upsert SQL

```ts
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';

const UPSERT_OPEN_INCIDENT = `
  INSERT INTO incidents (id, service_id, dedup_key, status, severity, summary, source, created_at, last_seen_at)
  VALUES ($1, $2, $3, 'triggered', $4, $5, $6, now(), now())
  ON CONFLICT (service_id, dedup_key) WHERE status <> 'resolved'
  DO UPDATE SET occurrence_count = incidents.occurrence_count + 1,
                last_seen_at     = now(),
                severity         = GREATEST(incidents.severity, EXCLUDED.severity)
  RETURNING id, status, version, escalation_level, occurrence_count, (xmax = 0) AS inserted
`;

export interface UpsertResult {
  id: string; status: string; version: number;
  escalationLevel: number; occurrenceCount: number; inserted: boolean;
}

export class IncidentRepository {
  async upsertOpenIncident(client: PoolClient, event: IngestedEvent): Promise<UpsertResult> {
    const { rows } = await client.query(UPSERT_OPEN_INCIDENT, [
      randomUUID(),
      event.serviceId,
      event.dedupKey,
      event.payload.severity,
      event.payload.summary.slice(0, 1024),
      event.payload.source.slice(0, 255),
    ]);
    const r = rows[0];
    return {
      id: r.id, status: r.status, version: r.version,
      escalationLevel: r.escalation_level, occurrenceCount: r.occurrence_count,
      inserted: r.inserted === true,
    };
  }
}
```

**Code Explanation:**

- `const UPSERT_OPEN_INCIDENT = \`...\`` -- SQL ek **module-level constant**. Fayda: Postgres ka prepared-statement plan cache isi text par kaam karta hai, aur SQL ek jagah dikhta hai (review/audit easy).
- `VALUES ($1, $2, ...)` -- **parameterized query, hamesha.** String concatenation (`WHERE dedup_key = '${key}'`) = SQL injection. Yahan `dedupKey` **customer ki di hui string** hai -- yaani ye wo exact jagah hai jahan injection hota.
- `ON CONFLICT (service_id, dedup_key) WHERE status <> 'resolved'` -- `WHERE` clause **partial index ko match karna zaroori hai**, bilkul waise hi jaise wo bana tha. Postgres isi se decide karta hai ki kaunsa index "arbiter" hai. `WHERE` chhod doge toh error: "there is no unique or exclusion constraint matching the ON CONFLICT specification".
- `DO UPDATE SET occurrence_count = incidents.occurrence_count + 1` -- **`incidents.`** prefix = table ki **maujooda** (purani) row. Ye ek atomic read-modify-write hai: do consumers ek saath aayein toh Postgres row lock lega aur count 2 badhega, 1 nahi.
- `EXCLUDED.severity` -- `EXCLUDED` ek special pseudo-table hai jismein wo row hai jo **insert hone wali thi** (naya event). Yaani `incidents.` = purana, `EXCLUDED.` = naya. Ye do prefix upsert ka poora vocabulary hain.
- `severity = GREATEST(incidents.severity, EXCLUDED.severity)` -- **severity upgrade ho sakti hai, downgrade nahi.** `warning` se shuru hua incident agar ab `critical` bhej raha hai toh badh jaana chahiye.
  > **Gotcha:** `severity` `TEXT` hai, toh `GREATEST` **alphabetical** compare karega: `'warning' > 'error' > 'critical'` -- yaani **bilkul ulta**! Sahi ilaaj: ek Postgres `ENUM` type banao jiska order sahi ho (`CREATE TYPE severity_t AS ENUM ('info','warning','error','critical')` -- enum comparison declaration order se hota hai), ya `CASE WHEN severity_rank(EXCLUDED.severity) > severity_rank(incidents.severity) THEN ... END`. Ye chhoti si detail real production bug hai, aur interview mein ise pakadna strong signal hai.
- `RETURNING ... (xmax = 0) AS inserted` -- ek hi round trip mein pata chal gaya ki naya bana ya purana mila (upar PART 9.6 ka poora deep dive).
- `RETURNING version, escalation_level` -- agli steps (optimistic lock, escalation) ko ye chahiye. Ek alag `SELECT` bachaya.
- `randomUUID()` **application mein** generate -- `gen_random_uuid()` DB mein bhi ho sakta tha, lekin app mein banane se: (a) id insert se **pehle** pata hoti hai (logs, tracing), (b) `ON CONFLICT` wale case mein ye id use hi nahi hoti aur `RETURNING id` purana id deta hai -- dono case saaf.
- `client: PoolClient` (Pool nahi) -- taaki ye query caller ke transaction ka hissa bane.
- `.slice(0, 1024)` / `.slice(0, 255)` -- **defence in depth.** zod pehle hi validate kar chuka hai, lekin ye repository worker path se bhi call hota hai. DB column limits ke paas ek aur guard rakhna sasta hai.
- `inserted: r.inserted === true` -- `pg` boolean ko sahi map karta hai, par explicit compare se `undefined`/`null` galti se truthy nahi banega. Yahan ek bug ka matlab hai "har repeat alert par page" ya "kabhi page nahi" -- dono disasters.

### 5. `services/oncall.service.ts` -- rotation math + DST trap

```ts
import { DateTime } from 'luxon';
import type { ScheduleRepository } from '../repositories/schedule.repository';

export interface OnCallUser { userId: string; until: Date }

export class OnCallService {
  constructor(private readonly schedules: ScheduleRepository) {}

  async resolveOnCall(scheduleId: string, at: Date): Promise<OnCallUser[]> {
    const schedule = await this.schedules.findById(scheduleId);
    if (!schedule) return [];

    const override = await this.schedules.findActiveOverride(scheduleId, at);
    if (override) {
      return [{ userId: override.userId, until: override.endsAt }];
    }

    const layers = await this.schedules.findLayers(scheduleId);
    const result: OnCallUser[] = [];

    for (const layer of layers) {
      if (!this.withinRestriction(layer, at, schedule.timezone)) continue;

      const rotationMs = layer.rotationLengthSec * 1000;
      const elapsedMs = at.getTime() - layer.handoffAt.getTime();
      if (elapsedMs < 0) continue;                                   // rotation abhi shuru nahi hui

      const periods = Math.floor(elapsedMs / rotationMs);
      const index = periods % layer.memberIds.length;
      const until = new Date(layer.handoffAt.getTime() + (periods + 1) * rotationMs);

      result.push({ userId: layer.memberIds[index], until });
    }
    return result;
  }

  private withinRestriction(layer: ScheduleLayer, at: Date, tz: string): boolean {
    if (!layer.restriction) return true;
    const local = DateTime.fromJSDate(at, { zone: tz });               // IANA zone, offset nahi
    const { days, startHour, endHour } = layer.restriction;
    if (!days.includes(local.weekday)) return false;                   // 1 = Monday ... 7 = Sunday
    return local.hour >= startHour && local.hour < endHour;
  }
}
```

**Code Explanation:**

- `resolveOnCall(scheduleId, at)` -- `at` **parameter hai, `new Date()` andar nahi.** Kyun? (a) "agle Tuesday raat ko kaun on-call hai" wala preview isi function se aata hai; (b) test mein koi bhi time de sakte ho, fake clock ki zarurat nahi; (c) escalation 5 min baad fire ho toh hum wo timestamp de sakte hain jab incident bana tha ya jab timer fire hua -- decision explicit rehta hai.
- **Override pehle, rotation baad mein** -- override ka poora matlab hi "normal rotation ko override karna" hai. Ulta order karoge toh Amit chhutti par hote hue bhi page khaata rahega.
- `findActiveOverride(scheduleId, at)` -- SQL: `WHERE schedule_id = $1 AND starts_at <= $2 AND ends_at > $2`. Note `<=` aur `>` -- **half-open interval** `[start, end)`. Dono taraf `<=` rakhoge toh `ends_at` wale exact instant par **do log** on-call honge (aur dono ko page jaayega).
- `for (const layer of layers)` -- **har layer** ka apna on-call. Array return hota hai kyunki primary aur secondary dono ho sakte hain (spec ka `User[]`).
- `const elapsedMs = at.getTime() - layer.handoffAt.getTime()` -- **UTC milliseconds ka subtraction.** Dono `Date` objects hain, jo andar se epoch millis hain. Yahan timezone ka koi rol nahi -- aur yahi is design ka bachav hai.
- `if (elapsedMs < 0) continue` -- rotation ka anchor future mein hai (schedule abhi shuru nahi hui). Ye check na ho toh JS mein `Math.floor(-1.5) = -2` aur `-2 % 3 = -2` -> `memberIds[-2]` = **`undefined`** -> `undefined` ko page karne ki koshish -> crash ya silent skip.
- `const periods = Math.floor(elapsedMs / rotationMs)` -- anchor se ab tak **kitni poori rotations** guzar gayin. `Math.floor` (`Math.round` nahi) -- half-way par agla banda on-call nahi ho jaata.
- `const index = periods % layer.memberIds.length` -- **rotation index.** 3 log, weekly rotation, 10 hafte guzre: `10 % 3 = 1` -> `memberIds[1]`. Ek line mein poora rotation.
- `const until = handoffAt + (periods + 1) * rotationMs` -- **agla handoff kab.** API response mein ye jaata hai ("Amit until 09:00"). `periods + 1` = current period ka end.
- `withinRestriction(...)` -- "sirf Mon-Fri 9-6" wali layer. Restriction fail -> ye layer skip, agli layer (night coverage) dekho.

**DST trap -- is function ka sabse bada khatra:**

```
Schedule: America/New_York, daily rotation, handoff 02:00 local
9 March 2026 (spring forward): 01:59:59 EST ke turant baad 03:00:00 EDT aata hai.
                               02:00 local us din EXIST HI NAHI KARTA.
```

| Approach | Kya hota hai |
|---|---|
| `new Date(2026, 2, 9, 2, 0)` (JS local) | Server ke local time mein banta hai, server UTC par chalta hai -> handoff galat, aur dev ke laptop par kuch aur |
| Offset store karna (`-05:00`) | 9 March ke baad asli offset `-04:00` hai -> **poori rotation ek ghanta shift** -> galat banda on-call |
| `luxon` + IANA zone (**hamara**) | `DateTime.fromJSDate(at, { zone: 'America/New_York' })` -- luxon ke paas tz database hai, wo jaanta hai ki us din offset badla tha |

**Hamara design DST se lagbhag immune kyun hai?** Kyunki rotation math **poori tarah UTC milliseconds** par hai: `handoffAt` ek UTC instant hai, `rotationLengthSec` ek fixed duration hai, subtraction UTC mein hota hai. **Wall-clock time kahin beech mein aata hi nahi.** Timezone sirf do jagah use hota hai: (a) `withinRestriction` mein ("local 9 se 6"), (b) UI display mein.

**Trade-off jo yahan chhupa hai:** fixed 86400-second rotation ka matlab hai ki DST wale hafte mein handoff **local time se ek ghanta khisak jaayega** (2 AM ki jagah 1 AM ya 3 AM). Iska ilaaj chahiye toh rotation ko UTC duration ki jagah **calendar-aware** banana padega (`local.plus({ days: 1 })` luxon se, jo DST-aware hai). Dono valid hain -- lekin **decide karo aur likho**. PagerDuty khud calendar-aware handoff use karta hai.

> **Rules jo hamesha follow karne hain:** (1) **UTC instants** store karo (`TIMESTAMPTZ`), (2) **IANA zone names** store karo, offsets kabhi nahi, (3) `new Date(y, m, d)` (local constructor) production code mein **kabhi nahi** -- hamesha luxon/`Temporal` with explicit zone, (4) DST boundaries ke liye test cases likho (spring forward **aur** fall back, kyunki fall back mein 01:30 **do baar** aata hai -> ek banda do baar on-call ban sakta hai).

### 6. `workers/notification.worker.ts` -- delivery, retry, DLQ

```ts
import { withTimeout } from '../utils/time';
import { fullJitterDelay } from '../utils/backoff';
import { notificationAttempts, notificationDuration } from '../infra/metrics';
import { logger } from '../infra/logger';

const MAX_ATTEMPTS = 5;
const PROVIDER_TIMEOUT_MS = 10_000;

export async function handleNotificationTask(deps: Deps, task: NotificationTask): Promise<void> {
  const { incidents, notifications, registry, contacts, producer } = deps;

  const incident = await incidents.findById(task.incidentId);
  if (!incident || incident.status !== 'triggered') {
    await notifications.markCancelled(task.taskId);
    return;                                                   // ack ho chuka -- mat bhejo
  }

  const notification = await notifications.createIfAbsent(task);
  if (!notification) return;                                  // duplicate task (task_id unique) -- pehle ho chuka

  const contact = await contacts.findById(task.contactMethodId);
  if (!contact || !contact.verified) {
    await notifications.markFailed(notification.id, 'CONTACT_UNVERIFIED');
    return;
  }

  const provider = registry.pick(task.channel);               // circuit breaker khula ho toh failover
  const address = await contacts.decrypt(contact);
  const startedAt = Date.now();

  try {
    const result = await withTimeout(
      provider.send(task, address, incident),
      PROVIDER_TIMEOUT_MS,
      `${provider.name}.send`,
    );

    const latencyMs = Date.now() - startedAt;
    await notifications.recordAttempt(notification.id, task.attempt, 'sent', null, latencyMs);
    await notifications.markSent(notification.id, provider.name, result.providerMessageId);
    notificationAttempts.inc({ channel: task.channel, provider: provider.name, result: 'sent' });
    notificationDuration.observe({ channel: task.channel, provider: provider.name }, latencyMs / 1000);
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const permanent = isPermanent(err);
    await notifications.recordAttempt(notification.id, task.attempt, 'failed', String(err), latencyMs);
    notificationAttempts.inc({ channel: task.channel, provider: provider.name, result: 'failed' });

    if (permanent || task.attempt >= MAX_ATTEMPTS) {
      await notifications.markFailed(notification.id, String(err));
      await producer.send('notifications-dlq', task.incidentId, {
        task, error: String(err), permanent, failedAt: new Date().toISOString(),
      });
      logger.error({ taskId: task.taskId, provider: provider.name, permanent }, 'notification exhausted -> DLQ');
      return;
    }

    const delayMs = fullJitterDelay(task.attempt);
    await producer.send('notifications', task.incidentId, {
      ...task, attempt: task.attempt + 1, scheduledFor: new Date(Date.now() + delayMs).toISOString(),
    });
  }
}
```

```ts
// utils/backoff.ts
export function fullJitterDelay(attempt: number, capMs = 30_000, baseMs = 1_000): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.floor(Math.random() * ceiling);
}
```

**Code Explanation:**

- `const incident = await incidents.findById(task.incidentId)` + `status !== 'triggered'` -- **last-moment cancelled check** (Flow D step 9). Task Kafka queue mein pada tha; beech mein Priya ne ack kar diya. **Ab bhejna galat hai** -- raat 3 baje ek bekaar SMS trust todta hai. Ek extra DB read ki keemat is se kam hai.
- `notifications.createIfAbsent(task)` -- andar `INSERT ... ON CONFLICT (task_id) DO NOTHING RETURNING id`. `null` mila = **ye task pehle ho chuka** (Kafka ka at-least-once duplicate). Yahi wo ek unique index hai jo hamare "duplicate SMS mostly nahi jaayega" wale claim ko sach banata hai.
- `if (!contact.verified)` -- unverified number par page mat bhejo. Attacker kisi ka number add karke hamare system ko SMS bombing tool bana sakta hai.
- `registry.pick(task.channel)` -- registry circuit breaker state (`cb:<provider>`) dekhta hai. Twilio ka breaker `open` hai -> MessageBird. **Worker ko pata bhi nahi chalta ki kis provider par gaya.**
- `await contacts.decrypt(contact)` -- KMS data key (cached) se AES-GCM decrypt. Plaintext number ek **local variable** mein hai, kabhi log mein nahi. Logging ke liye alag masked version (`+91XXXXXX1234`).
- `withTimeout(provider.send(...), 10_000, ...)` -- **ye line poore system ko bachati hai.** Twilio hang ho gaya aur hum bina timeout ke wait karein, toh worker ka concurrency slot block, phir saare slots block, phir consumer lag minutes mein, phir **sabke pages late**. Ek slow dependency ka poore system ko khaa jaana "cascading failure" hai. 10 s = normal p99 (900 ms) se kaafi upar, aur 5 s budget se... zyada -- jaan-boojh kar, kyunki late page bhi no page se behtar hai.
- `notifications.recordAttempt(id, attempt, 'sent', null, latencyMs)` -- har attempt ka apna row. Debugging mein poori kahani milti hai.
- `notificationDuration.observe({ channel, provider }, latencyMs / 1000)` -- **labels mein sirf `channel` aur `provider`** (kuch values). `userId` ya `incidentId` label mein daalna = lakhon time series = Prometheus OOM (high cardinality trap).
- `const permanent = isPermanent(err)` -- **retry karne layak hai ya nahi**, ye decision ka core hai.
- `if (permanent || task.attempt >= MAX_ATTEMPTS)` -- do exit conditions. Permanent error par 5 baar retry karna = 5 guna paisa, 5 guna latency, aur result wahi. `MAX_ATTEMPTS = 5` = ~1+2+4+8+16 s (jitter ke saath average aadha) = under a minute.
- `producer.send('notifications-dlq', ...)` -- **DLQ (dead letter queue)**. Task delete nahi hota, alag topic par jaata hai. Kyun? (a) `dlq_depth` metric par alert -- koi insaan dekhega, (b) Twilio ka outage theek hone ke baad `dlq.worker.ts` unhe replay kar sakta hai, (c) forensics: "us raat 400 SMS kyun fail hue?"
- **DLQ ke baad kya?** Ideally notification service agle channel par chala jaata (SMS fail -> voice), aur escalation timer waise bhi chal raha hai -- 5 min baad level 2. **Do independent safety nets.**
- `const delayMs = fullJitterDelay(task.attempt)` + `producer.send('notifications', {...task, attempt: attempt + 1})` -- retry ko **wapas Kafka par** bhejte hain, `setTimeout` se in-process wait nahi karte. Kyun? (a) `setTimeout` worker crash par gayab, (b) wo worker slot 16 s tak block rakhta, (c) Kafka par task durable rehta hai. Trade-off: `scheduledFor` ko honour karne ke liye consumer ko delay logic chahiye (ya delay-tier topics) -- ye poora comparison Part 3 mein.
- `fullJitterDelay`: `ceiling = min(30000, 1000 * 2^attempt)` -> `1s, 2s, 4s, 8s, 16s, 30s(cap)`. `Math.random() * ceiling` = **full jitter**.
  - **Jitter kyun?** Twilio 30 s ke liye down hua. 1,000 notifications ek saath fail hue. Bina jitter ke sab exactly 1 s, phir 2 s, phir 4 s par **ek saath** wapas aayenge -- ye **thundering herd** hai jo mar rahe provider ko aur maarta hai (aur breaker ko half-open se wapas open kar deta hai).
  - **Full jitter (`random(0, ceiling)`)** vs "exponential + thoda jitter" (`ceiling + random(0, 100)`) -- AWS ki research kehti hai full jitter sabse achha spread deta hai. Cost: kabhi-kabhi retry bahut jaldi ho jaata hai (`random` ne 50 ms diya). Hamare liye theek hai, kyunki circuit breaker asli overload se bachata hai.
- **Offset commit yahan nahi dikh raha** -- wo `eachMessage` wrapper mein hai: `handleNotificationTask` **successfully return** kare tabhi commit. Ye function throw kare toh offset commit nahi hota aur Kafka task dobara dega. **Isliye is function ke andar catch kiya gaya hai** -- provider failure ek *expected* outcome hai (DLQ/retry se handle), Kafka-level redelivery se nahi. Kafka redelivery sirf **unexpected** failures (DB down, process crash) ke liye bachi hai.

### 7. `providers/twilio-sms.provider.ts` -- interface ka ek implementation

```ts
import type { Twilio } from 'twilio';
import type { NotificationProvider, NotificationTask, ProviderResult, Incident } from './provider.interface';

const PERMANENT_CODES = new Set([
  21211,  // invalid 'To' number
  21408,  // permission to send to this region not enabled
  21610,  // recipient unsubscribed (STOP)
  21612,  // cannot route to this number
  21614,  // 'To' number is not SMS capable
]);

export class TwilioSmsProvider implements NotificationProvider {
  readonly name = 'twilio-sms';
  readonly channel = 'sms' as const;

  constructor(
    private readonly client: Twilio,
    private readonly fromPool: string[],
    private readonly shortLinkBase: string,
  ) {}

  async send(task: NotificationTask, address: string, incident: Incident): Promise<ProviderResult> {
    const body = this.buildBody(incident);
    const from = this.fromPool[hashToIndex(task.incidentId, this.fromPool.length)];

    try {
      const message = await this.client.messages.create(
        { to: address, from, body, statusCallback: `${this.shortLinkBase}/webhooks/twilio/status` },
        { idempotencyKey: task.taskId },
      );
      return { providerMessageId: message.sid, status: 'sent' };
    } catch (err) {
      const code = (err as { code?: number }).code;
      const status = (err as { status?: number }).status;
      const permanent = (code !== undefined && PERMANENT_CODES.has(code))
        || (status !== undefined && status >= 400 && status < 500 && status !== 429);
      throw new ProviderError(`${this.name}: ${code ?? status ?? 'unknown'}`, { permanent, cause: err });
    }
  }

  private buildBody(incident: Incident): string {
    const link = `${this.shortLinkBase}/i/${incident.id.slice(0, 8)}`;
    const head = `[${incident.severity.toUpperCase()}] `;
    const tail = ` ${link} Reply 4 to ack`;
    const room = 160 - head.length - tail.length;
    const summary = incident.summary.length > room
      ? `${incident.summary.slice(0, room - 3)}...`
      : incident.summary;
    return head + summary + tail;
  }
}
```

**Code Explanation:**

- `implements NotificationProvider` -- TypeScript compile time par check karta hai ki `name`, `channel`, `send()` sahi shape mein hain. Naya provider likhte waqt kuch bhoolna namumkin.
- `readonly channel = 'sms' as const` -- `as const` ke bina type `string` ho jaata aur `Channel` union match nahi karta.
- `fromPool: string[]` -- **kai sender numbers.** Spec: Twilio long code ~**1 SMS/sec** deta hai; hamein peak par **1,000 notifications/sec** chahiye (jismein ~30% SMS). Ek number se ye impossible hai. Isliye numbers ka pool.
- `hashToIndex(task.incidentId, pool.length)` -- number **incident se deterministically** chuna, random nahi. Kyun? Ek hi incident ke saare SMS **ek hi number** se jaayein -- user ke phone mein ek hi conversation thread mein dikhe, aur uska `"4"` reply sahi number par wapas aaye.
- `{ idempotencyKey: task.taskId }` -- **provider-side idempotency.** Hamara `task_id` unique index apne DB ko bachata hai, lekin ek case bachta hai: humne Twilio ko bheja, SMS chala gaya, response network mein kho gaya, humne retry kiya. Bina is header ke = **do SMS**. Iske saath Twilio khud pehchan leta hai. **Do layers of idempotency -- apni taraf aur unki taraf.**
- `statusCallback: .../webhooks/twilio/status` -- delivery status webhook ka URL. Isse hi pata chalta hai ki SMS **sach mein deliver hua** ya carrier ne drop kar diya.
- **Error classification -- is file ka sabse important hissa:**
  - `PERMANENT_CODES` -- `21610` (user ne STOP kiya), `21211` (number hi galat). Inhe retry karna: paisa jalao, latency badhao, result wahi. Aur `21610` par baar-baar bhejna **legally problematic** hai.
  - `status >= 400 && status < 500 && status !== 429` -- baaki 4xx = "teri request galat hai" = permanent. **`429` alag hai** kyunki wo "abhi zyada bhej rahe ho" = **retryable**.
  - Implicitly retryable: 5xx (Twilio ki problem), timeout (`withTimeout` se), network errors. Inke liye `permanent` `false` rehta hai.
- `throw new ProviderError(..., { permanent, cause: err })` -- return nahi, **throw**. Kyun? Worker ka `try/catch` ek hi jagah saare failure paths handle karta hai (attempt row, metric, retry/DLQ decision). `{ status: 'failed' }` return karte toh worker mein do parallel error paths hote -- ek `catch` wala, ek `if (result.status === 'failed')` wala. Ek hi raasta rakhna behtar hai.
- `cause: err` -- original Twilio error attach. Logs mein poora context milta hai bina custom error ke fields copy kiye.
- `buildBody()` -- SMS **160 characters** (GSM-7). Isse zyada = message multi-part = **har part ka alag paisa** + kuch carriers par order badal jaata hai.
- `const room = 160 - head.length - tail.length` -- pehle fixed hisse (severity tag, short link, "Reply 4 to ack") ki jagah nikaalo, **jo bacha wo summary ko do**. Ulta karoge (summary pehle) toh long summary link ko kha jaayegi -- aur link hi wo cheez hai jisse banda incident tak pahunchta hai.
- `${shortLinkBase}/i/${incident.id.slice(0, 8)}` -- URL Shortener lesson wapas: poora UUID 36 chars kha jaata, short link ~20. (Production mein `slice(0,8)` ki jagah asli short-link service se code lo -- prefix collide kar sakta hai.)
- `Reply 4 to ack` -- inbound webhook ka contract user ko batana padta hai. Ye "4" PagerDuty ki convention hai (voice DTMF "4" bhi).
- **Note:** is file mein **koi retry nahi**, **koi DB nahi**, **koi business rule nahi**. Provider ka kaam sirf "bhejo aur sach-sach batao kya hua". Retry policy worker ki hai. Yahi separation naya provider jodna 30 minute ka kaam banata hai.

### 8. `controllers/incidents.controller.ts` -- acknowledge (optimistic lock)

```ts
import type { Request, Response } from 'express';

export class IncidentsController {
  constructor(
    private readonly incidents: IncidentRepository,
    private readonly escalation: EscalationService,
    private readonly db: Pool,
  ) {}

  acknowledge = async (req: Request, res: Response): Promise<void> => {
    const incidentId = req.params.id;
    const userId = req.user!.id;

    const current = await this.incidents.findForUser(incidentId, req.user!.accountId);
    if (!current) { res.status(404).json({ error: 'NOT_FOUND' }); return; }

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      const { rowCount } = await client.query(
        `UPDATE incidents
            SET status = 'acknowledged', acknowledged_by = $1, version = version + 1
          WHERE id = $2 AND status = 'triggered' AND version = $3`,
        [userId, incidentId, current.version],
      );

      if (rowCount === 1) {
        await this.incidents.insertTimelineEvent(client, {
          incidentId, type: 'acknowledged', actor: userId, detail: { via: req.body.via ?? 'web' },
        });
        await client.query(
          `UPDATE escalation_timers SET state = 'cancelled' WHERE incident_id = $1 AND state = 'pending'`,
          [incidentId],
        );
        await client.query(
          `UPDATE notifications SET status = 'cancelled' WHERE incident_id = $1 AND status = 'queued'`,
          [incidentId],
        );
      }

      await client.query('COMMIT');

      if (rowCount === 1) await this.escalation.cancelTimers(incidentId);   // Redis ZREM
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    const fresh = await this.incidents.findForUser(incidentId, req.user!.accountId);
    res.status(200).json(fresh);
  };
}
```

**Code Explanation:**

- `const userId = req.user!.id` -- **auth middleware se**, `req.body.userId` se **nahi**. Body se lena = koi bhi kisi ke naam par ack kar de (impersonation). Ye ek classic authorization bug hai.
- `findForUser(incidentId, req.user!.accountId)` -- **account scoping**. Sirf `findById` karoge toh koi bhi UUID daal ke doosre customer ka incident ack kar dega (IDOR). Account filter **hamesha SQL mein**, application `if` mein nahi.
- `res.status(404)` (403 nahi) -- doosre account ka incident "exist hi nahi karta". `403` dene se attacker ko pata chal jaayega ki wo id valid hai.
- `UPDATE ... WHERE id = $2 AND status = 'triggered' AND version = $3` -- **optimistic locking.** Teen conditions: sahi incident, abhi bhi `triggered`, aur **version wahi jo humne padha tha**.
  - **"Optimistic" ka matlab:** hum pehle se lock nahi lete ("shayad koi conflict nahi hoga"). Conflict hua toh update **0 rows** kar dega aur hum sambhal lenge. Pessimistic (`SELECT ... FOR UPDATE`) mein row pehle lock hoti hai -- correct hai, lekin lock hold karna padta hai aur ye ek **HTTP request** hai (user ka network slow ho sakta hai).
- **Ack race (do responders, ek second):**
  ```
  t=0ms   Amit ka request : SELECT -> version 3, status triggered
  t=5ms   Priya ka request: SELECT -> version 3, status triggered
  t=10ms  Amit ka UPDATE  : WHERE version=3 -> 1 row.  version ab 4, acknowledged_by=Amit
  t=15ms  Priya ka UPDATE : WHERE version=3 -> 0 rows (ab version 4 hai, status bhi badal gaya)
  ```
  **Koi lock nahi, koi corruption nahi, koi "dono ne ack kiya" wali gadbad nahi.**
- `if (rowCount === 1) { ... }` -- **saare side effects isi ke andar.** Priya ka request timers dobara cancel nahi karega, doosri timeline row nahi banayega.
- `UPDATE escalation_timers SET state = 'cancelled'` -- **DB mein cancel karna zaroori hai**, sirf Redis se `ZREM` kaafi nahi: recovery job har 60 s `state = 'pending'` timers ko ZSET mein wapas daalta hai. DB mein pending chhod doge toh timer **zombie ban ke wapas aayega** aur 5 min baad galat escalation kar dega.
- `UPDATE notifications SET status = 'cancelled' WHERE status = 'queued'` -- pending channels (`5 min par voice call`) rok do. Jo `sent` ho chuke unhe chhedo mat.
- `await this.escalation.cancelTimers(incidentId)` -- **COMMIT ke baad** Redis `ZREM`. Pehle karte aur transaction rollback ho jaata, toh timer Redis se gayab lekin DB mein `pending` -- recovery job 60 s mein wapas laata, yaani sirf confusion. Commit ke baad karne se worst case: Redis mein timer bacha reh gaya -> scheduler use uthayega -> escalation consumer dekhega `state = 'cancelled'` -> **drop kar dega.** **Do independent guards.**
- `const fresh = await ...; res.status(200).json(fresh)` -- **hamesha current state wapas**, chahe `rowCount` 1 ho ya 0.

**Aur ab sabse important sawaal: `rowCount === 0` par `409 Conflict` kyun nahi?**

| Perspective | `409 Conflict` | `200` + current state (hamara) |
|---|---|---|
| **User ka intent** | "Tumhari request fail ho gayi" | "Jo tum chahte the (incident acknowledged ho) wo **ho chuka hai**" |
| **UX raat 3 baje** | Mobile app red error dikhata hai. Aadha soya banda ghabra ke dobara tap karta hai, phir dobara 409 | Screen turant "Acknowledged by Priya" dikhati hai. Kaam ho gaya |
| **Client ka retry** | 409 par app retry kare? Confusing. Har retry phir 409 | Retry safe hai, wahi 200 aata hai |
| **Idempotency** | Toota hua -- same operation dobara alag result deta hai | **Idempotent** -- POST ko idempotent banana ek design choice hai, aur yahan sahi choice hai |
| **Double-tap / offline sync** | App ne network flaky hone par 3 baar bheja -> 2 errors | Teeno baar 200 |

> **Interview line:** "`409` tab do jab client ki request ka **matlab hi galat** ho gaya ho (jaise stale data ke saath **edit**). Yahan operation ka **goal hi complete** hai -- bas kisi aur ne pehle kar diya. Goal poora hai toh success return karo. Yahi 'idempotent POST' ka poora idea hai, aur yahi PagerDuty/Opsgenie bhi karte hain."

**`409` kab dena hi chahiye?** Agar `status` `resolved` ho aur koi ack kare -- yahan sach mein state conflict hai ("resolved ko acknowledge nahi kar sakte"). Lekin waise bhi hum `200` + current state dete hain, kyunki incident ka **jalna band ho chuka hai** -- yaani user ka asli intent (mujhe is page se chhutkara chahiye) poora ho chuka hai.

### Poora code ek line mein

```
POST /v2/enqueue -> zod -> svc:<key> (Redis) -> rate limit -> Kafka acks=all -> 202
   -> incident-service: BEGIN [upsert ON CONFLICT (xmax=0) | timeline | timer] COMMIT
        inserted=false -> stop (95%)   |   inserted=true -> ZADD + produce tasks
   -> notification-worker: cancelled? -> task_id unique -> provider.send (10s timeout)
        ok -> attempt row + commit offset  |  fail -> permanent? DLQ : full-jitter retry
   -> ack: UPDATE ... AND version=$v  -> 1 row? cancel timers (DB + Redis) + notifications
                                      -> 0 rows? koi aur pehle kar gaya -> 200, error nahi
```

---

## Remember

> **Ingest ka kaam sirf "sun liya aur likh liya" hai (`202` + Kafka `acks=all`), asli kaam consumers ka hai.** Dedup ka source of truth ek partial unique index hai aur `(xmax = 0)` batata hai ki page karna hai ya chup rehna hai. Incident + timeline + timer **ek transaction**, Kafka/Redis uske **baahar**. Har jagah at-least-once, kyunki **duplicate page is OK, missed page is NOT** -- aur jo missed page bach sakta hai wo escalation timer bacha leta hai.

## Quick Self-Test

1. Incident, timeline row aur escalation timer -- teeno ek hi transaction mein kyun hain, aur agar timer transaction ke **baahar** insert karein toh production mein exactly kya bura hoga (aur kisko pata bhi nahi chalega)?
2. `ON CONFLICT ... RETURNING (xmax = 0) AS inserted` ki jagah agar "pehle `SELECT`, na mile toh `INSERT`" likhein, toh storm ke doran kaun sa exact bug aayega -- aur `notifications.task_id` wala unique index usse bacha payega ya nahi?
3. Ingest par hum **fail closed** hain (Kafka down -> `503`) jab ki Rate Limiter mein **fail open** the. Dono jagah ka reasoning ek line mein bolo -- kaunsi cheez decide karti hai ki kaun sa mode chunna hai?
4. Do responders ek hi second mein ack karte hain. Doosre ko `409` **nahi** dete -- kaunse teen practical faayde hain, aur `409` kis situation mein sach mein sahi answer hota?
5. `resolveOnCall` ka poora math UTC milliseconds par chalta hai, phir bhi `schedules.timezone` (IANA) store karna kyun zaroori hai? DST ke din exactly kahan cheez toot sakti hai?

---

**Next (Part 3):** Dedup aur idempotency andar se, escalation timers ke saare design options (Redis ZSET vs DB polling vs Kafka delay vs timer wheel), retries + backoff + circuit breaker, concurrency (ack race, duplicate consumers, at-least-once), Redis state deep dive. "next" bolo.
