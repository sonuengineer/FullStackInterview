# Vector Search & Core RAG

## Metadata filtering

> Core | Fast CP3 / Slow CP4 | ~1.2 h | Builds on: M06-06, M06-07

### Kahani
Ek multi-tenant SaaS: ek hi vector index mein 200 customers ke support docs. Globex ka agent poochta hai "refund policy?" -- top-3 mein Acme ke documents aate hain, kyunki Acme ke paas 500 refund chunks hain.
Developer ne fix kiya: "results ko tenant pe filter kar do". Ab Globex ko zero results milte hain -- top-3 to Acme ne bhar diya tha, filter ke baad kuch bacha hi nahi.
Aur ek din kisi ne API mein `filter={"tenant": "acme"}` bhej diya Globex ke token se. Ye security incident hai, bug nahi.

### What it is
**Metadata filtering** = har chunk ke saath structured fields (tenant, doc_type, roles, region, date, source) store karo aur search ko sirf allowed subset tak limit karo.
**Pre-filter** = pehle filter, phir us subset mein top-k (sahi). **Post-filter** = global top-k, phir filter (results kam ya zero, aur leak ka risk).

### Why it matters for an FDE
Enterprise customer ka pehla sawaal: "Kya HR ka data sales wale ko dikhega?" Tenant aur role filters retrieval layer mein enforce na hon to LLM wahi bolega jo context mein aaya -- prompt mein "don't reveal" likhna security nahi hai (M12-07).

### Key concepts
- **Server-side mandatory filters** -- tenant aur role hamesha verified auth token se aate hain, request body se kabhi nahi.
- **Allow-listed client filters** -- user sirf `doc_type`, `date` jaise safe fields filter kare; unknown field = reject.
- **Pre-filter over post-filter** -- vector DB ka filtered search (payload/metadata index) use karo, warna k results nahi milte.
- **Payload index** -- filter fields (tenant, doc_type) pe DB index banao; bina index ke filter = full scan.
- **Namespaces / collections** -- strong isolation chahiye to tenant per namespace/collection; trade-off: zyada collections manage karne padte hain.

### Code example
`pip install numpy`

```python
# runnable
import re
import zlib
from dataclasses import dataclass

import numpy as np

def toy_embed(text, dim=256):
    """TOY embedder: hashed bag-of-words, L2-normalised. Word overlap only, NOT meaning."""
    v = np.zeros(dim)
    for w in re.findall(r"[a-z0-9]+", text.lower()):
        v[zlib.crc32(w.encode()) % dim] += 1
    return v / (np.linalg.norm(v) or 1)

CHUNKS = [
    # tenant acme has many refund chunks, tenant globex has one; roles restrict HR docs
    *[{"id": f"acme-{i}", "tenant": "acme", "doc_type": "policy", "roles": ["staff", "manager"],
       "text": f"acme refund policy section {i} refund rules"} for i in range(8)],
    {"id": "acme-hr", "tenant": "acme", "doc_type": "hr", "roles": ["manager"],
     "text": "manager only refund approval limits and salary bands"},
    {"id": "globex-1", "tenant": "globex", "doc_type": "policy", "roles": ["staff"],
     "text": "globex refund policy for staff"},
    {"id": "globex-2", "tenant": "globex", "doc_type": "ticket", "roles": ["staff"],
     "text": "ticket customer wants shipping update"},
]
VECS = np.stack([toy_embed(c["text"]) for c in CHUNKS])

@dataclass(frozen=True)
class UserCtx:                      # comes from the verified auth token (M12), never from the request body
    tenant: str
    role: str

ALLOWED_FILTER_FIELDS = {"doc_type"}            # what the CLIENT may filter on

def build_filter(user: UserCtx, client_filter: dict):
    bad = set(client_filter) - ALLOWED_FILTER_FIELDS
    if bad:
        raise ValueError(f"filter fields not allowed: {sorted(bad)}")
    def match(c):
        return (c["tenant"] == user.tenant                      # mandatory, server-side
                and user.role in c["roles"]                     # mandatory, server-side
                and all(c.get(k) == v for k, v in client_filter.items()))
    return match

def search_post_filter(q, match, k):
    """Anti-pattern: take global top-k, THEN filter. Loses results (and is one bug away from leaking)."""
    order = np.argsort(-(VECS @ toy_embed(q)))[:k]
    return [CHUNKS[i]["id"] for i in order if match(CHUNKS[i])]

def search_pre_filter(q, match, k):
    """Filter first (what a vector DB does with a payload/metadata index), then rank inside the allowed set."""
    idx = [i for i, c in enumerate(CHUNKS) if match(c)]
    if not idx:
        return []
    scores = VECS[idx] @ toy_embed(q)
    return [CHUNKS[idx[j]]["id"] for j in np.argsort(-scores)[:k]]

globex_staff = UserCtx("globex", "staff")
acme_staff = UserCtx("acme", "staff")
f = build_filter(globex_staff, {})
post = search_post_filter("refund policy", f, k=3)
pre = search_pre_filter("refund policy", f, k=3)
print("globex staff, post-filter:", post)
print("globex staff, pre-filter :", pre)
assert post == []                               # acme's 8 refund chunks filled the top-3, then got filtered away
assert pre[0] == "globex-1" and all(x.startswith("globex") for x in pre)

r = search_pre_filter("refund approval limits", build_filter(acme_staff, {}), k=10)
assert "acme-hr" not in r                       # role check: staff never sees manager-only chunk
r = search_pre_filter("refund approval limits", build_filter(UserCtx("acme", "manager"), {}), k=1)
assert r == ["acme-hr"]
r = search_pre_filter("update", build_filter(globex_staff, {"doc_type": "ticket"}), k=5)
assert r == ["globex-2"]

try:
    build_filter(globex_staff, {"tenant": "acme"})   # client tries to override tenant
    raise AssertionError("should have been rejected")
except ValueError as e:
    print("rejected:", e)
print("OK: tenant + role enforced server-side, pre-filter keeps k results")
```

- `UserCtx` frozen dataclass -- tenant/role verified JWT se aata hai (M12-02); route handler isse request body se kabhi na banaye.
- `ALLOWED_FILTER_FIELDS` -- client sirf `doc_type` filter kar sakta hai; `tenant` bhejne ki koshish `ValueError` -- log + 400, aur security alert.
- `search_post_filter` ne Globex ko `[]` diya: Acme ke 8 refund chunks ne top-3 bhar diya. Bade corpus mein yahi "kabhi kabhi results nahi aate" bug hai.
- `search_pre_filter` -- pehle allowed subset, phir ranking. Real vector DB yahi filter-aware ANN se karta hai.
- Role assert -- staff ko `acme-hr` kabhi nahi milta, manager ko milta hai. Ye M12-07 ka seed hai: permissions retrieval layer mein, prompt mein nahi.
- Toy embedder sirf word overlap dekhta hai -- yahan focus filtering pe hai, ranking quality pe nahi.

```python
# real version -- not run here, needs: pip install qdrant-client pinecone   (shapes only, check the docs for your version)
from qdrant_client import QdrantClient, models

qc = QdrantClient(url=QDRANT_URL, api_key=QDRANT_API_KEY, timeout=10)
qc.create_payload_index("chunks", field_name="tenant", field_schema="keyword")   # index the filter field
hits = qc.query_points(
    collection_name="chunks", query=query_vec, limit=5,
    query_filter=models.Filter(must=[
        models.FieldCondition(key="tenant", match=models.MatchValue(value=user.tenant)),
        models.FieldCondition(key="roles", match=models.MatchAny(any=[user.role])),
    ]),
).points

# Pinecone: a namespace per tenant + metadata filter for role
res = pc_index.query(vector=query_vec, top_k=5, namespace=user.tenant,
                     filter={"roles": {"$in": [user.role]}}, include_metadata=True)
```

### Mini-exercise (30-60 min)
`omniguard/rag/filters.py` banao aur retrieval mein lagao.
- Chunk metadata: `tenant`, `doc_type`, `roles` (list), `source`, `page`, `ingested_at`. Ingest pe missing `tenant`/`roles` = chunk reject (fail closed).
- `build_filter(user_ctx, client_filter)` -- mandatory tenant + role, allow-listed client fields; har rejected field structured log mein (`request_id`, user, field) -- values nahi.
- 2 fake tenants, 2 roles, 20 chunks. Test matrix: har (tenant, role) combo ke liye ek "should never see" query.
- Acceptance: pytest -- cross-tenant leak count == 0 over all queries; selective filter pe bhi `k` results (jab subset mein >= k chunks hon).

### Common pitfalls
- Tenant filter frontend se bhejna "kyunki UI already jaanta hai" -- koi bhi curl se badal dega. Server-side, token se.
- Filter fields pe payload index na banana -- 10 lakh chunks pe har query full scan, latency spike.
- Doc permissions badle (employee ka role change) lekin chunk metadata purana -- ACL sync job aur re-index plan chahiye (M12-07).

### Checklist before moving on
- [ ] Pre-filter vs post-filter ka farak aur post-filter ka bug dikha sakta hoon.
- [ ] Tenant aur role hamesha auth context se lagte hain, client se nahi.
- [ ] Client filters allow-listed hain; unknown field reject hota hai.
- [ ] Cross-tenant leak ke liye automated test hai.

### Related
- M06-06 Index creation
- M06-09 Cloud vector database provisioning
- M12-06 Implementing Role-Based Access Control
- M12-07 Enforcing data-level permissions in retrieval layers

### Self-quiz
1. Globex ko post-filter ke baad zero results kyun mile? Bade corpus pe ye kitna common hoga?
2. Tenant filter request body se lene mein kya attack possible hai? Ek curl example socho.
3. Namespace-per-tenant vs ek index + tenant filter -- kab kaunsa choose karoge?
4. Employee ka role "manager" se "staff" hua. Uske baad bhi wo HR chunks dekh sakta hai -- kyun, aur fix kya?
