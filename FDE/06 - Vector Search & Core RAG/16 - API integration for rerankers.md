# Vector Search & Core RAG

## API integration for rerankers

> Core | Fast CP3 / Slow CP4 | ~1.2 h | Builds on: M06-15, M05-09

### Kahani
SaaS customer ke paas GPU nahi hai, isliye aapne hosted rerank API lagaya. Pehle din sab badhiya. Teesre din vendor ka region slow hua -- rerank call 12 second leti thi, aur poora `/ask` endpoint timeout. Support bot down, 400 tickets queue mein.
Post-mortem mein CTO ka sawaal: "Reranker ek optional quality booster hai. Uske fail hone se poora bot kyun gira?"
Sahi jawab: reranker ko hamesha timeout, bounded retry aur fallback ke saath lagao -- fail ho to RRF order se answer do, bas thoda kam precise.

### What it is
**Hosted reranker** = HTTP API jo `query` + `documents` list leta hai aur `results: [{index, relevance_score}]` deta hai (Cohere, Voyage, Jina jaise providers ka common shape -- exact fields docs mein check karo).
Integration = client jo timeout, retries, batching (provider ki max docs/tokens limit), response validation aur **graceful fallback** handle kare.

### Why it matters for an FDE
Customer ke production mein har external call ek failure point hai. Optional component ka failure core feature ko nahi girana chahiye -- ye design decision aapko customer ke SRE ko explain karna padega.

### Key concepts
- **Timeout budget** -- poore request ka latency budget (e.g. 3 s) mein rerank ka hissa fix (e.g. 800 ms connect+read); usse zyada = fallback.
- **Bounded retry** -- 429/5xx pe 1 retry with backoff (M14-02); timeout pe aksar retry mat karo agar budget khatam.
- **Batching** -- provider ki per-call document/token limits; zyada candidates = multiple calls, indexes ko global positions pe map karo.
- **Validate the response** -- `index` range mein ho, count sahi ho; garbage pe fallback, crash nahi.
- **Fallback + metric** -- `status="fallback_unreranked"` response mein aur metrics mein; fallback rate pe alert.

### Code example
`pip install httpx pydantic`

> Needs API key for the real version: COHERE_API_KEY or VOYAGE_API_KEY (from env/secrets manager)

```python
# runnable
import json
import logging

import httpx
from pydantic import BaseModel, ValidationError

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("rerank")
logging.getLogger("httpx").setLevel(logging.WARNING)

class RerankItem(BaseModel):
    index: int
    relevance_score: float

class RerankResponse(BaseModel):              # shape of a Cohere/Voyage-style rerank API (check the docs)
    results: list[RerankItem]

class RerankClient:
    def __init__(self, http: httpx.Client, model="rerank-model", max_docs_per_call=4, max_attempts=2):
        self.http, self.model = http, model
        self.max_docs, self.max_attempts = max_docs_per_call, max_attempts

    def _call(self, query, docs):
        for attempt in range(1, self.max_attempts + 1):
            try:
                r = self.http.post("/v1/rerank", json={"model": self.model, "query": query, "documents": docs})
                if r.status_code in (429, 500, 502, 503) and attempt < self.max_attempts:
                    log.info("rerank retry status=%s attempt=%s", r.status_code, attempt)
                    continue                              # real code: backoff + jitter (M14-02)
                r.raise_for_status()
                parsed = RerankResponse.model_validate(r.json())
                if any(not 0 <= it.index < len(docs) for it in parsed.results):
                    raise ValueError("index out of range")
                return parsed.results
            except httpx.TimeoutException:
                log.info("rerank timeout attempt=%s", attempt)
        raise TimeoutError("rerank gave up")

    def rerank(self, query, candidates, top_n=3):
        """Never fails the user request: on any error, return the original (RRF) order."""
        try:
            scored = []
            for start in range(0, len(candidates), self.max_docs):          # batch to the API's limit
                batch = candidates[start:start + self.max_docs]
                for it in self._call(query, [c["text"] for c in batch]):
                    scored.append((it.relevance_score, start + it.index))
            scored.sort(key=lambda x: -x[0])
            return [{**candidates[i], "rerank_score": s} for s, i in scored[:top_n]], "reranked"
        except (httpx.HTTPError, ValidationError, ValueError, TimeoutError) as e:
            log.warning("rerank fallback reason=%s", type(e).__name__)      # no query text in logs (PII)
            return candidates[:top_n], "fallback_unreranked"

def fake_api(mode):
    """httpx.MockTransport = a fake server. No network. Scores docs containing 'opened' highest."""
    calls = {"n": 0}
    def handler(request):
        calls["n"] += 1
        if mode == "timeout":
            raise httpx.ReadTimeout("slow", request=request)
        if mode == "flaky" and calls["n"] == 1:
            return httpx.Response(503, json={"message": "overloaded"})
        if mode == "garbage":
            return httpx.Response(200, json={"results": [{"index": 99, "relevance_score": 1.0}]})
        docs = json.loads(request.content)["documents"]
        res = [{"index": i, "relevance_score": 0.9 if "opened" in d.lower() else 0.1 * (len(docs) - i) / len(docs)}
               for i, d in enumerate(docs)]
        return httpx.Response(200, json={"results": sorted(res, key=lambda x: -x["relevance_score"])})
    return httpx.MockTransport(handler), calls

TEXTS = ["Electronics return policy overview", "Returns within 30 days if sealed", "Gift cards are not refundable",
         "Store hours", "Opened electronics cannot be returned, only exchanged", "Shipping times"]
CANDS = [{"id": f"c{i}", "text": t} for i, t in enumerate(TEXTS)]          # already in RRF order

out = {}
for mode in ["ok", "flaky", "timeout", "garbage"]:
    transport, calls = fake_api(mode)
    http = httpx.Client(transport=transport, base_url="https://rerank.example", timeout=httpx.Timeout(2.0, connect=1.0))
    hits, status = RerankClient(http).rerank("can I return opened electronics", CANDS)
    out[mode] = (hits, status, calls["n"])
    print(f"{mode:8} status={status:20} calls={calls['n']} top1={hits[0]['id']}")

assert out["ok"][1] == "reranked" and out["ok"][0][0]["id"] == "c4" and out["ok"][2] == 2   # 6 docs / 4 per call
assert out["flaky"][1] == "reranked" and out["flaky"][2] == 3                               # one retry, then ok
assert out["timeout"][1] == "fallback_unreranked" and out["timeout"][0][0]["id"] == "c0"   # RRF order kept
assert out["garbage"][1] == "fallback_unreranked"                                           # bad index rejected
print("OK: timeouts, retries, batching, validation and graceful fallback")
```

- `httpx.MockTransport` -- fake server, koi network nahi; chaar modes: ok, flaky (503 phir ok), timeout, garbage response.
- `httpx.Timeout(2.0, connect=1.0)` -- har call pe explicit timeout. httpx ka default 5 s hai; latency budget ke hisaab se khud set karo.
- `_call` -- 429/5xx pe bounded retry (`max_attempts=2`), timeout pe bhi bounded; `pydantic` se response shape aur index range validate.
- `rerank` batching -- 6 candidates, 4 per call = 2 calls; `start + it.index` se batch-local index ko global banaya. Alag calls ke scores comparable hain ya nahi, provider docs mein confirm karo; warna ek call mein bhejo.
- Fallback -- koi bhi error = original RRF order + `status` flag. Log mein sirf error type, query text nahi (PII).

```python
# real version -- not run here, needs: pip install cohere voyageai   (shapes change -- check the docs for your SDK version)
import os
import cohere
import voyageai

co = cohere.ClientV2(api_key=os.environ["COHERE_API_KEY"], timeout=2)
resp = co.rerank(model=os.environ["RERANK_MODEL"], query=query,
                 documents=[c["text"] for c in candidates], top_n=5)
reranked = [(r.index, r.relevance_score) for r in resp.results]

vo = voyageai.Client(api_key=os.environ["VOYAGE_API_KEY"], timeout=2, max_retries=1)
resp = vo.rerank(query, [c["text"] for c in candidates], model=os.environ["RERANK_MODEL"], top_k=5)
reranked = [(r.index, r.relevance_score) for r in resp.results]
```

Wrap either SDK in the same `rerank(...) -> (hits, status)` function so the fallback logic stays in one place.

### Mini-exercise (30-60 min)
OmniGuard: `omniguard/rag/rerank.py` mein `HostedReranker` add karo, same `Reranker` Protocol (M06-15).
- Config: `RERANK_PROVIDER` (stub | local | cohere | voyage), `RERANK_TIMEOUT_MS`, `RERANK_TOP_N`, `RERANK_MAX_DOCS`. Default `stub` taaki tests aur CI bina key chalein.
- `/ask` response mein `"rerank_status"` aur `"rerank_ms"`; structured log mein `request_id`, provider, status, latency -- query text nahi.
- Tests `httpx.MockTransport` se: ok, 503-then-ok, timeout, malformed JSON, out-of-range index -- har case mein `/ask` 200 return kare.
- CP3 gate: `eval/report.md` mein `hybrid_rrf + rerank` row aur ek line fallback rate (test run mein).

### Common pitfalls
- Timeout set hi nahi kiya -- vendor slow hua to aapke workers block, poora service down.
- SDK ka retry + aapka retry + HTTP client ka retry -- nested retries se ek request 9 calls (M05-09 wala lesson yahan bhi).
- Poore chunks (2,000 tokens each) rerank API ko bhejna -- cost tokens pe hota hai; candidate text truncate karo ya chunk size soch ke rakho.

### Checklist before moving on
- [ ] Rerank API call pe explicit timeout aur bounded retry hai.
- [ ] Reranker fail ho to user ko phir bhi RRF order se answer milta hai.
- [ ] Response validate hota hai (index range, shape).
- [ ] Fallback rate aur rerank latency metrics mein dikhte hain.

### Related
- M06-15 Cross-encoder reranking models
- M05-09 Handling and retrying output parsing errors gracefully
- M14-02 Exponential backoff strategies
- M14-04 Configuring rate limiting and fallback routing
- M14-11 Monitoring granular token costs and endpoint latency

### Self-quiz
1. Rerank API 12 s le rahi hai. Aapke design mein user ko kya milega aur kitni der mein?
2. 60 candidates, API limit 25 docs per call. Indexes ko kaise map karoge, aur scores ke baare mein kya check karoge?
3. Timeout pe retry karna kab galat hai?
4. Fallback rate 30% ho gaya. Kaunse 3 cheezein check karoge?
