# Blog: Rate Limiting - What Happens When Thousands of Users Hit Your API at Once?

*Rate limiting protects your system from traffic spikes, abuse, and accidental overload. Here's how it works, in plain terms, with examples.*

---

## The Problem

Without rate limiting, one user, one buggy script, or one bot can send thousands of requests and use up the capacity meant for everyone:

`requests keep increasing -> server overloaded -> legitimate users get slow responses or errors`

**Real example:** a partner's integration has a bug and retries in a tight loop - 5,000 requests per second. Without limits, your whole API slows down for every customer. With limits, only that partner gets `429 Too Many Requests`, and everyone else doesn't notice. (This is load shedding, from [[04-handling-traffic-spike-15k-rps]].)

## The Idea

**Term: Rate limiting** - capping how many requests a client can make in a time period, e.g. **100 requests / minute / user**.

`request arrives -> check this client's usage -> under the limit: allow | over the limit: reject (429) or delay`

## The Four Common Algorithms (Simple Version)

**1. Fixed window** - count requests per calendar minute (12:00-12:01, 12:01-12:02...).
- Simple: one counter per user per minute.
- **Weakness:** a user can send 100 at 12:00:59 and 100 more at 12:01:00 - 200 requests in 2 seconds, right at the boundary.

**2. Sliding window** - count requests in the **last 60 seconds** from right now, not the calendar minute.
- Fixes the boundary burst.
- Exact version (store every timestamp) costs more memory; a common approximation blends the current and previous window counts.

**3. Token bucket** - each user has a bucket holding up to N tokens that refills at a steady rate (e.g. 100 tokens, +1.67 per second). Each request spends one token; no token, no request.
- **Allows short bursts** (up to the bucket size) while enforcing the average rate. The most popular choice for APIs (AWS API Gateway and Stripe-style limits work this way).

**4. Leaky bucket** - requests go into a queue that drains at a **fixed** rate, like water leaking from a bucket at a steady drip. If the bucket is full, new requests are dropped.
- **Smooths traffic** into a perfectly steady flow - good for protecting a fragile downstream that can't handle bursts.

| Algorithm | Allows bursts? | Smooth output? | Complexity |
|---|---|---|---|
| Fixed window | Yes, even at boundaries (bad) | No | Very low |
| Sliding window | Controlled | Mostly | Medium |
| Token bucket | Yes, up to bucket size | No | Medium |
| Leaky bucket | No | Yes | Medium |

## Where to Implement It

- **API gateway / CDN / WAF** - blocks abuse before it reaches your servers. Cheapest place to stop floods.
- **Load balancer** - coarse per-IP protection.
- **Application** - where you know *who* the user is and *which plan* they're on (free vs paid limits).
- **Distributed limiter in Redis** - so all your servers share one count.

Most real systems use more than one layer: coarse IP limits at the edge, precise per-user limits in the app.

## The Multi-Server Problem

If you have 5 servers and each keeps its own in-memory counter, a user effectively gets **5x the limit**. The limit must be shared - usually a Redis counter that every server updates atomically.

```javascript
// Fixed-window limiter shared by all servers (Redis)
async function allow(userId, limit = 100, windowSec = 60) {
  const key = `rl:${userId}:${Math.floor(Date.now() / 1000 / windowSec)}`;
  const count = await redis.incr(key);                 // atomic, safe across servers
  if (count === 1) await redis.expire(key, windowSec); // counter cleans itself up
  return count <= limit;
}

app.use(async (req, res, next) => {
  if (await allow(req.user.id)) return next();
  res.set('Retry-After', '60');
  res.status(429).json({ error: 'Too many requests, slow down.' });
});
```

For token/sliding-window versions in production, run the whole check as one **Lua script** in Redis so read-and-update is atomic (the same "don't split check and act" rule from [[26-duplicate-email-race-condition]]), or use a proven library.

## Design Decisions You Must Make

- **Per user, per IP, or per API key?** Per IP punishes whole offices behind one IP; per user needs authentication first. Often: per IP for login/signup, per user or API key everywhere else.
- **What happens at the limit?** Return **`429 Too Many Requests`** with a **`Retry-After`** header, and ideally `RateLimit-Remaining` headers so clients can slow down on their own.
- **Reject or queue?** Reject for interactive APIs (fast feedback). Queue for background work that can wait ([[23-queue-backlog-after-spike]]).
- **Different limits per endpoint:** login gets strict limits (brute-force protection), search gets tighter limits than cheap reads, paid plans get higher limits.
- **What if Redis is down?** Decide: *fail open* (allow traffic, risk overload) or *fail closed* (block traffic, risk an outage). Most APIs fail open with a local fallback limit.

## Common Mistakes

- Per-server in-memory counters behind a load balancer (users get N times the limit).
- Returning `500` instead of `429`, so clients retry immediately and make it worse ([[14-cascading-failure-recovery]]).
- No limits on login and password-reset endpoints - the favorite target for bots ([[66-blog-before-first-backend-job]]).
- Clients retrying on `429` without backoff and jitter, turning a limit into a retry storm.

## 🧠 Remember

> Rate limiting caps each client's share so one user or bot can't take down the service for everyone: pick the algorithm by how you want bursts handled, share the count across servers (usually Redis), and answer clearly with 429 + Retry-After.

## Self-Test

1. Why can a fixed window allow 2x the limit in a short time?
2. Why does token bucket suit most APIs better than leaky bucket?
3. What goes wrong if each server keeps its own counter?
