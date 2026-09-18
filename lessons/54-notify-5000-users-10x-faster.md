# 5,000 Notifications x 200ms = 16 Minutes. One Change Makes It 10x Faster.

> **Same-question flag**: this is [[13-hidden-latency-bottleneck]] (sequential waits add up) and [[01-concurrency-vs-parallelism]] (I/O-bound work needs concurrency, not more CPU) wearing a notification costume. What's new here is doing it **safely**: bounded concurrency, not "fire all 5,000 at once."

## 1. The Math

The loop sends one notification, waits 200ms for the provider to answer, then sends the next:

`5,000 x 0.2s = 1,000s ~ 16.7 minutes`

During each 200ms, your server is doing almost nothing - it's **waiting** on the network. The CPU is idle.

## 2. The Fix: Send Them Concurrently (With a Limit)

Keep **10 sends in flight at the same time** instead of 1:

`1,000s / 10 = 100s` -> **10x faster.** Same users, same notifications, same 200ms each.

With 50 in flight it's ~20 seconds. The limit is set by what the provider allows (rate limits) and what your connection pool can handle, not by your CPU.

## 3. Why Not Just `Promise.all` on All 5,000?

Firing 5,000 requests at once will hit the provider's rate limit, exhaust sockets/connection pools, and turn into a burst of failures and retries - the thundering herd from [[14-cascading-failure-recovery]]. **Bounded** concurrency gives you the speedup without the stampede.

## 4. Code Example

```javascript
// BEFORE: sequential, ~1,000 seconds
for (const user of users) {
  await sendNotification(user); // 200ms each, one at a time
}

// AFTER: bounded concurrency, ~100 seconds with limit 10
const pLimit = require('p-limit');
const limit = pLimit(10); // at most 10 in flight
await Promise.all(users.map(u => limit(() => sendNotification(u))));
```

## 5. Other Moves That Stack On Top

- **Batch API**: many providers (FCM, SES, Twilio) accept many recipients per call - 5,000 users might become 5 calls.
- **Queue + workers**: put 5,000 jobs on a queue and let several workers drain it, with retries and idempotency - the design from [[17-notification-system-design]]. The API returns immediately instead of blocking for minutes.

## 6. 🧠 Remember

> When time is spent waiting, not computing, the fix is overlap: run the I/O concurrently with a sensible limit, and the total drops from the sum of all waits to roughly the sum divided by the concurrency.

## 7. Quick Self-Test

1. Why doesn't a faster CPU help this job at all?
2. Why is a concurrency limit of 10-50 safer than sending all 5,000 at once?
3. How would a provider's batch API change the math?
