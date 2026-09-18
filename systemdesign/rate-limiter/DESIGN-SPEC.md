# Rate Limiter -- shared design spec (for writing Parts 1-6 consistently)

This is the single source of truth for the Rate Limiter lessons. Every part must use these exact numbers, names, and decisions. Not a lesson itself (build.mjs skips it).

## Scenario
A SaaS company exposes a public REST API (like Stripe/GitHub style) to customers via API keys, plus a web/mobile app (logged-in users) and some anonymous endpoints (signup, login, public search). We must protect backend services and the database from abuse, bugs in customer scripts (retry loops), scraping, brute-force login, and enforce per-plan quotas (free vs pro).
Connection to previous system: URL Shortener used a `createUrlLimiter` middleware and Part 4 of it showed a simple Redis fixed-window limiter. This system goes deep into how a production rate limiter works.

## Requirements
Functional:
1. Limit requests per client identity: API key (`apiKey`), logged-in user (`userId`), or IP (`ip`) for anonymous traffic.
2. Different rules per plan and per route. Default rules:
   - `api-free`: 100 requests/min per API key (capacity 100, refillPerSec 100/60 = ~1.67)
   - `api-pro`: 1000 requests/min per API key (capacity 1000, refillPerSec ~16.67)
   - `anon-ip`: 60 requests/min per IP (capacity 60, refillPerSec 1)
   - `login`: 5 attempts/min per (IP + username) (capacity 5, refillPerSec 5/60), stricter endpoint rule
3. Rejected requests get HTTP 429 with headers `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (seconds), and `Retry-After` (seconds). Allowed requests also get the RateLimit-* headers.
4. Rules changeable without redeploy (stored in Postgres, cached in memory, refreshed every 30s).
5. Per-client overrides (enterprise customer gets custom limit).
Non-functional: very low latency (adds < 2 ms p99), highly available (limiter failure must not take the API down), accurate enough (small over-admission OK, not exact), scalable to peak traffic, distributed (limits are global across all Node instances, not per instance).

## Numbers (verified; use exactly)
- 10M active client identities/day (API keys + users + IPs)
- 2B API requests/day -> ~23K RPS average (2e9 / 86400 = 23,148), peak 4x -> ~92.6K, say **~100K RPS peak**
- Every request = 1 rate-limit check = 1 Redis round trip (EVALSHA of Lua script)
- NOT read-heavy: every check is read + write (counter update). So a cache in front doesn't help like in URL shortener -- key insight.
- Memory: ~150 bytes per bucket key (hash with 2 fields + key + overhead) x 10M = ~1.5 GB. TTL removes idle keys. Memory is not the bottleneck; **throughput is**.
- Redis throughput: plan ~50K Lua-script ops/sec per primary as a safe budget -> 100K peak needs Redis Cluster with **3 primaries** (~33K each) + 1 replica each.
- Sliding log would need per-request entries: 10M keys x ~100 entries x ~60 bytes = ~60 GB -> rejected.
- Network to Redis: ~300 bytes per check x 100K = ~30 MB/s -- fine.
- Rules: a few hundred rows -- KBs, trivially cached.
- Rejections: assume ~1% of requests -> ~20M 429s/day -> log sampled, count in metrics.

## Architecture (decided)
```
Client -> DNS -> Load Balancer / API Gateway -> N stateless Node.js API instances (Express 5)
                                                  |-- rateLimit() middleware (runs BEFORE auth-heavy work and business logic; after cheap API-key identification)
                                                  |-- Redis Cluster (bucket state, Lua token bucket)  [source of truth for counters; ephemeral]
                                                  |-- RuleCache (in-memory) <- Postgres rate_limit_rules (refresh every 30s)
                                                  |-- Prometheus metrics
```
- Placement options discussed: client-side (can't trust), in-app middleware (our choice, v1-v2), API gateway (Kong/Envoy/nginx limit_req) for coarse per-IP limits at the edge, separate rate-limit service (Envoy global rate limit service, gRPC) at large scale / polyglot services. Our design: middleware library + shared Redis; edge gateway does coarse IP flood protection.
- No queue needed (rate limiter must answer synchronously). No DB on the hot path. No CDN.

## Algorithm (decided)
Primary: **Token bucket**, implemented as an atomic **Redis Lua script** using Redis server time (`TIME`) to avoid clock skew between Node servers. Compare in Part 3: fixed window (boundary burst: 2x limit at window edge), sliding window log (exact but memory heavy), sliding window counter (good approximation, 2 counters), leaky bucket (smooths output, queue-based), token bucket (allows bursts up to capacity, then steady refill rate). Why token bucket: burst-friendly for real API clients, O(1) memory (2 fields), one atomic script, industry-used (AWS API Gateway, Stripe).

Canonical Lua script (use verbatim; Part 3 explains it line by line, Part 2 references it):
```lua
-- KEYS[1] = bucket key
-- ARGV[1] = capacity, ARGV[2] = refill tokens per second, ARGV[3] = cost
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])

local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil then
  tokens = capacity
  ts = now
end

local elapsed = math.max(0, now - ts)
tokens = math.min(capacity, tokens + elapsed * rate / 1000)

local allowed = 0
local retry_after = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry_after = math.ceil((cost - tokens) * 1000 / rate)
end

redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity * 1000 / rate) + 1000)

return { allowed, math.floor(tokens), retry_after }
```
Registered in Node with ioredis: `redis.defineCommand('tokenBucket', { numberOfKeys: 1, lua: TOKEN_BUCKET_LUA })` -> `const [allowed, remaining, retryAfterMs] = await redis.tokenBucket(key, capacity, refillPerSec, cost)`.

## Names (use exactly)
- Redis key: `rl:<ruleId>:<identifierValue>` e.g. `rl:api-free:ak_live_9f2c`, `rl:login:203.0.113.7:priya@example.com`. Single-key script, so no hash tags needed (mention hash tags `{...}` only when a script touches multiple keys in Redis Cluster).
- TypeScript types:
```ts
type Identifier = 'apiKey' | 'userId' | 'ip';
interface RateLimitRule {
  id: string;               // 'api-free'
  identifier: Identifier;
  routePattern: string;     // '/api/v1/*' or 'POST /auth/login'
  plan: 'free' | 'pro' | 'enterprise' | null;
  capacity: number;         // max burst
  refillPerSec: number;     // steady rate
  failMode: 'open' | 'closed';
  enabled: boolean;
}
interface RateLimitDecision {
  allowed: boolean;
  limit: number;            // capacity
  remaining: number;
  retryAfterMs: number;     // 0 when allowed
  resetSec: number;         // seconds until bucket full again = ceil((capacity - remaining) / refillPerSec)
}
```
- Classes/files (LLD): `src/middleware/rate-limit.ts` (`rateLimit(ruleResolver)` Express middleware: builds identity, calls service, sets headers, 429), `src/services/rate-limiter.service.ts` (`RateLimiterService.check(rule, identityValue, cost = 1): Promise<RateLimitDecision>`, handles Redis failure -> fallback), `src/stores/redis-token-bucket.store.ts` (`RedisTokenBucketStore.consume(key, rule, cost)`), `src/stores/memory-token-bucket.store.ts` (`MemoryTokenBucketStore` -- same algorithm in process memory, used as fallback), `src/rules/rule.repository.ts` (Postgres), `src/rules/rule-cache.ts` (`RuleCache` refresh every 30s, keeps last good copy if DB is down), `src/lua/token-bucket.lua`, `src/utils/key-builder.ts`, `src/infra/{redis,postgres,logger,metrics}.ts`, `src/app.ts` (composition root), `src/server.ts`.
- ioredis options: `enableOfflineQueue: false, maxRetriesPerRequest: 1, commandTimeout: 20` (limiter budget is tighter than URL shortener's 50 ms), Redis Cluster client `new Redis.Cluster([...])` at scale.
- Failure policy: Redis error/timeout -> **fall back to `MemoryTokenBucketStore` with capacity and refill divided by the number of instances** (approximate global limit), increment metric `rate_limiter_fallback_total`, log warn (sampled). `failMode` only matters when NO decision is possible at all (e.g. rules never loaded at startup, or an unexpected bug in the limiter): `open` rules allow the request, `closed` rules (used for `login`) reject with 503. When only Redis is down, every rule (including `login`) uses the local fallback, which still limits. Generally: **fail open (with local fallback) for normal API traffic; availability over strictness.**
- Metrics names: `rate_limit_checks_total{rule,result="allowed|rejected"}`, `rate_limit_check_duration_seconds` (histogram), `rate_limiter_fallback_total`, `rate_limit_rule_cache_age_seconds`, Redis latency/ops.

## Database (rules only; counters never in SQL)
```sql
CREATE TABLE rate_limit_rules (
  id              TEXT PRIMARY KEY,                 -- 'api-free', 'login'
  description     TEXT,
  identifier      TEXT NOT NULL CHECK (identifier IN ('apiKey','userId','ip')),
  route_pattern   TEXT NOT NULL,                    -- '/api/v1/*', 'POST /auth/login'
  plan            TEXT NULL,                        -- 'free' | 'pro' | 'enterprise' | NULL
  capacity        INT NOT NULL CHECK (capacity > 0),
  refill_per_sec  NUMERIC(12,4) NOT NULL CHECK (refill_per_sec > 0),
  fail_mode       TEXT NOT NULL DEFAULT 'open' CHECK (fail_mode IN ('open','closed')),
  enabled         BOOLEAN NOT NULL DEFAULT true,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE rate_limit_overrides (
  client_id       TEXT NOT NULL,                    -- API key id or user id
  rule_id         TEXT NOT NULL REFERENCES rate_limit_rules(id),
  capacity        INT NOT NULL,
  refill_per_sec  NUMERIC(12,4) NOT NULL,
  expires_at      TIMESTAMPTZ NULL,
  PRIMARY KEY (client_id, rule_id)
);
```
Why Postgres for rules: small, relational, audited, changes rarely. Why Redis for counters: in-memory speed, atomic Lua, TTL; counters are ephemeral (losing them = limits reset briefly, acceptable).

## APIs
- The limiter is mostly middleware (no public endpoint). Headers on every limited response, 429 body: `{ "error": "RATE_LIMITED", "message": "Too many requests", "retryAfterSec": 12 }`.
- Admin API (internal, authenticated + authorized admin role): `GET /admin/v1/rate-limit-rules`, `PUT /admin/v1/rate-limit-rules/:id`, `PUT /admin/v1/rate-limit-overrides/:clientId/:ruleId`.
- Option at scale (standalone service): `POST /v1/ratelimit/check { "ruleId", "identity", "cost" }` -> `{ allowed, remaining, retryAfterMs }` (or gRPC like Envoy RLS). Mention as Version 3, not v1.

## Decisions settled while writing (parts follow these)
- Fallback per-instance capacity = `Math.max(1, Math.floor(capacity / INSTANCE_COUNT))`, refill = `refillPerSec / INSTANCE_COUNT`; `INSTANCE_COUNT` comes from config/env (or the orchestrator). Trade-off: small rules like `login` get looser (instances x 1) during a Redis outage instead of blocking everyone.
- Rules never loaded at startup: `/auth/*` fails closed, everything else fails open; `/health` reports `rulesLoaded` for the readiness probe.
- `NUMERIC(12,4)` stores 5/60 as 0.0833, so real login `Retry-After` is 13 s, not 12 (examples use exact 5/60 and note the difference).
- Minimum Redis 5 (script effects replication for `TIME` + writes).
- Several rules can match one request: check all, header shows the one with the lowest remaining.

## Style rules (every part)
- Title: `# Rate Limiter -- HLD + LLD (Part N: A -> B -> C)` (the reader uses the text inside `(Part N: ...)` as the chapter label).
- Easy Hinglish, ASCII only (no em/en dashes, smart quotes, arrows, box-drawing, emojis), Node.js/TypeScript, `**Code Explanation:**` line-by-line after every code block, interview lines, `## Remember` + `## Quick Self-Test` (5 questions) at end, final `**Next (Part N+1):** ... "next" bolo.` line (Part 6 ends with `**Rate Limiter complete.** Next system: **Payment System / Idempotent API**. "next" bolo.`).
