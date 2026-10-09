# Vector Search & Core RAG

## Distance metrics (Cosine, Euclidean)

> Core | Fast CP3 / Slow CP4 | ~1.2 h | Builds on: M06-03

### Kahani
SaaS customer ka "help center search" ek contractor ne banaya tha: vectors normalise nahi kiye, aur DB mein metric `dotproduct` set kiya. Result: har query pe sabse upar 40-page "Admin Guide (full)" aata hai, chahe sawaal kuch bhi ho.
Users bolte hain "search kuch bhi pooch lo, wahi PDF dikhata hai". Contractor ka jawab: "model kharab hai".
Model theek tha. Distance metric aur normalisation ka mismatch tha -- aur ye bug code review mein dikhta bhi nahi.

### What it is
**Cosine similarity** = do vectors ke beech angle (direction) -- length ignore. **Euclidean (L2) distance** = do points ke beech seedhi doori -- length matter karti hai. **Dot product** = cosine x dono lengths.
Unit vectors pe teeno ek hi ranking dete hain: `||a - b||^2 = 2 - 2 cos(a, b)` aur `a . b = cos(a, b)`.

### Why it matters for an FDE
Vector DB create karte waqt metric set hota hai aur baad mein badalna = re-index. Galat metric = lambe/"loud" documents har query pe jeet-te hain, aur customer ka trust pehle hafte mein chala jaata hai.

### Key concepts
- **Match the model** -- model card batata hai kis metric pe train hua (zyada tar text models: cosine / normalised dot). Wahi use karo.
- **Normalise once** -- ingest pe aur query pe dono jagah L2-normalise karo; phir dot product sabse fast aur cosine ke barabar.
- **Distance vs score** -- kuch APIs distance dete hain (lower = better, e.g. pgvector `<=>` = 1 - cosine), kuch similarity (higher = better). Threshold likhne se pehle check karo.
- **Length bias** -- raw dot product lambe vectors ko reward karta hai; raw Euclidean unhe punish karta hai -- dono "meaning" nahi hai.
- **Thresholds are model-specific** -- "cosine > 0.8 = relevant" ek model pe sahi, doosre pe bekaar; eval se calibrate karo.

### Code example
`pip install numpy`

```python
# runnable
import numpy as np

def cosine(a, b):
    return float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b)))

def euclidean(a, b):
    return float(np.linalg.norm(a - b))

def dot(a, b):
    return float(a @ b)

# Raw (un-normalised) count vectors over terms [refund, days, shipping, delivery]
query = np.array([1.0, 1.0, 0.0, 0.0])                    # "refund days"
docs = {
    "short_refund_faq":   np.array([1.0, 1.0, 0.0, 0.0]),          # exactly on topic, short
    "long_refund_policy": np.array([6.0, 4.0, 1.0, 1.0]),          # on topic, 12x longer
    "long_shipping_sop":  np.array([6.0, 6.0, 30.0, 30.0]),        # mostly shipping, very long
}

def rank(metric, higher_is_better):
    s = {name: metric(query, v) for name, v in docs.items()}
    order = sorted(s, key=s.get, reverse=higher_is_better)
    return order, s

for label, fn, hib in [("cosine", cosine, True), ("dot", dot, True), ("euclidean", euclidean, False)]:
    order, s = rank(fn, hib)
    print(f"{label:9} ->", order, {k: round(v, 2) for k, v in s.items()})

dot_order, _ = rank(dot, True)
euc_order, _ = rank(euclidean, False)
cos_order, _ = rank(cosine, True)
assert dot_order[0] == "long_shipping_sop"          # raw dot rewards length -> wrong doc on top
assert cos_order[0] == "short_refund_faq"           # cosine ignores length, looks at direction only
assert euc_order[-1] == "long_shipping_sop"         # euclidean punishes length differences

# Normalise everything -> all three metrics give the SAME ranking
unit = lambda v: v / np.linalg.norm(v)
qn = unit(query)
for name, v in docs.items():
    vn = unit(v)
    # identity for unit vectors: ||a - b||^2 = 2 - 2 * cos(a, b)
    assert abs(euclidean(qn, vn) ** 2 - (2 - 2 * cosine(qn, vn))) < 1e-9
    assert abs(dot(qn, vn) - cosine(qn, vn)) < 1e-9
orders = []
for fn, hib in [(cosine, True), (dot, True), (euclidean, False)]:
    s = {n: fn(qn, unit(v)) for n, v in docs.items()}
    orders.append(sorted(s, key=s.get, reverse=hib))
assert orders[0] == orders[1] == orders[2]
print("normalised ranking (all metrics):", orders[0])

# What vector DBs return: a DISTANCE (lower = better) or a SCORE (higher = better)
cos_distance = 1 - cosine(qn, unit(docs["long_refund_policy"]))   # e.g. pgvector `<=>`
print(f"cosine distance of long_refund_policy = {cos_distance:.3f} (lower is closer)")
assert 0 <= cos_distance < 0.1
print("OK: pick the metric your model was trained for; normalise and they agree")
```

- Raw counts pe `dot` ne `long_shipping_sop` ko top pe rakha -- sirf isliye ki vector bada hai. Yahi contractor wala bug hai.
- `euclidean` ne ulta kiya: on-topic `long_refund_policy` ko 6.0 door bataya, sirf length ki wajah se.
- `cosine` sirf direction dekhta hai: short FAQ aur long policy dono refund ki taraf point karte hain.
- Normalise karte hi teeno metrics same ranking; identity `||a-b||^2 = 2 - 2cos` assert se prove hui. Isliye "normalise + dot" production default hai.
- `cos_distance` -- DB jo number deta hai wo distance ho sakta hai; `1 - cosine`. Thresholds aur logs mein ye confusion common hai.

```sql
-- pgvector operators (check the docs for your version)
SELECT id, embedding <=> :q AS cosine_distance FROM chunks ORDER BY embedding <=> :q LIMIT 5;  -- 1 - cosine
SELECT id, embedding <-> :q AS l2_distance     FROM chunks ORDER BY embedding <-> :q LIMIT 5;  -- Euclidean
SELECT id, (embedding <#> :q) * -1 AS inner_product FROM chunks ORDER BY embedding <#> :q LIMIT 5;  -- <#> is NEGATIVE inner product
```

Managed DBs mein metric collection/index create karte waqt set hota hai: Pinecone `metric="cosine" | "euclidean" | "dotproduct"`, Qdrant `Distance.COSINE | Distance.EUCLID | Distance.DOT` (M06-09).

### Mini-exercise (30-60 min)
`omniguard/rag/dense_index.py` mein metric ko explicit banao.
- Index metadata mein `metric` ("cosine" default); `add()` aur `search()` dono pe normalisation enforce karo; non-unit vector aaye to warning log + normalise.
- `search()` hamesha "higher is better" `score` return kare -- andar DB distance de to convert karo; ek jagah, documented.
- Test: same data pe cosine, dot (normalised) aur L2 (normalised) ranking identical; un-normalised dot pe ek lamba doc top pe aata hai (regression demo).
- Acceptance: pytest green; README mein ek line "we normalise and use cosine because <model card link>".

### Common pitfalls
- Ingest pe normalise kiya, query pe bhool gaye (ya ulta) -- scores scale badal jaate hain, thresholds toot jaate hain.
- pgvector `<#>` ko positive similarity samajhna -- wo negative inner product hai; `ORDER BY ... ASC` sahi, sign ulta padha to ranking ulti.
- Ek fixed similarity threshold (0.75) se "no answer" decide karna bina eval ke -- model badla, threshold bekaar; per-model calibrate karo.

### Checklist before moving on
- [ ] Cosine, Euclidean aur dot ka farak ek example se bata sakta hoon.
- [ ] Unit vectors pe teeno same ranking kyun dete hain, prove kar sakta hoon.
- [ ] Mera index metric model card se match karta hai aur metadata mein saved hai.
- [ ] Distance vs score convention apne code mein ek jagah handle karta hoon.

### Related
- M06-03 Understanding vector representations
- M06-06 Index creation
- M06-09 Cloud vector database provisioning
- M06-12 Combining dense and sparse signals

### Self-quiz
1. Contractor ke bug mein exactly kya galat tha, aur do-line fix kya hai?
2. `||a-b||^2 = 2 - 2cos(a,b)` unit vectors pe kyun sach hai? Isse ranking ke baare mein kya pata chalta hai?
3. pgvector se distance 0.18 aaya. Cosine similarity kitni hai?
4. Model badalne ke baad "score > 0.8 = relevant" rule kyun toot sakta hai?
