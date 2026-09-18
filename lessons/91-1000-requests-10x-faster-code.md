# 1,000 Independent Requests, 500 ms Each - the 10x Fix, With Code

*Same question as [[61-1000-requests-10x-faster]] and [[54-notify-5000-users-10x-faster]]. This version is the **code**.*

## 1. The Math

- **Sequential:** 1,000 x 500 ms = **500 s (~8.3 min)**. The program spends almost all that time **waiting** on the network.
- **The fix:** run them **concurrently** - many requests in flight at once.
- **With 10 at a time:** 1,000 / 10 = 100 rounds x 500 ms = **50 s -> 10x faster.**
- **With 50 at a time:** ~10 s -> 50x faster (if the other side can take it).

Node.js is perfect for this: waiting on I/O doesn't block the event loop, so one process can have many requests in flight ([[01-concurrency-vs-parallelism]]).

## 2. The Slow Version

```javascript
// ~500 seconds - each call waits for the previous one
for (const id of ids) {
  results.push(await fetchUser(id));
}
```

## 3. The Wrong "Fast" Version

```javascript
// Fires all 1,000 at once
const results = await Promise.all(ids.map(fetchUser));
```

It's fast on a laptop test, but in production it can:
- **Overload the other service** (or get you rate-limited: 429s),
- exhaust sockets / the connection pool,
- and **fail everything** if one request rejects (`Promise.all` fails fast).

## 4. The Right Version: Bounded Concurrency

```javascript
// Run at most `limit` tasks at the same time; keep results in the original order
async function mapWithLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  async function runner() {
    while (next < items.length) {
      const i = next++;                         // safe: JS runs this synchronously between awaits
      try {
        results[i] = { ok: true, value: await worker(items[i], i) };
      } catch (err) {
        results[i] = { ok: false, error: err.message };   // one failure doesn't kill the batch
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

// Usage: 1,000 requests, 10 at a time -> ~50 s instead of ~500 s
const results = await mapWithLimit(ids, 10, (id) =>
  fetch(`https://api.example.com/users/${id}`, { signal: AbortSignal.timeout(3000) })   // always a timeout
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }));

const failed = results.filter((r) => !r.ok);
console.log(`done: ${results.length - failed.length} ok, ${failed.length} failed`);
```

(The `p-limit` package does the same thing in one line: `const limit = pLimit(10); await Promise.all(ids.map((id) => limit(() => fetchUser(id))));`)

## 5. Choosing the Limit

- Start around **10-20** for a third-party API; respect its documented rate limit.
- For your own internal service, raise it while watching **its** latency and error rate.
- If you get **429 Too Many Requests**, lower the limit and retry with **backoff + jitter**.
- **Batch endpoints beat concurrency:** if the API supports `GET /users?ids=1,2,3...` (100 per call), 1,000 requests become **10** ([[69-orm-save-in-loop-bulk-insert]] - the same "fewer round trips" idea).

## 6. When It's Not a One-Off Script

If this runs inside an API request or needs to survive restarts (e.g. notifying 100,000 users), move it to a **queue with workers**, where concurrency is set per worker and failures retry ([[90-blog-expensive-work-in-api-lifecycle]]).

## 🧠 Remember

> Independent I/O calls shouldn't wait in line: run them concurrently, but bounded - 10x faster at 10 in flight, with a timeout per call, per-item errors, and a limit the other side can handle.

## Self-Test

1. Why is sequential `await` in a loop slow for independent calls?
2. Why is `Promise.all` over 1,000 calls risky?
3. How long would 1,000 x 500 ms take with a limit of 25?

Related: [[61-1000-requests-10x-faster]], [[54-notify-5000-users-10x-faster]], [[01-concurrency-vs-parallelism]]
