# 1,000 Independent Requests x 500ms = 8.3 Minutes. One Change Makes It 10x Faster.

> **Same-question flag**: this is exactly [[54-notify-5000-users-10x-faster]] with different numbers, and it rests on [[13-hidden-latency-bottleneck]] and [[01-concurrency-vs-parallelism]]. Short recap only.

## The Answer

The requests are **independent** and each one spends its 500ms **waiting** on I/O, not using CPU. Run them **concurrently with a limit** instead of one after another:

- Sequential: `1,000 x 0.5s = 500s` (~8.3 min)
- 10 in flight at once: `500s / 10 = 50s` -> **10x faster**
- 50 in flight: ~10s

```javascript
const pLimit = require('p-limit');
const limit = pLimit(10);
const results = await Promise.all(urls.map(u => limit(() => fetch(u))));
```

## The Two Things Interviewers Listen For

1. **"Bounded"** - not `Promise.all` on all 1,000 at once, which can hit rate limits, exhaust connections, and cause a retry storm ([[14-cascading-failure-recovery]]).
2. **"Independent"** - if request B needs A's result, you can't overlap them; concurrency only helps work that doesn't depend on each other.

Bonus: check for a **batch endpoint** (1 call for 100 items) - often a bigger win than concurrency.

## 🧠 Remember

> Independent, I/O-bound work should overlap: total time goes from the sum of all waits to roughly the sum divided by your concurrency limit.
