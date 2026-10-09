# Vector Search & Core RAG

## BM25 sparse matrices

> Core | Fast CP3 / Slow CP4 | ~1.2 h | Builds on: M06-03

### Kahani
Insurance customer ke claims team ka bot dense search pe chal raha hai. Agent type karta hai "PX-2291 renew" -- bot PX-1180 ka document de deta hai, kyunki embedding mein dono "policy covers damage" jaise hi lagte hain.
Claims team gussa: "Policy number exact likha hai, phir bhi galat?" Ticket IDs, SKU, clause numbers, error codes -- enterprise queries isi se bhari hain.
Yahan purana, boring, 1990s ka BM25 jeet jaata hai. Aur usse samajhne ka sabse saaf tareeka hai: ek sparse matrix.

### What it is
**BM25** = keyword ranking function: query ke har term ke liye doc mein uski frequency (TF, saturating), uski rarity (IDF), aur doc length normalisation -- sab jodke ek score.
Har doc ko ek **sparse vector** samjho: length = vocabulary size, value = us term ka BM25 weight, baaki sab zero. Query score = query ke columns ka sum.

### Why it matters for an FDE
Customer ke users IDs aur exact phrases search karte hain jo dense models blur kar dete hain. BM25 sasta hai (no GPU, no API), explainable hai ("ye doc isliye aaya kyunki px-2291 match hua"), aur hybrid RAG ka aadha hissa hai (M06-12).

### Key concepts
- **TF saturation (k1)** -- term 10 baar aaye to 10x score nahi; `k1` (default ~1.2-2.0) control karta hai kitni jaldi saturate ho.
- **IDF** -- jo term kam docs mein hai (px-2291) uska weight zyada; "policy" jaise common terms ka kam.
- **Length normalisation (b)** -- lamba doc har word ke liye "free" match na le; `b=0.75` typical, `b=0` = off.
- **Sparse matrix** -- docs x vocab, 95%+ zeros real corpora mein; isliye inverted index (term -> doc list) se store karte hain (M06-11).
- **Tokenizer is the model** -- BM25 utna hi accha jitna tokenizer: IDs tootne na dein, case fold karein, stemming decide karein.

### Code example
`pip install numpy rank_bm25`

```python
# runnable
import math
import re

import numpy as np
from rank_bm25 import BM25Okapi

DOCS = [
    "Policy PX-2291 covers flood damage for commercial warehouses",
    "Policy PX-1180 covers fire damage for retail shops",
    "Claims for flood damage need photos and the policy number",
    "Ticket 5512: customer asks how to renew policy PX-2291",
    "Warehouse inspection checklist for fire safety",
    "Refund of premium is processed within 14 days",
]

def tokenize(text):
    return re.findall(r"[a-z0-9]+(?:-[a-z0-9]+)*", text.lower())   # keeps IDs like px-2291 intact

corpus = [tokenize(d) for d in DOCS]
vocab = sorted({t for doc in corpus for t in doc})
col = {t: j for j, t in enumerate(vocab)}

# 1) Term-frequency matrix: rows = docs, cols = vocabulary. Mostly zeros -> "sparse".
TF = np.zeros((len(DOCS), len(vocab)))
for i, doc in enumerate(corpus):
    for t in doc:
        TF[i, col[t]] += 1
print(f"TF matrix shape={TF.shape}, non-zero={np.count_nonzero(TF) / TF.size:.0%}")

# 2) BM25 weights by hand (same formula and defaults as rank_bm25.BM25Okapi)
k1, b, eps = 1.5, 0.75, 0.25
N = len(DOCS)
df = (TF > 0).sum(axis=0)                                 # docs containing each term
idf = np.log(N - df + 0.5) - np.log(df + 0.5)
idf = np.where(idf < 0, eps * idf.mean(), idf)            # rank_bm25 floors negative idf
dl = TF.sum(axis=1, keepdims=True)                        # doc lengths
avgdl = dl.mean()
W = idf * TF * (k1 + 1) / (TF + k1 * (1 - b + b * dl / avgdl))   # BM25 term-weight matrix

def bm25_scores(query):
    cols = [col[t] for t in tokenize(query) if t in col]   # unknown words contribute nothing
    return W[:, cols].sum(axis=1)

# 3) Cross-check against the library
bm25 = BM25Okapi(corpus)
for q in ["px-2291 renew", "flood damage claim photos", "fire safety warehouse"]:
    mine, lib = bm25_scores(q), bm25.get_scores(tokenize(q))
    assert np.allclose(mine, lib), (q, mine, lib)
    top = int(np.argmax(lib))
    print(f"{q!r:30} -> top doc {top}: {DOCS[top][:50]}")

# Top weighted terms of one doc = its sparse vector, readable by humans
d = 3
top_terms = sorted(((W[d, j], vocab[j]) for j in np.nonzero(W[d])[0]), reverse=True)[:3]
print("doc 3 strongest terms:", [(t, round(float(w), 2)) for w, t in top_terms])

assert int(np.argmax(bm25_scores("px-2291 renew"))) == 3          # exact ID + rare word wins
assert bm25_scores("money back").sum() == 0                       # no shared words -> BM25 is blind
assert idf[col["px-2291"]] > idf[col["policy"]]                   # rare terms weigh more
print("OK: hand-built BM25 matrix matches rank_bm25")
```

- `tokenize` -- regex jo `PX-2291` ko `px-2291` ek token rakhta hai. Default `split()` ya naive regex isse `px` aur `2291` mein tod deta -- ID matching kamzor.
- `TF` matrix 22% non-zero sirf 6 docs pe; 1 lakh docs pe ye 0.1% se bhi kam hoga -- isliye production mein dense numpy nahi, inverted index/`scipy.sparse`.
- `W` -- BM25 term-weight matrix ek baar precompute; query time pe sirf columns ka sum. Ye exactly `BM25Okapi.get_scores` se match karta hai (`np.allclose` assert).
- `eps * idf.mean()` -- rank_bm25 ka detail: jo term aadhe se zyada docs mein hai uska idf negative aata hai, library usse ek chhote positive floor pe set karti hai.
- Doc 3 ke strongest terms mein "to" aaya -- stopwords hatane chahiye ya nahi, ye tokenizer decision hai; aur "claim" query "claims" doc se match nahi karti (no stemming). Dono eval se decide karo.
- `money back` ka score 0 -- BM25 synonyms nahi samajhta. Yahi gap dense vectors bharte hain.

### Mini-exercise (30-60 min)
`omniguard/rag/sparse.py` banao.
- `SparseIndex.build(chunks)` -- tokenizer config (lowercase, ID regex, optional stopwords), `BM25Okapi` andar; `search(query, k) -> [(chunk_id, score)]`.
- `explain(query, chunk_id)` -- har matching term ka contribution return kare (aapke `W` matrix jaisa) -- customer demo mein "why this result" dikhane ke liye.
- 15 queries likho jinmein 5 exact IDs (policy/ticket numbers) hon; recall@5 print karo.
- Acceptance: pytest -- ID query ka top-1 sahi doc; unknown-word query empty/zero scores de, crash nahi; `explain` ke contributions ka sum == score.

### Common pitfalls
- Index aur query pe alag tokenizer -- ek mein lowercase, doosre mein nahi; matches chupchap gayab.
- BM25 scores ko 0-1 probability samajhna -- scale corpus aur query length pe depend karta hai; isliye fusion mein raw scores add nahi karte (M06-13).
- Har request pe BM25 index dobara banana -- startup pe build karo ya persist karo; 1 lakh chunks ka rebuild per request = timeouts.

### Checklist before moving on
- [ ] TF, IDF, k1, b ka role ek line mein bata sakta hoon.
- [ ] Docs x vocab BM25 weight matrix numpy mein bana sakta hoon aur library se match kar sakta hoon.
- [ ] Mera tokenizer customer ke IDs ko todta nahi.
- [ ] Samajhta hoon BM25 kahan jeet-ta hai (IDs, rare terms) aur kahan haarta hai (synonyms).

### Related
- M06-03 Understanding vector representations
- M06-11 Keyword-based search mechanisms
- M06-12 Combining dense and sparse signals
- M06-13 Implementing RRF algorithms

### Self-quiz
1. "PX-2291 renew" query pe BM25 ne doc 3 kyun choose kiya? Kaunse do terms ne sabse zyada contribute kiya hoga?
2. `b=0` aur `b=1` rakhne se lambe docs ki ranking pe kya farak padega?
3. Aapka tokenizer `PX-2291` ko `px` aur `2291` mein tod de to kaunsi queries kharab hongi?
4. BM25 score 12.4 aur dense cosine 0.82 -- inhe seedha add kyun nahi kar sakte?
