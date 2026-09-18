# 500 Million Rows, 45-Second Query, Business Wants Under 2 Seconds - What First?

> **Connects to**: [[21-database-partitioning]] and [[28-scaling-database-reads]] cover the bigger tools. This lesson is about the **order**: what you touch *first*, and why the answer is "read the query plan" before anything else.

## 1. Story

A reporting query on a 500-million-row `orders` table takes 45 seconds. The business wants it under 2. Someone suggests "bigger database," someone else says "add Redis," a third wants to shard. Nobody has looked at *why* it takes 45 seconds.

## 2. First Move: Look at the Query Plan

**Term: Query plan** - the step-by-step strategy the database chose to run your query (which indexes, which scan type, which join order). You see it with `EXPLAIN` (estimates) or `EXPLAIN ANALYZE` (actually runs it and shows real timings and row counts).

This is the Database Mode chain in practice: **data -> storage -> index -> query -> query plan -> performance**. A 45-second query on 500M rows almost always shows one of these in the plan:

- **Sequential scan** (reading the whole table) because no usable index exists for the `WHERE` filter.
- An index exists but **can't be used**: a function on the column (`WHERE DATE(created_at) = ...`), an implicit type cast, a leading wildcard `LIKE '%abc'`, or `OR` across different columns.
- A huge **sort or hash** spilling to disk because `ORDER BY` / `GROUP BY` isn't backed by an index.
- Row estimates wildly wrong because **statistics are stale**, so the planner picks a bad strategy.

## 3. Then Fix in Order of Cheapness

1. **Rewrite the query so indexes can be used.** `WHERE created_at >= '2026-01-01' AND created_at < '2026-01-02'` instead of `WHERE DATE(created_at) = '2026-01-01'`. Select only the columns you need instead of `SELECT *`.
2. **Add the right index.** Usually a **composite index** matching the filter and sort, e.g. `(customer_id, created_at)`. If the index also contains every selected column (a **covering index**), the database never even touches the table rows.
3. **Update statistics** (`ANALYZE`) so the planner makes good choices.
4. **Partition** by the filter key (often time) so the query touches one partition instead of 500M rows - see [[21-database-partitioning]].
5. **Precompute** if it's an aggregate report: a summary table or materialized view refreshed periodically turns a 45-second aggregation into a millisecond lookup - the CQRS idea from [[28-scaling-database-reads]].
6. Only after all that: caching, read replicas, or bigger hardware.

## 4. Code Example

```sql
-- Step 1: see what the database is actually doing
EXPLAIN ANALYZE
SELECT id, total FROM orders
WHERE customer_id = 42 AND DATE(created_at) = '2026-09-01'
ORDER BY created_at DESC;
-- Plan shows: Seq Scan on orders (rows=500,000,000) ... 45,000 ms

-- Step 2: make the filter index-friendly
SELECT id, total FROM orders
WHERE customer_id = 42
  AND created_at >= '2026-09-01' AND created_at < '2026-09-02'
ORDER BY created_at DESC;

-- Step 3: index that matches filter + sort, covering the selected columns
CREATE INDEX CONCURRENTLY idx_orders_customer_created
  ON orders (customer_id, created_at DESC) INCLUDE (total);
-- Plan now: Index Only Scan ... ~5 ms
```

## 5. Mental Model

> Never tune a slow query blind. `EXPLAIN ANALYZE` tells you whether the database is reading 500 million rows or 50 - and most "45 second" queries are one missing or unusable index away from milliseconds.

## 6. Production Reality

- On a live 500M-row table, create indexes **concurrently** (`CREATE INDEX CONCURRENTLY` in Postgres, online DDL in MySQL) so you don't lock writes for an hour.
- Every index speeds up reads but slows down writes and uses disk, so add the one the plan actually needs, not ten "just in case."
- Test with production-like data volume; a query that's fast on 10,000 rows in staging can pick a completely different plan on 500M.

## 7. Common Mistakes

- Jumping to Redis or a bigger instance before reading the query plan.
- Wrapping an indexed column in a function in the `WHERE` clause, silently disabling the index.
- Adding a single-column index when the query filters on one column and sorts on another, so the database still sorts millions of rows.

## 8. 🧠 Remember

> Slow query on a huge table: run `EXPLAIN ANALYZE` first, make the filter index-friendly, add the index that matches the filter and sort, and only then reach for partitioning, precomputation, or hardware.

## 9. Quick Self-Test

1. Why does `WHERE DATE(created_at) = ...` often ignore an index on `created_at`?
2. What makes an index "covering," and why is it faster?
3. When is a materialized view a better fix than an index?
