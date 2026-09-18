# Millions of Records + Infinite Scroll - Which Pagination Strategy?

*Same topic as [[82-return-10000-show-20]], asked from the design side. Short answer below; the full code is in lesson 82.*

## 1. The Answer in One Line

> **Cursor-based (keyset) pagination** on an indexed, stable sort order - because offset gets slower the deeper you scroll and shifts rows while new data arrives.

## 2. Why Not Offset for Infinite Scroll?

| Problem | Offset (`LIMIT 20 OFFSET 200000`) | Cursor (`WHERE (created_at, id) < (...)`) |
|---|---|---|
| Speed on deep scroll | Slower every page - the DB walks and discards all skipped rows | Same speed at any depth - the index jumps to the cursor |
| New items arrive while scrolling | Rows shift: duplicates or missed items | Stable - you continue after the last item you saw |
| Jump to page 500 | Possible | Not possible (not needed for infinite scroll) |

## 3. How It Works

1. The first request returns 20 items + a **`nextCursor`** (an encoded `created_at|id` of the last item).
2. The client sends `?cursor=...` to get the next 20.
3. The query uses `WHERE (created_at, id) < (cursor values) ORDER BY created_at DESC, id DESC LIMIT 21` on an index `(created_at DESC, id DESC)`.
4. When `nextCursor` is `null`, the client shows "You're all caught up".

## 4. Production Details

- **Opaque cursor** (base64) - clients shouldn't build or depend on its format.
- **Tiebreaker column (`id`)** - many rows can share a timestamp.
- **Filters are part of the index** - e.g. a feed per tenant needs `(tenant_id, created_at DESC, id DESC)`.
- **Cap the page size** and skip `COUNT(*)`; use `limit + 1` to know if there's more.
- **Frontend:** an IntersectionObserver loads the next page before the user hits the bottom, and **virtualize** the list once it gets long so the DOM doesn't hold 10,000 nodes ([[33-react-performance-at-scale]]).
- **Deletions are fine;** the cursor just continues from the last seen position.

## 🧠 Remember

> For infinite scroll over millions of rows: cursor pagination on an indexed, stable sort (timestamp + id), an opaque cursor, a capped page size - and a virtualized list on the frontend.

## Self-Test

1. What two problems does offset pagination cause in an infinite feed?
2. Why must the cursor include `id` and not just `created_at`?

Related: [[82-return-10000-show-20]], [[33-react-performance-at-scale]]
