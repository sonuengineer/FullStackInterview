# Vector Search & Core RAG

## Index creation

> Core | Fast CP3 / Slow CP4 | ~1.2 h | Builds on: M06-03, M06-07

### Kahani
Logistics customer ka POC 5,000 chunks pe tha -- numpy brute force, 3 ms per query, sab khush. Production mein 80 lakh chunks aaye (har shipment ka ticket history). Ab har query 2 second, aur 50 concurrent users pe API timeout.
Kisi ne vector DB mein HNSW index bana diya default settings ke saath -- latency theek, lekin QA team ne notice kiya ki kuch sahi documents "kabhi kabhi" nahi aate.
Dono problems ek hi concept se aati hain: exact search vs approximate nearest neighbour (ANN), aur uske knobs.

### What it is
**Index** = vectors ko aise organise karna ki query pe har vector score na karna pade. **Flat** (brute force) = exact, simple, O(N). **ANN** (IVF, HNSW) = sirf chhota candidate set scan karo -- bahut fast, lekin kabhi kabhi true neighbour miss (recall < 100%).
IVF = k-means se vectors ko `nlist` buckets mein baanto, query pe `nprobe` nearest buckets scan karo. HNSW = multi-layer graph; query greedy walk karti hai neighbours pe.

### Why it matters for an FDE
Customer ke sizing questions ("kitni RAM? kitna latency? kitna recall?") ka jawab inhi params se aata hai. Default params pe chalaya aur recall measure nahi kiya to bot "random" lagta hai aur koi debug nahi kar paata.

### Key concepts
- **Flat is fine to ~1 lakh** -- chhote corpora pe brute force (numpy/pgvector without index) simplest aur exact hai; ANN tab lao jab latency maange.
- **IVF knobs** -- `nlist` (buckets, often ~sqrt(N) as a starting point) aur `nprobe` (query pe kitne buckets); nprobe badhao = recall up, latency up.
- **HNSW knobs** -- `M` (har node ke links, memory), `ef_construction` (build quality/time), `ef_search` (query-time candidate list; recall vs latency).
- **Recall vs exact** -- ANN ko hamesha flat search ke against measure karo, same queries pe: "recall@10 vs exact".
- **Build cost** -- IVF ko training (k-means) chahiye aur data drift pe retrain; HNSW RAM-heavy hai aur deletes/updates pe tuning maangta hai.

### Code example
`pip install numpy`

```python
# runnable
import time

import numpy as np

rng = np.random.default_rng(0)
DIM, N, TOPICS = 64, 20000, 50

def unit(x):
    return x / np.linalg.norm(x, axis=-1, keepdims=True)

# Synthetic "chunk embeddings": 50 topic clusters, like real docs (refunds, KYC, shipping, ...)
centers = unit(rng.normal(size=(TOPICS, DIM)))
X = unit(centers[rng.integers(0, TOPICS, N)] + 0.2 * rng.normal(size=(N, DIM))).astype(np.float32)
queries = unit(X[rng.choice(N, 50, replace=False)] + 0.03 * rng.normal(size=(50, DIM))).astype(np.float32)

class FlatIndex:
    """Exact search: score every vector. O(N * dim) per query, 100% recall."""
    def __init__(self, vecs):
        self.vecs = vecs
    def search(self, q, k):
        return np.argsort(-(self.vecs @ q))[:k]

class TinyIVF:
    """IVF idea: k-means into nlist buckets; at query time scan only the nprobe nearest buckets."""
    def __init__(self, vecs, nlist=64, iters=8, seed=1):
        r = np.random.default_rng(seed)
        self.vecs = vecs
        self.centroids = vecs[r.choice(len(vecs), nlist, replace=False)].copy()
        for _ in range(iters):                                    # a few rounds of spherical k-means
            assign = np.argmax(vecs @ self.centroids.T, axis=1)
            for c in range(nlist):
                members = vecs[assign == c]
                if len(members):
                    self.centroids[c] = unit(members.mean(axis=0))
        assign = np.argmax(vecs @ self.centroids.T, axis=1)
        self.lists = [np.nonzero(assign == c)[0] for c in range(nlist)]   # inverted lists
    def search(self, q, k, nprobe=4):
        probe = np.argsort(-(self.centroids @ q))[:nprobe]
        cand = np.concatenate([self.lists[c] for c in probe])
        self.last_scanned = len(cand)
        return cand[np.argsort(-(self.vecs[cand] @ q))[:k]]

t0 = time.perf_counter()
flat = FlatIndex(X)
ivf = TinyIVF(X)
print(f"build time (ivf incl. k-means): {time.perf_counter() - t0:.2f}s, list sizes min/max:",
      min(map(len, ivf.lists)), max(map(len, ivf.lists)))

K = 10
truth = [set(flat.search(q, K).tolist()) for q in queries]
results = {}
for nprobe in [1, 2, 4, 8, 16]:
    hits, scanned = 0, 0
    for q, t in zip(queries, truth):
        hits += len(t & set(ivf.search(q, K, nprobe).tolist()))
        scanned += ivf.last_scanned
    results[nprobe] = (hits / (K * len(queries)), scanned / (len(queries) * N))
    print(f"nprobe={nprobe:2d}  recall@{K} vs exact = {results[nprobe][0]:.2f}  scanned = {results[nprobe][1]:.1%} of vectors")

assert results[1][0] < results[4][0] < results[16][0]       # more probes -> better recall
assert results[16][0] >= 0.95 and results[16][1] < 0.5        # near-exact while scanning < half
assert results[1][1] < 0.1                                    # nprobe=1 is fast but lossy
print("OK: ANN trades a little recall for scanning far fewer vectors")
```

- Synthetic data 50 "topics" mein clustered hai -- real chunk embeddings bhi clustered hote hain; isi wajah se IVF kaam karta hai.
- `TinyIVF.__init__` -- k-means centroids + inverted lists (bucket -> vector ids). Yahi "index creation" hai: ek baar ka kaam, query time pe fayda.
- `search(..., nprobe)` -- sirf nearest buckets ke candidates score hote hain. Table: nprobe=1 pe ~2% vectors scan, recall ~0.80; nprobe=16 pe ~25% scan, recall ~0.99.
- `truth` flat index se -- ANN ka recall hamesha exact search ke against nikalo; ye aapka regression test hai jab koi params badle.
- Ye toy hai: real libraries (FAISS, hnswlib, pgvector, Qdrant) C++/SIMD mein, quantization ke saath -- lekin knobs ka matlab yahi hai.

```python
# real version -- not run here, needs: pip install faiss-cpu hnswlib numpy
import faiss
import hnswlib

d = X.shape[1]
quantizer = faiss.IndexFlatIP(d)                          # inner product on unit vectors = cosine
ivf = faiss.IndexIVFFlat(quantizer, d, 256, faiss.METRIC_INNER_PRODUCT)   # nlist=256
ivf.train(X); ivf.add(X)
ivf.nprobe = 8
D, I = ivf.search(queries, 10)

hnsw = hnswlib.Index(space="cosine", dim=d)
hnsw.init_index(max_elements=len(X), M=16, ef_construction=200)
hnsw.add_items(X)
hnsw.set_ef(64)                                           # ef_search; must be >= k
labels, distances = hnsw.knn_query(queries, k=10)
```

```sql
-- pgvector (Postgres): same knobs as SQL. Check the docs for your pgvector version.
CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
SET hnsw.ef_search = 40;
-- or IVF:
CREATE INDEX ON chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
SET ivfflat.probes = 10;
```

### Mini-exercise (30-60 min)
`omniguard/rag/dense_index.py` -- ek `DenseIndex` interface (`add(ids, vecs)`, `search(q, k)`) aur `FlatDenseIndex` implementation (numpy). Persist: `np.save` vectors + JSON ids + `{"model", "dim", "chunking_version"}` metadata.
- `scripts/ann_check.py`: apne chunks pe (ya 50k synthetic) flat vs IVF/hnswlib (agar install kar sako) -- recall@10 vs exact, p50/p95 latency, memory. Table README mein.
- Acceptance: test -- index reload ke baad same query same ids de; metadata mein `dim` mismatch pe load fail ho with clear error.

### Common pitfalls
- ANN params default chhod dena aur recall kabhi na naapna -- "kabhi kabhi doc nahi aata" complaints yahi se.
- Metadata filter ke saath ANN (M06-08): bahut selective filter pe HNSW ke candidates filter mein kat jaate hain aur results kam aate hain; DB ka filtered-search behaviour docs mein check karo.
- IVF ko chhote/purane sample pe train karke naya data add karte rehna -- buckets imbalanced, recall girta hai; periodic rebuild plan karo.

### Checklist before moving on
- [ ] Flat vs ANN kab choose karna hai, numbers ke saath bata sakta hoon.
- [ ] `nlist/nprobe` aur `M/ef_construction/ef_search` ka effect samjha sakta hoon.
- [ ] ANN recall ko exact search ke against measure karta hoon.
- [ ] Index ke saath model name, dim aur chunking version store karta hoon.

### Related
- M06-03 Understanding vector representations
- M06-04 Dimensionality trade-offs
- M06-07 Distance metrics (Cosine, Euclidean)
- M06-08 Metadata filtering
- M06-09 Cloud vector database provisioning

### Self-quiz
1. 50k chunks ka customer HNSW maang raha hai. Aap kya recommend karoge aur kyun?
2. nprobe 1 se 16 karne pe recall aur latency dono kyun badhte hain? Kaunsa number customer ko dikhaoge?
3. HNSW mein `ef_search` aur `M` mein kya farak hai -- kaunsa query time pe change ho sakta hai bina rebuild?
4. "Recall@10 vs exact = 0.9" ka matlab kya hai, aur ye RAG answer quality ko kaise affect karta hai?
