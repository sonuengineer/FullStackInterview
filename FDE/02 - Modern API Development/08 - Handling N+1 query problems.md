# Modern API Development

## Handling N+1 query problems

> Extended (slow track only) | Slow CP2 only | ~1.2 h

**N+1 problem** = 1 query list laane ke liye (`SELECT * FROM documents LIMIT 50`) + har row ke liye ek aur query (`SELECT * FROM users WHERE id = ?`) = 51 round-trips. REST + ORM lazy loading mein bhi hota hai; GraphQL nested resolvers mein to ye default behaviour hai.
GraphQL fix: **DataLoader** -- ek request ke andar saare `owner_id` collect karo, ek batch query (`WHERE id IN (...)`) chalao, results cache karo. Strawberry mein `strawberry.dataloader.DataLoader(load_fn=...)`; har request ke liye naya loader context mein banao, warna users/tenants ke beech cache leak.
SQLAlchemy/REST fix: eager loading -- `select(Document).options(selectinload(Document.owner))` (2 queries total) ya `joinedload` (1 JOIN query).
FDE angle: POC pe 10 rows pe sab fast, customer ke 50k rows pe dashboard 8 second. Logs mein same query 500 baar dikhe to N+1 hai -- `create_engine(..., echo=True)` ya test mein query counter se pakdo.
Yaad rakho: fix hamesha "fewer, bigger queries" hai (batching ya eager loading), aur ek test jo query count assert kare taaki ye wapas na aaye.

**Try this (20-40 min):** M02-07 wale counter example ko DataLoader se fix karo (counter 20 -> 1); phir M02-05 ke CRUD mein `Document.owner` relationship add karke `echo=True` se lazy vs `selectinload` ki query count compare karo.

**Read:** https://strawberry.rocks/docs/guides/dataloaders
