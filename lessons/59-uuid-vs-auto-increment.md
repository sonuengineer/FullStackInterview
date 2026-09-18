# Why Are UUIDs Preferred Over Auto-Increment IDs in Some Systems?

## 1. Story

Your app's order URLs look like `/orders/1042`. A curious user changes it to `/orders/1041` and sees someone else's order (an authorization bug - but the guessable ID made it trivial to find). A competitor notices your order IDs jumped by 3,000 this month and now knows your sales volume. Later, you split the database into shards, and two shards both create order `5000`.

## 2. What Each One Is

**Auto-increment ID** - the database hands out `1, 2, 3, ...`. Small, fast, naturally ordered.

**Term: UUID** - a 128-bit identifier like `3f2b8c1e-9a4d-4e7f-b6a1-0c9d2e5f7a13`, generated so that collisions are practically impossible, **without asking anyone** for the next number.

## 3. Why UUIDs Win in Some Systems

- **Generated anywhere.** App servers, mobile clients (offline), or different shards can create IDs independently, with no central counter. That matters for distributed systems and sharding ([[21-database-partitioning]]).
- **Not guessable.** You can't walk `/orders/1`, `/orders/2`, ... (still enforce authorization - a UUID is not a security control by itself - but it removes the easy enumeration).
- **Doesn't leak business data.** Sequential IDs reveal how many users/orders you have and how fast you're growing.
- **Easy merging.** Combining data from multiple databases, regions, or tenants doesn't cause ID clashes.
- **ID known before insert.** The client can create the ID up front, which helps with idempotency and offline sync ([[32-payment-idempotency-double-click]]).

## 4. Why Auto-Increment Is Still Often Better

- **Smaller**: 8 bytes vs 16. Every index and foreign key referencing it is smaller too.
- **Faster inserts**: new rows always go at the end of the B-tree index.
- **Random UUIDs (v4) hurt write performance at scale**: inserts land at random places in the index, causing page splits and poor cache use.
- **Human-friendly**: "order 1042" is easy to read over the phone.

## 5. The Modern Middle Ground

- **UUIDv7 / ULID**: time-ordered UUIDs. Globally unique and generated anywhere, **but** roughly sequential, so inserts stay index-friendly. This is often the best default today when you want UUIDs.
- **Both**: an internal `BIGINT` primary key for joins and speed, plus a public UUID column used in URLs and APIs.

## 6. Mental Model

> Auto-increment is a ticket machine at one counter: tidy, small, ordered - but everyone must visit that one machine. UUIDs let everyone print their own ticket anywhere, at the cost of bigger, messier tickets. UUIDv7 prints tickets with a timestamp, so they still line up nicely.

## 7. Trade-offs

| | Auto-increment | UUIDv4 (random) | UUIDv7 / ULID |
|---|---|---|---|
| Generated without DB | No | Yes | Yes |
| Guessable | Yes | No | Hard (time part visible) |
| Size | 8 bytes | 16 bytes | 16 bytes |
| Index insert performance | Best | Poor at scale | Good |

## 8. 🧠 Remember

> Use UUIDs when IDs must be created in many places, merged across systems, or kept unguessable; prefer time-ordered UUIDv7/ULID over random UUIDv4 to keep inserts fast; and remember an ID is never a replacement for authorization checks.

## 9. Quick Self-Test

1. Why do random UUIDs slow down inserts on large tables?
2. What problem does a UUID solve when you shard a database?
3. Why is "unguessable IDs" not enough to protect other users' data?
