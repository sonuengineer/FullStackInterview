# `UPDATE products SET price = price * 1.1` on 12M Rows: Two Prices at Once

> **Connects to**: [[81-delete-150m-rows-safely]] (same batching discipline for mass writes) and [[28-scaling-database-reads]] (why replicas lag). The new problem here is that a *partly applied* price change is visible to users.

## 1. What Actually Went Wrong

One statement rewrote 12 million rows. Two separate problems followed:

1. **A giant transaction.** One long write holds locks, bloats the undo/WAL, and if it fails halfway it rolls back for just as long.
2. **Replica lag of 40 seconds.** Reads that go to replicas still saw old prices while the primary had new ones. So the product listing showed the old price and the cart showed the new one: **two prices at the same moment**.

Note the second one isn't fixed by batching alone. Smaller batches actually make the mixed-price window *longer*, just less violent. Users seeing two prices is a **rollout** problem, not a throughput problem.

## 2. The Real Fix: Don't Mutate Prices In Place - Switch Versions

Make the price change a single, instant, atomic event that every replica sees at once.

**Option A - price list version (best for catalog-wide changes).**

```sql
-- prices live in a versioned table, never overwritten
CREATE TABLE price_list (id serial PRIMARY KEY, name text, status text);  -- draft | active | retired
CREATE TABLE price_item (price_list_id int, product_id bigint, price numeric,
                         PRIMARY KEY (price_list_id, product_id));

-- 1. Build the new list in the background, as slowly as you like. Nobody reads it yet.
INSERT INTO price_item (price_list_id, product_id, price)
SELECT 2, product_id, price * 1.1 FROM price_item WHERE price_list_id = 1;

-- 2. Flip, in one tiny transaction (one row changes, replicas apply it instantly)
BEGIN;
UPDATE price_list SET status = 'retired' WHERE id = 1;
UPDATE price_list SET status = 'active'  WHERE id = 2;
COMMIT;
```

The heavy work is a background insert nobody reads; the *cutover* is one row. Rollback is flipping back. This is the same idea as dropping a partition instead of deleting rows ([[21-database-partitioning]]): make the expensive thing invisible, and the visible thing cheap.

**Option B - effective-dated prices.** Store `price, effective_from` and have reads pick the row where `effective_from <= now()`. Write all the future prices ahead of time, and the change happens by clock, everywhere at once. (Mind timezone/DST handling - see [[67-dst-scheduled-jobs]].)

## 3. If You Must Update In Place

Then the goal is: keep lag low, and make sure nobody can see a half-applied catalog.

**Batch and throttle, watching lag:**

```javascript
// Batch by primary key, commit each batch, and pause when replicas fall behind
let lastId = 0;
for (;;) {
  const { rows } = await db.query(
    `UPDATE products SET price = price * 1.1
      WHERE id IN (SELECT id FROM products WHERE id > $1 ORDER BY id LIMIT 5000)
      RETURNING id`, [lastId]);
  if (!rows.length) break;
  lastId = rows[rows.length - 1].id;

  // Postgres: lag in seconds on the primary
  const { rows: [lag] } = await db.query(
    `SELECT COALESCE(MAX(EXTRACT(EPOCH FROM (now() - reply_time))), 0) AS sec FROM pg_stat_replication`);
  while (lag.sec > 5) { await sleep(1000); }        // let replicas catch up
  await sleep(50);                                   // be kind to the primary
}
```

**And close the "two prices" window** with one of these:
- **Read the price from the primary** (or from a cache written at cutover) for anything money-related: cart, checkout, invoice. Product listings can be slightly stale; the price you *charge* must not be.
- **Pin one price per user session**: resolve the price once, carry it (or a `price_list_id`) through cart and checkout, so a user never sees it change mid-flow.
- **Do it in a low-traffic window** and hide the catalog behind a cache that's refreshed after the update completes.

## 4. Protect the User, Not Just the Database

Whatever the mechanism, decide the rule before you start: **the price shown when the item was added is the price honoured at checkout** (or you clearly tell the user it changed). That rule is what stops "split brain" from becoming a support ticket or a refund.

## 5. Checklist Before a Mass Write

- [ ] Can this be a version flip or an effective date instead of an in-place update?
- [ ] Batched, throttled, resumable (keyed by primary key, not `OFFSET`)?
- [ ] Replica lag watched, with an automatic pause?
- [ ] Money reads pinned to the primary or to a session-fixed price?
- [ ] Rollback plan: one flip back, or a saved copy of the old values?
- [ ] Run it off-peak, and announce it if prices are customer-visible.

## 6. 🧠 Remember

> Don't rewrite 12 million rows live - build the new prices in the background and flip a single version row, so every replica switches at the same instant; if you must update in place, batch with replica-lag checks and serve money-critical reads from the primary.

## 7. Quick Self-Test

1. Why do smaller batches fix lag but not the "two prices at once" problem?
2. What makes the version-flip approach atomic for replicas as well as the primary?
3. Which reads in an e-commerce flow must never come from a lagging replica?
