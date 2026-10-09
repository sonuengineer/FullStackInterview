# Advanced Agent Orchestration

## Semantic long-term memory retrieval

> Core | Fast CP7 / Slow CP9 | ~1.2 h | Builds on: M10-01, M06-03, M06-10

### Kahani
Ek logistics SaaS ka support agent. Ops manager Priya har Monday poochti hai "Mumbai hub ke delayed shipments dikhao" -- aur har baar batana padta hai "mujhe sirf FTL loads chahiye, aur report INR mein".
Checkpointing (M10-01) laga hua hai, lekin wo sirf us ek thread ka state yaad rakhta hai. Naya thread = agent sab bhool gaya.
Ek developer ne "fix" kiya: poori pichhli chat history har prompt mein chipka di. Teen hafte baad prompt 40k tokens ka, cost 6x, aur ek din Priya ki preference galti se doosre user Rahul ke answer mein dikh gayi.

### What it is
**Long-term memory** = threads ke paar zinda rehne wale chhote facts ("Priya prefers FTL only, INR"), jo ek **namespace** (e.g. `("memories", user_id)`) mein key-value + embedding ke saath store hote hain. Har naye thread mein agent query se **semantically relevant top-k** memories nikaalta hai aur sirf wahi prompt mein daalta hai.
Thread state (checkpointer) = "is conversation mein kya hua". Memory store = "is user ke baare mein kya pata hai".

### Why it matters for an FDE
Customers personalization chahte hain, par cross-user leak = data breach, aur bina forgetting ke memory = GDPR/DPDP "right to erasure" ka violation. Retrieval ke bina "sab history chipkao" approach cost aur latency dono maarta hai.

### Key concepts
- **Namespace** -- tuple jaise `("memories", tenant_id, user_id)`; search hamesha ek namespace ke andar, kabhi global nahi.
- **Write path** -- har turn ke baad (ya background mein) LLM se 0-3 durable facts extract karo; raw transcript store mat karo.
- **Read path** -- current question ko embed karo, cosine top-k + min score threshold; kuch relevant nahi to kuch mat daalo.
- **TTL / forgetting** -- har memory pe `expires_at`; "delete my data" pe namespace wipe; purani conflicting memory update karo, duplicate mat banao.
- **PII gate** -- memory write se pehle PII check; card numbers, Aadhaar, passwords kabhi memory mein nahi (M13-14).

### Code example
`pip install numpy`

```python
# runnable
import re
import time
import zlib

import numpy as np

DIM = 256
def embed(text):
    """Toy embedding: hashed bag of words. Stand-in for a real embedding model (M06-03)."""
    v = np.zeros(DIM)
    for w in re.findall(r"[a-z0-9]+", text.lower()):
        v[zlib.crc32(w.encode()) % DIM] += 1.0
    n = np.linalg.norm(v)
    return v / n if n else v

PII = re.compile(r"\b\d{12,16}\b|[\w.]+@[\w.]+|password", re.I)

class MemoryStore:
    """Teaching stand-in shaped like LangGraph's BaseStore: put / search / delete by namespace."""
    def __init__(self, clock=time.time):
        self.items, self.clock = {}, clock
    def put(self, namespace, key, text, ttl_s=90 * 86400):
        if PII.search(text):
            raise ValueError("refusing to store PII in long-term memory")
        self.items[(namespace, key)] = {"text": text, "vec": embed(text), "expires": self.clock() + ttl_s}
    def search(self, namespace, query, k=2, min_score=0.2):
        now, q = self.clock(), embed(query)
        hits = [(float(q @ it["vec"]), it["text"]) for (ns, _), it in self.items.items()
                if ns == namespace and it["expires"] > now]           # namespace + TTL filter FIRST
        return [t for s, t in sorted(hits, reverse=True)[:k] if s >= min_score]
    def forget_user(self, namespace):
        self.items = {k: v for k, v in self.items.items() if k[0] != namespace}

now = [1_000_000.0]
store = MemoryStore(clock=lambda: now[0])
priya, rahul = ("memories", "acme", "priya"), ("memories", "acme", "rahul")
store.put(priya, "pref-load", "Priya wants only FTL loads in shipment reports")
store.put(priya, "pref-currency", "Priya wants report amounts in INR currency")
store.put(priya, "temp-hub", "Priya is covering the Pune hub this week", ttl_s=7 * 86400)
store.put(rahul, "pref-load", "Rahul wants LTL loads and USD amounts")

def build_prompt(namespace, question):
    mem = store.search(namespace, question)
    ctx = "\n".join(f"- {m}" for m in mem) or "- (no relevant memories)"
    return f"Known user preferences:\n{ctx}\n\nQuestion: {question}"

p = build_prompt(priya, "show delayed shipment loads report for Mumbai")
print(p)
assert "FTL" in p and "Rahul" not in p                          # no cross-user leak
assert "Pune" in " ".join(store.search(priya, "which hub is Priya covering"))
now[0] += 8 * 86400                                              # 8 days later
assert all("Pune" not in m for m in store.search(priya, "which hub is Priya covering", k=3))
assert store.search(priya, "weather in Goa tomorrow") == []      # irrelevant -> inject nothing
try:
    store.put(priya, "card", "Priya card is 4111111111111111")
    raise AssertionError("PII should be rejected")
except ValueError as e:
    print("blocked:", e)
store.forget_user(priya)                                          # right to erasure
assert store.search(priya, "FTL loads") == [] and store.search(rahul, "loads")
print("OK: namespaced, TTL-aware, PII-gated semantic memory")
```

- `embed()` toy hai (hashed words) -- concept same rehta hai: text -> vector -> cosine. Real mein embedding model ya store ka built-in index use karo.
- `search()` pehle namespace aur TTL filter karta hai, phir ranking -- filter-then-rank hi cross-user leak rokta hai (M06-08 metadata filtering jaisa).
- `min_score` -- "weather in Goa" pe koi memory inject nahi; irrelevant memory prompt ko confuse karti hai aur tokens khaati hai.
- `ttl_s=7 days` wali "Pune hub" memory 8 din baad gayab -- temporary facts ko permanent mat banao.
- `put()` mein PII regex ek last gate hai; real mein Presidio-style detector (M13-04) + write-time LLM extraction prompt jo PII avoid kare.

```python
# real version -- not run here, needs: pip install langgraph
# Check the LangGraph docs for your version (store API and index config change between releases).
from langgraph.store.memory import InMemoryStore      # prod: langgraph.store.postgres.PostgresStore

store = InMemoryStore(index={"embed": my_embed_fn, "dims": 1536})
ns = ("memories", tenant_id, user_id)
store.put(ns, "pref-load", {"text": "Priya wants only FTL loads"})
hits = store.search(ns, query="delayed shipment report", limit=3)
graph = builder.compile(checkpointer=checkpointer, store=store)   # nodes receive the store
```

### Mini-exercise (30-60 min)
`fde-exercises/m10_memory/`: memory ko apne CP7 AuditMesh agent mein jodo -- auditor ki preferences ("SOX controls first", "report in Excel").
- `memory.py`: upar wala store sqlite pe persist karo (vector ko `np.ndarray.tobytes()` blob mein), namespace `("memories", tenant, user)`.
- `extract_memories(turn)` -- FakeLLM jo turn se max 3 facts nikale; duplicate key pe update, naya row nahi.
- Acceptance tests: cross-tenant search empty; TTL expiry; PII reject; `forget_user` ke baad 0 rows; prompt mein max 3 memories.

### Common pitfalls
- Poori chat history ko "memory" bana dena -- cost badhta hai, purane galat facts zinda rehte hain.
- Namespace mein tenant na daalna -- do customers ke same `user_id = 42` aapas mein mix.
- Memory ko truth maan lena -- user ne preference badli, purani memory abhi bhi jeet rahi; latest-wins update aur "last_confirmed" timestamp rakho.

### Checklist before moving on
- [ ] Thread state vs long-term memory ka fark ek line mein bata sakta hoon.
- [ ] Search namespace + TTL filter ke baad hi rank karta hai.
- [ ] Irrelevant query pe kuch inject nahi hota (min score).
- [ ] PII gate aur forget-user path tested hain.

### Related
- M10-01 Check-pointing graph states
- M06-08 Metadata filtering
- M06-10 End-to-end basic retrieval
- M13-14 Safe logging (never log PII or prompts)
- M12-07 Enforcing data-level permissions in retrieval layers

### Self-quiz
1. User ne kaha "ab se USD mein dikhao". Aapka write path purani "INR" memory ke saath kya karega, aur kyon?
2. Memory search pehle rank kare aur baad mein namespace filter -- isme kya galat ho sakta hai (k=2 ke saath socho)?
3. Kaunse facts memory mein kabhi nahi jaane chahiye, aur ye rule code mein kahan enforce karoge?
4. Memory write har turn pe synchronously karoge ya background mein? Latency aur consistency ka trade-off batao.
