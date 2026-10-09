# Agentic Frameworks & LangGraph

## Running agent tasks concurrently using async execution

> Core | Fast CP7 / Slow CP9 | ~1.2 h | Builds on: M09-06, M05-13

### Kahani
Ek fintech customer ka vendor audit 4 jagah se evidence laata hai: Okta (MFA), S3 (access logs), ek legacy HR SOAP API, aur Jira history. Graph ye sab ek ke baad ek karta tha -- 4 x 8 s = 32 s per vendor, 300 vendors = raat bhar.
Parallel kiya to naya problem: legacy HR API kabhi-kabhi hang ho jaati thi, aur ek branch ka exception poore audit ko gira deta tha -- teen achhe results bhi phenk diye.
Customer ko chahiye: jo evidence mila wo rakho, jo nahi mila wo clearly "missing" mark karo, aur koi ek slow system poore run ko na roke.

### What it is
LangGraph mein ek superstep ke saare nodes (fan-out) **concurrently** chal sakte hain; async nodes (`async def`) + `await graph.ainvoke(...)` se I/O-bound branches (APIs, LLM calls) ek saath wait karti hain. Har branch ko **timeout** aur **error capture** wrapper chahiye, taaki ek failure baaki branches ko cancel na kare -- yahi **partial failure handling** hai.

### Why it matters for an FDE
Agent ka zyada time network wait hai (LLM + tools). Concurrency latency SLA (M16-03) bachati hai; guards na hon to ek hung legacy system poora pipeline rok deta hai aur customer "AI slow/unreliable hai" bolta hai.

### Key concepts
- **Superstep concurrency** -- ek step ke nodes ek hi snapshot padhte hain aur saath chalte hain; updates step ke end mein merge.
- **TaskGroup semantics** -- ek task fail = baaki cancel + `ExceptionGroup`; isliye har branch ko apna try/except wrapper do.
- **Per-branch timeout** -- `asyncio.wait_for(coro, t)`; timeout ko error ki tarah state mein record karo, crash nahi.
- **Partial result contract** -- `evidence` + `errors` dono reducers; final node decide kare "complete / partial / failed".
- **Deterministic merge order** -- updates task-creation order mein merge karo, finish order mein nahi.

### Code example
stdlib only

```python
# runnable
import asyncio, operator, time
from typing import Annotated, TypedDict, get_args, get_origin, get_type_hints

START, END = "__start__", "__end__"

class MiniGraph:
    """MiniGraph -- mimics the LangGraph StateGraph API shape, for learning only (async version)."""
    def __init__(self, schema):
        hints = get_type_hints(schema, include_extras=True)
        self.reducers = {k: get_args(t)[1] for k, t in hints.items() if get_origin(t) is Annotated}
        self.nodes, self.edges = {}, {}
    def add_node(self, name, fn): self.nodes[name] = fn
    def add_edge(self, src, dst): self.edges.setdefault(src, []).append(dst)
    def compile(self): return self                                  # validation: M09-08

    async def ainvoke(self, state, config=None):
        limit, state, tasks, steps = (config or {}).get("recursion_limit", 25), dict(state), self.edges[START], 0
        while tasks := [t for t in tasks if t != END]:
            steps += 1
            if steps > limit: raise RecursionError(f"hit recursion_limit={limit}")
            snapshot = dict(state)
            async with asyncio.TaskGroup() as tg:                  # all nodes of this superstep at once
                running = [tg.create_task(self.nodes[t](dict(snapshot))) for t in tasks]
            for task in running:                                    # merge in declared order
                for k, v in (task.result() or {}).items():
                    state[k] = self.reducers[k](state.get(k, []), v) if k in self.reducers else v
            tasks = list(dict.fromkeys(n for t in tasks for n in self.edges.get(t, [])))
        return state

class S(TypedDict):
    vendor: str
    evidence: Annotated[list, operator.add]
    errors: Annotated[list, operator.add]
    status: str

def fake_source(name, delay, fail=None):          # stand-in for an async HTTP / SOAP / LLM call
    async def collect(s):
        await asyncio.sleep(delay)
        if fail: raise fail
        return {"evidence": [f"{name}: ok for {s['vendor']}"]}
    return collect
def guarded(name, fn, timeout):
    async def node(s):
        try:
            return await asyncio.wait_for(fn(s), timeout)
        except TimeoutError:
            return {"errors": [f"{name}: timeout after {timeout}s"]}
        except Exception as e:                    # never let one branch cancel its siblings
            return {"errors": [f"{name}: {type(e).__name__}: {e}"]}
    return node
async def decide(s):
    return {"status": "complete" if not s["errors"] else "partial" if s["evidence"] else "failed"}
SOURCES = {"okta_mfa": fake_source("okta_mfa", 0.4), "s3_logs": fake_source("s3_logs", 0.4),
           "legacy_hr": fake_source("legacy_hr", 5.0), "jira": fake_source("jira", 0.1, ConnectionError("reset"))}
def build(guard=True):
    g = MiniGraph(S)
    for name, fn in SOURCES.items():
        g.add_node(name, guarded(name, fn, 0.6) if guard else fn)
        g.add_edge(START, name); g.add_edge(name, "decide")          # same length -> decide runs once
    g.add_node("decide", decide); g.add_edge("decide", END)
    return g.compile()
async def main():
    t0 = time.perf_counter()
    out = await build().ainvoke({"vendor": "acme", "evidence": [], "errors": []}, config={"recursion_limit": 5})
    elapsed = time.perf_counter() - t0
    print(f"{elapsed:.2f}s", out["status"], out["evidence"], out["errors"])
    assert out["status"] == "partial" and len(out["evidence"]) == 2 and len(out["errors"]) == 2
    assert out["evidence"][0].startswith("okta_mfa"), "merge order = declared order"
    assert elapsed < 1.5, "branches must overlap (sequential would be ~1.5s+)"
    try:                                          # unguarded: one failure cancels everything
        await build(guard=False).ainvoke({"vendor": "acme", "evidence": [], "errors": []})
        raise AssertionError("unguarded run should have failed")
    except* ConnectionError as eg:
        print("unguarded run lost all evidence:", eg.exceptions)

asyncio.run(main())
print("OK: concurrent branches, per-branch timeout, partial result kept")
```

- `asyncio.TaskGroup` -- ek superstep ke nodes saath; wall time ~0.6 s (sabse lambi guarded branch), sequential hota to 1.5 s+.
- `guarded(...)` -- `wait_for` timeout + broad except, dono ko `errors` reducer mein likhta hai; legacy_hr hang aur jira reset dono record hue, okta/s3 ka evidence bacha.
- `for task in running` -- merge creation order mein; `evidence[0]` hamesha okta_mfa, chahe kaun pehle finish hua.
- `except* ConnectionError` -- unguarded TaskGroup ne siblings cancel kiye aur `ExceptionGroup` phenka; is run ka kuch nahi bacha.
- `decide` -- "complete / partial / failed" explicit; downstream (Jira, HITL) ko pata hai evidence adhoora hai.

```python
# real version -- not run here, needs: pip install langgraph
import asyncio
from langgraph.graph import StateGraph, START, END

builder = StateGraph(S)
for name, fn in SOURCES.items():                 # real async collectors (httpx, SDK clients)
    builder.add_node(name, guarded(name, fn, 5.0))
    builder.add_edge(START, name)
builder.add_node("decide", decide)
builder.add_edge(list(SOURCES), "decide")        # join: wait for all collectors
builder.add_edge("decide", END)
graph = builder.compile()
out = asyncio.run(graph.ainvoke({"vendor": "acme", "evidence": [], "errors": []},
                                config={"recursion_limit": 10}))
```

LangGraph nodes pe retry policy bhi de sakte ho (`add_node(..., retry_policy=...)`; purane versions mein naam alag) aur concurrency limit config bhi hota hai -- check the docs for your langgraph version.

### Mini-exercise (30-60 min)
AuditMesh mein `auditmesh/graph/collectors.py`: 3 async evidence collectors (fake Okta, fake S3, fake Jira via `httpx.MockTransport`) + `guarded()` wrapper.
- Timeout config se (env var `COLLECTOR_TIMEOUT_S`), error message mein koi secret/token nahi.
- `asyncio.Semaphore(2)` se max 2 concurrent calls (rate-limited customer API).
- Acceptance: pytest + `asyncio.run` -- (a) ek collector hang -> status "partial" aur baaki evidence present, (b) total time < sum of delays, (c) semaphore ke saath kabhi 2 se zyada calls in-flight nahi (counter se check).

### Common pitfalls
- Async node ke andar blocking call (`requests.get`, `time.sleep`, sync DB driver) -- event loop ruk jaata hai, concurrency zero. Async client use karo ya `asyncio.to_thread`.
- Bina timeout ke parallel calls -- sabse slow system hi aapka latency SLA ban jaata hai.
- Unlimited fan-out -- 300 vendors x 4 calls customer API ko DDoS karta hai aur 429s aate hain; semaphore + backoff (M14-02).

### Checklist before moving on
- [ ] Superstep concurrency aur snapshot semantics samjha sakta hoon.
- [ ] Har branch ko timeout + error capture wrapper deta hoon.
- [ ] Partial results ko explicit status ke saath downstream bhejta hoon.
- [ ] Blocking calls async nodes mein nahi daalta.

### Related
- M05-13 Handling multi-tool parallel execution
- M09-11 Aggregating parallel outputs with map-reduce patterns
- M09-12 Handling state conflicts during concurrent node execution
- M14-02 Exponential backoff strategies

### Self-quiz
1. TaskGroup mein ek task exception phenke to baaki tasks ka kya hota hai? Wrapper isse kaise bachata hai?
2. Merge ko finish order ki jagah declared order mein kyun karte hain?
3. Async node ke andar `time.sleep(5)` likh diya. Concurrency pe kya asar hoga?
4. Teen mein se do collectors fail. Aap Jira ticket banaoge ya nahi? Status kya hoga aur kyun?
