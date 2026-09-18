# Your API Returns 10,000 Records but the Screen Shows 20 - What Do You Do?

## 1. The Question

The frontend displays 20 rows. The API sends 10,000. Options:
- A) Return all 10,000
- B) Add pagination
- C) Add cursor pagination
- D) Let the frontend handle it

**Answer: paginate on the server - B for a simple admin table, C for large, growing or infinite-scroll lists.** A and D are the same mistake.

## 2. Why "Return All 10,000" Hurts Everyone

Every request pays for 9,980 rows nobody sees:

- **Database:** reads and sorts 10,000 rows instead of 20.
- **Server:** builds a huge object and serializes a multi-MB JSON (which blocks the Node event loop while it runs).
- **Network:** megabytes per request - painful on mobile data.
- **Browser:** parses it all and holds it in memory; rendering 10,000 rows freezes the page.

And it gets worse every day as the table grows. "Let the frontend handle it" (D) means you already paid all of those costs - the frontend can only hide rows, not un-download them.

## 3. Option B: Offset Pagination (page numbers)

```javascript
// GET /api/orders?page=3&limit=20
app.get('/api/orders', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);   // cap it - never trust the client
  const page = Math.max(Number(req.query.page) || 1, 1);
  const { rows } = await db.query(
    'SELECT id, customer, total, created_at FROM orders ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2',
    [limit, (page - 1) * limit]);
  res.json({ items: rows, page, limit });
});
```

- **Good for:** admin tables where users jump to "page 7"; small or medium tables.
- **Weak at depth:** `OFFSET 100000` makes the database walk and throw away 100,000 rows first. And if new rows arrive while the user pages, rows **shift** - duplicates or skipped items.

## 4. Option C: Cursor (Keyset) Pagination

Instead of "skip N rows", say "give me the 20 rows **after the last one I saw**".

```javascript
// GET /api/orders?limit=20&cursor=<opaque>
app.get('/api/orders', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  let where = '', params = [limit + 1];                     // fetch one extra to know if there's more
  if (req.query.cursor) {
    const [ts, id] = Buffer.from(req.query.cursor, 'base64url').toString().split('|');
    where = 'WHERE (created_at, id) < ($2, $3)';
    params.push(ts, id);
  }
  const { rows } = await db.query(
    `SELECT id, customer, total, created_at FROM orders ${where}
     ORDER BY created_at DESC, id DESC LIMIT $1`, params);

  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  res.json({
    items,
    nextCursor: hasMore
      ? Buffer.from(`${last.created_at.toISOString()}|${last.id}`).toString('base64url')
      : null,
  });
});
// Index: CREATE INDEX ON orders (created_at DESC, id DESC);
```

- **Fast at any depth** - the index jumps straight to the cursor position.
- **Stable** - new rows don't shift what you've already seen.
- **Can't jump to page 50** - fine for feeds and infinite scroll.
- The `id` tiebreaker handles rows with the same timestamp.

## 5. How to Choose

| Situation | Use |
|---|---|
| Admin table, "page 3 of 12", small data | Offset (B) |
| Feed, infinite scroll, large or fast-growing table | Cursor (C) |
| Export of all rows | A **background job** that streams a file (CSV) - not one API response |
| Frontend truly needs everything (a tiny dropdown list) | Return it all - but only if it's small and bounded |

## 6. Details That Show Seniority

- **Cap `limit`** (e.g. max 100) - otherwise `?limit=1000000` brings the problem back.
- **Return only needed columns**, not `SELECT *`.
- **Avoid `COUNT(*)` on every page** - on big tables it's a full scan. Use `hasMore` (the `limit + 1` trick) or a cached/approximate total.
- **Filter and sort on the server** with matching indexes; otherwise pagination returns the wrong 20.

## 🧠 Remember

> Never send what the user can't see. Paginate on the server: offset for small tables with page numbers, cursor for large lists and infinite scroll - cap the limit and index the sort order.

## Self-Test

1. Why is "let the frontend handle it" the same mistake as returning everything?
2. Why does offset pagination get slower on deep pages?
3. What does the `limit + 1` trick give you?

Related: [[84-infinite-scroll-pagination-at-scale]], [[48-huge-json-payloads]]
