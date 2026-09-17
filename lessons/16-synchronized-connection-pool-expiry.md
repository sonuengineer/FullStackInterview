# Synchronized Connection Pool Expiry (Same Thundering Herd, Different Costume)

> **Similar-question flag**: this is the *same root pattern* as [[14-cascading-failure-recovery]] — a Thundering Herd. Last time it was retries piling up after an outage; this time it's a connection pool where everything was born together, so everything dies together. The core lesson doesn't need repeating — what's actually new here is *where* it shows up and which of the three fixes is the real one.

## 1. Story

Every 30 minutes, latency spikes for exactly 20 seconds. Traffic is flat, CPU and memory are fine, nobody deployed anything. Digging in, you find all 200 database connections in the pool were created together — and they all expire together, every 30 minutes, on the dot.

## 2. Why This Happens

Connection pools (HikariCP, pgbouncer, most JDBC/ODBC pools) are typically configured with a single **max lifetime** — e.g. "recycle every connection after 30 minutes" — to avoid stale connections. If all 200 connections were created at roughly the same moment (commonly at app startup, or when the pool first filled), they all share the same birth time, so they all hit that 30-minute lifetime at the same instant. The pool then has to close and re-establish all 200 connections in a tight burst — and queries queue up behind that churn for the ~20 seconds it takes to recover. Same disease as [[14-cascading-failure-recovery]]'s thundering herd: **many things acting in perfect synchrony create a burst the system isn't sized to absorb instantly.**

## 3. Evaluating the Three Options You Were Given

- **Change the lifetime** (e.g. 30 min -> 2 hours): this only makes the spike **less frequent**, not gone. It doesn't fix the synchronization — you'll get the exact same 20-second stall, just every 2 hours instead of every 30 minutes. Not a real fix by itself.
- **Add jitter** (the actual fix): give each connection a randomized variance on top of the base lifetime (e.g. 30 min ± a random 0-5 min per connection), so they expire at *different* moments and reconnections spread out over time instead of arriving as one burst. This is the exact same principle as "exponential backoff with jitter" from [[14-cascading-failure-recovery]], applied to connection lifetimes instead of retries.
- **Pre-warming**: establish the pool's connections gradually/staggered at startup instead of all at once. This prevents the *original* synchronization from ever happening — if they're never born in sync, they won't expire in sync 30 minutes later either.

**Best answer: do both jitter and pre-warming.** Pre-warming fixes the cause (how they were born); jitter is ongoing insurance even if something else re-synchronizes them later (e.g. a full pool restart after a deploy).

## 4. Code Example

```javascript
// HikariCP-style config: fixed lifetime = synchronized expiry risk
const badConfig = { maxLifetime: 30 * 60 * 1000 }; // all connections die together

// Jitter added: spreads expiry across a window instead of one instant
function jitteredLifetime(baseMs, jitterMs) {
  return baseMs + Math.floor(Math.random() * jitterMs);
}
const perConnectionLifetime = jitteredLifetime(30 * 60 * 1000, 5 * 60 * 1000);
```

## 5. Production Reality

This exact "synchronized expiry" pattern shows up far beyond database connections: TTL-based cache entries all set with the same expiry, cron jobs scheduled "every 30 minutes" that all started at the same deploy time, or a Kubernetes rolling restart where too many pods land on the same restart interval. Any time a fleet of things shares a fixed lifetime *and* a shared birth time, expect a periodic burst unless jitter is deliberately added.

## 6. 🧠 Remember

> Anything born together dies together, unless you add jitter — a synchronized lifetime creates a synchronized failure burst, the same thundering herd from Lesson 14 wearing a different costume.

## 7. Quick Self-Test

1. Why does simply increasing the connection lifetime not fix the underlying problem?
2. Why is doing *both* jitter and pre-warming better than picking just one?
3. Name one other place in a real system (not database connections) where this exact synchronized-expiry pattern could bite you.
