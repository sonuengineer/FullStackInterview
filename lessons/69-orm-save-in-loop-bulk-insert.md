# ORM `.save()` Inside a Loop for 5,000 Records

> **Similar-question flag**: this is the write-side version of the N+1 problem from [[52-orm-or-raw-sql]], and the same "stop paying the round-trip cost one at a time" idea as [[54-notify-5000-users-10x-faster]]. Short recap.

## Why It's Slow

```javascript
for (const row of rows) {        // 5,000 iterations
  await Order.create(row);       // 1 INSERT + 1 network round trip + 1 commit each
}
```

- **5,000 round trips**: at ~2ms each, that's 10 seconds of pure waiting.
- **5,000 commits**: each commit may force a disk flush.
- **ORM overhead** per object: hooks, validation, change tracking.
- **No atomicity**: if it fails at row 3,127, you have half the data saved.

## The Fix

**1. Bulk insert in batches** - one statement for many rows:

```javascript
// Sequelize: one INSERT ... VALUES (...), (...), ... per batch
for (let i = 0; i < rows.length; i += 1000) {
  await Order.bulkCreate(rows.slice(i, i + 1000));
}
```

**2. Wrap it in a transaction** so it's all-or-nothing and commits once:

```javascript
await sequelize.transaction(async (t) => {
  for (let i = 0; i < rows.length; i += 1000) {
    await Order.bulkCreate(rows.slice(i, i + 1000), { transaction: t });
  }
});
```

**3. For very large loads**, use the database's bulk loader (`COPY` in Postgres, `LOAD DATA` in MySQL) - often 10-100x faster than even batched inserts.

Typical result: **~10 seconds -> well under 1 second** for 5,000 rows.

## Batch Size Matters

Too small keeps the round-trip cost; too large can hit parameter limits (Postgres allows 65,535 bind parameters per statement) and long lock times. **500-5,000 rows per batch** is a common sweet spot.

## 🧠 Remember

> Don't pay a network round trip and a commit per row - batch inserts into multi-row statements, wrap them in one transaction, and use the database's bulk loader for really large imports.
