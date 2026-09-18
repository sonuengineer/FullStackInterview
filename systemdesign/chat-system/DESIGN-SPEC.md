# Chat System -- shared design spec (for writing Parts 1-6 consistently)

Single source of truth for this system's lessons. Every part MUST use these exact numbers, names, schemas and decisions. Not a lesson itself (build.mjs skips `DESIGN-SPEC.md`).

## Scenario
Hum ek **real-time messaging app** bana rahe hain (WhatsApp / Slack DM style). 1:1 chat + group chat (max 256 members), delivery receipts (**sent -> delivered -> read**, woh do grey tick aur blue tick), online / last-seen presence, typing indicator, offline hone par push notification, media (image/file) attachments, aur **multi-device sync** (phone + web dono par same history).

**Is system ki asli nayi cheez, jo pichhle saare systems se alag hai:**
Ab tak hamare saare systems **stateless request-response** the -- client request bhejta tha, server jawab deta tha, connection khatam. Chat mein server ko **client ko khud se message bhejna** padta hai, bina client ke poochhe. Iske liye connection **khula rehna** padta hai -> server **stateful** ho jaata hai -> "kaunsa user kis server se juda hai" ye ab ek design problem ban jaati hai. **Yahi is poore lesson ka dil hai.**

Connection to previous systems:
- **URL Shortener / Rate Limiter / Search** -- wahan koi bhi API node koi bhi request handle kar sakta tha (stateless, load balancer ko sochna nahi padta tha). Yahan user ka socket **ek specific gateway node** par pada hai, isliye message ko **us node tak route** karna padta hai.
- **Notification / Paging** -- jab recipient offline ho, message ko push notification banake bhejna hai. Wahi FCM/APNs path yahan reuse hota hai (hum us system ko **call** karenge, dobara nahi banayenge).
- **File Storage (S3-style)** -- media attachment chat server se hoke nahi jaata; client S3 par **presigned URL** se direct upload karta hai aur message mein sirf `mediaKey` jaata hai.
- **Payment / Idempotency** -- client-generated `messageId` (UUID) wahi idempotency key hai: network retry par message do baar nahi dikhna chahiye.
- **News Feed** -- dono mein "fan-out" shabd aata hai par matlab alag hai. Feed mein fan-out-on-write (har follower ki timeline mein copy) ek badi design choice hai; chat mein message **ek hi baar conversation ke against** store hota hai aur **delivery** fan-out hoti hai. Ye farak Part 3 mein explicitly samjhana hai.

## Requirements
Functional:
1. **1:1 aur group chat** (group max 256 members), text message max 4 KB.
2. **Real-time delivery** -- recipient online ho toh message uske screen par p95 **< 500 ms** mein dikhe.
3. **Delivery receipts:** `sent` (server ne accept kiya), `delivered` (recipient device tak pahuncha), `read` (recipient ne chat khola). Har ek alag event hai.
4. **Offline delivery** -- recipient offline ho toh message store rahe aur (a) push notification jaaye, (b) reconnect par sync ho jaaye.
5. **History + multi-device sync** -- naya device login kare ya app 3 din baad khule toh `afterSeq` se delta sync ho.
6. **Presence:** online / offline / last-seen, aur **typing indicator** (ephemeral, kabhi store nahi hota).
7. **Media attachments** -- S3 presigned upload, message mein sirf `mediaKey` + thumbnail meta.
8. **Unread counts** per conversation, aur `last_read_seq` se calculate ho.
9. **Ordering** -- ek conversation ke messages har device par **same order** mein dikhein (global order ki zarurat nahi, per-conversation kaafi hai).

Non-functional (aur KYUN):
- **Low latency (p95 < 500 ms end to end)** -- chat mein 2 second ka lag turant "app hang ho gaya" feel deta hai. Ye product ki core quality hai.
- **Availability 99.99%** -- messaging down = product down, koi workaround nahi.
- **Durability: accepted message kabhi na khoye.** Ek bhi message ka gayab hona trust todta hai. Server jab tak persist na kar le, client ko `sent` ack mat do.
- **Ordering per conversation** -- strong. Global ordering ki zarurat **nahi** hai (aur woh mehenga hota hai).
- **Scalability:** 10M concurrent open connections. Ye sabse mushkil non-functional requirement hai, kyunki ye **memory aur file descriptors** ka problem hai, CPU ka nahi.
- **Delivery semantics: at-least-once + client-side dedup** (`messageId`). Exactly-once network par possible nahi.
- Security: auth on connect, per-conversation authorization on every send, media URL leak prevention, abuse/spam control.

## Numbers (verified; use exactly)
- **50M DAU**, peak **10M concurrent WebSocket connections** (DAU ka ~20% ek saath online).
- **Messages: 50M x 40 msg/day = 2B messages/day** -> 2e9 / 86400 = **23,148 msg/sec average**; peak 3x -> **~70,000 msg/sec peak**.
- **Delivery amplification (ye number interview jeet-ta hai):**
  - 80% messages 1:1 -> 1.6B x 1 recipient = 1.6B deliveries
  - 20% messages group (avg 30 members) -> 0.4B x 29 other members = 11.6B deliveries
  - **Total ~13.2B deliveries/day = ~153,000 deliveries/sec average**, peak 3x -> **~460,000 deliveries/sec**.
  - Sikhne wali baat: **messages 23K/sec hain, par deliveries 153K/sec.** Group chat 6.6x amplification deta hai. Capacity hamesha **deliveries** par plan karo, messages par nahi.
- **Connections:** 10M concurrent / **50,000 connections per gateway node** = **200 gateway nodes** (+ headroom -> 250). Per connection memory ~20 KB (socket buffers + TLS + JS object) -> 50,000 x 20 KB = **~1 GB per node** sirf connections ke liye. Node ko 8 GB RAM do.
  - `ulimit -n` (file descriptors) har node par >= 200,000 chahiye -- default 1024 par server 1024 connections ke baad mar jaayega. Ye classic production trap hai.
- **Storage:** avg message ~300 bytes (200 B text + 100 B metadata) -> 2B x 300 B = **600 GB/day**. 1 saal hot retention = **~219 TB**, replication factor 3 -> **~657 TB**. Isiliye Cassandra/ScyllaDB (v3), Postgres nahi.
  - Receipts: 13.2B deliveries/day x ~50 B = **660 GB/day** -- **receipts messages se zyada storage khaate hain.** Isliye receipts ko compact rakho (per-user `last_delivered_seq` / `last_read_seq`, har message par row nahi).
- **Presence:** 10M connections x heartbeat har 30 s = **333,000 heartbeats/sec**. Ye messaging traffic (23K/s) se **14x zyada** hai. Sikhne wali baat: **presence messaging se mehenga hai**, isliye presence ko throttle aur scope karna padta hai.
- **Typing indicators:** kabhi persist nahi, 3 s throttle, sirf us conversation ke currently-connected members ko.
- Kafka: `chat-events` **64 partitions**, key = `conversationId` (per-conversation ordering).
- Media: 5% messages mein media, avg 300 KB -> 100M media/day x 300 KB = **30 TB/day** S3 par (chat servers se hoke bilkul nahi jaata).

## Architecture (decided)
```
Mobile / Web client
  |  WebSocket (wss://), heartbeat 30 s, reconnect w/ full-jitter backoff, resume with lastSeq
  v
L4 Load Balancer (TCP/TLS, least-connections; NOT round-robin -- connections long-lived hain)
  v
WS Gateway nodes  (250 nodes x 50K connections, STATEFUL -- ye hamara pehla stateful tier hai)
  |-- connect par JWT auth, phir socket ko userId/deviceId se bind
  |-- session registry -> Redis  `conn:<userId>:<deviceId>` = gatewayNodeId   (TTL 90 s, heartbeat par refresh)
  |-- subscribe to its own delivery channel  `gw:<nodeId>`  (Redis Pub/Sub)
  v
Chat Service (STATELESS)  -- validate, authorize, seq assign, persist, then fan out
  |-- Redis  `seq:<conversationId>`  INCR  -> per-conversation monotonic sequence number
  |-- Message store: v1 Postgres, v3 Cassandra  ((conversationId), seq DESC)
  |-- Kafka `chat-events` (64 partitions, key=conversationId) -> async consumers
  v
Delivery Workers (consumer group `delivery`)
  |-- conversation ke members nikalo -> har member ke devices nikalo
  |-- har device ka session registry lookup -> gatewayNodeId
  |-- PUBLISH to `gw:<nodeId>`  -> wahi gateway socket par push karta hai
  |-- koi session nahi mili (offline) -> Notification service ko push bhejo  [Notification lesson]
  v
Recipient device  -> `delivered` receipt wapas -> sender ko do tick

Side consumers on `chat-events`: unread-counter worker (Redis), search indexer [Search lesson], analytics, archival to S3.
Support: Postgres (users, conversations, members, devices), Redis (sessions, seq, presence, unread, typing), S3 (media), Prometheus + OpenTelemetry.
```

**Jaan-boojh kar kya NAHI liya (parts mein explicitly bolna):**
- **Sticky sessions / session affinity on the LB** -- zarurat nahi, kyunki session registry batati hai ki user kis node par hai. Sticky sessions ek anti-pattern ban jaate hain (node restart par sab toot-ta hai).
- **Socket.IO** v3 mein nahi -- raw `ws` lighter hai (per-connection memory kam). Socket.IO v1/v2 ke liye theek hai (auto-reconnect, fallback built-in). Trade-off Part 5 mein.
- **End-to-end encryption v1 mein nahi** -- Part 5 mein deeply discuss karo: E2EE ke baad server-side search, server-side fan-out of content, aur web multi-device sab mushkil ho jaate hain.
- **CDN** -- sirf media ke liye (S3 + CloudFront), messages ke liye nahi.
- **Elasticsearch** -- message search v3 ka feature, aur woh Search System lesson hai.

## Key mechanisms (decided; teach from zero)
1. **Real-time transport ki seedhi** (Part 1 mein story ke through, Part 3 mein depth):
   short polling (har 2 s `GET /messages` -> 10M users x 0.5 rps = 5M rps of mostly-empty responses, aur phir bhi 2 s lag) -> long polling (server request ko rok ke rakhta hai; better, par har message par naya HTTP request + headers) -> SSE (server -> client one-way, text only, client -> server ke liye alag HTTP) -> **WebSocket** (ek TCP connection, dono taraf, binary + text, HTTP `Upgrade` handshake se shuru). Handshake ko byte level par dikhao (`Upgrade: websocket`, `Sec-WebSocket-Key`, `101 Switching Protocols`).
2. **Session registry aur routing** -- "user A ka message user B tak kaise pahunche jab B ka socket kisi doosre node par hai": Redis `conn:<userId>:<deviceId> -> nodeId` + Redis Pub/Sub channel per node. Alternatives compare karo: (a) har gateway sabko broadcast kare (N^2, bekaar), (b) consistent hashing se user ko fixed node par map karo (rebalance problem), (c) session registry + pub/sub (**hamari choice**), (d) Kafka topic per node (partition explosion), (e) direct gRPC node-to-node (fastest, par service discovery + mesh chahiye -- v3 option).
3. **Message ID + ordering (do alag cheezein hain, ye confusion clear karna hai):**
   - `messageId` = **client-generated UUID v4** -> idempotency. Client retry kare toh server wahi message dobara insert nahi karega (unique constraint), aur client apne side par duplicate render nahi karega.
   - `seq` = **server-assigned, per-conversation monotonic integer** (`INCR seq:<conversationId>`) -> ordering + gap detection + delta sync (`afterSeq`). 
   - **Timestamp ordering kyun nahi:** client clocks galat hote hain (user manually time badal sakta hai), aur do servers ke clocks mein bhi skew hota hai. `createdAt` display ke liye hai, ordering ke liye nahi.
   - Snowflake ID kab: agar aapko globally sortable ID chahiye bina per-conversation counter ke (Part 3 mein compare karo; URL Shortener lesson se link).
4. **Delivery state machine:** `pending (client) -> sent (server persisted, ack to sender) -> delivered (recipient device ne receive kiya) -> read (recipient ne chat khola)`. Har transition ek chhota event hai jo wapas sender tak jaata hai. Group mein `delivered`/`read` = "sab members" ya "kitne members" (WhatsApp group mein sab ke liye blue tick tabhi jab sabne padha).
5. **Reconnect + sync protocol:** client reconnect par `{"type":"resume","lastSeqByConversation":{...}}` bhejta hai -> server har conversation ke liye `seq > lastSeq` wale messages bhejta hai. Reconnect backoff **full jitter** (`random(0, min(30s, 2^attempt))`) -- warna ek gateway node marne par 50,000 clients ek saath reconnect karke agle node ko maar denge (**thundering herd**; ye is system ka signature failure hai).
6. **Presence ka N-squared problem:** agar har user ke online hone par uske saare contacts ko notify karein toh 10M users x avg 200 contacts = 2B notifications per presence flip. Solution: presence **pull on demand + subscribe only to open chats** (jo screen abhi khuli hai sirf unke liye), Redis key `presence:<userId>` with TTL 90 s (heartbeat se refresh, expire ho gaya = offline), aur last-seen ko batch mein persist karo.
7. **Unread counts:** Redis `unread:<userId>:<conversationId>` INCR on delivery, `SET 0` on read; source of truth = `conversation_members.last_read_seq` (Redis khoye toh `lastMessageSeq - last_read_seq` se recompute).
8. **Backpressure:** ek slow client (2G network) ka socket buffer bharta jaata hai. `ws` ka `socket.bufferedAmount` check karo; threshold (1 MB) cross ho toh us client ko **drop** kar do -- woh reconnect karke sync kar lega. Warna ek slow client gateway node ki memory kha jaayega (**ye production mein asli OOM ka karan hota hai**).

## Names (use exactly)
- Redis keys: `conn:<userId>:<deviceId>` (-> nodeId, TTL 90 s), `gw:<nodeId>` (Pub/Sub channel), `seq:<conversationId>` (INCR counter), `presence:<userId>` (TTL 90 s), `unread:<userId>:<conversationId>`, `typing:<conversationId>` (TTL 5 s).
- Kafka: topic `chat-events` (64 partitions, key `conversationId`), consumer groups `delivery`, `unread-counter`, `push-notifier`, `archiver`.
- WebSocket frame protocol (JSON; every frame has `type`):
```ts
// client -> server
type ClientFrame =
  | { type: 'auth'; token: string; deviceId: string }
  | { type: 'send'; messageId: string; conversationId: string; body: string; mediaKey?: string }
  | { type: 'receipt'; conversationId: string; seq: number; state: 'delivered' | 'read' }
  | { type: 'typing'; conversationId: string }
  | { type: 'resume'; lastSeqByConversation: Record<string, number> }
  | { type: 'ping' };
// server -> client
type ServerFrame =
  | { type: 'auth_ok'; userId: string }
  | { type: 'ack'; messageId: string; seq: number; serverTs: string }      // 'sent' tick
  | { type: 'message'; message: ChatMessage }
  | { type: 'receipt'; conversationId: string; seq: number; userId: string; state: 'delivered' | 'read' }
  | { type: 'presence'; userId: string; status: 'online' | 'offline'; lastSeenAt?: string }
  | { type: 'typing'; conversationId: string; userId: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' };
interface ChatMessage {
  messageId: string;        // client UUID = idempotency key
  conversationId: string;
  seq: number;              // server assigned, per conversation
  senderId: string;
  body: string;
  mediaKey?: string;
  createdAt: string;        // display only, NEVER used for ordering
}
```
- Classes/files (LLD):
```
src/
  gateway/        ws-server.ts, connection-manager.ts, frame-router.ts, heartbeat.ts, backpressure.ts
  services/       chat.service.ts, presence.service.ts, receipt.service.ts,
                  conversation.service.ts, sync.service.ts, typing.service.ts
  repositories/   message.repository.ts, conversation.repository.ts, device.repository.ts,
                  session.repository.ts (Redis), receipt.repository.ts
  workers/        delivery.worker.ts, unread.worker.ts, push-notifier.worker.ts, archiver.worker.ts
  routes/         conversations.routes.ts, sync.routes.ts, media.routes.ts   (plain REST, non-realtime)
  middleware/     auth.ts, rate-limit.ts, validate.ts
  infra/          redis.ts, kafka.ts, postgres.ts, s3.ts, logger.ts, metrics.ts
  app.ts  server.ts
```
- Metrics: `ws_connections_active{node}`, `ws_connect_total`, `ws_disconnect_total{reason}`, `message_send_duration_seconds`, `message_delivery_latency_seconds` (**North Star SLI**: server accept -> recipient socket write), `deliveries_total{result}`, `fanout_size` (histogram), `offline_push_total`, `presence_heartbeats_total`, `ws_buffered_amount_bytes` (histogram), `slow_client_drops_total`, `reconnect_storm_rate`, `kafka_consumer_lag{group}`, `seq_gap_detected_total`.

## Database (v1 Postgres; v3 Cassandra for `messages`)
```sql
CREATE TABLE users (
  id UUID PRIMARY KEY, phone TEXT UNIQUE, display_name TEXT,
  last_seen_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE devices (
  id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id),
  platform TEXT NOT NULL CHECK (platform IN ('ios','android','web')),
  push_token TEXT, last_active_at TIMESTAMPTZ,
  UNIQUE (user_id, id)
);

CREATE TABLE conversations (
  id UUID PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('direct','group')),
  title TEXT,                                  -- groups only
  last_message_seq BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE conversation_members (
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  user_id         UUID NOT NULL REFERENCES users(id),
  role            TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin')),
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_read_seq   BIGINT NOT NULL DEFAULT 0,
  last_delivered_seq BIGINT NOT NULL DEFAULT 0,
  muted           BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX conversation_members_by_user ON conversation_members (user_id);
-- direct chat ke duplicate rokne ke liye: normalized pair index
CREATE UNIQUE INDEX direct_pair_uniq ON direct_pairs (user_a, user_b);  -- user_a < user_b (sorted)

CREATE TABLE messages (
  conversation_id UUID   NOT NULL,
  seq             BIGINT NOT NULL,             -- per-conversation monotonic
  message_id      UUID   NOT NULL,             -- client generated, idempotency
  sender_id       UUID   NOT NULL,
  type            TEXT   NOT NULL DEFAULT 'text' CHECK (type IN ('text','media','system')),
  body            TEXT,
  media_key       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ NULL,
  PRIMARY KEY (conversation_id, seq)
);
CREATE UNIQUE INDEX messages_msgid_uniq ON messages (conversation_id, message_id);  -- idempotency
-- Read pattern: "last N messages of a conversation" and "everything after seq X".
-- PK (conversation_id, seq) serves both with a range scan. No other index needed on the hot path.

-- v3 Cassandra equivalent (parts must show this and explain the difference):
--   CREATE TABLE messages (
--     conversation_id uuid, seq bigint, message_id uuid, sender_id uuid,
--     body text, media_key text, created_at timestamp,
--     PRIMARY KEY ((conversation_id), seq)
--   ) WITH CLUSTERING ORDER BY (seq DESC);
--   partition key = conversation_id -> ek conversation ki saari rows ek node par, seq se sorted.
--   Gotcha: ek bahut badi group (lakhs messages) = ek fat partition. Fix: bucket by month ->
--   PRIMARY KEY ((conversation_id, month_bucket), seq).
```
Why Postgres in v1: relational membership/authorization, transactions, `ON CONFLICT` idempotency, ek hi DB se sab. Kab Cassandra: jab `messages` ka write volume (23K/s) aur size (219 TB/year) ek Postgres primary se nikal jaaye -- messages append-only time-series hain, koi join nahi chahiye, yahi Cassandra ka perfect use case hai. **Membership aur users phir bhi Postgres mein rehte hain.**

## APIs
```
WebSocket:  wss://chat.example.com/ws     (frames as defined above)
REST (non-realtime):
  GET  /api/v1/conversations?cursor=            -> list with lastMessage + unreadCount
  GET  /api/v1/conversations/:id/messages?afterSeq=1200&limit=50   -> delta sync
  GET  /api/v1/conversations/:id/messages?beforeSeq=900&limit=50   -> scroll back (history)
  POST /api/v1/conversations                    { type, memberIds } -> 201
  POST /api/v1/conversations/:id/members        (admin only)
  POST /api/v1/media/presign                    { contentType, sizeBytes } -> { uploadUrl, mediaKey }
  GET  /api/v1/users/:id/presence               -> { status, lastSeenAt }
  GET  /health  /ready
```
Error codes: `401 UNAUTHENTICATED` (bad/expired token on connect), `403 NOT_A_MEMBER` (conversation ka member nahi), `413 MESSAGE_TOO_LARGE` (> 4 KB), `429 RATE_LIMITED`, `1011` WebSocket close code for server error, `4001` custom close code for auth failure.

## Decisions settled while writing (parts must follow)
- **`sent` ack tabhi jab message persist ho chuka ho.** Pehle ack dene se message kho sakta hai aur user ko lagega gaya hai. Ye durability requirement ka concrete roop hai.
- **Seq Redis se (`INCR`), par durability Postgres se.** Redis wipe ho jaaye toh `seq:<conversationId>` ko `conversations.last_message_seq` se rebuild karo (`SET ... ` only if absent). Sequence mein gap ho jaana **acceptable hai** (gap = "koi number skip ho gaya"), par **reuse kabhi nahi** -- duplicate seq do alag messages ko ek hi slot de dega.
- **At-least-once delivery, client-side dedup by `messageId`.** Duplicate message dikhna galat hai par recoverable; message kho jaana nahi.
- **Presence eventual hai aur 30-90 s tak stale ho sakti hai** -- ye bilkul theek hai aur interview mein ise confidently bolna chahiye ("last seen 2 minutes ago" ka matlab hi yahi hai).
- **Typing indicator kabhi persist nahi, kabhi retry nahi, kabhi guarantee nahi.** Fire and forget, 3 s throttle client par.
- **Slow client ko drop karo** jab `bufferedAmount > 1 MB`. Close code `1013` (try again later). Client reconnect + resume karega.
- **Heartbeat:** server har 30 s `ping` bhejta hai, 2 miss (60 s) par connection close + session registry se entry hatao. Redis TTL 90 s isse thoda zyada rakha hai (taaki race na ho).
- **Group limit 256** -- isse bada karne par fan-out aur receipts dono phat-te hain; badi groups ke liye alag design (broadcast channel / read-only announcements) chahiye. Part 5 mein discuss.
- **Media chat servers se hoke nahi jaata** (presigned S3 upload), warna 30 TB/day hamare gateways se guzarta.
- **Authorization har send par:** sender us `conversationId` ka member hai ya nahi -- membership Redis mein cache (TTL 300 s), miss par Postgres. Ye check skip karna is system ka sabse bada security hole hai.
- Pagination: `afterSeq` / `beforeSeq` (keyset), offset kabhi nahi.

## Style rules (every part)
- Title: `# Chat System -- HLD + LLD (Part N: A -> B -> C)` (reader `(Part N: ...)` ke andar ka text chapter label banata hai).
- Easy Hinglish, **ASCII only** (no em/en dash, smart quotes, arrows, box-drawing chars, emojis, checkmarks). Use `->`, `--`, `[OK]`, `[X]`.
- Node.js / TypeScript only (no Java/Python). `ws` library for WebSocket, `ioredis`, `kafkajs`, `pg`.
- Har code block ke baad `**Code Explanation:**` + line-by-line Hinglish.
- Mermaid diagrams allowed (```mermaid fenced), plus ASCII diagrams and tables.
- Har part ke end mein: `## Remember` (one memorable line) + `## Quick Self-Test` (5 questions, answers nahi) + `---` + `**Next (Part N+1):** ... "next" bolo.`
- Part 6 ends with: `**Chat System complete.** prompt.md ke saare systems cover ho gaye -- ab revision mode: har system ka Part 6 cheat sheet dobara padho. "next" bolo.`
- Har important component ke liye WHY format: Kya hai? / Kyun use kar rahe hain? / Hata dein toh kya hoga? / Kab zarurat nahi? / Interview mein kaise bolun?
