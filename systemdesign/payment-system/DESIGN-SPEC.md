# Payment System / Idempotent API -- shared design spec (for writing Parts 1-6 consistently)

Single source of truth for the Payment System lessons. Every part must use these exact numbers, names, and decisions. Not a lesson itself (build.mjs skips it).

## Scenario
ShopKart (the e-commerce company from the Rate Limiter story) needs its own **Payment Service**. Customers pay for orders by card/UPI. ShopKart does NOT move money or store cards itself -- it integrates with an external **PSP** (Payment Service Provider: Razorpay / Stripe style). The PSP's client SDK / hosted fields tokenizes the card on the device and gives us a `paymentMethodToken` (`pm_...`), so raw card numbers never touch our servers (PCI DSS scope stays small).
Hard problem of this system: **money must move exactly once** even though networks time out, users double-click, mobile apps retry, servers crash mid-request, and PSP webhooks arrive late, twice, or out of order. The core tool is the **Idempotent API**.
Connections: URL Shortener taught unique constraints and ID generation; Rate Limiter taught atomic operations and fail-open. Payments flip that: **correctness over availability -- fail closed** (better to show "try again" than charge twice).

## Requirements
Functional:
1. Create a payment for an order: `POST /v1/payments` with a required `Idempotency-Key` header.
2. Charge through the PSP (card / UPI); support async outcomes (3-D Secure / UPI collect -> `REQUIRES_ACTION`, final result via webhook).
3. Get payment status: `GET /v1/payments/:id`.
4. Refunds, full or partial, also idempotent: `POST /v1/payments/:id/refunds`.
5. Double-entry **ledger** entry for every money movement.
6. Receive PSP **webhooks**, verify signature, dedupe, apply to the payment state machine.
7. Publish `payment.succeeded` / `payment.failed` / `refund.succeeded` events to Order and Notification services.
8. Daily **reconciliation** against the PSP settlement report.
Non-functional: correctness first (no double charge, no lost payment, ledger always balanced), exactly-once *effect* via idempotency, strong consistency for payment state + ledger + idempotency keys, durability + audit trail (7-year retention), security (PCI DSS scope reduction, webhook signature verification, authz), availability 99.95% (but fail closed on doubt), latency: dominated by PSP, p99 create ~2-3 s is acceptable.

## Numbers (verified; use exactly)
- 5M payments/day -> ~58 TPS average (5e6 / 86400 = 57.9); big sale peak 10x -> ~580, plan for **~1,000 TPS peak**.
- Each payment = ~3 DB transactions and ~10 row writes (idempotency key, payment, attempt, ledger entries, outbox, key completion) -> peak ~10K row writes/sec -- fits one well-tuned Postgres primary; not a sharding problem at this scale.
- Reads: status polls + GET ~5x writes -> ~300 avg / ~5K peak reads/s.
- Storage: ~2 KB per payment across all tables -> 10 GB/day -> ~3.65 TB/year -> ~25.5 TB for 7-year retention -> partition by month, archive old partitions to cheaper storage.
- Idempotency keys: ~1 KB each (includes stored response) x 5M = ~5 GB/day, kept 24 hours then deleted -> ~5 GB live.
- Webhooks: ~3 per payment -> ~15M/day -> ~174/s average.
- Real bottleneck is usually the **PSP** (its latency 300 ms - 3 s, its own rate limits, its outages), not our DB.

## Architecture (decided)
```
Mobile/Web client (PSP SDK tokenizes card -> pm_token)
   -> LB / API Gateway (TLS, rate limit on POST /v1/payments -- see Rate Limiter)
   -> Payment Service: N stateless Node.js (Express 5) instances
        -> PostgreSQL primary (+ sync/async replica for HA): payments, refunds, idempotency_keys, ledger_entries, webhook_events, outbox
        -> PSP API over HTTPS (timeouts, retries WITH the PSP idempotency key)
   PSP -> POST /webhooks/psp (signature verified, deduped)
   Outbox relay worker -> Kafka topic `payments.events` -> Order Service, Notification Service (idempotent consumers)
   Recovery worker (every 1 min): resumes stuck IN_PROGRESS idempotency keys and PROCESSING payments by asking the PSP
   Reconciliation job (daily): PSP settlement file vs our ledger -> mismatches to a review queue + alert
```
- Redis: **not** used for idempotency or payment state (not the source of truth; must be in the same DB transaction). Redis only for rate limiting at the gateway. Say "yahan Redis ki zarurat nahi" for the payment path.
- No CDN, no Elasticsearch. Kafka is justified by the outbox fan-out to other services (SQS/RabbitMQ also fine -- trade-off in Part 5).

## Core idempotency design (decided; Parts 2, 3, 6 must match)
- Client generates `Idempotency-Key` (UUID v4) once per logical operation ("pay for order X, attempt 1") and reuses it on every retry. Scope: `(customer_id, key)`.
- Server stores keys in **Postgres** table `idempotency_keys` (same database as payments). Request fingerprint = SHA-256 of `method + path + canonical JSON body`.
- Claim step (canonical SQL):
```sql
INSERT INTO idempotency_keys (customer_id, key, request_path, request_hash, status, recovery_point, locked_until)
VALUES ($1, $2, $3, $4, 'IN_PROGRESS', 'STARTED', now() + interval '60 seconds')
ON CONFLICT (customer_id, key) DO NOTHING
RETURNING *;
```
  - Row returned -> we own it, proceed.
  - No row -> `SELECT` the existing one:
    - different `request_hash` -> **422 `IDEMPOTENCY_KEY_REUSED`**
    - `COMPLETED` -> **replay** stored `response_code` + `response_body`, header `Idempotent-Replayed: true`
    - `IN_PROGRESS` and `locked_until > now()` -> **409 `IDEMPOTENCY_IN_PROGRESS`** (client retries after a moment)
    - `IN_PROGRESS` and lock expired (previous server crashed) -> take over with `UPDATE ... SET locked_until = now() + interval '60 seconds' WHERE customer_id=$1 AND key=$2 AND locked_until < now() RETURNING *` and resume from `recovery_point`.
- **Atomic phases** (Stripe-style) with recovery points:
  1. Tx 1: claim key; load order (amount comes from the order, NEVER from the client); insert `payments` row `CREATED` with id `pay_<ULID>`; set `recovery_point = 'PAYMENT_CREATED'`, `payment_id`.
  2. Outside any transaction: call PSP `charge` with **PSP idempotency key = our payment id** (so a retried call can never create a second charge at the PSP). Before calling, mark payment `PROCESSING` and `recovery_point = 'PSP_CALLED'`.
  3. Tx 2: apply result -> payment status (`SUCCEEDED` / `FAILED` / `REQUIRES_ACTION`), ledger entries (on success), outbox event, key `COMPLETED` with response, `recovery_point = 'FINISHED'`.
  - PSP timeout / unknown result: payment stays `PROCESSING` and the client gets **202** with status `PROCESSING`. The key is NOT completed: it stays `IN_PROGRESS` with `recovery_point = 'PSP_CALLED'` and the lock is released (`locked_until = now()`). The client's retry (same key) or the recovery worker resumes by calling `psp.getPaymentByIdempotencyKey` (or `charge` again with the same PSP idempotency key). Never mark FAILED on a timeout.
- Keys expire after 24 hours (cleanup job deletes `created_at < now() - interval '24 hours'`).
- Second safety net independent of keys: partial unique index -> at most one active/successful payment per order (protects against a double-click that sends two DIFFERENT keys).

## Payment state machine (decided)
```
CREATED -> PROCESSING -> SUCCEEDED -> PARTIALLY_REFUNDED -> REFUNDED
                      -> REQUIRES_ACTION -> SUCCEEDED | FAILED
                      -> FAILED
SUCCEEDED -> REFUNDED (full refund)
```
Transitions only via conditional update (optimistic, no locks held across PSP calls):
```sql
UPDATE payments SET status = $2, psp_payment_id = COALESCE($3, psp_payment_id), version = version + 1, updated_at = now()
WHERE id = $1 AND status = ANY($4::text[])
RETURNING *;
```
rowCount 0 -> someone else (usually the webhook) already moved it -> re-read and treat as success of the idempotent apply, never as an error. Terminal states (`SUCCEEDED`, `FAILED`, `REFUNDED`) never go backwards; late/out-of-order webhooks are ignored.

## Ledger (decided)
- Double-entry, append-only, amounts as **integer minor units** (`amount_minor BIGINT`, paise) + `currency CHAR(3)`. Never floats. In JS use `number` checked with `Number.isSafeInteger` (safe up to ~9e15 paise).
- Payment success of 49,900 paise: DEBIT `psp_clearing` 49900, CREDIT `sales_revenue` 49900 (same `transaction_id`).
- Refund 10,000: DEBIT `sales_revenue` 10000, CREDIT `psp_clearing` 10000.
- PSP fee (on settlement/reconciliation): DEBIT `psp_fees` / CREDIT `psp_clearing`.
- Invariant: per `transaction_id`, sum(DEBIT) = sum(CREDIT). No UPDATE/DELETE (enforced by DB grants); corrections = reversing entries.

## Database (decided)
```sql
CREATE TABLE payments (
  id              TEXT PRIMARY KEY,                  -- 'pay_01J8...' (ULID: sortable, app-generated)
  order_id        TEXT NOT NULL,
  customer_id     TEXT NOT NULL,
  amount_minor    BIGINT NOT NULL CHECK (amount_minor > 0),
  currency        CHAR(3) NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('CREATED','PROCESSING','REQUIRES_ACTION','SUCCEEDED','FAILED','PARTIALLY_REFUNDED','REFUNDED')),
  refunded_minor  BIGINT NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0 AND refunded_minor <= amount_minor),
  psp             TEXT NOT NULL,                     -- 'razorpay'
  psp_payment_id  TEXT NULL,
  failure_code    TEXT NULL,
  version         INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_payments_one_active_per_order ON payments (order_id)
  WHERE status IN ('CREATED','PROCESSING','REQUIRES_ACTION','SUCCEEDED','PARTIALLY_REFUNDED','REFUNDED');
CREATE UNIQUE INDEX ux_payments_psp_id ON payments (psp, psp_payment_id) WHERE psp_payment_id IS NOT NULL;
CREATE INDEX ix_payments_stuck ON payments (updated_at) WHERE status IN ('PROCESSING','REQUIRES_ACTION');

CREATE TABLE idempotency_keys (
  customer_id     TEXT NOT NULL,
  key             TEXT NOT NULL,
  request_path    TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('IN_PROGRESS','COMPLETED')),
  recovery_point  TEXT NOT NULL DEFAULT 'STARTED' CHECK (recovery_point IN ('STARTED','PAYMENT_CREATED','PSP_CALLED','FINISHED')),
  payment_id      TEXT NULL,
  response_code   INT NULL,
  response_body   JSONB NULL,
  locked_until    TIMESTAMPTZ NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, key)
);
CREATE INDEX ix_idem_created ON idempotency_keys (created_at);

CREATE TABLE refunds (
  id              TEXT PRIMARY KEY,                  -- 're_<ULID>'
  payment_id      TEXT NOT NULL REFERENCES payments(id),
  amount_minor    BIGINT NOT NULL CHECK (amount_minor > 0),
  status          TEXT NOT NULL CHECK (status IN ('PENDING','SUCCEEDED','FAILED')),
  psp_refund_id   TEXT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id              BIGSERIAL PRIMARY KEY,
  transaction_id  TEXT NOT NULL,
  account         TEXT NOT NULL,                     -- 'psp_clearing','sales_revenue','psp_fees'
  direction       TEXT NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount_minor    BIGINT NOT NULL CHECK (amount_minor > 0),
  currency        CHAR(3) NOT NULL,
  payment_id      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_ledger_payment ON ledger_entries (payment_id);
CREATE INDEX ix_ledger_account_time ON ledger_entries (account, created_at);

CREATE TABLE webhook_events (
  psp             TEXT NOT NULL,
  psp_event_id    TEXT NOT NULL,
  type            TEXT NOT NULL,
  payload         JSONB NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at    TIMESTAMPTZ NULL,
  PRIMARY KEY (psp, psp_event_id)
);

CREATE TABLE outbox (
  id              BIGSERIAL PRIMARY KEY,
  event_id        TEXT NOT NULL UNIQUE,              -- 'evt_<ULID>', consumers dedupe on this
  aggregate_id    TEXT NOT NULL,                     -- payment id
  event_type      TEXT NOT NULL,                     -- 'payment.succeeded'
  payload         JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at    TIMESTAMPTZ NULL
);
CREATE INDEX ix_outbox_unpublished ON outbox (id) WHERE published_at IS NULL;
```
Postgres chosen: ACID transactions across payment + ledger + key + outbox in ONE commit, unique/partial indexes, CHECK constraints, mature ops. READ COMMITTED isolation + unique constraints + conditional updates (no SERIALIZABLE needed). Monthly partitioning for `ledger_entries` and `payments` at retention scale.

## APIs (decided)
- `POST /v1/payments` -- headers `Authorization: Bearer <jwt>`, `Idempotency-Key: <uuid>` (required -> 400 `IDEMPOTENCY_KEY_REQUIRED` if missing). Body `{ "orderId": "ord_123", "paymentMethodToken": "pm_abc" }` (amount is read from the order server-side). Responses:
  - `201` `{ "id": "pay_01J8...", "status": "SUCCEEDED" | "FAILED" | "REQUIRES_ACTION", "amount": { "valueMinor": 49900, "currency": "INR" }, "failureCode"?: "card_declined", "nextAction"?: { "type": "redirect", "url": "..." } }` -- a decline is a valid outcome of creating a payment, so it is `201` with `status: FAILED` (and gets replayed like any other response).
  - `202` `{ "id": "...", "status": "PROCESSING" }` -- PSP outcome unknown yet (timeout); client polls GET or waits for push.
  - `400` validation / missing key, `401`, `403` (order not yours), `404` order not found, `409 IDEMPOTENCY_IN_PROGRESS`, `409 ORDER_ALREADY_PAID`, `422 IDEMPOTENCY_KEY_REUSED`, `429` rate limited, `503 PSP_UNAVAILABLE` (circuit open, nothing charged -- safe to retry with same key).
- `GET /v1/payments/:id` -- owner only, reads from primary (read-after-write).
- `POST /v1/payments/:id/refunds` -- `Idempotency-Key` required; body `{ "amountMinor": 10000, "reason": "customer_request" }`; `201` refund object; `422 REFUND_EXCEEDS_AMOUNT`.
- `POST /webhooks/psp` -- from PSP, header `X-PSP-Signature` (HMAC-SHA256 of the RAW body with the webhook secret), verify with `crypto.timingSafeEqual`, insert into `webhook_events` (`ON CONFLICT DO NOTHING` = dedupe), apply transition, respond `200` fast; on our failure respond `500` so the PSP retries.

## Names (use exactly)
- TypeScript:
```ts
type PaymentStatus = 'CREATED' | 'PROCESSING' | 'REQUIRES_ACTION' | 'SUCCEEDED' | 'FAILED' | 'PARTIALLY_REFUNDED' | 'REFUNDED';
interface Money { amountMinor: number; currency: string }           // integer paise, Number.isSafeInteger
interface PspChargeInput { idempotencyKey: string; amountMinor: number; currency: string; paymentMethodToken: string }
interface PspChargeResult { outcome: 'succeeded' | 'failed' | 'requires_action' | 'unknown'; pspPaymentId?: string; failureCode?: string; nextActionUrl?: string }
interface PspClient {
  charge(input: PspChargeInput): Promise<PspChargeResult>;
  getPaymentByIdempotencyKey(idempotencyKey: string): Promise<PspChargeResult>;
  refund(input: { idempotencyKey: string; pspPaymentId: string; amountMinor: number }): Promise<{ outcome: 'succeeded' | 'failed' | 'unknown'; pspRefundId?: string }>;
}
```
- Files (LLD): `src/routes/{payment,webhook}.routes.ts`, `src/controllers/{payment,webhook}.controller.ts`, `src/services/payment.service.ts` (orchestrates the phases), `src/services/idempotency.service.ts` (claim / replay / complete / release), `src/services/ledger.service.ts`, `src/services/refund.service.ts`, `src/domain/payment-state.ts` (allowed transitions map), `src/domain/money.ts`, `src/psp/psp-client.ts` (interface) + `src/psp/razorpay.client.ts` (HTTP impl: 10 s timeout, retries only on network/5xx/429 with exponential backoff + jitter, always same idempotency key, circuit breaker), `src/repositories/{payment,idempotency,ledger,outbox,webhook-event}.repository.ts`, `src/workers/outbox-relay.ts`, `src/workers/payment-recovery.worker.ts`, `src/jobs/reconciliation.job.ts`, `src/infra/{postgres (withTransaction helper), kafka, logger, metrics}.ts`, `src/app.ts`, `src/server.ts`.
- Kafka topic `payments.events`, key = payment id (ordering per payment). Consumers dedupe with a `processed_events(event_id PRIMARY KEY)` table in their own DB.
- Metrics: `payments_total{status}`, `payment_success_rate` (derived), `psp_request_duration_seconds{op}`, `psp_errors_total{op,reason}`, `payments_stuck_processing` (gauge: PROCESSING/REQUIRES_ACTION older than 10 min), `idempotency_replays_total`, `idempotency_conflicts_total{reason="in_progress|reused"}`, `webhook_processing_lag_seconds`, `outbox_oldest_unpublished_age_seconds`, `reconciliation_mismatches_total`, `ledger_imbalance_total` (must always be 0).

## Decisions settled while writing (parts follow these)
- The key claim is its own atomic statement and the order is read from the Order Service OUTSIDE any transaction (no HTTP call inside a DB transaction); Tx 1 is then the payment insert + `PAYMENT_CREATED`.
- Monthly partitioning applies cleanly to `ledger_entries`; for `payments`, unique indexes would need the partition key, so use a hot table + partitioned archive for old finished payments.
- "~3 transactions" = Tx 1 (claim + CREATED payment), a small Tx to mark `PROCESSING` + `recovery_point = 'PSP_CALLED'`, and Tx 2 (apply result). The Tx 2 function is `paymentService.applyChargeResult(paymentId, result)`; the webhook and recovery worker call the same function.
- Circuit breaker is checked BEFORE Tx 1, so a `503 PSP_UNAVAILABLE` never leaves a `CREATED` row behind.
- Abandoned attempts must not block the order forever: the recovery worker marks `CREATED` older than 15 min (PSP never called) and `REQUIRES_ACTION` past the PSP's expiry as `FAILED` (`failure_code = 'abandoned'` / `'action_expired'`), which frees the one-active-payment-per-order index. A fully `REFUNDED` order cannot be paid again (intended).
- Errors decided before any money moves (403, 404, 409 `ORDER_ALREADY_PAID`) complete the key and are replayed; 409 `IDEMPOTENCY_IN_PROGRESS` and 422 never touch the key.
- Refunds: reserve first with `UPDATE payments SET refunded_minor = refunded_minor + $2 WHERE id = $1 AND status IN ('SUCCEEDED','PARTIALLY_REFUNDED') AND refunded_minor + $2 <= amount_minor`, call PSP refund with the refund id as its idempotency key, release the reservation only on a definitive PSP failure.
- Idempotency cleanup deletes only `status = 'COMPLETED'` keys older than 24 h; stuck `IN_PROGRESS` keys are left for the recovery worker.
- The recovery worker only asks the PSP (`getPaymentByIdempotencyKey`) -- it cannot re-send `charge` because we don't store `paymentMethodToken`; only a client retry with the same key can. Refund recovery re-sends `refund` with the same key.
- HA: primary + 2 standbys with `synchronous_standby_names = 'ANY 1 (s1, s2)'` (RPO ~0 without one standby blocking writes).
- Outbox relay: multiple relays with `SKIP LOCKED` can reorder events of one payment; consumers must tolerate it via the state machine (or run a single leader relay when strict order is needed).
- Aggregates (ledger sums over years) use BigInt / strings; single payment amounts stay `number` checked with `Number.isSafeInteger`.
- GET on someone else's payment returns 404 (don't reveal existence).

## Style rules (every part)
- Title: `# Payment System -- HLD + LLD (Part N: A -> B -> C)` (the reader uses the text inside `(Part N: ...)` as the chapter label).
- Easy Hinglish, ASCII only (no em/en dashes, smart quotes, arrows, box-drawing, emojis), Node.js/TypeScript, `**Code Explanation:**` line-by-line after every code block, interview lines, `## Remember` + `## Quick Self-Test` (5 questions) at end, final `**Next (Part N+1):** ... "next" bolo.` line (Part 6 ends with `**Payment System complete.** Next system: **File Storage (S3-style)**. "next" bolo.`).
- Say honestly that real payment systems (Stripe, Razorpay, Adyen) are far bigger; this is the design an interviewer expects for a merchant-side payment service.
