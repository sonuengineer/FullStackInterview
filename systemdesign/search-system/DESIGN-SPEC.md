# Search System -- shared design spec (for writing Parts 1-6 consistently)

Single source of truth for this system's lessons. Every part MUST use these exact numbers, names, schemas and decisions. Not a lesson itself (build.mjs skips `DESIGN-SPEC.md`).

## Scenario
Hum ek **marketplace ka product search** bana rahe hain (Flipkart / Amazon / Myntra style). 50M products, 20,000 sellers. Search box mein user type karta hai -> **autocomplete suggestions** aate hain -> Enter dabata hai -> **relevant products** + **filters/facets** (brand, price range, rating, category, in-stock) + **sort** (relevance, price, newest, rating) dikhte hain.

Kahani jisse shuru karna hai (Part 1): shuruaat mein search bas ye tha --
```sql
SELECT * FROM products WHERE name ILIKE '%iphone case%' LIMIT 20;
```
Ye 50,000 products tak theek chala. 50M par: **full table scan, 8-12 second query, DB CPU 100%**, aur phir bhi result kharab -- "iphone case" likhne par "iPhone 15" upar aata hai aur actual case neeche; "iphon cover" likhne par **zero results**; "mobile" likhne par "mobile charger" hi nahi milta agar title mein "Mobile" capital ho ya "Mobiles" plural ho.

Ye do alag problems hain aur dono ko Part 1 mein alag karna hai:
1. **Speed problem** -- `%term%` kisi B-tree index ko use nahi kar sakta (leading wildcard).
2. **Relevance problem** -- SQL `LIKE` boolean hai (match / no match). Usme "kaun sa result zyada relevant hai" ka koi concept hi nahi.

Search system in dono ko solve karta hai: **inverted index** (speed) + **scoring/ranking** (relevance).

Connection to previous systems:
- **URL Shortener** se: wahan lookup key exact thi (`short_code` -> ek row, hash/B-tree index kaafi). Yahan query **text** hai aur ek query **hazaaron** documents match karti hai, phir unhe **rank** karna padta hai -- isliye alag data structure chahiye.
- **Rate Limiter** se: search API par per-IP limit (scrapers price scraping karte hain), aur autocomplete par alag (zyada) limit.
- **Notification / Paging** se: wahan Kafka events incidents banate the; yahan Kafka events **index updates** banate hain -- same CDC/outbox pattern, alag consumer.

## Requirements
Functional:
1. **Full-text search** `q` par: typo tolerance (`iphon` -> `iphone`), stemming (`running` ~ `run`, `mobiles` ~ `mobile`), synonyms (`mobile` = `smartphone` = `cell phone`), multi-word phrase handling.
2. **Filters (facets):** category, brand, price range, rating >= X, in-stock only, seller rating, discount %.
3. **Facet counts:** "Samsung (1,204)", "Apple (890)" -- har filter ke aage kitne results.
4. **Sorting:** relevance (default), price asc/desc, newest, rating, popularity.
5. **Pagination:** page 1-5 tak `from/size`, usse aage **`search_after`** (deep pagination problem).
6. **Autocomplete:** har keystroke par top 10 suggestions, **p99 < 100 ms**.
7. **Near-real-time indexing:** seller product update kare -> search mein **<= 30 s** mein dikhe (price/stock ke liye stricter path).
8. **Business ranking:** text relevance ke upar business boosts -- in-stock, popularity (30-day orders), seller rating, "sponsored" slots (clearly marked).
9. **Analytics:** har query log ho (query, results count, clicked position) -- zero-result rate, CTR, aur synonyms/ranking improvement ke liye.

Non-functional (aur KYUN):
- **Latency:** search p95 < 200 ms, p99 < 400 ms; autocomplete p99 < 100 ms. Search ek **interactive** feature hai -- 1 s = user bounce, conversion gir jaata hai (Amazon ka classic "100 ms = 1% sales" wala data point).
- **Availability 99.95%** -- search down = homepage se aage koi nahi badh paayega = revenue zero. Isliye **fallback path** (Postgres/degraded search) chahiye.
- **Eventual consistency acceptable** -- product update 30 s mein dikhe toh chalega. LEKIN **stock/price** galat dikhana business problem hai (user cart mein daalega phir "out of stock"), isliye price/stock ka special treatment.
- **Scalability:** index 50M docs, traffic 4x peak (sale days 20x).
- Cost: ES cluster RAM-heavy hota hai; nodes ka size + shard count cost decision hai.

## Numbers (verified; use exactly)
- **Catalog: 50M products.** Searchable doc ~2 KB (title, description snippet, brand, category path, attributes, price, stock, ratings) -> raw **~100 GB**.
- ES index size ~1.3x source (inverted index + doc values + stored `_source`) -> **~130 GB primary data**.
- **Shards:** target 25-40 GB per shard -> **6 primary shards** (~22 GB each) **+ 1 replica** = 12 shards total, ~260 GB cluster data.
  - Nodes: **6 data nodes** (2 shards each, 64 GB RAM, 31 GB JVM heap -- heap kabhi 32 GB se upar nahi, compressed oops), **3 dedicated master nodes** (quorum, split-brain se bachne ke liye).
- **Search traffic: 20M searches/day** -> 20e6/86400 = **231 QPS average**, peak 4x = **~1,000 QPS**, sale day 20x = **~4,600 QPS**.
- **Autocomplete traffic:** user avg 12 characters type karta hai, 150 ms debounce ke baad ~4 requests per search -> 80M/day = **~925 QPS avg, ~4,000 QPS peak**. **Key insight: autocomplete traffic search se 4x zyada hai** -- isliye alag lightweight index + Redis cache, warna main cluster mar jaayega.
- **Head queries:** top 1,000 queries = traffic ka ~30% (Zipf distribution) -> Redis query cache se **~30% requests ES tak jaati hi nahi**. Cache TTL 60 s (page 1 only, no personalization).
- **Updates: 5M product updates/day** = **58/sec avg**, flash sale par **~500/sec** (price/stock changes majority).
  - Full doc reindex 5M x 2 KB = 10 GB/day bulk traffic -- theek hai. Lekin ES mein har update = **delete + re-insert** (immutable segments) -> segment merge load. Isliye "stock ke har change par reindex" **galat** approach hai (Part 3/Part 4 mein discuss).
- **Query latency budget (200 ms p95):** Node API overhead ~10 ms + network ~5 ms + ES query 60-120 ms (6 shards parallel, slowest shard decides) + facet aggregations +20-40 ms + response serialization ~10 ms.
- **Zero-result rate target < 5%**; abhi baseline ~12% (typos + synonyms missing).
- Query log: 20M + 80M autocomplete/day x ~300 B = **~30 GB/day** Kafka -> S3/warehouse (7 day Kafka retention).

## Architecture (decided)
```
Browser (debounced 150 ms input)
   |  GET /api/v1/suggest?q=iph        |  GET /api/v1/search?q=iphone+case&brand=Apple&page=1
   v                                    v
                        Load Balancer / API Gateway
                                    v
                   Search API (N stateless Node.js instances)
                     |-- rate limit per IP (Rate Limiter lesson)
                     |-- Redis: head-query cache (60 s) + popular-prefix cache (suggest)
                     |-- QueryBuilder: parse -> analyze -> ES query DSL (bool: must/filter/should)
                     v
              Elasticsearch / OpenSearch cluster
                 index `products_v3` behind alias `products`  (6 primary x 1 replica)
                 index `suggestions_v2` (small, edge n-gram, fits in RAM)
                                    ^
                                    |  bulk index (workers)
Indexer Workers (Kafka consumer group) <---- Kafka `product-changes` (12 partitions, key=productId)
                                    ^
                                    |  outbox poller / Debezium CDC
Postgres `products` (SOURCE OF TRUTH) + `product_outbox`
                                    ^
                                    |  seller updates product
                        Catalog Service (writes)

Side path: query logs -> Kafka `search-queries` -> S3/warehouse -> popularity + synonyms + zero-result reports
                                                                 -> feeds `popularity_score` back into index (nightly)
```
**Decided but NOT in v1 (explicitly bolna):** Learning-to-Rank plugin (v3 topic), vector/semantic search (embeddings + kNN -- v3, mention as "modern addition"), personalization per user (v3, aur ye caching ko todta hai), multi-region active-active (v3), CDN for search results (nahi -- results personalized/volatile; sirf static facets/category pages CDN-able).

## Key mechanisms (decided; teach from scratch)
1. **Inverted index zero se:** documents -> analyzer (char filter -> tokenizer -> lowercase -> stop words -> stemmer) -> terms -> postings list `term -> [docId(+positions, freq)]`. Chhota example use karo (5 products, "red cotton shirt" type), by hand table banao, phir query "cotton shirt" ke liye postings intersect karke dikhao. Phir bolo: "Postgres ka `ILIKE '%x%'` isme se kuch nahi kar sakta -- usko har row padhni padti hai."
2. **Scoring: TF-IDF -> BM25.** BM25 formula likho aur har term ka matlab batao:
   - `tf` (term frequency, saturating -- `k1 = 1.2`), `idf` (rare term = zyada weight), field length normalization (`b = 0.75`, chhote title mein match = zyada strong signal).
   - Manual mini-calculation dikhao (2 documents, ek term) taaki number samajh aaye.
3. **Query context vs filter context:** `must`/`should` = score karte hain (mehenga, cacheable nahi); `filter` = sirf yes/no, **cacheable bitset** (`brand`, `price range`, `in_stock`). **Rule: jo cheez score mein contribute nahi karti, usse hamesha `filter` mein daalo.**
4. **Function score / business boost:** `function_score` with `field_value_factor` on `popularity_score` (log1p, weight 0.3) + `in_stock` boost + freshness decay. **Rule: text relevance ko multiply karo, replace mat karo.**
5. **Autocomplete:** teen options compare karne hain --
   - `match_phrase_prefix` on main index (easy, par slow aur fuzzy nahi),
   - **edge n-gram index** (`iphone` -> `i, ip, iph, ipho, iphon, iphone` index time par; query time par simple term match) -- **hamari choice**, kyunki index time par kaam karke query time O(1) ho jaata hai,
   - `completion suggester` (FST, in-memory, sabse fast par filters/typo limited).
   Plus Redis mein top ~10K popular prefixes ka precomputed result (TTL 10 min) -- 4,000 QPS ka bada hissa ES tak pahunchta hi nahi.
6. **Typo tolerance:** `fuzziness: AUTO` (Levenshtein edit distance: length 1-2 -> 0 edits, 3-5 -> 1 edit, >5 -> 2 edits), `prefix_length: 1` (pehla letter sahi maano -- warna index ka bada hissa scan hota hai) aur `max_expansions: 50`. Cost samjhao: fuzzy = term dictionary mein multiple terms expand karna = mehenga.
7. **Synonyms:** `synonym_graph` filter **search time par** (index time nahi) -- kyunki synonym list badalne par poora reindex nahi karna padta. Trade-off: search-time thoda slow, index-time fast par rigid.
8. **Indexing pipeline (outbox pattern):** Postgres transaction mein product update + `product_outbox` row ek saath (atomic) -> poller/Debezium outbox padhta hai -> Kafka `product-changes` -> indexer worker **bulk API** (500 docs ya 5 MB ya 1 s, jo pehle) -> ES. **Dual-write (DB + ES seedha app se) kyun galat hai** -- ek fail ho jaaye toh permanent divergence. Ye Part 2/3 ka core lesson hai.
9. **Zero-downtime reindex (alias swap):** `products_v3` naya index banao -> `_reindex` + live Kafka tail -> verify (doc count, sample queries) -> `POST /_aliases` atomic swap (`remove products_v2, add products_v3`) -> purana index rakho 24 h (rollback ke liye).
10. **Near-real-time:** `refresh_interval: 1s` normal, bulk reindex ke dauran `-1`; segments immutable hain, delete = tombstone, merges background mein. Isliye "har stock change par doc update" = **segment churn**; decision: **stock ko doc mein `in_stock` boolean rakho (filter ke liye) aur exact quantity Redis/DB se serve karo product page par**. Price change indexed hota hai (search results mein dikhta hai) par debounced (30 s batch window).

## Names (use exactly)
- Indices: `products_v3` (alias `products`), `suggestions_v2` (alias `suggestions`). Kafka topics: `product-changes` (12 partitions, key=`productId`), `search-queries`. Consumer group: `product-indexer`.
- Redis keys: `q:<sha1(normalizedQuery+filters+sort+page)>` (search result cache, TTL 60 s), `sug:<prefix>` (TTL 600 s), `rl:search:<ip>` (token bucket).
- ES mapping (core fields, use exactly):
```json
{
  "settings": {
    "number_of_shards": 6, "number_of_replicas": 1, "refresh_interval": "1s",
    "analysis": {
      "filter": {
        "en_stop":     { "type": "stop", "stopwords": "_english_" },
        "en_stemmer":  { "type": "stemmer", "language": "english" },
        "syn_graph":   { "type": "synonym_graph", "synonyms_path": "synonyms.txt" },
        "edge_ngram":  { "type": "edge_ngram", "min_gram": 2, "max_gram": 20 }
      },
      "analyzer": {
        "product_index":  { "tokenizer": "standard", "filter": ["lowercase", "en_stop", "en_stemmer"] },
        "product_search": { "tokenizer": "standard", "filter": ["lowercase", "syn_graph", "en_stop", "en_stemmer"] },
        "autocomplete_index": { "tokenizer": "standard", "filter": ["lowercase", "edge_ngram"] }
      }
    }
  },
  "mappings": {
    "properties": {
      "productId":   { "type": "keyword" },
      "title":       { "type": "text", "analyzer": "product_index", "search_analyzer": "product_search",
                       "fields": { "keyword": { "type": "keyword", "ignore_above": 256 },
                                   "ac": { "type": "text", "analyzer": "autocomplete_index", "search_analyzer": "standard" } } },
      "description": { "type": "text", "analyzer": "product_index", "search_analyzer": "product_search" },
      "brand":       { "type": "keyword" },
      "categoryPath":{ "type": "keyword" },
      "attributes":  { "type": "flattened" },
      "price":       { "type": "scaled_float", "scaling_factor": 100 },
      "rating":      { "type": "half_float" },
      "ratingCount": { "type": "integer" },
      "inStock":     { "type": "boolean" },
      "sellerId":    { "type": "keyword" },
      "popularityScore": { "type": "float" },
      "createdAt":   { "type": "date" },
      "updatedAt":   { "type": "date" },
      "version":     { "type": "long" }
    }
  }
}
```
- Canonical search query (Part 2/3 line-by-line explain karega):
```json
{
  "size": 24,
  "query": {
    "function_score": {
      "query": {
        "bool": {
          "must": [{
            "multi_match": {
              "query": "iphon case", "fields": ["title^3", "brand^2", "description"],
              "type": "best_fields", "fuzziness": "AUTO", "prefix_length": 1, "max_expansions": 50
            }
          }],
          "filter": [
            { "term":  { "brand": "Apple" } },
            { "range": { "price": { "gte": 500, "lte": 2000 } } },
            { "term":  { "inStock": true } }
          ]
        }
      },
      "functions": [
        { "field_value_factor": { "field": "popularityScore", "modifier": "log1p", "missing": 0 }, "weight": 0.3 },
        { "filter": { "term": { "inStock": true } }, "weight": 1.2 }
      ],
      "score_mode": "sum", "boost_mode": "multiply"
    }
  },
  "aggs": {
    "brands":     { "terms": { "field": "brand", "size": 10 } },
    "categories": { "terms": { "field": "categoryPath", "size": 10 } },
    "price_ranges": { "range": { "field": "price", "ranges": [{ "to": 500 }, { "from": 500, "to": 2000 }, { "from": 2000 }] } }
  },
  "sort": ["_score", { "productId": "asc" }],
  "track_total_hits": 10000
}
```
  (`track_total_hits: 10000` kyun: exact total count nikalna mehenga hai; "10,000+ results" dikhana kaafi hai.)
- TypeScript types:
```ts
interface SearchRequest {
  q: string; page: number; size: number;
  filters: { brand?: string[]; categoryPath?: string[]; priceMin?: number; priceMax?: number; minRating?: number; inStockOnly?: boolean };
  sort: 'relevance' | 'price_asc' | 'price_desc' | 'newest' | 'rating';
  searchAfter?: [number, string];
}
interface SearchHit { productId: string; title: string; brand: string; price: number; rating: number; inStock: boolean; score: number; }
interface FacetBucket { value: string; count: number }
interface SearchResponse {
  hits: SearchHit[]; total: number; totalIsLowerBound: boolean;
  facets: { brands: FacetBucket[]; categories: FacetBucket[]; priceRanges: FacetBucket[] };
  tookMs: number; searchAfter?: [number, string]; degraded?: boolean;
}
interface ProductDoc { productId: string; title: string; description: string; brand: string; categoryPath: string;
  attributes: Record<string, string>; price: number; rating: number; ratingCount: number; inStock: boolean;
  sellerId: string; popularityScore: number; createdAt: string; updatedAt: string; version: number; }
```
- Classes/files (LLD):
```
src/
  routes/          search.routes.ts, suggest.routes.ts, admin.routes.ts
  controllers/     search.controller.ts, suggest.controller.ts
  services/        search.service.ts, suggest.service.ts, indexer.service.ts, reindex.service.ts
  search/          query-builder.ts, response-mapper.ts, facets.ts, analyzer-config.ts
  repositories/    product.repository.ts (Postgres), es.repository.ts (ES client wrapper)
  workers/         product-indexer.worker.ts (Kafka -> bulk), outbox-poller.ts, popularity-job.ts
  middleware/      rate-limit.ts, validate.ts, cache.ts
  infra/           elasticsearch.ts, kafka.ts, redis.ts, postgres.ts, logger.ts, metrics.ts
  app.ts  server.ts
```
- Metrics: `search_requests_total{sort,cached}`, `search_latency_seconds` (histogram, p50/p95/p99), `es_query_duration_seconds{index}`, `search_zero_results_total`, `search_cache_hit_ratio`, `suggest_latency_seconds`, `indexer_lag_seconds` (product `updatedAt` -> searchable), `bulk_index_errors_total`, `es_cluster_status` (green/yellow/red), `es_jvm_heap_used_percent`, `search_degraded_total` (fallback path use hua).

## Database (Postgres = source of truth; ES = derived)
```sql
CREATE TABLE products (
  id            UUID PRIMARY KEY,
  seller_id     UUID NOT NULL,
  title         TEXT NOT NULL,
  description   TEXT,
  brand         TEXT,
  category_path TEXT NOT NULL,             -- 'electronics/mobiles/accessories'
  attributes    JSONB NOT NULL DEFAULT '{}',
  price_paise   BIGINT NOT NULL,           -- paisa/cents, never float for money
  stock_qty     INT NOT NULL DEFAULT 0,
  rating        NUMERIC(2,1) DEFAULT 0,
  rating_count  INT DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','deleted')),
  version       BIGINT NOT NULL DEFAULT 1, -- bumped on every update; used as ES external version
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX products_seller_idx ON products (seller_id, updated_at DESC);

CREATE TABLE product_outbox (              -- written in the SAME transaction as the product change
  id          BIGSERIAL PRIMARY KEY,
  product_id  UUID NOT NULL,
  op          TEXT NOT NULL CHECK (op IN ('upsert','delete')),
  version     BIGINT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ NULL
);
CREATE INDEX product_outbox_unpublished ON product_outbox (id) WHERE published_at IS NULL;

CREATE TABLE search_synonyms (             -- edited by ops, exported to synonyms.txt on reload
  id BIGSERIAL PRIMARY KEY, terms TEXT NOT NULL, enabled BOOLEAN DEFAULT true, updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE query_popularity (            -- nightly job output, feeds suggestions index
  query TEXT PRIMARY KEY, searches_30d BIGINT, ctr NUMERIC(5,4), updated_at TIMESTAMPTZ
);
```
**Version-based conflict handling (important):** ES bulk index `version_type: 'external'` + `version: product.version` -> out-of-order Kafka messages purane data se naye doc ko overwrite nahi kar sakte (ES 409 dega, indexer usse ignore karega). Ye "eventual consistency mein ordering" ka concrete answer hai.

## APIs
```
GET /api/v1/search?q=iphone+case&brand=Apple&priceMin=500&priceMax=2000&inStock=true&sort=relevance&page=1&size=24
  200 { hits, total, totalIsLowerBound, facets, tookMs, searchAfter }
GET /api/v1/suggest?q=iph&limit=10          200 { suggestions: [{ text, type: 'query'|'product'|'category' }] }
POST /api/v1/admin/reindex                   # starts reindex job (admin only)
POST /api/v1/admin/synonyms                  # add/update synonyms, then reload analyzers
GET  /health  /ready                         # ready checks ES cluster status
```
Validation: `q` max 100 chars (lambi query = mehengi fuzzy expansion), `size` max 100, `page` max 50 (uske aage `searchAfter` mandatory), unknown filter = `400`.
Error codes: `400 VALIDATION_ERROR`, `429 RATE_LIMITED`, `503 SEARCH_UNAVAILABLE` (ES red aur fallback bhi fail).

## Decisions settled while writing (parts must follow)
- **v1 ke liye honest answer: agar catalog 100K products hai toh Elasticsearch mat lagao** -- Postgres `tsvector` + GIN index + `pg_trgm` kaafi hai. ES tab lagao jab (a) docs > ~5-10M, (b) facet aggregations chahiye, (c) relevance tuning/typo/synonyms chahiye, (d) search traffic DB ko hurt kar raha ho. Part 1 aur Part 5 dono mein ye clearly likhna hai (don't-overengineer rule).
- **Postgres FTS ka comparison concrete hona chahiye:** `to_tsvector('english', title) @@ plainto_tsquery('iphone case')` + `ts_rank`, GIN index, aur uski limits (facet counts mehenge, distributed nahi, analyzer flexibility kam, ranking tuning limited).
- **Deep pagination:** `from + size` par ES har shard se `from+size` docs laata hai -> page 500 = 6 shards x 12,024 docs coordinate node par = memory blow-up (`index.max_result_window: 10000` default limit). Solution: page <= 50 tak `from/size`, aage `search_after` + tie-breaker `productId`. Scroll API sirf export/offline ke liye (stateful, snapshot, real-time UI ke liye nahi); PIT + search_after modern tareeka.
- **Fallback jab ES down ho:** (1) Redis cache se stale results (head queries), (2) Postgres `pg_trgm`/FTS degraded search top 20 bina facets, `degraded: true` response field + UI banner, (3) phir `503`. Rate Limiter ka "fail open vs closed" wala structure yahan **"degrade, don't die"** ban jaata hai.
- **Money:** `price_paise BIGINT` DB mein, ES mein `scaled_float` (scaling_factor 100). Float rupees kabhi nahi.
- **Stock:** `inStock` boolean index mein (filter ke liye), exact `stock_qty` product page par DB/Redis se. Har quantity change par reindex nahi.
- **Personalization v1 mein nahi** kyunki woh query cache ko kill kar deti hai (har user ke liye alag result); v3 mein re-ranking sirf top 100 results par API layer mein.
- **Sponsored results:** ads ek alag service se aate hain aur top 2 slots par **merge** hote hain -- organic ranking ke andar mix nahi karte (auditability + user trust).
- **Analyzer change = reindex.** Ye rule har jagah dohrana hai: mapping/analyzer badla toh purane docs purane tokens ke saath pade hain -> alias swap wala reindex chahiye. Synonyms search-time hone ki wajah se synonyms change par reindex nahi chahiye (bas `_reload_search_analyzers`).
- **Bulk indexing tuning:** batch 500 docs / 5 MB / 1 s; `refresh_interval: -1` + `number_of_replicas: 0` sirf **initial** full reindex ke dauran, baad mein wapas set karo (aur ye kyun risky hai woh bhi batao).
- ES client: `@elastic/elasticsearch` v8, `maxRetries: 2`, `requestTimeout: 1000` (search ke liye tight), sniffing off behind LB, per-request `timeout: '800ms'` aur `allow_partial_search_results: true` (ek shard slow ho toh baaki results de do -- par response mein `_shards.failed` check karke metric badhao).

## Style rules (every part)
- Title: `# Search System -- HLD + LLD (Part N: A -> B -> C)` (reader `(Part N: ...)` ke andar ka text chapter label banata hai).
- Easy Hinglish, **ASCII only** (no em/en dash, smart quotes, arrows, box-drawing chars, emojis, checkmarks). Use `->`, `--`, `[OK]`, `[X]`.
- Node.js / TypeScript code only (no Java/Python).
- Har code block ke baad `**Code Explanation:**` + line-by-line Hinglish.
- Mermaid diagrams allowed (```mermaid fenced), plus ASCII diagrams aur tables.
- Har part ke end mein: `## Remember` (one memorable line) + `## Quick Self-Test` (5 questions, answers nahi) + `---` + `**Next (Part N+1):** ... "next" bolo.`
- Part 6 ends with: `**Search System complete.** Baaki systems: File Storage (S3-style), News Feed, Chat System. "next" bolo.`
- Har important component ke liye WHY format: Kya hai? / Kyun use kar rahe hain? / Hata dein toh kya hoga? / Kab zarurat nahi? / Interview mein kaise bolun?
