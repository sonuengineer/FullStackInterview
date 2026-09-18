# News Feed -- shared design spec (for writing Parts 1-6 consistently)

Single source of truth for the News Feed lessons. Every part must use these exact numbers, names, and decisions. Not a lesson itself (build.mjs skips it).

## Scenario
**Chirp** -- a Twitter/Instagram-style social app. Users follow other users; the home screen shows a **news feed**: recent posts from people you follow, newest (later: most relevant) first, infinite scroll. Interview framing: "Design the Twitter home timeline / Facebook News Feed".
Connections to earlier systems:
- URL Shortener Part 3: Snowflake IDs (time-sortable) -- now the post ID.
- Rate Limiter: limits on posting / following (spam bots).
- Payment System: `Idempotency-Key` on `POST /v1/posts` so a retried post is not published twice; outbox pattern for `post.created`.
- File Storage: images/videos go to StoreBox (S3-style) via presigned URLs and are served through the CDN; the feed only stores media keys.
- Repo lessons worth linking: `lessons/84-infinite-scroll-pagination-at-scale.md`, `lessons/83-redis-down-database-stampede.md`.
The core problem to teach: **reading a feed = merging posts from hundreds of followees**. Doing that at read time (pull) is slow; precomputing it at write time (push / fan-out on write) is fast to read but explodes for celebrities. The answer is a **hybrid**.

## Requirements
Functional:
1. Create a post (text up to 500 chars + up to 4 media items).
2. Follow / unfollow users.
3. Home feed: posts from followees, reverse-chronological in V1 (ranking in V2), cursor-paginated infinite scroll (20 per page).
4. User timeline: a single user's own posts.
5. Like / unlike a post; show like count and whether the viewer liked it.
6. Delete a post (must disappear from feeds).
Out of scope (say so): comments threads, DMs (Chat System), notifications (Notification system), search (Search system), ads, stories.
Non-functional: feed read p99 < 200 ms (server side); high availability (feed may be slightly stale rather than down); eventual consistency OK -- a new post may take a few seconds to appear in followers' feeds (target p99 fan-out lag < 5 s for normal users); **read-your-own-writes** for the author (your own post shows immediately); scalable for celebrities with tens of millions of followers; durable posts (never lose a post, feeds can be rebuilt).

## Numbers (verified; use exactly)
- 300M registered users, **100M DAU**.
- Feed opens: 10 per DAU per day -> 1B feed reads/day -> ~11.6K/s average, peak 3x -> **~35K feed reads/s**.
- Posts: 10M/day -> ~116/s average, peak ~350/s (plan ~1K/s for spikes like big events).
- Average followers per user: 200; celebrities up to **50M** followers. Celebrity threshold = **10,000 followers**.
- Pure fan-out on write: 10M posts x 200 = **2B feed inserts/day** -> ~23K/s average, ~69K/s peak. One 50M-follower post alone = 50M inserts (~50 s even at 1M inserts/s) -> this is why celebrities are pulled, not pushed.
- Feed cache: keep the latest **200** entries per user, ~64 bytes per ZSET entry -> ~12.8 KB/user -> 100M DAU -> **~1.28 TB** of Redis -> ~20 shards of 64 GB (+ replicas). Only users active in the last 30 days get a pushed feed.
- Post metadata: ~1 KB per post -> 10 GB/day -> **~3.65 TB/year**.
- Media: 20% of posts have one image, ~300 KB after compression -> ~600 GB/day -> ~219 TB/year (lives in StoreBox/S3 + CDN, not in our DBs).
- Feed response: 20 hydrated posts x ~1 KB = ~20 KB -> 35K/s x 20 KB = ~700 MB/s (~5.6 Gbps) from the feed service at peak.
- Snowflake IDs today are ~2.1e18 -- larger than 2^53 (9,007,199,254,740,992): **JavaScript `number` and Redis ZSET scores (doubles) cannot hold them exactly** -> IDs are strings in JS/JSON; ZSET score = `createdAtMs`, member = postId string.

## Architecture (decided)
```
Mobile/Web clients
  -> CDN (media only)
  -> LB / API Gateway (auth, rate limits)
  -> Post Service (Node.js)   -> Cassandra (posts_by_id, posts_by_author) ; outbox -> Kafka `posts.created` / `posts.deleted`
  -> Graph Service (Node.js)  -> PostgreSQL (users, follows) + Redis cache of follower/followee lists
  -> Feed Service (Node.js)   -> Redis Cluster: feed:{userId} (pushed), timeline:{authorId} (celebrity/own recent posts), post:{postId} (hydration cache), counters
  -> Like Service (Node.js)   -> Cassandra post_likes + Redis counters (flushed to DB async)
  Fan-out workers (Node.js, kafkajs consumer group on `posts.created`):
      author followers < 10,000  -> push postId into feed:{followerId} for each follower active in last 30 days (pipelined ZADD + ZREMRANGEBYRANK trim to 200)
      author followers >= 10,000 -> NO push; post only goes to timeline:{authorId}; readers pull it at read time
```
- Hybrid feed read = pushed entries from `feed:{me}` + pulled recent posts from each celebrity I follow (`timeline:{celebId}`) + my own recent posts (`timeline:{me}`, read-your-own-writes) -> k-way merge by score -> filter (deleted, blocked, unfollowed) -> page of 20 -> hydrate.
- Inactive users (no feed in Redis): on open, **rebuild** the feed by pull (read recent posts of followees from `posts_by_author`, merge, write back into `feed:{me}`), then continue with push.
- Redis is a cache/derived store: every feed can be rebuilt from Cassandra + Postgres. Kafka makes fan-out asynchronous and retryable.
- Ranking: V1 reverse-chronological. V2 simple score (recency decay + engagement + affinity) over a candidate set of ~500. V3 ML ranking (mention only).

## Key algorithms (decided; Part 3 goes deep)
- Snowflake ID: 41 bits ms timestamp (custom epoch) + 10 bits worker + 12 bits sequence -> sortable by time; string in JSON.
- Fan-out on write (push) vs fan-out on read (pull) vs hybrid with threshold 10,000 followers.
- Feed cache as Redis ZSET: `ZADD feed:{uid} <createdAtMs> <postId>`, trim `ZREMRANGEBYRANK feed:{uid} 0 -201` (keep newest 200), read `ZREVRANGEBYSCORE feed:{uid} (<cursorScore> -inf WITHSCORES LIMIT 0 <n>`.
- Cursor pagination: opaque base64 of `{ s: lastScoreMs, id: lastPostId }`; tie-break equal scores by postId (compare as BigInt / string length then lexicographic). Never offset pagination.
- K-way merge of sorted lists (min-heap) -- O(total log k).
- Hydration: batch `MGET post:{id}...`; misses fetched from Cassandra `posts_by_id` in one `IN` query / parallel, then cached (TTL 24 h).
- Counters: Redis `INCR likes:{postId}` + a set/table for who liked (idempotent like); periodic flush to Cassandra counters.
- Deletes/unfollows/blocks: remove from source of truth immediately; feeds cleaned lazily (filter at read) + async cleanup job.
- New follow: async backfill last 20 posts of the followee into `feed:{me}` (non-celebrity).

## Database (decided)
PostgreSQL (graph + users):
```sql
CREATE TABLE users (
  id               BIGINT PRIMARY KEY,              -- Snowflake
  handle           TEXT NOT NULL UNIQUE,
  display_name     TEXT NOT NULL,
  avatar_key       TEXT NULL,                       -- StoreBox key
  follower_count   BIGINT NOT NULL DEFAULT 0,
  following_count  BIGINT NOT NULL DEFAULT 0,
  last_active_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE follows (
  follower_id  BIGINT NOT NULL REFERENCES users(id),
  followee_id  BIGINT NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),           -- "whom do I follow" + no duplicate follows
  CHECK (follower_id <> followee_id)
);
CREATE INDEX ix_follows_followee ON follows (followee_id, follower_id);   -- "who follows X" for fan-out
```
Cassandra (posts, likes) -- CQL:
```sql
CREATE TABLE posts_by_id (
  post_id     bigint PRIMARY KEY,
  author_id   bigint,
  text        text,
  media_keys  list<text>,
  created_at  timestamp,
  deleted     boolean
);

CREATE TABLE posts_by_author (
  author_id   bigint,
  bucket      text,          -- 'YYYY-MM' to keep partitions bounded for prolific authors
  post_id     bigint,
  PRIMARY KEY ((author_id, bucket), post_id)
) WITH CLUSTERING ORDER BY (post_id DESC);

CREATE TABLE post_likes (
  post_id    bigint,
  user_id    bigint,
  created_at timestamp,
  PRIMARY KEY ((post_id), user_id)
);

CREATE TABLE post_counters (
  post_id     bigint PRIMARY KEY,
  like_count  counter
);
```
Why: Postgres for users/follows (relational, unique constraints, moderate size, sharded by user id later); Cassandra for posts/likes (huge append-heavy writes, query-driven tables, partition by author + month, linear scaling, multi-DC). Denormalized tables because Cassandra has no joins. V1 can keep posts in Postgres too -- say so.

## APIs (decided)
- `POST /v1/posts` -- headers `Authorization`, `Idempotency-Key`; body `{ "text": "...", "mediaKeys": ["media/u1/abc.jpg"] }` -> `201 { "id": "2100907437367230464", "authorId": "...", "text": "...", "mediaUrls": [...], "createdAt": "..." }`; 400 (too long, >4 media), 429.
- `DELETE /v1/posts/:id` -> 204 (author only; 404 otherwise).
- `GET /v1/feed?limit=20&cursor=<opaque>` -> `200 { "items": [ { "post": {...}, "author": { "id", "handle", "displayName", "avatarUrl" }, "likeCount": 12, "viewerHasLiked": false } ], "nextCursor": "eyJzIjox..." | null }`; `limit` max 50.
- `GET /v1/users/:id/posts?cursor=` -> user timeline, same item shape.
- `PUT /v1/users/:id/follow` -> 204 (idempotent); `DELETE /v1/users/:id/follow` -> 204.
- `PUT /v1/posts/:id/like` -> 204 (idempotent); `DELETE /v1/posts/:id/like` -> 204.
- Media upload: `POST /v1/media/uploads` -> presigned StoreBox URL (File Storage system).
- IDs are always JSON strings.

## Names (use exactly)
- Redis keys: `feed:{userId}` (ZSET), `timeline:{authorId}` (ZSET of that author's latest 200 posts -- used for celebrities and read-your-own-writes), `post:{postId}` (JSON string, TTL 24 h), `likes:{postId}` (counter), `following:{userId}` / `celebs:{userId}` (cached sets, TTL 10 min), `active:{userId}` optional.
- Kafka topics: `posts.created`, `posts.deleted`, `follows.changed`; fan-out consumer group `feed-fanout`; message key = authorId (per-author ordering).
- Constants: `CELEBRITY_THRESHOLD = 10_000`, `FEED_MAX = 200`, `PAGE_SIZE = 20`, `ACTIVE_DAYS = 30`, `FANOUT_BATCH = 1_000` (followers per Redis pipeline).
- TypeScript:
```ts
interface Post { id: string; authorId: string; text: string; mediaKeys: string[]; createdAtMs: number; deleted: boolean }
interface FeedEntry { postId: string; scoreMs: number }
interface FeedItem { post: Post; author: { id: string; handle: string; displayName: string; avatarUrl: string | null }; likeCount: number; viewerHasLiked: boolean }
interface FeedPage { items: FeedItem[]; nextCursor: string | null }
```
- Files (LLD): `src/routes/{post,feed,follow,like}.routes.ts`, `src/controllers/...`, `src/services/{post,feed,fanout,graph,like,ranking}.service.ts`, `src/workers/fanout.worker.ts`, `src/repositories/{post.repository (cassandra-driver), follow.repository (pg), user.repository (pg)}.ts`, `src/cache/{feed-cache,post-cache,counter-cache}.ts`, `src/utils/{snowflake,cursor,kway-merge}.ts`, `src/infra/{redis,postgres,cassandra,kafka,logger,metrics}.ts`, `src/app.ts`, `src/server.ts`.
- Metrics: `feed_read_duration_seconds`, `feed_cache_hit_ratio` (feed present in Redis vs rebuild), `feed_rebuilds_total`, `fanout_lag_seconds` (post created -> last follower feed written), `fanout_writes_total`, `kafka_consumer_lag{group="feed-fanout"}`, `post_create_duration_seconds`, `hydration_cache_miss_total`, `celebrity_merge_sources` (histogram: celeb timelines merged per read).

## Style rules (every part)
- Title: `# News Feed -- HLD + LLD (Part N: A -> B -> C)` (the reader uses the text inside `(Part N: ...)` as the chapter label).
- Easy Hinglish, ASCII only (no em/en dashes, smart quotes, arrows, box-drawing, emojis), Node.js/TypeScript, `**Code Explanation:**` line-by-line after every code block, interview lines, `## Remember` + `## Quick Self-Test` (5 questions) at end, final `**Next (Part N+1):** ... "next" bolo.` line (Part 6 ends with `**News Feed complete.** Next system: **Chat System**. "next" bolo.`).
- Be honest: real Twitter/Facebook/Instagram feeds are far more complex (ML ranking, many candidate sources); hedge claims about their internals ("publicly described", "commonly").
- Keep each part between 700 and 950 lines (hard limit 1,000 -- trim prose, not required content).
