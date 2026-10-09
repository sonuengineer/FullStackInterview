# Vector Search & Core RAG

## Combining dense and sparse signals

> Core | Fast CP3 / Slow CP4 | ~1.2 h | Builds on: M06-03, M06-05, M06-10

### Kahani
Insurance customer ke saath UAT chal raha hai. Claims agents do tarah ke sawaal poochte hain: "5512" ya "PX-1180 coverage" (exact IDs), aur "when do I get my money back" (normal language).
Dense-only bot IDs pe fail, BM25-only bot paraphrases pe fail. Dono teams apna-apna "winner" lekar aayi hain aur aapse poochti hain: kaunsa rakhein?
Jawab: dono. Lekin dono ke scores alag scale pe hain -- inhe jodna hi asli engineering hai.

### What it is
**Hybrid retrieval** = ek hi query pe sparse (BM25/keyword) aur dense (embedding) dono retrievers chalao aur results ko fuse karo.
Fusion ke do common tareeke: **score fusion** (normalise karke weighted sum, `alpha`) aur **rank fusion** (RRF, M06-13 -- sirf ranks use karta hai).

### Why it matters for an FDE
Enterprise queries mixed hoti hain: IDs, product codes, jargon + natural language. Hybrid aksar sabse sasta quality jump hai -- aur customer ke existing keyword search (Elasticsearch, SharePoint) ko throw away kiye bina dense add kar sakte ho.

### Key concepts
- **Complementary failures** -- sparse: synonyms/paraphrase miss; dense: IDs, rare codes, exact numbers blur.
- **Score scales differ** -- BM25 unbounded (0 se 20+), cosine roughly -1 se 1; raw add = BM25 dominate karega.
- **Min-max normalisation** -- har retriever ke scores ko query ke andar 0-1 pe laao, phir `alpha * sparse + (1 - alpha) * dense`.
- **Alpha is a tuning knob** -- eval set pe sweep karo; ID-heavy customer ko zyada sparse weight.
- **Candidate pools** -- production mein har retriever se top-50/100 lo, phir fuse; poore corpus pe score nahi karte.

### Code example
`pip install numpy rank_bm25`

```python
# runnable
import re
import zlib

import numpy as np
from rank_bm25 import BM25Okapi

DOCS = [
    "Policy PX-2291 covers flood damage for commercial warehouses",
    "Policy PX-1180 covers fire damage for retail shops",
    "Reimbursement is processed within one week of claim approval",
    "Ticket 5512: customer wants to renew policy PX-2291 before expiry",
    "Parcels are delivered in five business days",
    "Staff may work from home two days per week",
    "Water damage to stored inventory is covered under flood clauses",
]
EVAL = {  # query -> relevant doc id (hand-labelled, like your eval set)
    "renew PX-2291": 3, "PX-1180 coverage": 1, "5512": 3,                  # exact-ID style
    "when do I get my money back": 2, "how long does shipping take": 4,    # paraphrase style
    "remote working rules": 5, "is water damage to stock insured": 6,
}

def tokenize(t):
    return re.findall(r"[a-z0-9]+(?:-[a-z0-9]+)*", t.lower())

# TOY dense embedder. SYNONYMS fakes what a trained model learns from data, and tokens with
# digits are dropped to mimic how dense models blur IDs. It is NOT a real semantic model.
SYNONYMS = {"reimbursement": "refund", "money": "refund", "back": "refund", "shipping": "deliver",
            "delivered": "deliver", "parcels": "deliver", "remote": "home", "working": "work",
            "stock": "inventory", "insured": "covered", "processed": "refund"}
def toy_dense(text, dim=512):
    v = np.zeros(dim)
    for w in tokenize(text):
        if not any(ch.isdigit() for ch in w):
            v[zlib.crc32(SYNONYMS.get(w, w).encode()) % dim] += 1
    return v / (np.linalg.norm(v) or 1)

bm25 = BM25Okapi([tokenize(d) for d in DOCS])
D = np.stack([toy_dense(d) for d in DOCS])

def sparse_scores(q):
    return np.array(bm25.get_scores(tokenize(q)))
def dense_scores(q):
    return D @ toy_dense(q)
def minmax(x):
    rng = x.max() - x.min()
    return (x - x.min()) / rng if rng else np.zeros_like(x)
def hybrid_scores(q, alpha=0.5):
    return alpha * minmax(sparse_scores(q)) + (1 - alpha) * minmax(dense_scores(q))

def hit_at_1(score_fn):
    return sum(int(np.argmax(score_fn(q))) == rel for q, rel in EVAL.items()) / len(EVAL)

q = "renew PX-2291"
print(f"score scales for {q!r}: bm25 max={sparse_scores(q).max():.2f}, dense max={dense_scores(q).max():.2f}")
results = {"bm25 only": hit_at_1(sparse_scores), "dense only": hit_at_1(dense_scores), "hybrid (minmax, a=0.5)": hit_at_1(hybrid_scores)}
for name, r in results.items():
    print(f"{name:24} hit@1 = {r:.2f}")
for qq in EVAL:
    print(f"  {qq:32} bm25->{int(np.argmax(sparse_scores(qq)))} dense->{int(np.argmax(dense_scores(qq)))} "
          f"hybrid->{int(np.argmax(hybrid_scores(qq)))} (want {EVAL[qq]})")

assert results["hybrid (minmax, a=0.5)"] > max(results["bm25 only"], results["dense only"])
assert results["hybrid (minmax, a=0.5)"] == 1.0
assert sparse_scores(q).max() > 3 * dense_scores(q).max()     # different scales: never add raw scores
print("OK: sparse catches IDs, dense catches paraphrases, hybrid catches both")
```

- `toy_dense` ek honest toy hai: `SYNONYMS` table woh nakli "meaning" hai jo real model data se seekhta hai, aur digits wale tokens drop karke dense models ka ID-blur simulate kiya. Real model ka behaviour similar hai, numbers nahi.
- Per-query table padho: `5512` aur `PX-1180 coverage` pe dense galat (doc 0), paraphrase queries pe BM25 galat -- complementary failures.
- `minmax` -- dono score lists ko 0-1 pe laata hai; zero-variance (sab scores same, jaise dense ka zero vector) pe zeros, taaki doosra signal decide kare.
- Scale assert -- BM25 max 2.11, dense max 0.35; raw sum mein BM25 ka shor dense ki signal ko dabaa deta. Isliye normalise ya rank fusion.
- `EVAL` dict -- 7 hand-labelled queries hi aapka pehla eval set hai. Hybrid ka faisla "feel" se nahi, hit@1 0.57/0.71 -> 1.00 se hua.

```python
# real version -- not run here, needs: pip install sentence-transformers rank_bm25 numpy
from sentence_transformers import SentenceTransformer

model = SentenceTransformer("all-MiniLM-L6-v2")
D = model.encode(DOCS, normalize_embeddings=True)
dense_scores = lambda q: D @ model.encode([q], normalize_embeddings=True)[0]

# Managed DBs can store sparse + dense vectors together and fuse server-side
# (e.g. Qdrant sparse vectors + query fusion, Pinecone sparse-dense, OpenSearch hybrid query).
# APIs differ and change -- check the docs for your provider and version.
```

### Mini-exercise (30-60 min)
OmniGuard Hybrid RAG v1: `omniguard/rag/hybrid.py`.
- `HybridRetriever(sparse: SparseIndex, dense: DenseIndex, alpha)` -- har retriever se top-50 candidates (tenant filter dono pe!), union, min-max fusion, top-k.
- `eval/questions.jsonl` (M06-10) mein 5 ID-style aur 5 paraphrase questions add karo; `scripts/alpha_sweep.py` alpha 0.0, 0.25, 0.5, 0.75, 1.0 pe hit@5 table print kare.
- Response mein har hit ke saath `{"sparse_rank", "dense_rank", "fused_score"}` -- debugging aur customer demo ke liye.
- Acceptance: pytest -- hybrid ka hit@5 dono single retrievers ke max se kam nahi; tenant filter dono paths pe test.

### Common pitfalls
- Tenant/role filter sirf dense path pe lagaya, BM25 path pe bhool gaye -- hybrid se data leak (M06-08, M12-07).
- Min-max sirf top-k pe vs poore candidate pool pe -- normalisation ka reference badalta hai; consistent rakho aur document karo.
- Alpha ek baar tune karke bhool jaana -- naye doc types/queries aayein to eval dobara chalao (M14-09).

### Checklist before moving on
- [ ] Sparse aur dense ke complementary failure modes example se bata sakta hoon.
- [ ] Raw scores add kyun nahi karte, samjha sakta hoon.
- [ ] Min-max + alpha fusion implement aur eval set pe tune kar sakta hoon.
- [ ] Filters dono retrievers pe lagte hain.

### Related
- M06-05 BM25 sparse matrices
- M06-11 Keyword-based search mechanisms
- M06-13 Implementing RRF algorithms
- M06-14 Precision and recall metrics
- M06-15 Cross-encoder reranking models

### Self-quiz
1. "5512" query pe dense retriever kyun fail hota hai? Real model mein bhi aisa kyun hota hai?
2. BM25 scores 0-15 aur cosine 0.2-0.6 hain. Raw sum karoge to kya hoga?
3. Alpha 0.9 kis customer ke liye sahi ho sakta hai? Kaise prove karoge?
4. Min-max normalisation mein ek outlier score kya problem karta hai? (Hint: M06-13)
