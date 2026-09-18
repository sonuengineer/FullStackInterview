# Notification / PagerDuty-style Paging -- shared design spec (for writing Parts 1-6 consistently)

Single source of truth for this system's lessons. Every part MUST use these exact numbers, names, schemas and decisions. Not a lesson itself (build.mjs skips `DESIGN-SPEC.md`).

## Scenario
Hum ek **on-call incident alerting product** bana rahe hain (PagerDuty / Opsgenie jaisa), plus uske andar ek general **multi-channel notification delivery** engine.

Flow: customer ke monitoring tools (Prometheus Alertmanager, Datadog, Sentry, cron jobs, custom scripts) hamari **Events API** par event bhejte hain -> hum events ko **dedupe** karke **incident** banate hain -> incident ko service ki **escalation policy** + **on-call schedule** se resolve karke sahi insaan nikalte hain -> us insaan ko **push / SMS / voice call / email / Slack** se page karte hain -> agar `ackTimeoutMin` ke andar **acknowledge** nahi hua toh **escalate** karke agle level par jaate hain.

Ek line mein: **"Ek machine ka alert, sote hue insaan ke phone tak, guaranteed, minutes mein."**

Connection to previous systems:
- **Rate Limiter** se: Events API par per-routing-key token bucket lagta hai (alert storm ek customer ko throttle kare, sabko nahi), aur har user ke liye notification throttle / quiet hours bhi ek rate limit hi hai.
- **URL Shortener** se: short links (`sho.rt/i/abc`) SMS mein incident link bhejne ke kaam aate hain (SMS 160 chars).
- **Payment System / Idempotency** se: `dedupKey` + `Idempotency-Key` wahi concept hai -- same request do baar aaye toh do incident / do SMS nahi banne chahiye.

## Requirements
Functional:
1. `POST /v2/enqueue` par event accept karo: `routingKey`, `eventAction` (`trigger` | `acknowledge` | `resolve`), `dedupKey`, `payload{ summary, source, severity, customDetails }`, optional `Idempotency-Key` header. Response `202 Accepted` + `dedupKey`.
2. **Dedup:** same `(serviceId, dedupKey)` ka trigger jab tak incident `resolved` nahi hota, naya incident NAHI banega -- purane incident par sirf timeline entry + counter badhega (`occurrenceCount`).
3. **Incident state machine:** `triggered -> acknowledged -> resolved` (+ `triggered -> resolved` auto-resolve monitoring se). Har transition timeline mein audit hoti hai.
4. **Routing:** service -> escalation policy -> level -> target (schedule ya user) -> on-call user(s) at time T -> us user ke enabled contact methods + notification rules.
5. **Multi-channel delivery:** push (FCM/APNs), SMS (Twilio), voice call (Twilio), email (SendGrid), Slack. Per-user notification rules: "0 min push, 1 min SMS, 5 min voice call".
6. **Escalation:** level ka `ackTimeoutMin` (default 5 min) khatam -> agle level par page, `repeatCount` (default 2) ke baad stop + timeline mein "escalation exhausted".
7. **Acknowledge / resolve** mobile app, web, email link, ya **SMS reply "4"** / voice DTMF "4" se ho sake. Ack hote hi saare pending escalations + pending notifications **cancel**.
8. **Quiet hours / low-urgency:** `severity=info|warning` wale low-urgency alerts sirf email/digest jaate hain (koi raat ko phone nahi bajta); `critical|error` high-urgency -> full paging.
9. **Alert grouping / storm control:** ek hi service se 1 min mein 10+ naye incidents -> incidents bante rahenge par notifications ek grouped page mein collapse ho jaayenge ("Service checkout: 63 new incidents").

Non-functional (aur KYUN):
- **Reliability sabse upar** -- ek page ka miss hona = production outage kisi ko pata hi nahi chala. Policy: **"duplicate page is OK, missed page is NOT"** (at-least-once delivery).
- **Latency SLO:** event accept -> first notification provider ko handover, **p95 < 5 s, p99 < 10 s**. Paging hi product hai; 2 min late page bekaar hai.
- **Availability 99.99%** ingest path par -- customer ka monitoring tab bhejta hai jab uska system already jal raha ho. Hamara system unke worst moment par upar hona chahiye.
- **Durability:** accepted event kabhi kho na jaaye (`202` dene se pehle Kafka mein committed).
- **Correctness / idempotency:** retry se duplicate incident nahi.
- **Security:** routing key = secret, per-account isolation, PII (phone/email) encrypted, provider webhook signature verification.
- Scalability: alert storms 10x-50x spike normal hain (ek DC down -> sab kuch ek saath alert karta hai).

## Numbers (verified; use exactly)
- 20,000 customer accounts, 500,000 responder users, ~100,000 services (`routingKey` per service).
- **Events ingested: 50M/day** -> 50e6 / 86400 = **579 events/sec average**; storm peak 10x -> **~6,000 events/sec peak**.
- **Dedup ratio ~95%** (monitoring har 30-60 s repeat bhejta hai jab tak problem hai) -> **2.5M incidents/day** = **~29 incidents/sec** avg, peak ~300/sec.
- **Notifications: avg 3 per incident** (push + SMS, phir ek escalation) -> **7.5M notifications/day** = **~87/sec** avg, peak ~1,000/sec.
  - Channel split assume: push 50% (3.75M), SMS 30% (2.25M), email 15% (1.1M), voice 5% (0.4M).
- **Cost (interview mein bolne layak):** SMS ~$0.0075 -> 2.25M x 0.0075 = **~$17K/day**; voice ~$0.013/min -> 0.4M x 0.013 = **~$5K/day**. Isliye push pehle, SMS baad mein, voice last -- **cost bhi ek design constraint hai**, sirf latency nahi.
- **Storage:**
  - Raw events: Kafka topic `incident-events`, 50M/day x ~1 KB = **50 GB/day**, retention 7 days = **350 GB** (replication factor 3 -> ~1 TB disk).
  - `incidents`: 2.5M/day x ~2 KB = **5 GB/day**, 90-day hot retention = **~450 GB** Postgres (monthly partitions), usse purana S3 + Parquet.
  - `notifications` + `notification_attempts`: 7.5M x ~500 B = **~4 GB/day**, 30-day retention = ~120 GB.
- **Active incidents at any moment** (yehi timers ka load hai): ack p50 ~2 min, p95 ~10 min -> 29/s x 120 s = **~3,500 active** typical, storm mein ~50,000. Redis ZSET mein 50K members x ~100 B = **5 MB** -- trivial. Timers memory problem nahi hain, **poll fairness aur duplicate-fire problem hai**.
- Twilio per-account throughput: ~**1 SMS/sec per long code**, short code ~100/sec -> peak 1,000 notif/sec ke liye **multiple sender numbers + provider-side queue**; isliye workers ko per-provider concurrency cap chahiye (Rate Limiter lesson wapas aaya).
- Kafka partitions: `incident-events` **24 partitions** (peak 6K eps / ~250 eps per partition safe budget), key = `serviceId` (ordering per service). `notifications` **48 partitions**, key = `incidentId`.

## Architecture (decided)
```
Monitoring tools / API clients
   |  POST /v2/enqueue  (routingKey, dedupKey, eventAction)
   v
Load Balancer
   v
Ingest API (N stateless Node.js instances, Express 5)
   |-- routingKey -> serviceId lookup (Redis cache, Postgres fallback)
   |-- rate limit per routingKey (token bucket, Rate Limiter lesson)
   |-- validate + produce to Kafka `incident-events` (acks=all)  --> 202 Accepted
   v
Kafka `incident-events` (24 partitions, key=serviceId)
   v
Incident Service (consumer group, Node.js workers)
   |-- dedup + state machine  -> Postgres (incidents, incident_events timeline)
   |-- routing: escalation policy -> level -> schedule -> on-call user
   |-- produce notification tasks -> Kafka `notifications`
   |-- schedule escalation timer -> Redis ZSET `sched:escalations` (+ Postgres escalation_timers durable copy)
   v                                    ^
Notification Workers (consumer group)   |  due timers
   |-- per-user notification rules, quiet hours, grouping                Scheduler Service (Timer)
   |-- provider adapters: FCM/APNs | Twilio SMS | Twilio Voice |          |-- ZRANGEBYSCORE due
   |   SendGrid | Slack                                                   |-- produce to `escalations`
   |-- retry w/ backoff+jitter, circuit breaker per provider, DLQ
   |-- writes notifications + notification_attempts
   v
Providers  --(delivery status webhook)-->  Webhook API --> Postgres + metrics
                                                  ^
Responder (mobile app / web / SMS reply "4") -----|  POST /incidents/:id/acknowledge
```
Support pieces: Postgres primary + 2 read replicas (dashboards read replicas se), Redis (routingKey cache, dedup fast-path, timers, locks, grouping counters), S3 (cold incidents + raw event archive), Prometheus/Grafana + OpenTelemetry tracing.

**Kya JAAN-BOOJH kar nahi liya (parts mein explicitly bolna):**
- **CDN:** kuch cache nahi hota, sab write path. Nahi chahiye.
- **Elasticsearch:** v1 mein nahi (incident search Postgres se); v3 mein "search incidents by text" ke liye aa sakta hai -> woh next system (Search System) ka topic hai.
- **Microservices har cheez ke liye:** v1 ek modular monolith hai (ingest + incident + notify ek hi codebase, alag deploys optional).
- **WebSocket:** mobile app ke liye push (FCM/APNs) kaafi hai; web dashboard live updates ke liye SSE v2 mein.

## Key algorithms / mechanisms (decided)
1. **Dedup (Postgres unique index, not just Redis):**
```sql
CREATE UNIQUE INDEX incidents_open_dedup_uniq
  ON incidents (service_id, dedup_key)
  WHERE status <> 'resolved';
```
   `INSERT ... ON CONFLICT (service_id, dedup_key) WHERE status <> 'resolved' DO UPDATE SET occurrence_count = incidents.occurrence_count + 1, last_seen_at = now() RETURNING (xmax = 0) AS inserted;`
   `xmax = 0` ka matlab: row **naya insert** hua (naya incident -> page karo), warna existing incident tha (sirf counter badha -> page mat karo). Redis sirf **fast path** hai (network/DB bachane ke liye), **source of truth Postgres ka partial unique index hai** -- kyunki Redis eviction/failover par duplicate incident ban sakta hai.
2. **Idempotency key** (Payment lesson se link): `Idempotency-Key` header -> `idempotency_keys(account_id, key, request_hash, response_json, created_at)`, 24 h TTL. Same key + same body -> stored response; same key + different body -> `409 IDEMPOTENCY_KEY_REUSED`.
3. **Escalation timers:** Redis **ZSET** `sched:escalations`, member = `escalationTimerId`, score = `dueAtMs`. Scheduler har 1 s ek **atomic Lua claim** chalata hai:
```lua
-- KEYS[1] = 'sched:escalations', ARGV[1] = now ms, ARGV[2] = batch size
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
if #due > 0 then redis.call('ZREM', KEYS[1], unpack(due)) end
return due
```
   Claim + remove ek hi atomic step mein, isliye do scheduler instances same timer do baar fire nahi karenge. Durable copy `escalation_timers` table mein (Redis wipe ho jaaye toh recovery job Postgres se ZSET rebuild karta hai -- **timers ko sirf Redis mein rakhna is system ki sabse badi galti hogi**).
   Alternatives compare karne hain: DB polling (`SELECT ... WHERE due_at <= now() FOR UPDATE SKIP LOCKED`), Kafka delayed topics (fixed delay tiers), SQS delay (max 15 min -> hamara 60 min escalation fit nahi hota), in-process timer wheel (`setTimeout`, crash = timer gaya), cron (1 min granularity + thundering herd).
4. **On-call resolution:** `resolveOnCall(scheduleId, at: Date): User[]` -- layers (rotation `daily` | `weekly` | `custom` with `handoffAt` anchor + IANA `timezone`), phir `schedule_overrides` (specific window par kisi aur ko) apply. Rotation index = `floor((at - handoffAt) / rotationLengthMs) % memberIds.length`. **DST bug** (spring-forward par 2 AM handoff exist hi nahi karta) explicitly discuss karna hai -- store UTC instants, compute with IANA tz (Luxon), never `new Date(y, m, d)` local.
5. **Delivery retries:** per-attempt exponential backoff **with full jitter**: `delay = random(0, min(30000, 1000 * 2^attempt))` ms, max 5 attempts per channel, phir agla channel / DLQ. Provider 4xx (invalid number) = **permanent fail, retry mat karo**; 5xx / timeout / 429 = retry.
6. **Circuit breaker per provider:** rolling window 30 s, >50% failures in >=20 requests -> `open` 30 s -> `half-open` 5 probe requests. Open hote hi **failover provider** (Twilio -> MessageBird) ya channel downgrade (SMS fail -> voice).
7. **Ack race:** do responders same second mein ack karein -> `UPDATE incidents SET status='acknowledged', acknowledged_by=$1, version=version+1 WHERE id=$2 AND status='triggered' AND version=$3` (optimistic locking). 0 rows = koi aur pehle kar gaya -> `200` with current state (idempotent, user ko error mat dikhao).
8. **Grouping / storm control:** Redis counter `grp:<serviceId>:<minuteBucket>` INCR; count > 10 -> individual notifications rok kar ek grouped notification per 5 min (`"checkout: 63 new incidents"`), incidents phir bhi banenge (audit chahiye).

## Names (use exactly)
- Kafka topics: `incident-events`, `notifications`, `escalations`, `notifications-dlq`. Consumer groups: `incident-service`, `notification-workers`, `escalation-consumer`.
- Redis keys: `svc:<routingKey>` (serviceId cache, TTL 300 s), `dedup:<serviceId>:<dedupKey>` (fast path, TTL 6 h), `sched:escalations` (ZSET), `grp:<serviceId>:<minute>`, `cb:<provider>` (circuit breaker state), `rl:events:<routingKey>` (token bucket, Rate Limiter format).
- TypeScript types:
```ts
type EventAction = 'trigger' | 'acknowledge' | 'resolve';
type Severity = 'critical' | 'error' | 'warning' | 'info';
type IncidentStatus = 'triggered' | 'acknowledged' | 'resolved';
type Channel = 'push' | 'sms' | 'voice' | 'email' | 'slack';
type NotificationStatus = 'queued' | 'sent' | 'delivered' | 'failed' | 'cancelled';

interface IncomingEvent {
  routingKey: string;
  eventAction: EventAction;
  dedupKey?: string;              // absent -> hash(summary + source)
  payload: { summary: string; source: string; severity: Severity; customDetails?: Record<string, unknown> };
  receivedAt: string;             // ISO, ingest API stamps it
  eventId: string;                // uuid v4, ingest API stamps it
}
interface Incident {
  id: string; serviceId: string; dedupKey: string; status: IncidentStatus;
  severity: Severity; summary: string; source: string;
  occurrenceCount: number; escalationLevel: number; escalationRound: number;
  acknowledgedBy: string | null; createdAt: Date; lastSeenAt: Date; resolvedAt: Date | null;
  version: number;                // optimistic lock
}
interface NotificationTask {
  taskId: string;                 // idempotency key for at-least-once delivery
  incidentId: string; userId: string; channel: Channel; contactMethodId: string;
  attempt: number; escalationLevel: number; scheduledFor: string;
}
interface ProviderResult { providerMessageId: string; status: 'sent' | 'failed'; permanent?: boolean }
interface NotificationProvider {
  name: string; channel: Channel;
  send(task: NotificationTask, address: string, incident: Incident): Promise<ProviderResult>;
}
```
- Classes/files (LLD, same layered style as previous systems):
```
src/
  routes/           events.routes.ts, incidents.routes.ts, webhooks.routes.ts
  controllers/      events.controller.ts, incidents.controller.ts, provider-webhook.controller.ts
  services/         incident.service.ts, routing.service.ts, oncall.service.ts,
                    notification.service.ts, escalation.service.ts, grouping.service.ts
  repositories/     incident.repository.ts, service.repository.ts, policy.repository.ts,
                    schedule.repository.ts, notification.repository.ts, timer.repository.ts
  providers/        provider.interface.ts, twilio-sms.provider.ts, twilio-voice.provider.ts,
                    fcm.provider.ts, sendgrid.provider.ts, slack.provider.ts, provider-registry.ts
  workers/          incident.consumer.ts, notification.worker.ts, scheduler.ts, dlq.worker.ts
  middleware/       auth.ts, rate-limit.ts, idempotency.ts, validate.ts
  infra/            kafka.ts, redis.ts, postgres.ts, logger.ts, metrics.ts, tracing.ts
  utils/            dedup-key.ts, backoff.ts, circuit-breaker.ts, time.ts
  app.ts  server.ts
```
- Metrics: `events_ingested_total{action}`, `incidents_created_total{severity}`, `dedup_hits_total`, `notification_send_duration_seconds{channel,provider}`, `notification_attempts_total{channel,provider,result}`, `page_latency_seconds` (event accept -> first provider handover; **North Star SLI**), `escalations_fired_total{level}`, `timer_lag_seconds` (dueAt vs actual fire -- alert > 10 s), `dlq_depth`, `circuit_breaker_state{provider}`, `kafka_consumer_lag{topic,group}`.

## Database (Postgres; schema decided)
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
Why Postgres: relational data (service -> policy -> schedule -> user), transactions (incident + timer + timeline ek transaction mein), partial unique index dedup ke liye, partitioning se retention easy. Why not MongoDB: multi-entity transactional correctness aur constraints yahan core hain, flexible schema ki zarurat nahi. Why Kafka (not RabbitMQ) for the event bus: replay (bug fix ke baad 7 din ke events dobara process), ordering per service key, multiple independent consumer groups (incident service + analytics + audit), high throughput. RabbitMQ per-message ack/retry/delay ke liye achha hai -- notification retry level par uska pattern bhi discuss karna hai.

## APIs
```
POST /v2/enqueue                     # Events API (routingKey in body, PagerDuty-compatible shape)
  202 { "status": "accepted", "dedupKey": "cpu-high-web-3" }
GET  /api/v1/incidents?status=triggered&serviceId=&cursor=   # keyset pagination (URL Shortener lesson)
GET  /api/v1/incidents/:id           # incident + timeline
POST /api/v1/incidents/:id/acknowledge   { "userId" }   -> 200 current state (idempotent)
POST /api/v1/incidents/:id/resolve       { "userId", "note" }
POST /api/v1/incidents/:id/notes
GET  /api/v1/oncall?scheduleId=&at=      -> [{ userId, name, until }]
POST /webhooks/twilio/status         # provider delivery status (signature verified)
POST /webhooks/twilio/inbound        # SMS reply "4" = acknowledge
GET  /health   GET /ready
```
Error codes: `400 VALIDATION_ERROR`, `401 INVALID_ROUTING_KEY`, `409 IDEMPOTENCY_KEY_REUSED`, `429 RATE_LIMITED`, `503 INGEST_UNAVAILABLE` (Kafka down and local spool full).

## Decisions settled while writing (parts must follow)
- **Ingest returns 202, not 201:** incident processing async hai. Client ko `dedupKey` wapas milta hai, `incidentId` nahi (abhi bana hi nahi). Trade-off explicitly discuss karo (sync banate toh latency + DB coupling, storm mein ingest gir jaata).
- **Kafka down par ingest:** local disk spool (bounded, ~60 s worth) + uske baad `503`. **Fail closed on ingest** (jhoot mat bolo ki accept kar liya) -- ye Rate Limiter ke "fail open" se ulta hai, aur yahi contrast lesson hai: **accepting a page you cannot deliver is worse than rejecting it loudly.**
- **At-least-once everywhere:** Kafka consumer `enable.auto.commit=false`, DB write ke baad manual commit. Duplicate SMS possible -> `notifications.task_id` unique index + provider-side idempotency key se mostly rukta hai, par **100% exactly-once nahi**, aur ye acceptable hai (design principle #1).
- **Ack cancels work:** ack par (a) `escalation_timers.state = 'cancelled'`, (b) Redis ZSET se `ZREM`, (c) queued notifications `status='cancelled'` aur worker send se pehle DB/Redis mein `cancelled` check karta hai (last-moment check, kyunki task already queue mein ho sakta hai).
- **Low urgency kabhi voice/SMS nahi** -- `severity` -> urgency mapping service level par configurable, default: `critical|error` = high, `warning|info` = low.
- **Timer granularity 1 s** (scheduler tick), acceptable lag budget 10 s; alert on `timer_lag_seconds > 10`.
- **Scheduler HA:** 2+ instances chal sakte hain kyunki claim atomic Lua hai; leader election ki zarurat nahi (mention karo ki leader-based design bhi valid hai par single point of failure ban jaata hai).
- **Recovery job:** har 60 s Postgres se `SELECT ... WHERE state='pending' AND due_at < now() + interval '5 minutes'` -> ZSET mein `ZADD NX`. Ye Redis wipe/failover ke baad timers wapas laata hai (idempotent kyunki `ZADD NX` + `state` check).
- **Phone numbers encrypted at rest** (`address_enc`, envelope encryption with KMS); logs mein phone masked (`+91XXXXXX1234`).
- **Voice call ack:** DTMF "4" press = acknowledge (PagerDuty convention), SMS reply "4" bhi.
- Pagination: keyset/cursor (`created_at, id`), offset pagination nahi (URL Shortener Part 4 ka rule).

## Style rules (every part)
- Title: `# Notification / Paging System -- HLD + LLD (Part N: A -> B -> C)` (reader `(Part N: ...)` ke andar ka text chapter label banata hai).
- Easy Hinglish, **ASCII only** (no em/en dash, smart quotes, arrows, box-drawing chars, emojis, checkmarks). Use `->`, `--`, `[OK]`, `[X]`.
- Node.js / TypeScript code only (no Java/Python).
- Har code block ke baad `**Code Explanation:**` + line-by-line Hinglish.
- Mermaid diagrams allowed (```mermaid fenced), plus ASCII diagrams. Tables for comparisons.
- Har part ke end mein: `## Remember` (one memorable line) + `## Quick Self-Test` (5 questions, answers nahi) + `---` + `**Next (Part N+1):** ... "next" bolo.`
- Part 6 ends with: `**Notification / Paging System complete.** Next system: **Search System**. "next" bolo.`
- Har important component ke liye WHY format: Kya hai? / Kyun use kar rahe hain? / Hata dein toh kya hoga? / Kab zarurat nahi? / Interview mein kaise bolun?
