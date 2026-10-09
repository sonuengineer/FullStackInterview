# Vector Search & Core RAG

## Cross-encoder reranking models

> Core | Fast CP3 / Slow CP4 | ~1.2 h | Builds on: M06-12, M06-13, M06-14

### Kahani
Electronics retailer ka store-staff bot. Sawaal: "Can I return opened electronics?" Hybrid retrieval ne sahi chunk ("Opened electronics cannot be returned...") top-5 mein laaya -- lekin rank 3 pe. Rank 1 pe ek vague, keyword-bhara "Electronics return policy" page tha.
LLM ne top chunk pe zyada bharosa kiya aur bola "Yes, within 30 days". Store manager ne refund de diya. Customer ka loss.
Recall theek tha (M06-14), order galat tha. Is gap ko reranker bharta hai.

### What it is
**Bi-encoder** (embeddings) query aur doc ko alag-alag vector banata hai -- fast, precompute ho sakta hai, lekin dono ek doosre ko "dekhte" nahi. **Cross-encoder** query aur doc ko ek saath model mein daalta hai aur ek relevance score deta hai -- word order, negation, exact relation samajhta hai, lekin har (query, doc) pair pe ek model call.
Isliye pattern: **retrieve wide and cheap** (hybrid top-20/50) -> **rerank narrow and precise** (cross-encoder) -> top-3/5 LLM ko.

### Why it matters for an FDE
Customer policies negations aur exceptions se bhari hain ("not", "except", "only if"). Reranker aksar sabse bada single precision jump hai -- aur latency/cost budget mein fit karna FDE ka kaam hai.

### Key concepts
- **Two-stage retrieval** -- stage 1 recall ke liye (BM25 + dense + RRF), stage 2 precision ke liye (cross-encoder).
- **Cost scales with candidates** -- `queries x candidates` model calls; 50 candidates x 200 tokens har query pe. Top-N ko chhota rakho.
- **Batching** -- pairs ko batches mein score karo (GPU/CPU efficient); ek-ek pair ka loop slow hai.
- **Scores are not probabilities** -- raw logits ho sakte hain; "not found" threshold model-specific, eval se calibrate.
- **Max length** -- cross-encoder ki input limit (often 512 tokens) query + chunk dono ko cover kare; lambe chunks truncate hote hain.

### Code example
`pip install numpy`

```python
# runnable
import re
import zlib

import numpy as np

STOP = {"a", "an", "the", "can", "i", "be", "is", "are", "my", "for", "of", "do", "you", "if", "and", "all", "to", "in"}

def words(t):
    return [re.sub(r"(ed|s)$", "", w) for w in re.findall(r"[a-z0-9]+", t.lower()) if w not in STOP]

def toy_bi_encoder(text, dim=512):
    """TOY bi-encoder: query and doc embedded SEPARATELY (bag-of-words). Word overlap only."""
    v = np.zeros(dim)
    for w in words(text):
        v[zlib.crc32(w.encode()) % dim] += 1
    return v / (np.linalg.norm(v) or 1)

class StubCrossEncoder:
    """Same interface as sentence_transformers.CrossEncoder.predict(pairs) -> scores.
    It reads query AND doc TOGETHER, so it can use word order: here, query bigrams found in the
    doc and query-term coverage. A real cross-encoder is a transformer that learns this; this is a stub."""
    def __init__(self):
        self.pairs_scored = 0
    def predict(self, pairs, batch_size=16):
        scores = []
        for i in range(0, len(pairs), batch_size):             # batching, like the real model
            for q, d in pairs[i:i + batch_size]:
                qw, dw = words(q), words(d)
                coverage = len(set(qw) & set(dw)) / max(len(set(qw)), 1)
                d_bigrams = set(zip(dw, dw[1:]))
                bigram_hits = sum(bg in d_bigrams for bg in zip(qw, qw[1:]))
                scores.append(coverage + 0.5 * bigram_hits)
            self.pairs_scored += len(pairs[i:i + batch_size])
        return np.array(scores)

def retrieve(query, docs, k):
    q = toy_bi_encoder(query)
    s = np.array([toy_bi_encoder(d) @ q for d in docs])
    return [docs[i] for i in np.argsort(-s, kind="stable")[:k]]

def rerank(query, candidates, model, top_n):
    scores = model.predict([(query, c) for c in candidates])
    order = np.argsort(-scores, kind="stable")[:top_n]
    return [candidates[i] for i in order]

DOCS = [
    "Electronics returns: electronics return policy for electronics",            # keyword-heavy, vague
    "Electronics can be returned within 30 days if the box is sealed",
    "Opened electronics cannot be returned, only exchanged for the same model",   # the real answer
    "Battery warranty covers 6 months for laptop batteries",
    "Laptop warranty is 1 year; battery warranty is shorter",
    "Warranty for battery replacement: 6 months from purchase date",              # the real answer
    "Express delivery takes 2 business days",
]
EVAL = {"can I return opened electronics": DOCS[2],
        "battery replacement warranty period": DOCS[5]}

def mrr(rank_fn):
    total = 0.0
    for q, gold in EVAL.items():
        ranked = rank_fn(q)
        total += 1 / (ranked.index(gold) + 1) if gold in ranked else 0.0
    return total / len(EVAL)

ce = StubCrossEncoder()
before = mrr(lambda q: retrieve(q, DOCS, k=5))
after = mrr(lambda q: rerank(q, retrieve(q, DOCS, k=5), ce, top_n=5))
pairs = ce.pairs_scored                  # cost grows with queries x candidates
for q in EVAL:
    print(f"{q!r}\n  retrieval top-1: {retrieve(q, DOCS, 5)[0]}\n  reranked  top-1: {rerank(q, retrieve(q, DOCS, 5), ce, 1)[0]}")
print(f"MRR before rerank = {before:.2f}, after = {after:.2f}, pairs scored = {pairs}")

assert after > before and after == 1.0
assert pairs == 2 * 5                    # 2 queries x 5 candidates: rerank only a short list
print("OK: retrieve wide and cheap, rerank narrow and precise")
```

- `toy_bi_encoder` query aur doc ko alag embed karta hai -- keyword-heavy vague doc ("electronics" 3 baar) top pe aa gaya. Real bi-encoders bhi isi tarah "topic match" ko "answer" samajh lete hain.
- `StubCrossEncoder.predict(pairs)` -- real `CrossEncoder.predict` jaisa interface. Ye stub hai: haath se likha scorer jo query bigrams ("opened electronics") doc mein dhoondta hai, kyunki ye query aur doc ko saath dekhta hai. Real model ye relation data se seekhta hai.
- `rerank` sirf retrieve ke top-5 pe chalta hai -- poore corpus pe cross-encoder kabhi nahi.
- MRR 0.75 -> 1.00 (M06-14 ka metric) -- reranker ka fayda number se prove karo, screenshot se nahi.
- `pairs` counter -- 2 queries x 5 candidates = 10 calls. Production mein yahi number latency aur cost decide karta hai.

```python
# real version -- not run here, needs: pip install sentence-transformers
from sentence_transformers import CrossEncoder

model = CrossEncoder("cross-encoder/ms-marco-MiniLM-L-6-v2", max_length=512)   # small, CPU-ok

def rerank(query, candidates, top_n=5, batch_size=32):
    scores = model.predict([(query, c["text"]) for c in candidates], batch_size=batch_size)
    order = sorted(range(len(candidates)), key=lambda i: -float(scores[i]))[:top_n]
    return [{**candidates[i], "rerank_score": float(scores[i])} for i in order]
```

Model choice: ms-marco MiniLM fast aur English-only; multilingual ya domain-heavy customer ke liye bge-reranker jaise models ya hosted API (M06-16). Model card aur licence check karo.

### Mini-exercise (30-60 min)
OmniGuard Hybrid RAG v1 ka stage 2: `omniguard/rag/rerank.py`.
- `Reranker` Protocol: `rerank(query, candidates, top_n) -> list[Hit]`; `StubReranker` (tests) aur `LocalCrossEncoderReranker` (optional import).
- Pipeline: hybrid RRF top-20 -> rerank -> top-5 -> prompt. Har hit pe `rrf_rank` aur `rerank_score` dono rakho.
- `eval/report.md` mein naya row: `hybrid_rrf + rerank` -- precision@5, MRR, nDCG@5, aur p50/p95 rerank latency (ms).
- Acceptance: pytest -- reranker sirf candidates ko reorder kare (naya doc add nahi), `top_n > len(candidates)` pe crash nahi, MRR non-decreasing on the labelled set (agar decrease ho to report mein flag).

### Common pitfalls
- 200 candidates rerank karna "quality ke liye" -- p95 latency seconds mein; top-20/50 + measure.
- Rerank ke baad tenant filter lagana -- filter hamesha stage 1 pe (M06-08); reranker ko kabhi unauthorised chunk mat dikhao.
- Reranker score ko fixed threshold (0.5) se "relevant" maanna -- model badla, scale badla; eval se calibrate.

### Checklist before moving on
- [ ] Bi-encoder vs cross-encoder ka farak aur trade-off bata sakta hoon.
- [ ] Two-stage pipeline (retrieve wide, rerank narrow) implement kar sakta hoon.
- [ ] Reranker ka fayda MRR/nDCG se measure karta hoon, latency ke saath.
- [ ] Candidates count aur batch size config mein hain.

### Related
- M06-13 Implementing RRF algorithms
- M06-14 Precision and recall metrics
- M06-16 API integration for rerankers
- M14-07 Measuring context precision and recall
- M14-11 Monitoring granular token costs and endpoint latency

### Self-quiz
1. Cross-encoder ko poore corpus pe kyun nahi chalate? 1 lakh chunks pe kya hoga?
2. "Opened electronics cannot be returned" ko bi-encoder rank 3 pe kyun rakh sakta hai?
3. Reranker lagane ke baad MRR badha lekin recall@5 same raha. Kyun?
4. p95 latency budget 800 ms hai, rerank 50 candidates pe 600 ms leta hai. Kya knobs ghumaoge?
