# Redis Goes Down for 30 Seconds - How Do You Stop the Database From Collapsing?

## 1. The Story

Your API serves 20,000 requests per second. Redis answers 95% of reads, so the database only sees ~1,000 queries per second - and it's sized for that.

Redis goes down for 30 seconds. Your code falls back to the database: **"cache miss? just query the DB."** Now the database gets **20,000 queries per second - 20x its normal load**. Queries slow down, connections pile up, timeouts start, clients **retry**... and the database collapses. When Redis comes back, the DB is still drowning ([[14-cascading-failure-recovery]]).

**The cache wasn't just a speed-up. It was protecting the database.** Losing it removes the protection.

## 2. The Defences (layer them)

### 1. Don't wait on a dead Redis - short timeouts + circuit breaker
If every Redis call waits 5 seconds to time out, your API is slow **and** threads/connections pile up. Set short timeouts (e.g. 50-100 ms). After several failures, **open a circuit breaker**: skip Redis entirely for a few seconds, then try again.

### 2. Limit how hard you hit the database
Put a **concurrency limit** in front of the fallback queries - e.g. at most 200 DB queries in flight per server. Requests beyond that **wait briefly or fail fast** with a friendly error. Better to fail some requests than to take the database (and everyone) down. This is **load shedding**.

### 3. Collapse duplicate requests (request coalescing / single-flight)
If 5,000 requests ask for the same hot key ("homepage products"), only **one** should query the database; the other 4,999 wait for that same promise.

### 4. Serve stale data
A small **in-process cache** (a few seconds to minutes) in each server keeps the hottest items available even when Redis is gone. Slightly stale data beats an outage for most reads (product lists, config) - not for money or permissions.

### 5. Degrade features, not the whole site
Turn off non-essential expensive features (recommendations, "people also viewed") while Redis is down, so core flows keep working.

## 3. Code: All the Layers Together (Node.js)

```javascript
const pLimit = require('p-limit');                 // or your own limiter
const dbLimit = pLimit(200);                        // max 200 DB fallback queries in flight
const inFlight = new Map();                         // single-flight: key -> promise
const local = new Map();                            // tiny stale cache: key -> { value, at }

let redisDownUntil = 0;                             // simple circuit breaker

async function cachedGet(key, loadFromDb, ttlSec = 60) {
  // 1. Try Redis unless the breaker is open
  if (Date.now() > redisDownUntil) {
    try {
      const hit = await withTimeout(redis.get(key), 80);       // don't wait on a dead Redis
      if (hit) return JSON.parse(hit);
    } catch {
      redisDownUntil = Date.now() + 5000;                       // open the breaker for 5s
    }
  }

  // 2. Serve slightly stale local data if we have it (fresh enough)
  const stale = local.get(key);
  if (stale && Date.now() - stale.at < 5 * 60_000) return stale.value;

  // 3. Single-flight: only one DB query per key at a time
  if (inFlight.has(key)) return inFlight.get(key);
  const p = dbLimit(() => loadFromDb())              // 4. bounded DB load (load shedding)
    .then((value) => {
      local.set(key, { value, at: Date.now() });
      if (Date.now() > redisDownUntil) {
        redis.set(key, JSON.stringify(value), 'EX', ttlSec + Math.floor(Math.random() * 30)).catch(() => {});
      }
      return value;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}
```

(In production, bound the `local` map with an LRU so it can't grow forever, and add a queue-wait timeout to the limiter.)

## 4. When Redis Comes Back: Avoid the Second Wave

- The cache is **empty** (cold). If every request rebuilds at once, you get a **stampede** again. Single-flight and TTL **jitter** (the `+ Math.random() * 30` above) spread the rebuilds out ([[16-synchronized-connection-pool-expiry]] - same "everything at once" trap).
- **Pre-warm** the hottest keys before sending full traffic back.
- Don't let the autoscaler add 10 more servers against the struggling DB - that makes it worse ([[39-autoscaling-amplifies-outage]]).

## 5. Prevent It in the First Place

- **Managed Redis with a replica and automatic failover** (e.g. ElastiCache Multi-AZ) - a 30-second outage becomes a few seconds.
- **Size the database for "cache is gone" for at least a short time**, or know exactly how much it can take.
- **Separate Redis roles:** sessions and queues shouldn't share an instance with a disposable cache.
- **Alert** on cache hit ratio and DB connection usage - you'll see trouble before it becomes an outage.


## 🧠 Remember

> A cache protects the database, so plan for losing it: short timeouts and a circuit breaker, a cap on fallback DB queries, one query per hot key, stale data where it's safe - and jittered, gradual refill when Redis returns.

## Self-Test

1. Why can a 30-second cache outage keep the database down for much longer?
2. What does single-flight (request coalescing) save you?
3. Why add random jitter to TTLs when refilling the cache?

Related: [[14-cascading-failure-recovery]], [[16-synchronized-connection-pool-expiry]], [[39-autoscaling-amplifies-outage]], [[44-distributed-locking-with-redis]]
