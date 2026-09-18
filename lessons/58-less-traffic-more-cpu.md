# Traffic Dropped by Half, But CPU Went From 45% to 91% - How?

## 1. Story

Yesterday: 50,000 requests/min, CPU at 45%. Today: 25,000 requests/min, CPU at 91%. No deployment. Everyone's first instinct - "it must be more traffic" - is the one thing the numbers rule out.

## 2. The Key Insight

**Requests per minute is not load.** Load is:

`load = number of requests x cost per request`

If traffic halved but CPU doubled, then **each request got about 4x more expensive**. The question becomes: *what made each request cost more?*

## 3. The Usual Suspects

**1. Fewer servers.** The autoscaler saw lower traffic and **scaled in** from, say, 8 instances to 2. Total traffic halved, but traffic *per instance* doubled. Per-server CPU goes up even though the system as a whole is quieter. Check instance count first - it's the fastest thing to rule out. (Same "autoscaler reacts to symptoms" theme as [[39-autoscaling-amplifies-outage]].)

**2. Cache hit rate collapsed.** A Redis restart, an eviction storm, a changed cache key format, or a TTL change means requests that used to be served from cache now hit the database and do full work. Fewer requests, far more work each.

**3. The traffic mix changed.** Yesterday's traffic was mostly cheap reads (homepage, product page). Today's is mostly expensive calls: search, reports, exports - or a scraper/bot hammering one heavy endpoint. Same count, very different cost.

**4. Retries and errors.** A downstream dependency started failing; clients and services now retry, so each user action produces several internal requests - and failed requests often cost more (timeouts, stack traces, logging).

**5. Data grew past a tipping point.** A table crossed a size where the query plan changed (from index scan to full scan), or an unindexed query got 10x slower as rows piled up ([[50-slow-query-500m-rows]]).

**6. Something else is using the CPU.** A cron job, a backup, a reindex, log shipping, or garbage-collection pressure from a slow memory leak ([[22-nodejs-memory-leak-debugging]]).

**7. Lock contention and spinning.** Threads waiting on hot locks or retrying optimistic updates can burn CPU without doing useful work.

## 4. How to Investigate

1. **Instance count** - did the fleet scale in?
2. **CPU per request** and **latency by endpoint** - which endpoint got expensive?
3. **Cache hit rate** over the last 48 hours.
4. **Traffic mix** by endpoint and by client/user agent - look for bots or one heavy customer.
5. **Downstream error and retry rates.**
6. **Profile the process** (CPU flame graph) to see where time is actually going.
7. **What changed** even without a deploy: config, feature flags, cron schedules, data volume ([[20-sudden-latency-spike-checklist]]).

## 5. Mental Model

> Don't watch the number of cars - watch how heavy each truck is. Half the trucks, each four times heavier, will still break the bridge.

## 6. Common Mistakes

- Alerting and capacity planning purely on request count.
- Assuming "no deploy" means "nothing changed" - caches, data size, traffic mix, and autoscaling all change without a deploy.

## 7. 🧠 Remember

> Less traffic can create more load when each request becomes more expensive - check fleet size, cache hit rate, traffic mix, retries, and data growth before blaming the code.

## 8. Quick Self-Test

1. How can scaling in make each server busier even though total traffic dropped?
2. Why can a drop in cache hit rate increase CPU even with fewer requests?
3. Which one metric would you add to dashboards so this is obvious next time?
