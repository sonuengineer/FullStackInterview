# Identity & Access Management

## Enforcing data-level permissions in retrieval layers

> Core | Fast CP5 / Slow CP7 | ~1.2 h | Builds on: M06-08, M06-10, M12-01, M12-06, M11-12

### Kahani
Ek manufacturing customer ka HR + engineering knowledge bot. SharePoint ke saare docs ek vector index mein daale. Demo mein ek junior engineer ne poocha "what is the salary band for L5?" -- aur bot ne HR ka confidential compensation doc quote kar diya.
Developer ka fix tha system prompt mein: "Do not reveal confidential HR documents." Agle din ek user ne "ignore previous instructions" likha aur wahi data phir aa gaya.
Asli fix: jo chunk user SharePoint mein khud nahi khol sakta, wo retrieval se bahar -- ranking se pehle, LLM ke context se pehle. LLM ko jo dikha hi nahi, wo leak nahi kar sakta.

### What it is
**Permission-aware retrieval** = har chunk ke saath ACL metadata (`tenant`, `allowed_groups`, `classification`) ingest time pe store karo, aur query time pe user ke principal se ek **mandatory filter** banao jo search ke andar lage (pre-filter), uske baad hi ranking aur LLM.
Same question, do users = do alag answers. Ye bug nahi, yahi requirement hai.

### Why it matters for an FDE
Enterprise RAG ka number one blocker yahi hai: "kya bot mera data galat logon ko dikhayega?" Iska jawab prompt nahi, retrieval layer ka code + tests hain. CP5 gate isi ka demo hai.

### Key concepts
- **ACL at ingest** -- source system (SharePoint, Confluence, DB) ke permissions chunk metadata mein copy; doc ke permissions badle to re-sync job (stale ACL = leak).
- **Pre-filter, not post-filter** -- filter search ke andar (M06-08 metadata filtering). Top-k ke baad filter karoge to ya to results khaali, ya galti se unfiltered path khula reh jaata hai.
- **Never rely on the prompt** -- "don't reveal X" ek suggestion hai, security control nahi. Prompt injection (M13-02) use tod deta hai.
- **Defense in depth** -- LLM call se pehle ek aur assert: har context chunk user ke liye allowed hai. Text-to-SQL ke liye same idea: read-only + row-level DB role (M11-12).
- **Permission-aware cache key** -- answer/retrieval cache key = query + tenant + hash(sorted groups + clearance). Warna admin ka cached answer intern ko milega.

### Code example
`stdlib only`

```python
# runnable
import hashlib, re
from dataclasses import dataclass

LEVELS = {"public": 0, "internal": 1, "confidential": 2}

@dataclass(frozen=True)
class Principal:
    sub: str; tenant: str; groups: frozenset; clearance: str

@dataclass(frozen=True)
class Chunk:                           # allowed_groups is copied from the source system's ACL at ingest
    id: str; text: str; tenant: str; allowed_groups: frozenset; classification: str

CHUNKS = [
    Chunk("eng-1", "L5 engineer career ladder: owns a service end to end", "acme", frozenset({"all-staff"}), "internal"),
    Chunk("hr-7", "L5 salary band is 42 to 55 lakh, confidential", "acme", frozenset({"hr"}), "confidential"),
    Chunk("hr-2", "Salary review happens every April for all staff", "acme", frozenset({"all-staff"}), "internal"),
    Chunk("oth-1", "L5 salary band at globex is 30 lakh", "globex", frozenset({"all-staff"}), "internal"),
]

def allowed(p: Principal, c: Chunk) -> bool:
    return (c.tenant == p.tenant and bool(c.allowed_groups & p.groups)
            and LEVELS[c.classification] <= LEVELS[p.clearance])

def score(query: str, text: str) -> int:           # stand-in for vector/BM25 score (M06-10)
    q = set(re.findall(r"\w+", query.lower()))
    return len(q & set(re.findall(r"\w+", text.lower())))

def retrieve(p: Principal, query: str, k: int = 2) -> list[Chunk]:
    candidates = [c for c in CHUNKS if allowed(p, c)]          # filter BEFORE ranking
    return sorted(candidates, key=lambda c: -score(query, c.text))[:k]

def retrieve_wrong(query: str, k: int = 2) -> list[Chunk]:     # tempting: rank everything, trust the prompt
    return sorted(CHUNKS, key=lambda c: -score(query, c.text))[:k]

class FakeLLM:                                       # same shape idea as a chat call; echoes its context
    def answer(self, system: str, context: list[Chunk], question: str) -> str:
        return " | ".join(c.text for c in context)  # a real model CAN repeat context despite the system prompt

def ask(p: Principal, q: str, cache: dict, key_fn) -> tuple[str, list[str]]:
    key = key_fn(p, q)
    if key in cache:
        return cache[key]
    ctx = retrieve(p, q)
    assert all(allowed(p, c) for c in ctx), "ACL violation before LLM"   # defense in depth
    out = (FakeLLM().answer("Answer from context.", ctx, q), [c.id for c in ctx])
    cache[key] = out
    return out

def perm_key(p: Principal, q: str) -> str:
    perms = f"{p.tenant}|{','.join(sorted(p.groups))}|{p.clearance}"
    return hashlib.sha256(f"{q.strip().lower()}||{perms}".encode()).hexdigest()

def naive_key(p: Principal, q: str) -> str:        # BUG: ignores who is asking
    return hashlib.sha256(q.strip().lower().encode()).hexdigest()

priya = Principal("priya", "acme", frozenset({"all-staff", "hr"}), "confidential")
dev = Principal("dev", "acme", frozenset({"all-staff"}), "internal")
Q = "What is the L5 salary band?"

ans_priya, ids_priya = ask(priya, Q, {}, perm_key)
ans_dev, ids_dev = ask(dev, Q, {}, perm_key)
print("priya:", ids_priya, "| dev:", ids_dev)
assert "hr-7" in ids_priya and "hr-7" not in ids_dev and "42 to 55" not in ans_dev
assert "oth-1" not in ids_priya + ids_dev                     # other tenant never visible

# Wrong approach 1: rank everything, then hope the system prompt hides it.
wrong_ctx = retrieve_wrong(Q)
leak = FakeLLM().answer("Never reveal confidential HR data.", wrong_ctx, Q)
assert "42 to 55" in leak or "30 lakh" in leak                # the prompt is not a control

# Wrong approach 2: permission-blind cache. HR asks first, dev gets HR's cached answer.
shared = {}
ask(priya, Q, shared, naive_key)
assert "42 to 55" in ask(dev, Q, shared, naive_key)[0]        # leak through the cache
shared = {}
ask(priya, Q, shared, perm_key)
assert "42 to 55" not in ask(dev, Q, shared, perm_key)[0]     # permission-aware key: no leak
print("OK: same question, different allowed answers; filter before rank; cache keyed by permissions")
```

- `allowed()` -- teen checks: tenant, group overlap, classification <= clearance. Ye hi function retrieval aur defense-in-depth assert dono mein -- ek source of truth.
- `retrieve` -- pehle filter, phir rank. Vector DB mein ye `filter=` parameter hota hai (M06-08); production mein filter server-side query mein, Python mein baad mein nahi.
- `retrieve_wrong` + "Never reveal" prompt -- FakeLLM context echo karta hai; real model bhi injection pe yahi karega. Context mein aaya = leak possible.
- `naive_key` vs `perm_key` -- cache key mein tenant + sorted groups + clearance. Kahani ka doosra leak path yahi hota hai jab team M14-15 caching add karti hai.
- Asserts -- CP5 gate ka chhota version: Priya ko `hr-7`, Dev ko nahi, globex ka chunk kisi ko nahi.

```python
# real version -- not run here, needs: pip install qdrant-client  (filter syntax differs per DB -- check the docs)
from qdrant_client import models

acl_filter = models.Filter(must=[
    models.FieldCondition(key="tenant", match=models.MatchValue(value=p.tenant)),
    models.FieldCondition(key="allowed_groups", match=models.MatchAny(any=sorted(p.groups))),
    models.FieldCondition(key="classification_level", range=models.Range(lte=LEVELS[p.clearance])),
])
hits = client.query_points(collection_name="docs", query=query_vector, query_filter=acl_filter, limit=8).points
```

pgvector mein yahi `WHERE tenant = %s AND allowed_groups && %s AND classification_level <= %s` hai, aur Postgres Row-Level Security policy usko DB level pe enforce kar sakti hai (M11-12 jaisa read-only role + RLS).

### Mini-exercise (30-60 min)
OmniGuard CP5 gate: ACL-filtered retrieval.
- Ingest: har chunk pe `tenant`, `allowed_groups`, `classification` metadata (M15-02 data classifications se). Missing ACL = chunk index hi na ho (deny by default).
- `omniguard/rag/retrieve.py`: `retrieve(principal, query)` jo filter search ke andar lagaye; `/ask` route `require_permission("ask:use")` (M12-06) ke peeche.
- LLM call se pehle `assert_all_allowed(principal, chunks)`; violation pe 500 + audit event (M12-10), answer nahi.
- `tests/test_two_user_demo.py`: do JWTs (M12-02), same question -> alag chunk ids, confidential text sirf HR user ke answer mein; cache on aur off dono mein pass.
- Demo script `scripts/two_user_demo.sh` jo dono users ke liye `curl /ask` chalaye -- yahi CP5 gate recording hai.

### Common pitfalls
- ACL sirf doc level pe, chunks/summaries/embeddings cache pe nahi -- summary chunk ne confidential data copy kar liya. Derived data ko parent ka ACL inherit karna chahiye.
- Source permissions badle, index re-sync nahi -- employee HR se nikla par 2 hafte tak HR docs dikhte rahe. ACL sync ka SLA customer ke saath likho.
- Logs/traces mein retrieved chunk text -- permission filter sahi, par observability tool sab ko dikha raha hai (M13-14).

### Checklist before moving on
- [ ] Har chunk pe ACL metadata hai aur missing ACL = not indexed.
- [ ] Filter search ke andar lagta hai, ranking aur LLM se pehle.
- [ ] Two-user test: same question, alag allowed chunks, assert ke saath.
- [ ] Cache key mein user ka permission set hai.
- [ ] Main explain kar sakta hoon kyun "system prompt se chhupa do" security control nahi hai.

### Related
- M06-08 Metadata filtering
- M06-10 End-to-end basic retrieval
- M11-12 Implementing read-only database roles
- M12-06 Implementing Role-Based Access Control
- M13-02 Prompt injection defenses
- M14-15 Prompt caching strategies
- M15-02 Defining data classifications

### Self-quiz
1. Post-filter (top-k ke baad filter) mein do problems kya hain -- ek security, ek quality?
2. CISO kehta hai "system prompt mein likh do confidential mat batana." Aap 2 line mein kya jawab doge?
3. Answer cache add kiya aur ek intern ko HR data mila. Cache key mein kya missing tha?
4. SharePoint mein ek doc ka access hata diya gaya. Aapke RAG system mein ye kab aur kaise reflect hoga?
