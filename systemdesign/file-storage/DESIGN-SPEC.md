# File Storage (S3-style Object Storage) -- shared design spec (for writing Parts 1-6 consistently)

Single source of truth for the File Storage lessons. Every part must use these exact numbers, names, and decisions. Not a lesson itself (build.mjs skips it).

## Scenario
ShopKart (from the Rate Limiter and Payment System stories) stores product images, invoices (PDFs), user uploads (return-request photos, videos), seller CSVs and database backups. AWS S3 bills are growing, and the platform team is asked: "design our own S3-style **object storage** service, called **StoreBox**". Interview framing: "Design S3" -- NOT "design Dropbox" (no folder sync, no collaborative editing).
Connections to earlier systems:
- URL Shortener: IDs, metadata DB, CDN, 302 redirects.
- Rate Limiter: per-API-key limits on PUT/GET.
- Payment System: HMAC signatures (now for request signing + presigned URLs), idempotent retries, "fail closed on durability".
- Lesson "2GB upload direct to S3" (`lessons/87-2gb-upload-direct-to-s3.md` in the repo) -- presigned URLs + multipart from the CLIENT side; this system is the SERVER side of that.

Core idea to teach: **separate metadata from data**. Metadata (bucket, key, size, version, where the bytes live) is small and needs a database; data (the bytes) is huge and lives on storage nodes' disks, replicated across failure domains.

## Requirements
Functional:
1. Buckets: create / delete bucket (globally unique name).
2. Objects: PUT (single upload up to 100 MB), GET (with HTTP `Range` support), HEAD, DELETE, LIST by prefix with pagination.
3. Multipart upload for large objects: initiate, upload parts (5 MB - 100 MB each, last part may be smaller, max 10,000 parts -> max object ~1 TB), complete, abort.
4. Presigned URLs: time-limited signed URL so a browser/app can upload/download directly without our API key.
5. Optional per-bucket versioning (keep old versions; DELETE creates a delete marker).
6. Lifecycle rules: move objects older than 30 days to COLD storage class (erasure coded), expire objects after N days, abort incomplete multipart uploads after 7 days.
7. Event notifications (`object.created`, `object.deleted`) to other services (e.g. image thumbnailer).
Non-functional: **durability 99.999999999% (11 nines)** = with 10B objects you expect to lose ~0.1 object per year; availability 99.99% for reads; strong read-after-write consistency for PUT/DELETE/LIST (like S3 since Dec 2020); high throughput for large objects (streaming, never buffer whole files in memory); scalable to PBs; cost-efficient (erasure coding for cold data); security (auth, encryption at rest, TLS).

## Numbers (verified; use exactly)
- 20M uploads/day -> ~231 PUT/s avg, peak 3x ~694 -> plan **~1,000 PUT/s**.
- Read:write 10:1 -> 200M GET/day -> ~2,315 GET/s avg, peak ~6,944 -> plan **~7K GET/s**; the CDN serves most public images, origin sees a fraction.
- Average object 500 KB (most are small images; a few are multi-GB videos/backups).
- Ingest: 10 TB/day logical -> ~116 MB/s (~0.93 Gbps) average -> **3.65 PB/year logical**.
- Raw storage: 3x replication -> ~10.95 PB/year; erasure coding 8+4 (1.5x) -> ~5.5 PB/year. With 20 TB HDDs: ~548 disks/year at 3x vs ~274 at 1.5x -> this is why cold data is erasure coded.
- Egress: 100 TB/day -> ~1.16 GB/s (~9.3 Gbps) average, ~28 Gbps peak -> CDN in front for public reads.
- Metadata: ~1 KB per object (object row + chunk rows) -> 20 GB/day -> **~7.3 TB/year, ~7.3B objects/year** -> metadata DB must be sharded eventually.
- Chunk size 8 MB: a 500 KB object is 1 chunk; a 1 GB object is 128 chunks.
- 11 nines: 10B objects x 1e-11 = ~0.1 objects lost per year.

## Architecture (decided)
```
Client / Browser / SDK
  -> CDN (public GETs only)                       -> origin: API layer
  -> LB -> API service: N stateless Node.js instances (Express 5 / plain http streams)
             - auth: API key + HMAC request signature, or presigned URL verification
             - rate limit per API key (Rate Limiter system)
             - streams bytes: client <-> storage nodes (never buffers whole object)
        -> Metadata service: PostgreSQL (primary + sync standby); sharded by (bucket_id, key) RANGE at scale
             tables: buckets, objects, object_chunks, chunk_locations, multipart_uploads, upload_parts, lifecycle_rules
        -> Placement service: which storage nodes get a new chunk (3 nodes in 3 different AZs, capacity-aware); keeps node membership via heartbeats
        -> Storage (data) nodes: many servers with HDDs; store chunks inside large append-only volume files (e.g. 1 GB) + a local index chunk_id -> (volume, offset, length, crc32c)
        -> Kafka: `storage.events` (object.created/deleted notifications) + background job topics
  Background workers: replication repair, erasure-coding (lifecycle to COLD), garbage collector + volume compaction, scrubber (checksum verification), multipart cleanup
```
- Node.js is used for the API service, metadata service and background workers (I/O and streaming heavy). Say honestly: real data nodes are usually written in Go/Rust/C++ for disk and memory control; we show a simplified Node.js data node for learning (streams + fsync).
- Redis: small optional cache for bucket metadata/auth lookups and hot object metadata (short TTL); never the source of truth. Not needed in V1.
- No Elasticsearch (LIST is a prefix range scan on the metadata DB).

## Write path (decided)
1. API authenticates, validates (bucket exists, size limit, Content-Length present).
2. Asks placement service for 3 nodes (3 AZs) for each chunk.
3. Streams each 8 MB chunk to the **primary** node, which forwards to the 2 replicas (chain/pipeline replication); every node computes CRC32C and fsyncs before acking.
4. **Write quorum W = 2 of N = 3**: the chunk is considered durable when 2 replicas in 2 different AZs have fsynced; the 3rd is completed asynchronously or by the repair worker (repair task published to Kafka `storage.repair`).
5. Only after all chunks are durable, ONE metadata transaction: insert `objects` row (new `version_id`), `object_chunks`, `chunk_locations`, flip `is_latest` (previous latest -> false), commit. **Commit = the moment the object becomes visible** (strong read-after-write). Then an outbox row -> `storage.events`.
6. Response `200 { etag, versionId }`. ETag = MD5 hex of the bytes for single PUT; for multipart = MD5 of the concatenated binary part MD5s + `-<partCount>` (S3 convention).
- If the client disconnects or a node fails mid-upload: nothing is committed in metadata -> no object; orphan chunks are cleaned by the garbage collector (chunks with no `object_chunks` reference older than 24 h).
- Concurrent PUTs to the same key: **last writer wins by metadata commit order** (each PUT gets its own version_id; the later commit becomes `is_latest`). No locks on data nodes.

## Read path (decided)
1. CDN hit -> done (public objects only).
2. API authenticates, reads latest version + chunk list + locations from metadata (primary or a synchronous standby -- never an async replica for GET-after-PUT correctness).
3. For each needed chunk (only those overlapping the `Range`), read from the nearest healthy replica; verify CRC32C; on mismatch/timeout try the next replica and publish a repair task.
4. Stream to the client with backpressure (`stream.pipeline`).

## Durability mechanisms (decided)
- 3 replicas across 3 AZs for STANDARD class; W=2 ack + async 3rd + repair.
- Erasure coding **8+4 Reed-Solomon** for COLD class (objects older than 30 days via lifecycle): 8 data fragments + 4 parity fragments on 12 different nodes, survives any 4 losses, 1.5x overhead. Reads of COLD data are slower (need 8 fragments).
- Checksums end to end: client `Content-MD5` / `x-checksum-sha256` optional, CRC32C per chunk stored in metadata and on the node, verified on every read and by the **scrubber** (reads everything periodically, e.g. every 2 weeks).
- Heartbeats: nodes heartbeat to placement every 5 s; node missing > 10 min -> declared dead -> repair workers re-replicate its chunks from surviving replicas.
- Deletes: metadata first (object disappears immediately), bytes reclaimed later by GC + volume compaction (rewrite volumes with > 30% garbage).

## Database (decided; metadata only)
```sql
CREATE TABLE buckets (
  id                 BIGSERIAL PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE CHECK (name ~ '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'),
  owner_id           TEXT NOT NULL,
  versioning_enabled BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE objects (
  version_id       TEXT PRIMARY KEY,                     -- ULID, sortable
  bucket_id        BIGINT NOT NULL REFERENCES buckets(id),
  key              TEXT NOT NULL,                        -- up to 1024 bytes UTF-8
  is_latest        BOOLEAN NOT NULL,
  is_delete_marker BOOLEAN NOT NULL DEFAULT false,
  size_bytes       BIGINT NOT NULL CHECK (size_bytes >= 0),
  etag             TEXT NOT NULL,
  content_type     TEXT NOT NULL DEFAULT 'application/octet-stream',
  storage_class    TEXT NOT NULL DEFAULT 'STANDARD' CHECK (storage_class IN ('STANDARD','COLD')),
  user_metadata    JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_objects_latest ON objects (bucket_id, key) WHERE is_latest;   -- one latest version per key
CREATE INDEX ix_objects_list ON objects (bucket_id, key, created_at DESC);           -- prefix LIST + version history

CREATE TABLE object_chunks (
  version_id   TEXT NOT NULL REFERENCES objects(version_id),
  seq          INT  NOT NULL,                 -- 0,1,2... order of chunks
  chunk_id     TEXT NOT NULL,                 -- 'ch_<ULID>'
  size_bytes   INT  NOT NULL,
  crc32c       BIGINT NOT NULL,
  PRIMARY KEY (version_id, seq)
);

CREATE TABLE chunk_locations (
  chunk_id   TEXT NOT NULL,
  node_id    TEXT NOT NULL,                   -- 'node-az1-017'
  volume_id  TEXT NOT NULL,
  offset_bytes BIGINT NOT NULL,
  state      TEXT NOT NULL CHECK (state IN ('WRITING','DURABLE','CORRUPT','DELETED')),
  PRIMARY KEY (chunk_id, node_id)
);

CREATE TABLE multipart_uploads (
  upload_id  TEXT PRIMARY KEY,                -- 'up_<ULID>'
  bucket_id  BIGINT NOT NULL REFERENCES buckets(id),
  key        TEXT NOT NULL,
  state      TEXT NOT NULL CHECK (state IN ('IN_PROGRESS','COMPLETED','ABORTED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_mpu_stale ON multipart_uploads (created_at) WHERE state = 'IN_PROGRESS';

CREATE TABLE upload_parts (
  upload_id   TEXT NOT NULL REFERENCES multipart_uploads(upload_id),
  part_number INT  NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
  size_bytes  BIGINT NOT NULL,
  md5_hex     TEXT NOT NULL,
  chunk_ids   TEXT[] NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (upload_id, part_number)        -- re-uploading a part replaces it (last one wins)
);
```
- Postgres for metadata: transactions (object + chunks + is_latest flip in one commit), unique partial index, ordered prefix scans with B-tree. At scale: shard by **range of (bucket_id, key)** (keeps prefix LIST on one or few shards; hot prefixes get split) -- trade-off vs hash sharding (even load, but LIST must fan out to all shards). Alternatives discussed: FoundationDB / TiKV / Cassandra-like KV stores.
- Data never in the DB.

## APIs (decided; REST, S3-inspired but simplified)
- Auth: `Authorization: SBX1-HMAC-SHA256 Credential=<keyId>, SignedHeaders=..., Signature=<hex>` over method + path + sorted query + selected headers + payload hash + `x-sbx-date` (reject if clock skew > 15 min) -- or a presigned URL (`?X-Sbx-KeyId=&X-Sbx-Expires=&X-Sbx-Signature=`).
- `PUT /v1/buckets/:bucket` -> 201; `DELETE /v1/buckets/:bucket` -> 204 (409 `BUCKET_NOT_EMPTY`).
- `PUT /v1/buckets/:bucket/objects/*key` (body = raw bytes; `Content-Length` required, max 100 MB -> 413 `USE_MULTIPART`; optional `Content-MD5`, `If-None-Match: *` for create-only) -> `200 { "etag": "\"9b2c...\"", "versionId": "01J8..." }`.
- `GET /v1/buckets/:bucket/objects/*key` (optional `Range: bytes=0-1048575`, `?versionId=`) -> 200 / 206 Partial Content / 404 `NO_SUCH_KEY` / 416; headers `ETag`, `Content-Length`, `Content-Type`, `Last-Modified`, `Accept-Ranges: bytes`; supports `If-None-Match` -> 304.
- `HEAD` same path -> headers only. `DELETE` same path -> 204 (idempotent: deleting a missing key is also 204).
- `GET /v1/buckets/:bucket/objects?prefix=invoices/2026/&delimiter=/&limit=1000&cursor=<opaque>` -> `{ items: [...], commonPrefixes: [...], nextCursor }` (cursor = last key, base64).
- Multipart: `POST /v1/buckets/:bucket/uploads { key, contentType }` -> `{ uploadId }`; `PUT /v1/buckets/:bucket/uploads/:uploadId/parts/:partNumber` -> `{ etag }`; `POST /v1/buckets/:bucket/uploads/:uploadId/complete { parts: [{ partNumber, etag }] }` -> `{ etag: "\"...-N\"", versionId }` (400 `INVALID_PART_ORDER`, 400 `ENTITY_TOO_SMALL` if a non-last part < 5 MB, 404 `NO_SUCH_UPLOAD`); `DELETE /v1/buckets/:bucket/uploads/:uploadId` -> 204.
- `POST /v1/presign { bucket, key, method: "GET"|"PUT", expiresInSec (max 604800) }` -> `{ url, expiresAt }`.
- Errors JSON: `{ "error": "NO_SUCH_KEY", "message": "..." }`; 403 `SIGNATURE_MISMATCH` / `REQUEST_EXPIRED`, 429 rate limited, 503 `SLOW_DOWN` when a shard/prefix is overloaded.

## Names (use exactly)
- TypeScript:
```ts
type StorageClass = 'STANDARD' | 'COLD';
interface ObjectMeta { versionId: string; bucketId: number; key: string; sizeBytes: number; etag: string; contentType: string; storageClass: StorageClass; isDeleteMarker: boolean; createdAt: Date }
interface ChunkRef { seq: number; chunkId: string; sizeBytes: number; crc32c: number; locations: { nodeId: string; volumeId: string; offsetBytes: number }[] }
interface PlacementService { pickNodes(chunkId: string, replicas: 3): Promise<string[]> }   // 3 node ids, 3 AZs
interface StorageNodeClient { putChunk(nodeId: string, chunkId: string, data: Buffer, replicas: string[]): Promise<{ crc32c: number }>; getChunk(nodeId: string, chunkId: string): Promise<NodeJS.ReadableStream> }
```
- Constants: `CHUNK_SIZE = 8 * 1024 * 1024`, `MAX_SINGLE_PUT = 100 * 1024 * 1024`, `MIN_PART = 5 * 1024 * 1024`, `MAX_PARTS = 10_000`, `REPLICAS = 3`, `WRITE_QUORUM = 2`.
- Files (LLD): `src/routes/{bucket,object,multipart,presign}.routes.ts`, `src/middleware/{sigv-auth,rate-limit}.ts`, `src/controllers/{object,multipart}.controller.ts`, `src/services/{object,multipart,presign}.service.ts`, `src/storage/{chunker,placement.client,storage-node.client,replicated-writer}.ts`, `src/repositories/{bucket,object,upload}.repository.ts`, `src/workers/{repair,gc,scrubber,lifecycle}.worker.ts`, `src/datanode/{server,volume}.ts` (simplified data node), `src/utils/{crc32c,etag,signature}.ts`, `src/infra/{postgres,kafka,logger,metrics}.ts`, `src/app.ts`, `src/server.ts`.
- Kafka topics: `storage.events` (object.created / object.deleted), `storage.repair`, `storage.gc`.
- Metrics: `storage_requests_total{op,status}`, `storage_request_duration_seconds{op}` (time to first byte + total), `storage_bytes_in_total`, `storage_bytes_out_total`, `chunks_under_replicated` (gauge -- must trend to 0), `repair_queue_lag_seconds`, `scrubber_corrupt_chunks_total`, `node_disk_used_ratio{node}`, `placement_live_nodes{az}`, `metadata_query_duration_seconds`, `gc_reclaimed_bytes_total`, `multipart_incomplete_uploads`.

## Style rules (every part)
- Title: `# File Storage (S3-style) -- HLD + LLD (Part N: A -> B -> C)` (the reader uses the text inside `(Part N: ...)` as the chapter label).
- Easy Hinglish, ASCII only (no em/en dashes, smart quotes, arrows, box-drawing, emojis), Node.js/TypeScript, `**Code Explanation:**` line-by-line after every code block, interview lines, `## Remember` + `## Quick Self-Test` (5 questions) at end, final `**Next (Part N+1):** ... "next" bolo.` line (Part 6 ends with `**File Storage complete.** Next system: **News Feed**. "next" bolo.`).
- Be honest: real S3 is vastly bigger and its internals are only partly public; this is the design an interviewer expects. Hedge any claim about S3 internals ("publicly described", "commonly").
- Keep each part between 700 and 950 lines.
