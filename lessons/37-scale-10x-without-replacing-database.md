# Database Handles 10,000 RPS, You Suddenly Need 100,000 - Without Replacing It

> **Connects to**: [[28-scaling-database-reads]] (the full technique breakdown), [[21-database-partitioning]] (partitioning/sharding vocabulary), and [[15-simple-vs-scalable-architecture]] / [[30-workload-before-conclusion]] (ask what's actually driving the number before picking a fix).

## 1. The First Question, Not the First Answer

Before reaching for any technique: is that 100,000 requests/sec mostly **reads**, mostly **writes**, or a mix? The right fix is completely different depending on the answer, so naming a solution before asking this is the same mistake called out in [[30-workload-before-conclusion]].

## 2. If It's Read-Heavy (the common case)

Apply the techniques from [[28-scaling-database-reads]] in order of cost: a **caching layer** (Redis) in front of hot, frequently-read data removes the highest-volume repeated reads entirely; **read replicas** multiply read throughput horizontally; **indexing/query optimization** reduces the cost of each remaining read; only reach for **sharding** ([[21-database-partitioning]]) once the above are demonstrably insufficient.

## 3. If Writes Are the Real Constraint

- **Batch writes** instead of one round trip per write, where the workload tolerates it.
- **Queue writes** through a message queue and let workers apply them at a sustainable rate, decoupling incoming request volume from database write throughput (the same decoupling principle from [[17-notification-system-design]]).
- **Sharding by write key** to spread writes across multiple database instances, since a single primary has a hard write-throughput ceiling that caching cannot help with (caching only helps reads).
- **Connection pooling and pruning slow queries** so existing write capacity isn't wasted on inefficient operations.

## 4. Mental Model

> "Without replacing the database" rules out swapping the technology - it doesn't rule out changing what actually reaches it. Caching, replicas, queuing, and partitioning all reduce or reshape the load the same database instance has to bear, without touching the engine itself.

## 5. 🧠 Remember

> A 10x request target isn't answered by one universal technique - ask whether it's reads or writes first, then apply caching and replicas for reads, or queuing and write-sharding for writes, escalating to sharding only once cheaper layers are proven insufficient.

## 6. Quick Self-Test

1. Why does caching help almost nothing if the actual bottleneck is write throughput?
2. Why should sharding be the last resort rather than the first move?
3. What's the first clarifying question you'd ask before answering this, and why does it change everything downstream?
