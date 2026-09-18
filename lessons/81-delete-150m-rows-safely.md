# Delete 150 Million Rows From a Live 800M-Row Table - No Locks, No Lag, No Downtime

*This is the "delete at scale" problem from [[03-ttl-deletion-at-scale]] under stricter rules: a busy table (3,000 writes/second), a replica that must not fall behind, and zero downtime.*

## 1. Why One Big DELETE Is a Disaster

```sql
DELETE FROM events WHERE created_at < '2025-01-01';   -- 150 million rows
```

- **One giant transaction:** it runs for hours, holding locks on every row it touches, and if it fails at 90% everything rolls back.
- **Huge log (WAL / binlog):** 150M row deletions flood the replica, so **replica lag** explodes.
- **Table bloat:** in Postgres, deleted rows become dead tuples until vacuum cleans them; one big delete creates 150M at once.
- **Blocks the 3,000 writes/second** hitting the same table and indexes.

## 2. The Best Answer - If You Can: Don't Delete, Drop

If the table is (or can become) **partitioned by time** ([[21-database-partitioning]]), deleting old data is:

```sql
ALTER TABLE events DETACH PARTITION events_2024_12;
DROP TABLE events_2024_12;                              -- instant, no row-by-row work
```

Dropping a partition removes a whole file - no per-row locks, almost no log, no bloat. **Say this first in the interview** - then handle the case where the table isn't partitioned.

## 3. If You Must Delete Rows: Small Batches, Throttled, Watched

The idea: delete a **small batch** (e.g. 5,000 rows) by primary key, commit, **pause**, check the replica lag, repeat.

```javascript
// Batch delete by primary-key ranges - each batch is a short, cheap transaction
const BATCH = 5000;
const CUTOFF = '2025-01-01';

async function purge() {
  let lastId = 0;
  const { rows: [{ max }] } = await db.query(
    'SELECT max(id) FROM events WHERE created_at < $1', [CUTOFF]);   // the old rows' id boundary

  while (lastId < max) {
    // 1. Stop if the replica is falling behind
    while ((await replicaLagSeconds()) > 5) await sleep(10_000);

    // 2. Delete one small, index-backed slice
    const res = await db.query(
      `DELETE FROM events
       WHERE id > $1 AND id <= $2 AND created_at < $3`,
      [lastId, lastId + BATCH, CUTOFF]);

    lastId += BATCH;
    console.log(`up to id ${lastId}: deleted ${res.rowCount}`);   // resumable: log progress

    // 3. Give live traffic and the replica room to breathe
    await sleep(200);
  }
}

async function replicaLagSeconds() {
  // Postgres, run on the replica connection
  const { rows } = await replica.query(
    'SELECT EXTRACT(EPOCH FROM now() - pg_last_xact_replay_timestamp()) AS lag');
  return Number(rows[0].lag || 0);
}
```

**Why each detail matters:**
- **Delete by primary-key range**, not `LIMIT` with a full scan - each batch finds its rows through the index instantly.
- **Short transactions** - locks are held for milliseconds, so the 3,000 writes/second barely notice.
- **Lag check before each batch** - the replica sets the pace (**backpressure**).
- **Sleep between batches** - smooths the load; tune it while watching latency.
- **Log the last id** - if the job stops, it resumes where it left off.
- **Run off-peak** if possible, and make it **pausable** (a flag or a kill switch).

## 4. After Deleting

- **Postgres:** run `VACUUM` (autovacuum will be busy) so dead rows become reusable space. The file won't shrink by itself - that needs `pg_repack` (online) if you need the disk back.
- **MySQL:** `OPTIMIZE TABLE` or `pt-online-schema-change` to reclaim space online.
- **Then prevent it happening again:** partition the table by month so next year's cleanup is a `DROP` ([[21-database-partitioning]]).

## 5. Alternative: Copy What You Keep

When you're deleting **most** of a table (say 700M of 800M), it's often faster to copy the rows you **keep** into a new table and swap - using an online tool (`pg_repack`, `gh-ost`, `pt-online-schema-change`) that keeps both in sync while live writes continue. With 150M of 800M, batched deletes are usually the simpler choice.

## 🧠 Remember

> Never delete millions of rows in one statement. Best: drop a partition. Otherwise: small primary-key batches, short transactions, pause when the replica lags, log progress so it can resume - and partition the table so you never have to do it again.

## Self-Test

1. Why does one big `DELETE` cause replica lag?
2. Why delete by primary-key range instead of `DELETE ... LIMIT 5000`?
3. Why is dropping a partition so much cheaper than deleting its rows?

Related: [[03-ttl-deletion-at-scale]], [[21-database-partitioning]], [[50-slow-query-500m-rows]]
