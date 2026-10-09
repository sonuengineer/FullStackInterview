# Agentic Frameworks & LangGraph

## Aggregating parallel outputs with map-reduce patterns

> Core | Fast CP7 / Slow CP9 | ~1.2 h | Builds on: M09-07, M09-09

### Kahani
Ek healthcare SaaS customer ka SOC 2 audit: har vendor ke liye 5 se 60 controls check hone hain, aur kitne honge ye **runtime** pe pata chalta hai (vendor ke scope se).
Pehla version har control ke liye hard-coded node banata tha -- naya control aaya to code change. Doosre version ne ek node ke andar `for` loop chalaya -- 60 LLM calls sequential, 4 minute per vendor.
Teesri dikkat: jab parallel kiya, report mein controls har run pe alag order mein aate the, aur auditor ne poocha "kal aur aaj ki report ka diff itna bada kyun hai jab kuch badla hi nahi?"

### What it is
**Map-reduce** = ek list ke har item pe same kaam parallel (**map**), phir saare outputs ek jagah combine (**reduce**). LangGraph mein router function `Send("node", item_state)` ki list return karta hai -- har `Send` us node ka ek alag run banata hai, apne chhote input ke saath. Outputs ek reducer key (`Annotated[list, operator.add]`) mein jama hote hain, aur ek reduce node unhe sort karke final result banata hai.

### Why it matters for an FDE
Customer data ka size runtime pe pata chalta hai (controls, documents, tickets). Map-reduce fan-out ko data-driven banata hai, `max_concurrency` customer API ko bachata hai, aur sorted reduce reports ko reproducible banata hai -- auditors diff karte hain.

### Key concepts
- **Dynamic fan-out** -- router `[Send(node, arg) for item in items]`; branches ki ginti data decide karta hai.
- **Per-item input** -- har mapped run ko sirf apna item milta hai (poora state nahi) -- chhota context, kam tokens.
- **Reducer collects** -- `results: Annotated[list, operator.add]`; har run ek-item list return kare.
- **Deterministic reduce** -- completion order pe kabhi bharosa mat karo; stable key (control id) se sort karo.
- **Bounded concurrency + per-item errors** -- `max_concurrency` limit, aur har item ka error result row ban ke aaye, crash nahi.

### Code example
stdlib only

```python
# runnable
import asyncio, operator
from dataclasses import dataclass
from typing import Annotated, TypedDict, get_args, get_origin, get_type_hints

START, END = "__start__", "__end__"
@dataclass
class Send:                                       # mimics langgraph.types.Send
    node: str
    arg: dict
class MiniGraph:
    """MiniGraph -- mimics the LangGraph StateGraph API shape, for learning only (async + Send)."""
    def __init__(self, schema):
        hints = get_type_hints(schema, include_extras=True)
        self.reducers = {k: get_args(t)[1] for k, t in hints.items() if get_origin(t) is Annotated}
        self.nodes, self.edges, self.branches = {}, {}, {}
    def add_node(self, name, fn): self.nodes[name] = fn
    def add_edge(self, src, dst): self.edges.setdefault(src, []).append(dst)
    def add_conditional_edges(self, src, router, mapping): self.branches[src] = (router, mapping)
    def compile(self): return self                                  # validation: M09-08
    def _next(self, n, state):
        if n not in self.branches: return self.edges.get(n, [])
        router, mapping = self.branches[n]; out = router(state)
        return [o if isinstance(o, Send) or isinstance(mapping, list) else mapping[o]
                for o in (out if isinstance(out, list) else [out])]
    async def ainvoke(self, state, config=None):
        cfg, state, steps = config or {}, dict(state), 0
        sem, tasks = asyncio.Semaphore(cfg.get("max_concurrency", 100)), self._next(START, state)
        async def run(t, snap):
            async with sem:
                return await (self.nodes[t.node](t.arg) if isinstance(t, Send) else self.nodes[t](dict(snap)))
        while tasks := [t for t in tasks if t != END]:
            snap = dict(state); steps += 1
            if steps > cfg.get("recursion_limit", 25): raise RecursionError("recursion_limit hit")
            async with asyncio.TaskGroup() as tg:
                running = [(t, tg.create_task(run(t, snap))) for t in tasks]
            for _, task in running:
                for k, v in (task.result() or {}).items():
                    state[k] = self.reducers[k](state.get(k, []), v) if k in self.reducers else v
            nxt = [n for t, _ in running for n in self._next(t.node if isinstance(t, Send) else t, state)]
            tasks = [x for i, x in enumerate(nxt) if isinstance(x, Send) or x not in nxt[:i]]
        return state

class S(TypedDict):
    vendor: str
    controls: list
    results: Annotated[list, operator.add]       # map outputs land here
    report: dict
FINISHED, LIVE = [], {"now": 0, "peak": 0}

async def plan(s): return {"controls": ["CC8.1", "CC6.2", "CC7.1", "CC6.1", "CC7.2", "CC6.3"]}
def fan_out(s): return [Send("audit_control", {"vendor": s["vendor"], "control": c, "i": i})
                        for i, c in enumerate(s["controls"])]
async def audit_control(arg):                    # stand-in for one LLM + evidence check per control
    LIVE["now"] += 1; LIVE["peak"] = max(LIVE["peak"], LIVE["now"])
    try:
        await asyncio.sleep(0.02 * (6 - arg["i"]))                 # later controls finish first
        if arg["control"] == "CC7.2": raise TimeoutError("evidence API timed out")
        return {"results": [{"control": arg["control"], "status": "pass" if arg["i"] % 3 else "fail"}]}
    except Exception as e:                       # per-item error becomes a row, not a crash
        return {"results": [{"control": arg["control"], "status": "error", "detail": str(e)}]}
    finally:
        LIVE["now"] -= 1; FINISHED.append(arg["control"])
async def reduce(s):
    rows = sorted(s["results"], key=lambda r: r["control"])        # deterministic order
    by = {st: [r["control"] for r in rows if r["status"] == st] for st in ("pass", "fail", "error")}
    return {"report": {"rows": rows, **by, "complete": not by["error"]}}

g = MiniGraph(S)
for fn in (plan, audit_control, reduce): g.add_node(fn.__name__, fn)
g.add_edge(START, "plan"); g.add_conditional_edges("plan", fan_out, ["audit_control"])
g.add_edge("audit_control", "reduce"); g.add_edge("reduce", END)
out = asyncio.run(g.compile().ainvoke({"vendor": "acme", "results": []},
                                      config={"recursion_limit": 10, "max_concurrency": 3}))
rep = out["report"]
print("finished:", FINISHED, "\nreport:", [r["control"] for r in rep["rows"]], rep["fail"], rep["error"])
assert [r["control"] for r in rep["rows"]] == sorted(out["controls"]) != out["controls"]
assert rep["fail"] == ["CC6.1", "CC8.1"] and rep["error"] == ["CC7.2"] and rep["complete"] is False
assert LIVE["peak"] <= 3, "max_concurrency respected"
print("OK: dynamic fan-out, bounded concurrency, per-item errors, sorted reduce")
```

- `fan_out` -- router `Send` ki list return karta hai; 6 controls = 6 runs. Kal 60 controls aaye to code same.
- `Send(..., {"vendor", "control", "i"})` -- mapped node ko sirf apna item milta hai, poora state nahi.
- `max_concurrency: 3` + semaphore -- ek waqt pe max 3 in-flight; `LIVE["peak"]` assert se proof.
- `FINISHED` print -- finish order na plan order hai na sorted (delays + concurrency limit); isliye `reduce` mein `sorted(..., key=control)`, report hamesha same order mein.
- CC7.2 ka timeout `status: "error"` row bana; `complete: False` downstream ko batata hai "partial audit, human dekhe".

```python
# real version -- not run here, needs: pip install langgraph
import asyncio
from langgraph.graph import StateGraph, START, END
from langgraph.types import Send


def fan_out(state: S):
    return [Send("audit_control", {"vendor": state["vendor"], "control": c}) for c in state["controls"]]

builder = StateGraph(S)
builder.add_node("plan", plan)
builder.add_node("audit_control", audit_control)   # receives the Send payload as its input
builder.add_node("reduce", reduce)
builder.add_edge(START, "plan")
builder.add_conditional_edges("plan", fan_out, ["audit_control"])
builder.add_edge("audit_control", "reduce")
builder.add_edge("reduce", END)
graph = builder.compile()
out = asyncio.run(graph.ainvoke({"vendor": "acme", "results": []},
                                config={"recursion_limit": 10, "max_concurrency": 4}))
```

`Send` ka import path aur `max_concurrency` ka exact behaviour versions ke beech badla hai -- check the docs for your langgraph version.

### Mini-exercise (30-60 min)
AuditMesh `auditmesh/graph/supervisor.py` ke saath ek `audit_controls` subflow: `plan_controls -> Send per control -> check_control -> reduce_findings`.
- `check_control` FakeLLM se verdict (`pass/fail/needs_evidence`) + evidence ids; har error ek row.
- `reduce_findings` sort by control id, summary counts, aur `complete` flag; `fail` ya `error` > 0 ho to supervisor ko `human_approval` pe route karo (M09-04).
- Acceptance: pytest -- (a) 1, 6 aur 60 controls teeno pe kaam kare, (b) do runs ki report byte-for-byte same (`json.dumps(sort_keys=True)`), (c) peak concurrency <= config value.

### Common pitfalls
- Reduce mein completion order pe depend karna -- flaky tests aur auditor ko "random" reports. Stable key se sort.
- Har `Send` mein poora state (saare documents) bhejna -- N x tokens aur N x cost. Sirf item + zaroori IDs bhejo.
- Unbounded fan-out (1000 items, no limit) -- LLM provider 429 aur customer API rate limits. `max_concurrency` + backoff (M14-02).

### Checklist before moving on
- [ ] `Send` se dynamic fan-out likh sakta hoon.
- [ ] Map outputs ko reducer key mein collect karke sorted reduce karta hoon.
- [ ] Per-item errors ko rows bana ke partial result report karta hoon.
- [ ] Concurrency limit set karta hoon.

### Related
- M09-09 Running agent tasks concurrently using async execution
- M09-12 Handling state conflicts during concurrent node execution
- M06-13 Implementing RRF algorithms
- M14-11 Monitoring granular token costs and endpoint latency

### Self-quiz
1. Static fan-out (fixed edges) aur `Send` wale dynamic fan-out mein farak kya hai? Kab kaunsa?
2. Mapped node ko poora state dene ki jagah sirf item dena kyun better hai?
3. Do runs ki report ka order alag aaya. Root cause kya hai aur fix kahan lagega?
4. 60 mein se 3 controls error mein gaye. Report "passed" kyun nahi bolni chahiye?
