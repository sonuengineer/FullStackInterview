# Expiring Short URLs: Cron Job or Redis TTL?

> **Same-question flag**: this is a direct instance of the exact contrast taught in [[03-ttl-deletion-at-scale]] - a batch cron sweep versus native per-key TTL expiry. That lesson already explains why the cron approach creates an avalanche and why TTL-based expiry avoids it; this is that same choice, asked directly.

## 1. The Choice

**Design A**: a background cron job periodically scans for expired short URLs and deletes them. **Design B**: store each short URL in Redis with its own TTL, letting Redis expire it natively.

## 2. The Answer: Redis TTL (Design B)

A cron job re-creates exactly the problem [[03-ttl-deletion-at-scale]] walks through: it has to scan for and batch-delete everything that's expired since the last run, all at once, on a schedule - a periodic spike instead of continuous, cheap background work, and it requires you to hand-build the batching/throttling logic to avoid a lock-heavy, disk-I/O-heavy sweep.

Redis's native TTL support does this correctly by design: each key expires **individually**, spread naturally across time as each URL's own creation time plus its own TTL dictates - no coordinated batch, no avalanche, no cron schedule to tune. Redis also serves short URL lookups from memory, which is exactly the access pattern a URL shortener needs (fast, frequent, simple key lookups) - so Redis is doing double duty as both the storage and the expiry mechanism.

## 3. Mental Model

> A cron job is a scheduled batch sweep - a shape known to cause spikes at scale. Native TTL is continuous, cheap, per-item expiry - the same "let it drain continuously instead of all at once" principle from [[03-ttl-deletion-at-scale]], with no manual batching logic to write or maintain.

## 4. 🧠 Remember

> Whenever the storage layer offers native TTL, prefer it over a cron sweep - it turns an expiry problem into something the database already does correctly and continuously, instead of something you have to build batching and throttling logic for yourself.

## 5. Quick Self-Test

1. Why does a cron-based expiry job risk recreating the "avalanche" problem from Lesson 3?
2. Why is Redis a particularly good fit for both storing and expiring short URLs, beyond just having a TTL feature?
3. In what situation might a cron-based approach still be preferable to native TTL?
