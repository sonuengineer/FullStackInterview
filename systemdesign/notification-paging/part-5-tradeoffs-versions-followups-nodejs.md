# Notification / Paging System -- HLD + LLD (Part 5: Trade-offs -> 3 Versions -> Follow-ups -> Node.js Questions)

> Is file mein prompt ke **Parts 21-25** hain: paging system ke har bade decision ka trade-off ("kyun ye, kyun woh nahi"), MVP -> Scalable -> Highly Scalable teen versions, 26 interviewer follow-up questions, 13 requirement-change ("What if...") questions, aur Node.js specific questions -- sab isi paging system par.
> Part 4 recap: humne dekha ki 1x se 100x tak kya pehle tootta hai (**Twilio ka per-number throughput aur Postgres ka incidents write path, Kafka nahi**), har component fail hone par kya hota hai (Kafka down -> ingest local spool phir `503`, Redis wipe -> `escalation_timers` se ZSET rebuild, provider down -> circuit breaker + failover), consistency kitni chahiye (**at-least-once: duplicate page OK, missed page NOT**), aur kya monitor karna hai (`page_latency_seconds`, `timer_lag_seconds`, `notification_attempts_total`, `dlq_depth`, `kafka_consumer_lag`). Ab un sab decisions ko interview ki language mein bolna seekhenge.
> Part 6 mein: poora TypeScript implementation end-to-end, 30-second answer, 5-minute answer, whiteboard drawing order, aur final cheat sheet.

Ek line mein system yaad kar lo, kyunki har answer isi par tika hai:

```
Monitoring tools -> POST /v2/enqueue (routingKey, dedupKey, eventAction)
  -> Ingest API (N stateless Node.js, Express 5): routingKey->serviceId (Redis cache),
     token bucket rate limit, validate, produce to Kafka (acks=all)  --> 202 Accepted
  -> Kafka `incident-events` (24 partitions, key=serviceId)
  -> Incident Service (consumer group `incident-service`):
       dedup (Postgres partial unique index) + state machine -> Postgres
       routing: policy -> level -> schedule -> on-call user
       produce -> Kafka `notifications` (48 partitions, key=incidentId)
       schedule timer -> Redis ZSET `sched:escalations` + Postgres `escalation_timers`
  -> Notification Workers: rules, quiet hours, grouping, provider adapters
       (FCM/APNs | Twilio SMS | Twilio Voice | SendGrid | Slack), retry + circuit breaker + DLQ
  -> Providers -> delivery webhook -> Webhook API
  -> Responder acknowledges (app / web / SMS reply "4" / voice DTMF "4") -> timers cancel
```

Numbers jo baar baar aayenge: **50M events/day = ~579 eps avg, ~6,000 eps storm peak; dedup ~95% -> 2.5M incidents/day (~29/sec avg, ~300/sec peak); 7.5M notifications/day (~87/sec avg, ~1,000/sec peak); SMS ~$17K/day + voice ~$5K/day; page latency SLO p95 < 5 s, p99 < 10 s; ~3,500 active incidents typical, ~50,000 in a storm.**

Aur ek principle jo har trade-off ka tie-breaker hai:

> **"Duplicate page is OK. Missed page is NOT."**

---

## PART 21 -- Trade-offs: har decision ka "kyun ye, kyun woh nahi"

### Pehle rule samjho

Paging system ke interview mein sabse common galti: "Kafka use karenge kyunki scalable hai" bol dena. Interviewer sunna chahta hai:

```
Requirement kya hai  ->  Options kya hain  ->  Har option ki keemat kya hai  ->  Is requirement par kaunsi keemat chalegi
```

Hamari requirements yaad rakho: **reliability sabse upar, p95 < 5 s page latency, 99.99% ingest availability, storms 10x-50x, cost ($22K/day SMS+voice) bhi ek constraint hai, aur accepted event kabhi kho na jaaye.** Har table ke end mein **hamare system ka decision** hai.

### 1. Event bus: Kafka vs RabbitMQ vs SQS vs Postgres-as-a-queue

Ye sabse pehla decision hai -- Ingest API `202` bolne se pehle event **kahan** likhta hai.

| | Kafka (hamara) | RabbitMQ | SQS (managed) | Postgres as a queue |
|---|---|---|---|---|
| **Pros** | **Replay** -- bug fix karke 7 din ke events dobara process kar sakte ho (paging mein ye sona hai: "raat ko 200 incidents galat route hue" -> replay); **ordering per key** (`serviceId` -> ek service ke trigger/resolve out of order nahi); **multiple independent consumer groups** (incident-service + analytics + audit + billing sab same topic padh sakte hain, ek doosre ko block kiye bina); 6K eps ek chhote cluster ke liye kuch bhi nahi; retention se durability | Per-message ack/nack/requeue bahut natural; **delayed messages** plugin se; priority queues; routing (topic exchange) se "critical events is queue mein" easy; operate karna Kafka se simple | Zero ops, infinite scale, `202` ke baad AWS sambhale; DLQ built-in; visibility timeout = automatic retry | Kuch naya component nahi; incident aur event **ek hi transaction** mein likh sakte ho (dual-write problem hi khatam); `SELECT ... FOR UPDATE SKIP LOCKED` kaafi accha kaam karta hai |
| **Cons** | Ops heavy (brokers, ISR, partitions, rebalance); consumer lag samajhna padta hai; per-message delay/retry natural **nahi** hai (isliye retries hum worker ke andar karte hain, topic se nahi); ek slow message poori partition ko rok sakta hai (head-of-line blocking) | Replay nahi (message consume hua toh gaya); ek queue ka throughput limited; multiple consumer groups ke liye alag queues + fanout exchange maintain karo; messages memory mein bharein toh broker slow | **Ordering nahi** (standard SQS), FIFO SQS mein 300 msg/s per group ki limit; replay nahi; **delay max 15 min** (hamara escalation 60 min tak jaata hai -> fit nahi); vendor lock-in; per-message cost 50M/day par dikhta hai | 6,000 eps = 6,000 inserts/sec + 6,000 deletes/sec + vacuum pressure -- **wahi DB jahan incidents likhne hain**; queue table bloat; storm mein DB lock contention se ingest aur incident write dono girte hain; replay manual |
| **Kab main ye choose karunga** | Jab replay, per-key ordering, aur multiple consumers -- teeno chahiye (hamara case); ya throughput 10K+ eps | Jab per-message retry/delay/priority hi main requirement ho aur replay ki zarurat na ho -- **notification retry level par RabbitMQ ka pattern (delayed exchange + DLX) hamare custom backoff se behtar hai**, isliye V2 mein exactly wahi (BullMQ) use kiya | Jab team chhoti hai, ops nahi karna, throughput moderate hai, aur ordering matter nahi karta -- ek startup ke liye bilkul sahi shuruaat | Jab tumhara scale hazaaron events/day hai (V1), ya jab "outbox pattern" chahiye -- DB transaction ke saath event likhna |
| **Kab main dusra choose karunga** | Agar hum sirf 500 events/day kar rahe hote toh Kafka chalana bewakoofi hai -- Postgres queue | Agar mujhe raat 2 baje ke incident ko dobara process karna pade toh RabbitMQ mujhe kuch nahi de sakta | Agar mujhe 60 min ka delay chahiye ya per-service ordering chahiye | Jaise hi DB CPU ka bada hissa queue polling kha jaaye |

**Decision:** "Kafka `incident-events`, 24 partitions, key = `serviceId`. Teen wajah: replay (paging mein sabse badi recovery tool), per-service ordering (trigger ke baad resolve aaye, ulta nahi), aur multiple consumer groups. Lekin main honest rahunga -- **Kafka retry/delay ke liye bura hai**, isliye notification retries topic se nahi, worker ke andar backoff + `notifications-dlq` se karte hain. Agar throughput 6K eps na hota aur replay ki zarurat na hoti, SQS se shuru karta."

> Note: `202 Accepted` tabhi bolte hain jab Kafka ne `acks=all` par confirm kar diya. Ye jaanbujh kar hai -- accept bol ke event khona is system ka sabse bada paap hai.

### 2. Incident store: Postgres vs MongoDB vs DynamoDB

| | Postgres (hamara) | MongoDB | DynamoDB |
|---|---|---|---|
| **Pros** | **Partial unique index** `(service_id, dedup_key) WHERE status <> 'resolved'` -- dedup DB khud enforce karta hai, application race ke bawajood; **multi-row transaction**: incident + timeline + escalation timer ek saath commit; relational data natural hai (service -> policy -> rule -> schedule -> layer -> user -> contact method: 6 joins ka graph); optimistic locking (`version`) se ack race solve; monthly partitions se 90-day retention aasaan; read replicas dashboards ke liye | Flexible schema (`customDetails` jaisa bada JSON), incident + timeline ek hi document mein (ek read se poora incident); sharding built-in; write throughput acchi | Infinite scale, single-digit ms, zero ops; conditional writes (`attribute_not_exists`) se atomic dedup possible; TTL se auto-retention; DynamoDB Streams se change events free |
| **Cons** | Ek primary par writes (29/sec avg, 300/sec peak -- ye Postgres ke liye kuch nahi, isliye ye con hamare scale par theoretical hai); manual partition management; connection limit (`max_connections`) N workers ke saath dikkat karti hai (Part 25 Q5) | **Partial unique index MongoDB mein hai** (`partialFilterExpression`) lekin sharded collection par unique index sirf shard key par ban sakta hai -- yahi hamara dedup toot jaata; multi-document transaction hai par performance aur ops cost ke saath; joins (`$lookup`) routing ke liye kharaab | Joins nahi -- escalation policy graph ke liye 4-5 alag queries ya heavy denormalization; **partial unique index nahi** (condition `status <> 'resolved'` ko manually modelling karna padta hai, e.g. `PK = serviceId#dedupKey` wala item resolve par delete); GSI eventual consistent; query flexibility kam (dashboard filters mushkil); cost model surprise de sakta hai |
| **Kab main ye choose karunga** | Jab correctness aur constraints core hain aur write volume mid-range hai -- **paging exactly yahi hai** | Jab incident ek self-contained document ho, schema har customer ka alag ho, aur cross-entity transactions na chahiye -- e.g. ek pure "event log" product | Jab 10x-100x scale ho aur team ops nahi karna chahti; ya jab access pattern sirf key-based ho (`getIncident(id)`), analytics alag system mein ho |
| **Kab main dusra choose karunga** | Agar incidents 100M/day hote toh single-primary Postgres pe likhna galat hota -- tab Dynamo ya Postgres sharding | Agar mujhe cross-table transaction chahiye (incident + timer + timeline atomically) | Agar mujhe rich dashboard queries chahiye ("last 7 days, service X, severity critical, unacknowledged > 10 min") |

**Decision:** "Postgres. Sabse bada reason **partial unique index** hai -- dedup is system ka dil hai, aur main use application logic se nahi, DB constraint se enforce karna chahta hoon. Do workers same `dedupKey` ek hi millisecond mein process karein toh `INSERT ... ON CONFLICT` ek ko insert dega aur doosre ko update -- `xmax = 0` se pata chal jaata hai kaunsa naya tha, aur sirf naye par page jaata hai. MongoDB/Dynamo mein ye guarantee banana padta, milta nahi. 29 incidents/sec Postgres ke liye kuch bhi nahi -- scale problem hai hi nahi, correctness problem hai."

### 3. Timers: Redis ZSET vs DB polling vs Kafka delay topics vs cloud scheduler

Escalation timer = "5 minute baad agar ack nahi hua toh agle level par page karo". Ye system ka **sabse critical mechanism** hai -- timer miss = missed page.

| | Redis ZSET (hamara) | DB polling (`FOR UPDATE SKIP LOCKED`) | Kafka delay topics | Cloud scheduler (SQS delay / EventBridge / Cloud Tasks) |
|---|---|---|---|---|
| **Kaise** | `ZADD sched:escalations <dueAtMs> <timerId>`; scheduler har 1 s ek atomic Lua `ZRANGEBYSCORE ... LIMIT` + `ZREM` chalata hai | `SELECT ... WHERE due_at <= now() AND state='pending' FOR UPDATE SKIP LOCKED LIMIT 100` har 1 s | Fixed delay tiers: `delay-1m`, `delay-5m`, `delay-15m` topics; consumer message padhta hai, `sleep(dueAt - now)` ya pause karta hai | `SendMessage` with `DelaySeconds`, ya EventBridge scheduler par ek one-off schedule |
| **Pros** | Sub-second precision; O(log N) add, O(log N + M) claim; 50,000 active timers = ~5 MB (trivial); claim + remove **ek atomic step** -> do scheduler instances same timer do baar fire nahi karte -> leader election ki zarurat nahi | Durable by default (koi alag recovery job nahi chahiye); `SKIP LOCKED` se multiple pollers safe; transaction ke andar "timer cancel + incident ack" ek saath; debugging aasaan (SQL se dekh lo) | Koi alag scheduler service nahi; durability Kafka ki; replay bhi mil jaata | Zero ops; provider durability; scale infinite |
| **Cons** | **Redis ephemeral hai** -- failover/eviction/wipe par timers gayab -> missed page. Isliye durable copy `escalation_timers` table + har 60 s recovery job (`ZADD NX`) **compulsory** hai; Redis ek aur failure domain | Har 1 s ek query x N pollers; 50,000 due timers storm mein DB par extra load exactly us waqt jab DB already busy hai; `due_at` index par lock contention; granularity badhao toh DB aur pite ga | **Delay fixed hai, arbitrary nahi** -- 5 min ka timer 5 min topic se, lekin 7 min ka? Multiple hops chahiye; consumer mein sleep = partition block (head-of-line); cancel karna **impossible** (message wapas nahi le sakte) -> ack ke baad bhi message aayega, har consumer ko "abhi bhi valid hai?" check karna padega | SQS `DelaySeconds` **max 15 min** -- hamara 60 min escalation fit hi nahi hota; EventBridge one-off schedules par quota + latency (~1 min granularity); per-timer API call cost; cancel karne ke liye alag API call; cross-cloud portability zero |
| **Kab main ye choose karunga** | Jab timers bahut hain, precision seconds mein chahiye, aur cancel bahut hota hai (ack par) -- hamara case | Jab timers kam hain (hazaaron/day), ya jab timer aur business row ka **ek transaction** hona hi sabse zaruri hai; V1 ke liye bilkul sahi | Jab delays chhote aur fixed set ke hain (retry ladder: 1s/10s/1m) aur cancel karna nahi hota | Jab delay < 15 min, volume kam, aur team ops nahi chahti |
| **Kab main dusra choose karunga** | Agar mera Redis already overloaded hai ya team Redis operate nahi kar sakti -> DB polling | Jab 50,000 timers ek second mein due ho jaayein (storm) aur DB already peak par ho | Jab arbitrary delay ya cancel chahiye (hamara dono chahiye) -> isliye reject | Jab 60 min escalation chahiye -> reject |

**Decision:** "Redis ZSET **plus** Postgres `escalation_timers` durable copy. Ye 'ya toh Redis ya toh DB' nahi hai -- **dono**. Redis speed aur atomic claim deta hai, Postgres truth deta hai. Recovery job har 60 s `SELECT ... WHERE state='pending' AND due_at < now() + interval '5 minutes'` karke `ZADD NX` karti hai, toh Redis wipe hone ke baad bhi agle 60 s mein timers wapas aa jaate hain. **Timers ko sirf Redis mein rakhna is system ki sabse badi galti hoti** -- aur 'sirf DB mein' rakhna storm mein DB ko maar deta. Agar mera scale 100x chhota hota, main seedha `SKIP LOCKED` polling lagata aur Redis touch bhi na karta."

> Interview line: "Timers ka problem memory ka nahi hai (50K timers = 5 MB). Problem do hain: **duplicate fire** (do scheduler same timer uthayein) aur **lost timer** (Redis wipe). Pehla atomic Lua claim se solve hota hai, doosra durable copy + recovery job se."

### 4. Delivery guarantee: at-least-once vs exactly-once vs at-most-once

| | At-least-once (hamara) | Exactly-once | At-most-once |
|---|---|---|---|
| **Matlab** | Consumer DB mein likhne ke **baad** offset commit karta hai; crash par message dobara aata hai -> duplicate possible, loss nahi | Har page theek ek baar jaaye -- na kam, na zyada | Offset pehle commit, kaam baad mein -> duplicate nahi, **loss possible** |
| **Pros** | Missed page kabhi nahi (hamara #1 requirement); simple; Kafka ka natural mode (`enable.auto.commit=false`) | Theoretically perfect; customer kabhi do SMS nahi dekhta | Fastest, simplest, provider cost sabse kam |
| **Cons** | Duplicate SMS/call possible -- responder ko do baar phone bajega | **Third-party ke saath possible hi nahi.** Twilio ko HTTP call gaya, timeout aaya -- SMS gaya ya nahi, hum jaante hi nahi. Retry karo toh shayad duplicate, na karo toh shayad missed. "Exactly-once" sirf tab possible hai jab dono taraf transaction ho -- Twilio hamare Postgres transaction mein nahi hai | Kabhi kabhi page jaayega hi nahi -- **production outage kisi ko pata hi nahi chalega**. Ye product ka hi khatma hai |
| **Kab main ye choose karunga** | **Paging, alerting, payments capture, koi bhi cheez jahan loss unacceptable hai** | Sirf apne system ke andar (Kafka -> Kafka transactions, ya DB idempotency key ke saath) -- "effectively once" | Metrics, telemetry, analytics events, "typing..." indicators -- jahan ek data point kho jaana koi farq nahi padta |
| **Kab main dusra choose karunga** | Agar system marketing push bhejta (duplicate promo = user annoyed, missed promo = kuch nahi) -- tab at-most-once bhi chalega | -- | Kabhi nahi, is system mein |

**Decision:** "At-least-once, poore pipeline mein. Kafka consumers `enable.auto.commit=false`, DB write ke baad manual commit. Duplicates ko hum **kam** karte hain -- `notifications.task_id` par unique index, aur provider-side idempotency key -- par 100% nahi rok sakte, aur ye acceptable hai. Reason ek line mein: **ek extra SMS se responder irritate hoga; ek missed SMS se customer ka production 40 minute down rahega aur kisi ko pata nahi chalega.** Exactly-once yahan marketing word hai, engineering reality nahi -- kyunki Twilio ki HTTP call hamare transaction ka hissa nahi ban sakti."

### 5. Sync ingest (`201` with `incidentId`) vs async ingest (`202`)

| | Async: `202 Accepted` + `dedupKey` (hamara) | Sync: `201 Created` + `incidentId` |
|---|---|---|
| **Kya hota hai** | Ingest API sirf validate + Kafka produce karta hai (`acks=all`), phir `202 { status: "accepted", dedupKey }` | Ingest API DB mein incident insert karta hai, routing resolve karta hai, phir `201 { incidentId }` |
| **Pros** | Ingest path par **DB touch nahi** -> storm mein bhi ingest zinda (99.99% availability); latency ~5-10 ms, predictable; DB slow ho toh ingest ko farq nahi padta; backpressure Kafka lag ban jaata hai, `503` nahi | Client ko turant `incidentId` milta hai (link banane, UI dikhane ke liye); ek hi call mein sab kuch; debugging simple ("maine bheja, banna chahiye tha") |
| **Cons** | Client ko `incidentId` nahi milta (abhi bana hi nahi) -- client ko baad mein `GET /api/v1/incidents?dedupKey=` se dhoondhna padta hai; "accepted" ka matlab "processed" nahi -- agar consumer mein bug hai toh client ko pata nahi chalega | Har event par DB write (dedup query + insert) -> **6,000 eps storm par Postgres pe seedha 6,000 queries/sec**; DB slow = ingest slow = customer ka Alertmanager timeout = **events kho gaye**; ingest ki availability DB ki availability se bandh gayi |
| **Kab main ye choose karunga** | Jab ingest ka #1 kaam "kabhi mat giro" ho aur processing few seconds late chal jaaye -- **paging exactly yahi hai** (PagerDuty ka Events API v2 bhi `202` deta hai) | Jab volume kam ho (V1), ya jab client ko turant ID chahiye workflow ke liye (e.g. ticketing API) |
| **Kab main dusra choose karunga** | Agar customer contract kehta "response mein incident ID chahiye" -- tab bhi main `202` + `dedupKey` dunga aur ek `GET` endpoint dunga, kyunki availability zyada important hai | Agar mera peak 50 eps hota, sync bilkul theek tha -- ek Kafka + consumer chalana overkill hota |

**Decision:** "`202` with `dedupKey`. Customer ka monitoring tab bhejta hai jab uska system **already jal raha ho** -- us waqt hamara ingest DB ki wajah se slow nahi ho sakta. Trade-off main openly bolunga: client ko `incidentId` nahi milta aur 'accepted' ka matlab 'notified' nahi hai. Isko cover karne ke liye: `dedupKey` se lookup endpoint, aur `page_latency_seconds` metric jo accept se lekar first provider handover tak measure karta hai -- taaki hum khud jaanein ki accepted events sach mein page ban rahe hain."

### 6. Channels: push vs SMS vs voice vs email vs Slack

Ye table interview mein sabse zyada impress karta hai, kyunki isme **latency + cost + reliability + failure mode** ek saath hai.

| Channel | Typical latency | Cost (hamara volume) | Reliability | Kab fail karta hai (asli failure mode) | Hamara use |
|---|---|---|---|---|---|
| **Push (FCM/APNs)** | 1-5 s | ~$0 (3.75M/day free) | Achhi, par **guaranteed nahi** | **Phone silent / Do Not Disturb** -> notification aayi par awaaz nahi hui, banda sota raha; app force-quit; device token expire; battery optimization ne app maar diya; phone offline (push queue mein rakha jaata hai, delivered nahi) | **Pehla channel, hamesha** -- sasta aur fast |
| **SMS (Twilio)** | 2-10 s (carrier par depend) | ~$0.0075 x 2.25M = **~$17K/day** | Achhi, par carrier ke haath mein | Carrier delay (minutes tak ho sakta hai); DND registry (India mein promotional filter); **long code par ~1 SMS/sec** per number -> storm mein queue; international number par delivery fail | **Doosra channel, ~1 min baad** (per-user notification rule) |
| **Voice call (Twilio)** | 5-20 s ring | ~$0.013/min x 0.4M = **~$5K/day** | Sabse zyada "wake up" power | Phone silent mode par bhi ring karta hai (zyada tar phones mein repeated call DND break karti hai) -- isliye ye last resort hai; call reject ho jaaye; voicemail par chala jaaye (delivered dikhega par insaan ne suna nahi); DTMF input miss ho | **Teesra channel, ~5 min baad**, sirf high urgency |
| **Email (SendGrid)** | 5 s - 5 min | ~$0.0001 (1.1M/day, sasta) | Delivery reliable, **attention unreliable** | Spam folder; inbox rules; raat ko koi email nahi padhta; greylisting se 15 min delay | **Low urgency ka default** (severity `warning`/`info`), aur high urgency ka audit copy |
| **Slack** | 1-5 s | ~$0 (workspace API) | Achhi | **Slack down ho toh?** (aur Slack down hona khud ek incident hai); channel muted; raat ko koi nahi dekhta; rate limit (~1 msg/sec per channel) | Team channel par context, **kabhi akela paging channel nahi** |

**Decision:** "Escalating ladder: **push (0 min) -> SMS (1 min) -> voice (5 min)**, per-user `notification_rules` se configurable. Teen wajah:
1. **Cost:** push free hai, SMS $17K/day, voice $5K/day. Agar main sabko turant voice call karta toh bill 5x ho jaata bina reliability 5x hue.
2. **Reliability ladder:** har agla channel pichle ke failure mode ko cover karta hai -- push ka failure mode 'silent phone' hai, SMS us par bhi vibrate karta hai, voice DND bhi tod deta hai.
3. **Politeness:** 90% incidents push se hi ack ho jaate hain (p50 ack ~2 min). Baaki 10% ke liye hi SMS/voice ka paisa lagta hai.

Kab main dusra choose karunga: agar customer 'critical database down' jaise service ke liye bole 'pehle hi call karo, 1 min bhi mat waste karo' -- toh us service ki policy mein level 1 ka rule hi `0 min voice` kar dunga. Ye per-service configurable hona chahiye, hardcoded nahi."

> Ek honest baat jo interview mein bolna: **koi channel 100% nahi hai.** Isliye hum multi-channel + escalation + repeat karte hain. Reliability ek channel se nahi, **layers se** aati hai.

### 7. Single shared notification worker pool vs per-channel pools

| | Ek shared pool (sab channels ek consumer group) | Per-channel pools (sms-workers, voice-workers, push-workers, email-workers) |
|---|---|---|
| **Pros** | Simple: ek deployment, ek autoscaling policy, ek dashboard; resource utilization better (SMS slow hai toh idle workers push kar lete hain); kam infra | **Isolation:** Twilio 10 min down ho toh SMS workers atke rahenge, push aur email chalte rahenge; per-channel concurrency limit natural (`sms: 50, voice: 10, push: 500`); per-channel scaling (storm mein SMS workers 3x, push workers same); alag deploy -> SMS adapter ka bug voice ko nahi girata |
| **Cons** | **Head-of-line blocking:** Twilio slow (5 s per call) ho gaya toh saare workers SMS calls par atak jaate hain, aur push notifications (jo 50 ms leti hain) queue mein pade rehte hain -- **poora system ek provider ki speed par chala jaata hai**; ek channel ki retry storm sabko affect karti hai | Zyada deployments, zyada dashboards; ek topic ko channel ke hisaab se split karna padta hai (ya har pool poora topic padhe aur apne channel ke alawa skip kare -- waste); partitions ki planning har pool ke liye |
| **Kab main ye choose karunga** | V1/V2 -- jab volume kam hai aur ek provider ka slow hona bardasht ho sakta hai | V3 -- jab 1,000 notif/sec peak hai aur channels ki latency 100x alag hai (push 50 ms vs voice 20 s) |
| **Kab main dusra choose karunga** | Jaise hi `notification_send_duration_seconds{channel="voice"}` ki wajah se `{channel="push"}` ki latency badhne lage -- ye signal hai | Agar mere paas sirf 2 channels hain aur dono fast hain, alag pools chalana bekaar overhead hai |

**Decision:** "V3 mein per-channel pools -- alag consumer groups, ya `notifications` topic ko channel ke hisaab se sub-topics mein split. Main reason cost nahi, **isolation** hai: voice call ka round trip 20 s hai aur push ka 50 ms -- inko ek pool mein rakhna matlab push ko voice ki speed par chalana. Har pool ka apna concurrency cap bhi hota hai, jo provider throughput se match karta hai (Twilio long code ~1 SMS/sec per number -> SMS pool ka cap sender numbers x 1). V1/V2 mein ek hi pool bilkul sahi hai -- premature split karna bas ops ka bojh hai."

### 8. Monolith vs microservices for this system

| | Modular monolith (hamara V1/V2) | Microservices (V3 ka rasta) |
|---|---|---|
| **Pros** | Ek repo, ek deploy, ek test suite; `IncidentService` -> `RoutingService` -> `NotificationService` sirf function calls (network failure nahi); transaction ek DB mein; naye engineer ko samajhna aasaan; refactor karna sasta | Ingest aur notification ki **scaling profile alag hai** (ingest 6,000 eps, notification 1,000/sec) -> alag autoscale; ek service ka bug doosre ko nahi girata; alag teams alag services own kar sakti hain; provider SDK upgrade sirf notification service ko touch kare |
| **Cons** | Ingest ko scale karne ke liye notification workers bhi scale hote hain (waste); ek memory leak poore process ko marta hai; deploy sab kuch ek saath restart karta hai (aur restart ke waqt in-flight pages?) | Network calls ke beech failures; distributed tracing compulsory; dual-write / eventual consistency ke problems; local dev heavy; ops 4x |
| **Kab main ye choose karunga** | Shuruaat mein hamesha. 20,000 accounts wale product ke liye bhi modular monolith bilkul chal sakta hai agar processes alag deploy ho sakein | Jab ek component ki scaling ya failure profile baaki se sach mein alag ho -- yahan **notification workers** aur **scheduler** sabse pehle alag hone chahiye |
| **Kab main dusra choose karunga** | Jab ek team 5 se 40 engineers ho jaaye aur deploy queue ban jaaye | Agar team 5 log ki hai, microservices se delivery slow hogi, reliability nahi badhegi |

**Decision:** "Ek **modular monolith codebase**, lekin **alag deployable processes**: `api` (ingest + REST + webhooks), `incident-consumer`, `notification-worker`, `scheduler`, `dlq-worker`. Same repo, same `src/`, alag entrypoints (`workers/*.ts`). Isse mujhe microservices ka main fayda (alag scaling, alag failure domain) mil jaata hai bina distributed transaction ke dard ke. Ye spec ka decision bhi hai: **'v1 ek modular monolith hai, alag deploys optional'**. Asli microservices tab jab alag teams own karein."

### 9. Build vs buy: PagerDuty / Opsgenie / Twilio Notify

Ye sawaal interviewer aksar last mein poochta hai, aur "main sab khud banaunga" bolna **galat answer** hai.

| | Buy (PagerDuty / Opsgenie) | Buy partial (Twilio Notify / Verify, SNS) + apna logic | Build (hamara full design) |
|---|---|---|---|
| **Pros** | Din 1 se kaam karta hai; mobile apps already bane hain (iOS + Android, critical alerts entitlement ke saath jo silent mode bhi todta hai); carrier relationships, short codes, international delivery; compliance (SOC2) ready; on-call ke saare edge cases (DST, overrides, vacations) already solved | Delivery ka sabse ganda hissa (carriers, retries, opt-out, number pools) provider ke paas; hum sirf incident logic likhte hain | Product **hum hi bech rahe hain** -- toh build karna hi padega; deep customization (per-customer routing rules); cost per page apna control mein; data apne paas |
| **Cons** | Per-user per-month cost ($20-40/user) -- 500,000 responders par ye impossible hai; customization limited; vendor lock-in; data unke paas | Escalation, schedules, dedup phir bhi hum likhenge -- jo is system ka 70% hai | 6-12 mahine ka kaam; **mobile app banana** (critical alerts, push reliability) sabse under-estimate kiya hua hissa; 24x7 on-call for the on-call system; carrier/delivery ka dard |
| **Kab main ye choose karunga** | Agar hum ek normal SaaS hain jise apni team ko page karna hai -- **100% PagerDuty khareedo**, ye design mat banao | Agar hamare paas apna incident model hai (e.g. security alerts) par delivery nahi karni | Agar paging **hamara product** hai (yahi hamara case hai), ya scale itna bada hai ki per-seat pricing DIY se 10x mehenga ho |
| **Kab main dusra choose karunga** | -- | Shuru mein: hum khud Twilio par direct hain (cheaper, more control on retries) par Notify jaisa layer V1 mein time bacha sakta hai | Agar ye internal tool hota, build karna **galat** hota |

**Decision:** "Main interview mein ye line bolunga: **'Agar ye internal tool hota, main PagerDuty kharid leta aur ghar chala jaata.'** Build karna sirf isliye sahi hai kyunki paging hi hamara product hai. Aur build karte hue bhi hum sab kuch nahi banate -- Twilio (SMS + voice), FCM/APNs (push), SendGrid (email) sab khareedte hain. Hum sirf woh banate hain jo hamara **differentiator** hai: dedup, routing, escalation, on-call schedules, aur reliability. Ye distinction -- 'kaunsa hissa hamara IP hai aur kaunsa commodity' -- hi build vs buy ka asli jawab hai."

### 10. Timers app ke andar vs external scheduler

| | In-app `setTimeout` / timer wheel | External scheduler service (hamara: Redis ZSET + scheduler process) | Managed cloud scheduler |
|---|---|---|---|
| **Pros** | Zero infra; sub-ms precision; cancel = `clearTimeout`, instant | Process crash ho toh timer bacha rehta hai (Redis + Postgres mein); koi bhi scheduler instance uthata hai; HA free (atomic claim); 50K timers trivial; `timer_lag_seconds` measure kar sakte ho | Zero ops, provider durability |
| **Cons** | **Crash = saare pending timers gaye** -- 3,500 active incidents ke escalation timers ek restart mein khatam. Deploy bhi ek restart hai, matlab **har deploy par pages miss honge**; `setTimeout` max delay `2^31-1` ms = ~24.8 din (ye overflow ho toh timer **turant** fire karta hai -- silent bug); timer ek hi process ki memory mein, doosra instance nahi jaanta | Ek aur component; Redis failure domain; recovery job likhni padti hai; 1 s granularity (hamare liye kaafi) | SQS delay max 15 min; per-timer API cost; cancel mushkil; latency ~1 min granularity |
| **Kab main ye choose karunga** | Sirf **short-lived, non-critical** waits ke liye: HTTP retry backoff (200 ms), debounce, circuit breaker ka 30 s `half-open` transition -- jo kho jaaye toh koi marta nahi | **Koi bhi timer jiska miss hona business ko hurt kare** -- escalation exactly yahi hai | Jab volume bahut kam ho aur ops team na ho |
| **Kab main dusra choose karunga** | Escalation ke liye **kabhi nahi** | Agar timers hazaaron/din hon toh external scheduler overkill hai -- Postgres polling kaafi | 60 min delay chahiye -> reject |

**Decision:** "Escalation timers kabhi bhi app process ki memory mein nahi. `setTimeout` is system mein sirf tab jab uska kho jaana matter na kare -- retry backoff, circuit breaker state transition. Ek line jo interviewer ko yaad rahegi: **'Agar tumhara escalation timer `setTimeout` mein hai, toh tumhara deploy hi ek missed page hai.'**"

### 11. Delivery status: polling vs webhooks

Twilio ko SMS de diya -- lekin phone tak pahunchi? Ye pata karne ke do tareeke hain.

| | Webhook (hamara) | Polling (`GET /Messages/:sid` loop) |
|---|---|---|
| **Pros** | Status change hote hi turant pata (`queued -> sent -> delivered -> failed`); zero wasted API calls; provider ka natural model | Koi public endpoint expose nahi karna; firewall friendly; provider down ho toh hum khud retry karte hain; ordering apne haath mein |
| **Cons** | Public endpoint = attack surface -> **signature verification compulsory** (`X-Twilio-Signature`, HMAC-SHA1 over URL + params); webhook out-of-order aa sakta hai (`delivered` pehle, `sent` baad mein) -> status machine ko monotonic banao; webhook kho bhi sakta hai (provider ne 3 baar try kiya, hamara endpoint down tha); duplicate webhooks aate hain -> idempotent handler chahiye | 7.5M notifications/day x kam se kam 2 polls = 15M extra API calls/day -- rate limits aur cost; status 30-60 s late; polling loop khud ek scheduler problem ban jaata hai |
| **Kab main ye choose karunga** | Default -- volume zyada hai aur latency chahiye | Reconciliation ke liye: jo notifications 10 min se `sent` par atki hain (webhook nahi aaya), unko batch mein poll karke sach pata karo |
| **Kab main dusra choose karunga** | Agar hamara system private network mein ho aur public endpoint possible hi na ho | Agar volume chhota ho (V1 mein polling bilkul theek hai) |

**Decision:** "Webhooks primary (`POST /webhooks/twilio/status`, signature verified, idempotent, out-of-order safe), aur **ek reconciliation job** safety net ki tarah -- har 5 min woh notifications dhoondho jo 10 min se `sent` par hain aur unhe poll karo. Ye 'webhook + reconcile' pattern payment systems se aaya hai aur wahi yahan bhi sahi hai: **webhook fast path hai, polling truth hai.** Aur ek design note: **delivery status se hum paging ka decision nahi lete** -- escalation timer status ka intezaar nahi karta, kyunki `delivered` ka matlab 'insaan ne dekha' nahi hai. Sirf `ack` matlab dekha."

### 12. Prompt ke generic pairs -- is system par kya lagta hai, kya nahi

| Pair | Is system par? | Decision |
|---|---|---|
| **SQL vs NoSQL** | Haan, bada decision | **Postgres** -- partial unique index (dedup), multi-row transactions (incident + timeline + timer), relational routing graph. Raw events Kafka mein (7 din), cold incidents S3 + Parquet |
| **Sync vs Async** | Haan, core decision | Ingest **async** (`202`), kyunki availability > client convenience. Ack **sync** (`200` turant, optimistic lock ke saath) kyunki responder ko turant confirmation chahiye -- warna woh dobara ack dabayega |
| **Cache vs no cache** | Thoda | `svc:<routingKey>` -> serviceId (TTL 300 s) -- har event par ye lookup hai, cache kiye bina Postgres par 6,000 reads/sec. Incidents cache **nahi** karte -- write-heavy hain aur stale incident status dikhana khatarnak hai. **Spec bolti hai: CDN ki zarurat nahi, kyunki kuch bhi cacheable read path nahi hai** |
| **Kafka vs RabbitMQ** | Haan (section 1) | Kafka event bus ke liye (replay + ordering + multi-consumer); RabbitMQ-style per-message retry/delay ka pattern notification retry par (V2 mein BullMQ) |
| **REST vs WebSocket / Polling vs WebSocket** | Partially | Mobile app ke liye **push (FCM/APNs)** -- WebSocket battery khata hai aur background mein mar jaata hai. Web dashboard live updates ke liye **SSE** (V2), WebSocket nahi -- kyunki data ek taraf hi jaata hai (server -> browser) |
| **UUID vs Snowflake** | Chhota | `incidents.id` = **UUID v4**. Ye ID public link mein aati hai (`sho.rt/i/abc` ke peeche), toh guessable nahi honi chahiye -- Snowflake sequential hai aur incident count leak karta hai. Index bloat ka dar hai toh UUID v7 (time-ordered) le lo, par hamare volume par farq nahi padta |
| **Idempotency** | Haan, do jagah | Ingest par `Idempotency-Key` header -> `idempotency_keys` table (24 h). Delivery par `notifications.task_id` unique index. **Dono alag layer hain** -- pehla client ke retry se bachata hai, doosra hamare apne at-least-once se |

### Summary: ek table mein saare decisions

| Decision | Humne kya chuna | Kab badlenge |
|---|---|---|
| Event bus | Kafka, 24 partitions, key=`serviceId` | Chhota scale -> SQS/Postgres queue; sirf retry chahiye -> RabbitMQ |
| Incident store | Postgres (partial unique index + transactions) | 100M incidents/day -> Dynamo ya shard |
| Timers | Redis ZSET + Postgres durable copy + 60 s recovery | Chhota scale -> `SKIP LOCKED` polling only |
| Delivery guarantee | At-least-once + `task_id` unique index | Kabhi nahi (missed page unacceptable) |
| Ingest | `202 Accepted` + `dedupKey` | Chhota scale -> sync `201` |
| Channels | push (0m) -> SMS (1m) -> voice (5m), per-service configurable | Critical service -> voice at 0m |
| Worker pools | V1/V2 ek pool; V3 per-channel | Jab ek channel doosre ki latency khaaye |
| Architecture | Modular monolith, alag deploy processes | Alag teams -> alag services |
| Build vs buy | Build core (dedup/routing/escalation), buy delivery (Twilio/FCM/SendGrid) | Internal tool -> PagerDuty kharido |
| Delivery status | Webhooks + reconciliation job | Chhota scale -> polling |
| Kafka down | Local disk spool (~60 s) phir `503` -- **fail closed** | Kabhi nahi |

> Interview line: "Is system mein har decision ek hi sawaal se nikalta hai: **'agar ye component fail hua, toh kya ek page miss hoga?'** Agar haan, toh durable copy + recovery chahiye (timers). Agar nahi, toh simple rakho (delivery status). Rate limiter mein main fail-open tha kyunki limiter ka kaam bachana tha; yahan main **fail-closed** hoon kyunki accept bol ke deliver na karna sabse bada jhoot hai."
