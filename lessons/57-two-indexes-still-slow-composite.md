# Index on user_id Exists. Index on created_at Added. Still 30 Seconds. What's Missing?

> **Similar-question flag**: [[50-slow-query-500m-rows]] already covers the method (read `EXPLAIN ANALYZE`, then add the index that matches filter + sort). This lesson zooms in on one specific trap: **two separate single-column indexes are not the same as one composite index.**

## 1. The Situation

```sql
SELECT * FROM orders
WHERE user_id = 42
ORDER BY created_at DESC
LIMIT 20;
```

50 million rows. There's an index on `user_id` and another on `created_at`. Still 30 seconds.

## 2. What's Missing: A Composite Index `(user_id, created_at)`

A database usually uses **one** index per table access to do the heavy lifting. With two separate indexes it has to pick:

- **Use `user_id` index**: finds all of user 42's rows fast - but if that user has 2 million orders, it must fetch all 2 million, then **sort them** by `created_at` to get the top 20.
- **Use `created_at` index**: walks rows newest-first - but it has to check `user_id = 42` on each one, possibly reading millions of other users' rows before finding 20 matches.

Either way, it reads a huge number of rows.

A **composite index** on `(user_id, created_at)` stores the data already grouped by user **and** sorted by time inside each user. The database jumps straight to user 42 and reads the first 20 entries in order. No sort, no scanning other users.

```sql
CREATE INDEX CONCURRENTLY idx_orders_user_created
  ON orders (user_id, created_at DESC);
```

## 3. Mental Model

> A phone book sorted by last name, then first name, lets you find "Sharma, Priya" instantly. Two separate books - one sorted by last name, one by first name - don't. Column **order** in a composite index matters the same way: put the equality filter first (`user_id`), then the sort/range column (`created_at`).

## 4. Other Things to Check in the Plan

If the composite index still doesn't fix it, `EXPLAIN ANALYZE` usually shows one of these:

- **`SELECT *`** forces a lookup into the table for every row; selecting only needed columns (or a covering index with `INCLUDE`) avoids it.
- **Type mismatch**: `user_id` is a string column but the query passes a number (or vice versa), so the index can't be used.
- **Function on the column** (`WHERE DATE(created_at) = ...`) disables the index.
- **Stale statistics**: run `ANALYZE` so the planner picks the right index.
- **Skew**: one "whale" user with millions of rows behaves very differently from a typical user.

## 5. 🧠 Remember

> Two single-column indexes don't combine into one fast path - a query that filters on one column and sorts by another needs a composite index in that order: equality column first, then the sort/range column.

## 6. Quick Self-Test

1. Why can't the database efficiently use both single-column indexes together for this query?
2. Why does `(user_id, created_at)` work but `(created_at, user_id)` is much worse here?
3. What does a covering index add on top of a composite one?
