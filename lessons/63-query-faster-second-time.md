# Why Is the Same Query 10ms the First Time and 1ms the Second?

## 1. Story

You run a query: 10ms. You run the exact same query again: 1ms. Same data, same database, nothing changed. Where did the other 9ms go?

## 2. The Short Answer

The first run did work that the second run **didn't have to repeat**: mostly **reading data from disk into memory**, plus some one-time setup. The second run found everything already warm.

## 3. Where the 9ms Went

**1. Disk vs memory (the big one).**
Databases store data in fixed-size **pages** (e.g. 8 KB in Postgres, 16 KB in MySQL InnoDB). To read a row, the database needs its page in memory.

**Term: Buffer pool / shared buffers** - the database's own in-memory cache of pages.

- First run: pages aren't in the buffer pool -> read from disk (or the OS page cache). That's the slow part.
- Second run: pages are already in memory -> RAM access is orders of magnitude faster than disk.

The operating system also keeps its own **page cache** of recently read file blocks, a second layer that makes repeated reads faster.

**2. Query planning.**
The database parses the SQL and builds a query plan the first time. With **prepared statements**, many databases can reuse a cached plan on the next run, skipping that work.

**3. Index pages warmed up too.**
The index's upper levels (root and branch pages) get loaded on the first run and stay hot, so the next lookup walks the tree in memory.

**4. Connection and app-side warm-up.**
If you're measuring from the application: the first request may pay for opening a DB connection, TLS handshake, JIT compilation, or ORM metadata loading. Later requests reuse the pooled connection.

**5. Query result cache (rare today).**
Some systems cache full results, but MySQL removed its query cache in 8.0 and Postgres never had one. Usually it's the **data pages**, not the result, that are cached.

## 4. Mental Model

> The first time, the librarian walks to the basement archive (disk) to fetch the book. The second time, it's already sitting on the front desk (memory). Same book, no walk.

## 5. Why This Matters in Production

- **Benchmarks lie if you only measure warm runs.** Test cold and warm, and look at p99, not just the fast repeat.
- **After a restart or failover, the cache is cold.** Queries are slower until the buffer pool warms up - a real cause of latency spikes right after a deploy or DB failover.
- **Working set vs RAM.** If your frequently used data (the working set) fits in memory, the database is fast. When it outgrows RAM, pages keep getting evicted and reloaded from disk, and performance falls off a cliff.
- **Buffer cache hit ratio** is a key database metric - a drop usually means the working set outgrew memory or a query started scanning far more data.

## 6. 🧠 Remember

> The second run is faster because the data pages were already in memory (the buffer pool and OS cache), and planning and connections were already done - the first run paid for reading from disk.

## 7. Quick Self-Test

1. What is the buffer pool, and why does it make repeated queries faster?
2. Why can a database be slow for a few minutes after a failover even with no code change?
3. What happens to performance when the working set no longer fits in memory?
