# Four Database Questions Backend Interviews Keep Asking

> **Connects to**: [[57-two-indexes-still-slow-composite]] and [[50-slow-query-500m-rows]] (indexes in practice), [[34-where-vs-having]] and [[63-query-faster-second-time]] (query basics).

## 1. Clustered vs Non-Clustered Index

**Clustered index** = the table rows are physically stored **in the order of that index**. There can be only **one** per table, because the data can only be sorted one way. In MySQL/InnoDB the primary key *is* the clustered index; in Postgres, tables are heaps and `CLUSTER` is a one-time reorder, so this question is usually about SQL Server/MySQL.

**Non-clustered (secondary) index** = a separate structure holding the indexed column plus a pointer back to the row. You can have many.

**Why it matters:** reading a range from a clustered index is fast because the rows sit next to each other on disk. A non-clustered index may need a second lookup to fetch the rest of the row (the "bookmark lookup") - unless the index is **covering**, meaning it already contains every column the query needs.

> Clustered = the phone book itself, sorted by surname. Non-clustered = an index at the back saying "Sharma - page 214".

**Practical tip:** in InnoDB, a random primary key (UUIDv4) scatters inserts through the clustered index and hurts write performance, which is exactly the point from [[59-uuid-vs-auto-increment]].

## 2. What Is a Materialized View?

- A **view** is a saved query. It runs every time you select from it, and stores no data.
- A **materialized view** stores the **result** on disk, like a cached table. Reads are fast, but the data is only as fresh as the last refresh (`REFRESH MATERIALIZED VIEW`, on a schedule or on demand).

**Use it when** an expensive aggregation is read far more often than the underlying data changes: dashboards, monthly reports, leaderboards. It turns a 45-second aggregation into a millisecond lookup ([[28-scaling-database-reads]]).

**The trade-off** is staleness plus the cost of refreshing. Postgres also supports `REFRESH ... CONCURRENTLY` so reads aren't blocked during a refresh.

## 3. Stored Procedure vs Function

| | Stored procedure | Function |
|---|---|---|
| Purpose | Do work (a series of statements) | Compute and return a value |
| Returns | Optionally output parameters / result sets | Always returns a value |
| Call style | `CALL proc(...)` | Inside SQL: `SELECT fn(col) FROM t` |
| Transactions | Can usually manage them (COMMIT/ROLLBACK) | Usually cannot |
| Side effects | Allowed (INSERT/UPDATE/DELETE) | Restricted, especially if marked deterministic/immutable |

> A function answers a question; a procedure performs a task.

## 4. Find the Nth Highest Salary

The version to write first (standard SQL, handles ties honestly):

```sql
-- Nth highest DISTINCT salary, e.g. N = 3
SELECT DISTINCT salary
FROM employees
ORDER BY salary DESC
OFFSET 2 ROWS FETCH NEXT 1 ROWS ONLY;   -- MySQL/Postgres: LIMIT 1 OFFSET 2
```

Better in an interview, because it names the tie behaviour explicitly:

```sql
-- DENSE_RANK: equal salaries share a rank, so "3rd highest" means the 3rd distinct amount
SELECT emp_id, name, salary
FROM (
  SELECT e.*, DENSE_RANK() OVER (ORDER BY salary DESC) AS rnk
  FROM employees e
) ranked
WHERE rnk = 3;
```

**Say this out loud:** `RANK()` skips numbers after ties (1,2,2,4), `DENSE_RANK()` doesn't (1,2,2,3), and `ROW_NUMBER()` picks one arbitrary row per tie. Which one is "correct" depends on whether two people on the same salary count once or twice - ask the interviewer.

**Also mention:** an index on `salary DESC` lets the `LIMIT/OFFSET` version stop early instead of sorting the whole table.

## 5. 🧠 Remember

> Clustered = the rows themselves in order (one per table); a materialized view is a stored result you must refresh; a function returns a value while a procedure does work; and for "Nth highest", use DENSE_RANK and state how you're treating ties.

## 6. Quick Self-Test

1. Why can a table have only one clustered index?
2. When is a materialized view the wrong choice?
3. What's the difference in output between `RANK()` and `DENSE_RANK()` when two people earn the same salary?
