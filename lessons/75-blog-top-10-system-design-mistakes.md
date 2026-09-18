# Blog: Top 10 Mistakes in System Design Interviews

*Each mistake below comes with what it sounds like in the room, what to do instead, and the lessons in this library that teach the fix.*

---

## 1. Skipping Requirements

**Sounds like:** "Okay, so we'll have a load balancer, then..." within the first 30 seconds.

**Instead:** spend the first few minutes on numbers - QPS (peak, not average), p95 latency target, data size, retention, regions, and consistency needs. Every later decision depends on them.

-> [[30-workload-before-conclusion]], [[15-simple-vs-scalable-architecture]]

## 2. Drawing Boxes Before the API and Data Model

**Sounds like:** a beautiful diagram that can't answer "how do I get a user's last 20 orders?"

**Instead:** define the main API calls and the core tables/entities first. Then draw components that serve those calls.

-> [[11-what-is-an-api]], [[71-parking-lot-lld-review]]

## 3. Treating the Database as Infinite

**Sounds like:** "and we store it in the database" - with no index plan, no hot-key discussion, no partitioning, no read-replica vs cache trade-off.

**Instead:** say which queries matter, which index serves each one, and what happens when one key or tenant gets hot.

-> [[57-two-indexes-still-slow-composite]], [[21-database-partitioning]], [[28-scaling-database-reads]]

## 4. Ignoring Backpressure

**Sounds like:** "we'll put it in a queue" - an unlimited queue with no load shedding and no timeouts, until every dependency gets dogpiled.

**Instead:** bound your queues, set timeouts, shed load with `429`, and scale consumers carefully.

-> [[04-handling-traffic-spike-15k-rps]], [[23-queue-backlog-after-spike]], [[39-autoscaling-amplifies-outage]]

## 5. No Connection Pooling

**Sounds like:** nothing - it simply never comes up. Then one request = one new DB connection, and the database melts at 2k RPS.

**Instead:** mention pooled connections, pool size vs DB max connections, and what happens when the pool is exhausted.

-> [[16-synchronized-connection-pool-expiry]], [[53-blog-senior-system-design-without-big-scale]]

## 6. Retries Without Rules

**Sounds like:** "and if it fails, we retry." No jitter, no max attempts, no idempotency key, no circuit breaker - a guaranteed retry storm.

**Instead:** exponential backoff with jitter, a retry budget, idempotency keys, and a circuit breaker.

-> [[14-cascading-failure-recovery]], [[32-payment-idempotency-double-click]]

## 7. Assuming Exactly-Once

**Sounds like:** "the consumer processes each message once." It won't: duplicates, reordering, and partial failures across services happen.

**Instead:** design for at-least-once delivery with idempotent consumers, and use an outbox where state and messages must stay in sync.

-> [[19-idempotent-consumer-duplicate-events]], [[65-pagerduty-incident-dedup-paging]]

## 8. Observability as an Afterthought

**Sounds like:** "we'll add monitoring." No SLIs/SLOs, no tracing, no plan for metric cardinality, no structured logs.

**Instead:** name the 2-3 SLIs that define "working" (e.g. p99 latency, error rate, queue lag), and say how you'd trace one request across services.

-> [[02-debugging-random-500-errors]], [[20-sudden-latency-spike-checklist]]

## 9. Hand-Waving Deploys

**Sounds like:** the design exists, but nobody knows how it changes. No migrations, rollbacks, versioning, dark launches, or capacity planning.

**Instead:** mention backward-compatible schema changes, versioned APIs and events, feature flags, and rollback.

-> [[68-schema-change-producer-vs-consumer]], [[18-http-status-codes-400-404-409-422]]

## 10. Not Talking About Failure Modes

**Sounds like:** a design that only works when everything is healthy.

**Instead:** walk through what happens on an AZ outage, a cache stampede, clock skew, a poison message, and a slow dependency - and how you recover.

-> [[12-multi-az-availability]], [[10-clock-skew-last-write-wins]], [[44-distributed-locking-with-redis]]

---

## The Pattern Behind All 10

Every mistake is the same thing in different clothes: **describing the happy path of an imaginary system instead of the real behavior of a system under load and failure.** Interviewers aren't grading the boxes. They're grading whether you can predict what breaks.

## 🧠 Remember

> Clarify numbers first, define the API and data first, then design for limits, retries, duplicates, deploys, and failure - that's what separates a senior answer from a diagram.
