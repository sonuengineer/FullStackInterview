# Vector Search & Core RAG

## Implementing RRF algorithms

> Core | Fast CP3 / Slow CP4 | ~1.2 h | Builds on: M06-05, M06-12

### Kahani
Insurance customer ka hybrid search (M06-12) do hafte theek chala. Phir marketing ne ek FAQ page upload kiya jismein "claim" 40 baar likha tha (SEO ke liye). Ab har claims query pe wahi FAQ top pe.
Debug kiya: BM25 ne us page ko 30 score diya, baaki sab ko ~5. Min-max normalisation ke baad baaki saare BM25 scores ~0 ho gaye -- ek outlier ne poora sparse signal mita diya.
Aapko fusion chahiye jo scores ke scale aur outliers se pareshaan hi na ho.

### What it is
**Reciprocal Rank Fusion (RRF)** = har retriever ki ranked list lo, har doc ko har list mein uske rank ke hisaab se points do: `score(d) = sum over lists of 1 / (k + rank_d)`, rank 1-based, `k = 60` common default.
Scores ignore hote hain, sirf ranks. Jo doc kisi list mein nahi, us list se 0 points. Final list = points ke hisaab se sort.

### Why it matters for an FDE
Customer ke paas aksar 2-3 retrievers hote hain (BM25, dense, purana Elasticsearch, SQL lookup) jinke scores comparable nahi. RRF bina tuning ke robust fusion deta hai -- Monday demo ke liye safe default, baad mein eval se improve.

### Key concepts
- **Rank, not score** -- scale-invariant: BM25 ko 1000 se multiply karo, RRF result same.
- **k smooths the top** -- chhota k = rank 1 bahut dominate karta hai; `k=60` pe rank 1 aur rank 10 ka farak sirf ~1.15x -- agreement across lists jeet-ta hai.
- **Union of candidates** -- ek hi retriever ne doc diya to bhi credit milta hai; "dono mein top-ish" sabse upar aata hai.
- **Weighted RRF** -- `w / (k + rank)`; ID-heavy customer ke liye sparse ko zyada weight. Weights eval se tune karo.
- **Deterministic ties** -- equal scores pe stable tie-break (doc id), warna tests flaky aur results har request pe badalte hain.

### Code example
stdlib only

```python
# runnable
from collections import defaultdict

def rrf(rankings, k=60, weights=None, top_n=None):
    """Reciprocal Rank Fusion. rankings: list of ranked doc-id lists (best first).
    score(d) = sum over lists of w / (k + rank_d), rank is 1-based; docs missing from a list add 0."""
    weights = weights or [1.0] * len(rankings)
    scores = defaultdict(float)
    for w, ranked in zip(weights, rankings):
        for rank, doc_id in enumerate(ranked, start=1):
            scores[doc_id] += w / (k + rank)
    fused = sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))   # tie-break by id = deterministic
    return fused[:top_n] if top_n else fused

def minmax_fusion(score_maps, alpha=0.5):
    """Score fusion for comparison: min-max normalise each retriever, then weighted sum."""
    def norm(m):
        lo, hi = min(m.values()), max(m.values())
        return {d: (s - lo) / (hi - lo) if hi > lo else 0.0 for d, s in m.items()}
    a, b = norm(score_maps[0]), norm(score_maps[1])
    docs = set(a) | set(b)
    fused = {d: alpha * a.get(d, 0.0) + (1 - alpha) * b.get(d, 0.0) for d in docs}
    return sorted(fused.items(), key=lambda kv: (-kv[1], kv[0]))

def ranked(score_map):
    return [d for d, _ in sorted(score_map.items(), key=lambda kv: -kv[1])]

# Scenario: query "PX-2291 flood claim". Relevant doc = "policy_px2291".
# BM25 has an OUTLIER: a keyword-stuffed FAQ page repeats "claim" 40 times.
bm25 = {"faq_keyword_spam": 30.0, "policy_px2291": 5.2, "claims_howto": 5.0, "fire_policy": 4.9}
dense = {"policy_px2291": 0.82, "claims_howto": 0.80, "faq_keyword_spam": 0.60, "fire_policy": 0.55}

mm = minmax_fusion([bm25, dense])
rr = rrf([ranked(bm25), ranked(dense)])
print("min-max fusion:", [(d, round(s, 3)) for d, s in mm])
print("RRF (k=60)    :", [(d, round(s, 5)) for d, s in rr])
assert mm[0][0] == "faq_keyword_spam"        # outlier squashed every other BM25 score to ~0
assert rr[0][0] == "policy_px2291"           # RRF only sees ranks: 2nd + 1st beats 1st + 3rd

# Hand check of the formula (1-based ranks, k=60)
expected = 1 / (60 + 2) + 1 / (60 + 1)       # policy_px2291: rank 2 in BM25, rank 1 in dense
assert abs(dict(rr)["policy_px2291"] - expected) < 1e-12
assert abs(dict(rr)["faq_keyword_spam"] - (1 / 61 + 1 / 63)) < 1e-12

# Docs found by only ONE retriever still get credit (union, not intersection)
r = rrf([["a", "b", "c"], ["d", "a"]], top_n=3)
print("partial lists :", [(d, round(s, 5)) for d, s in r])
assert r[0][0] == "a" and abs(dict(r)["d"] - 1 / 61) < 1e-12

# Scale-invariance: multiply BM25 by 1000 -> RRF result identical, min-max can change
bm25_x = {d: s * 1000 for d, s in bm25.items()}
assert rrf([ranked(bm25_x), ranked(dense)]) == rr

# k controls how much the top ranks dominate: small k = "winner takes most"
top_vs_tenth = lambda k: (1 / (k + 1)) / (1 / (k + 10))
print(f"rank1/rank10 weight ratio: k=1 -> {top_vs_tenth(1):.2f}x, k=60 -> {top_vs_tenth(60):.2f}x")
assert top_vs_tenth(1) > 5 > top_vs_tenth(60)

# Weighted RRF: trust sparse more for an ID-heavy customer
w = rrf([ranked(bm25), ranked(dense)], weights=[2.0, 1.0])
print("weighted [2,1]:", [d for d, _ in w])
assert w[0][0] == "faq_keyword_spam"         # weights are a real knob: tune them on the eval set
print("OK: RRF fuses by rank, ignores score scales and outliers")
```

- `rrf` -- `enumerate(ranked, start=1)`: ranks 1-based. 0-based likha to rank 1 ko `1/60` milega aur formula ke saath published numbers match nahi honge -- common bug.
- Min-max fusion ne spam FAQ ko top pe rakha: outlier (30.0) ne baaki BM25 scores ko 0.0-0.01 range mein squash kar diya, jabki dense ne spam ko 3rd rank diya tha.
- RRF: `policy_px2291` = 1/62 + 1/61 > spam = 1/61 + 1/63. Dono lists mein "high" hona ek list mein #1 hone se better.
- Scale assert -- BM25 x 1000 ke baad bhi RRF output identical. Score fusion ke saath ye guarantee nahi.
- Weighted `[2, 1]` ne spam wapas top pe la diya -- weights powerful knob hain; bina eval ke mat ghumao.

### Mini-exercise (30-60 min)
OmniGuard Hybrid RAG v1 ka fusion layer: `omniguard/rag/fusion.py`.
- `rrf(rankings, k=60, weights=None, top_n=None)` exactly upar jaisa, docstring mein formula; `HybridRetriever` mein `fusion="rrf" | "minmax"` config.
- Har retriever se top-50 candidates; RRF ke baad top-20 reranker ke liye (M06-15).
- `scripts/fusion_compare.py`: apne eval set pe minmax (alpha 0.5) vs RRF (k = 10, 60, 100) -- hit@5 aur MRR (M06-14) ki table README mein.
- Acceptance: pytest -- hand-computed RRF value match (1e-12), scale invariance test, single-list doc ko credit milta hai, ties deterministic.

### Common pitfalls
- 0-based ranks -- formula shift ho jaata hai; hamesha `start=1`.
- Har retriever se sirf top-5 lena -- union chhota, RRF ke paas fuse karne ko kuch nahi; 20-100 candidates lo.
- RRF score ko "relevance probability" ki tarah threshold karna (score > 0.03 = relevant) -- score list count aur k pe depend karta hai; "not found" ke liye reranker score ya retriever-level floor use karo.

### Checklist before moving on
- [ ] RRF formula 1-based ranks aur k=60 ke saath likh aur haath se compute kar sakta hoon.
- [ ] Bata sakta hoon kab RRF min-max fusion se better hai (scale mismatch, outliers).
- [ ] k ka effect samajhta hoon.
- [ ] Mere fusion mein ties deterministic hain aur tests mein hand-checked values hain.

### Related
- M06-12 Combining dense and sparse signals
- M06-14 Precision and recall metrics
- M06-15 Cross-encoder reranking models
- M14-07 Measuring context precision and recall

### Self-quiz
1. Doc X: BM25 rank 1, dense rank 10. Doc Y: dono mein rank 3. k=60 pe kaun jeet-ta hai? Haath se compute karo.
2. RRF scale-invariant kyun hai? Ek example se dikhao jahan min-max fusion fail hota hai.
3. k=1 aur k=1000 pe fused ranking ka behaviour kaise badlega?
4. Teesra retriever (purana Elasticsearch) add karna hai. RRF code mein kya change hoga?
