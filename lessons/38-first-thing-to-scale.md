# 10K Users Works Perfectly. 1M Users Breaks. What's the FIRST Thing You'd Change?

> **Connects to**: [[15-simple-vs-scalable-architecture]] (don't reach for the big rewrite first), [[04-handling-traffic-spike-15k-rps]] and [[28-scaling-database-reads]] (cache first, most of the time), [[13-hidden-latency-bottleneck]] (a chain of sequential calls to the database multiplies the cost of every request).

## 1. The Question

`User -> API -> Database` (drawn as several database hops in the original diagram - worth reading as the API making multiple round trips to the database per request, the same sequential-call pattern from [[13-hidden-latency-bottleneck]]). Works fine at 10K users. Falls over at 1M. First thing to change: **A) Database, B) API, C) Caching, or D) Architecture?**

## 2. The Answer: C - Caching, and Here's the Ordering Logic Behind It

**Answer: Caching**, as the *first* move - not because the others are wrong eventually, but because of cost, speed, and risk, in that order:

- **Cost**: adding a cache in front of hot reads is cheap to build and cheap to run compared to re-architecting or swapping the database engine.
- **Speed to implement**: a cache can be added incrementally, in front of existing code, without a rewrite - it can ship in days, not a quarter.
- **Leverage**: if the diagram really does show the API making multiple sequential round trips to the database per request (as in [[13-hidden-latency-bottleneck]]), a single cache hit can eliminate *all* of those round trips at once for repeat reads - the multiplier effect makes caching's payoff even larger here than in a single-round-trip system.
- **Risk**: swapping the database (A) or redesigning the architecture (D) are both large, risky, slow-to-validate changes - exactly the kind of move [[15-simple-vs-scalable-architecture]] warns against making before cheaper options are exhausted. Tweaking the API code alone (B) helps efficiency but doesn't address the fundamental math of far more users generating far more repeated database load.

## 3. The General Ordering Principle

When a system starts failing at higher scale, the cost-ordered sequence to reach for is usually:

1. **Caching** - remove repeated, avoidable load first; cheapest, fastest, highest immediate leverage.
2. **Query/API optimization** - fix N+1 queries, add missing indexes, reduce round trips.
3. **Read replicas / horizontal scaling of the app tier** - once the above are genuinely insufficient.
4. **Full architecture redesign or database replacement** - the last resort, reserved for when the workload has fundamentally outgrown what incremental fixes can address.

## 4. Mental Model

> Scaling problems are usually solved cheapest-fix-first, not most-impressive-fix-first - caching is almost always the highest return on effort at the moment a system first starts to strain, and the big rewrite is what you reach for only after the cheap wins are proven insufficient.

## 5. 🧠 Remember

> When a system that worked at 10K users breaks at 1M, reach for caching first - it's the cheapest, fastest, highest-leverage fix, and it's what turns "the database is the bottleneck" into "most requests never touch the database at all."

## 6. Quick Self-Test

1. Why is caching usually a better *first* move than swapping the database or rearchitecting?
2. If the diagram represents multiple sequential database round trips per request, why does that make caching's payoff even bigger?
3. In what situation would caching genuinely *not* be the right first move?
