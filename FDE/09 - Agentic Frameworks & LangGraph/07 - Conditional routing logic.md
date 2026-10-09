# Agentic Frameworks & LangGraph

## Conditional routing logic

> Core | Fast CP7 / Slow CP9 | ~1.2 h | Builds on: M09-05, M09-06

### Kahani
Ek hospital ke vendor-risk graph mein LLM har finding ko "high" / "low" label deta tha, aur router: `if label == "high": human else auto_close`.
Ek din model ne "High" (capital H) aur ek baar "CRITICAL!!" likh diya -- dono `auto_close` mein chale gaye. Ek critical finding bina kisi insaan ke dekhe band ho gayi.
Doosre hafte "unclear" ke liye retry loop add kiya, bina counter ke -- ek ajeeb finding pe graph 40 baar LLM call karta raha jab tak timeout nahi hua.
Routing logic hi wo jagah hai jahan "agent" ka control flow decide hota hai -- isse sabse zyada defensive hona chahiye.

### What it is
`add_conditional_edges(source, router_fn, mapping)` -- source node ke baad `router_fn(state)` ek **key** return karta hai, aur `mapping` us key ko agle node (ya `END`) pe map karta hai. Router ek chhota, **pure** function hai: state padho, decide karo, kuch likho mat.

### Why it matters for an FDE
Customer ke liye galat route = galat outcome (critical finding auto-close) ya runaway cost (infinite loop). Safe default, bounded retries aur recursion limit -- teeno production mein must hain.

### Key concepts
- **LLM in node, decision in router** -- node label state mein likhe; router sirf us label ko padhke route kare. Router ke andar LLM call mat karo.
- **Normalise + safe default** -- unknown/garbled label hamesha safest path (human review) pe jaye, kabhi auto-close pe nahi.
- **Bounded loops** -- retry edge ke saath `attempts` counter state mein; limit ke baad escalate.
- **Recursion limit** -- framework-level last guard: N supersteps ke baad error, chahe router mein bug ho.
- **Explicit mapping** -- har possible key mapping mein; unknown key pe turant error, silent fall-through nahi.

### Code example
stdlib only

> Needs API key for the real version: ANTHROPIC_API_KEY (or OPENAI_API_KEY)

```python
# runnable
import operator
from typing import Annotated, TypedDict, get_args, get_origin, get_type_hints

START, END = "__start__", "__end__"

class MiniGraph:
    """MiniGraph -- mimics the LangGraph StateGraph API shape, for learning only."""
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
        router, mapping = self.branches[n]
        key = router(state)
        if key not in mapping: raise ValueError(f"router after {n!r} returned unknown key {key!r}")
        return [mapping[key]]
    def invoke(self, state, config=None):
        limit, state, tasks, steps = (config or {}).get("recursion_limit", 25), dict(state), self._next(START, state), 0
        while tasks := [t for t in tasks if t != END]:
            steps += 1
            if steps > limit: raise RecursionError(f"hit recursion_limit={limit}")
            snapshot = dict(state)
            for t in tasks:
                for k, v in (self.nodes[t](dict(snapshot)) or {}).items():
                    state[k] = self.reducers[k](state.get(k, []), v) if k in self.reducers else v
            tasks = list(dict.fromkeys(n for t in tasks for n in self._next(t, state)))
        return state

class FakeLLM:
    """Stand-in for a classification call; returns scripted labels per attempt. No network."""
    SCRIPT = {"F1": ["high"], "F2": ["unclear", "Low "], "F3": ["unclear"] * 9, "F4": ["CRITICAL!!"]}
    def classify(self, finding_id, attempt): return self.SCRIPT[finding_id][attempt]

class S(TypedDict):
    finding_id: str
    label: str
    attempts: int
    labels_seen: Annotated[list, operator.add]
    outcome: str

llm, MAX_ATTEMPTS = FakeLLM(), 3
def classify(s):
    label = llm.classify(s["finding_id"], s["attempts"]).strip().lower()     # normalise
    return {"label": label, "attempts": s["attempts"] + 1, "labels_seen": [label]}
def route(s):                                   # pure: reads state, writes nothing
    if s["label"] == "unclear" and s["attempts"] < MAX_ATTEMPTS: return "retry"
    if s["label"] == "low": return "auto"
    return "human"                              # high, exhausted retries, or garbage -> safest path
def build(router):
    g = MiniGraph(S)
    g.add_node("classify", classify)
    g.add_node("auto_close", lambda s: {"outcome": "auto_closed"})
    g.add_node("human_review", lambda s: {"outcome": "queued_for_human"})
    g.add_edge(START, "classify")
    g.add_conditional_edges("classify", router, {"retry": "classify", "auto": "auto_close", "human": "human_review"})
    g.add_edge("auto_close", END); g.add_edge("human_review", END)
    return g.compile()

graph, results = build(route), {}
for fid in ["F1", "F2", "F3", "F4"]:
    out = graph.invoke({"finding_id": fid, "label": "", "attempts": 0, "labels_seen": []}, config={"recursion_limit": 10})
    results[fid] = (out["outcome"], out["attempts"])
    print(fid, "->", out["outcome"], "| labels:", out["labels_seen"])
assert results == {"F1": ("queued_for_human", 1), "F2": ("auto_closed", 2),
                   "F3": ("queued_for_human", 3), "F4": ("queued_for_human", 1)}

try:                                            # a buggy router that always retries
    build(lambda s: "retry").invoke({"finding_id": "F3", "label": "", "attempts": 0, "labels_seen": []},
                                    config={"recursion_limit": 5})
    raise AssertionError("should have stopped")
except RecursionError as e:
    print("guard:", e)
print("OK: safe default, bounded retries, recursion limit as last guard")
```

- `.strip().lower()` node mein -- "Low " aur "LOW" ek hi label ban jaate hain; router ko saaf data milta hai.
- `route` ka last line `return "human"` -- "CRITICAL!!" jaisa unknown label safe path pe gaya (F4). Default hamesha safest outcome ho.
- `attempts < MAX_ATTEMPTS` -- F3 teen baar "unclear" ke baad escalate hua; loop bounded hai.
- Buggy router (`lambda s: "retry"`) -- apna counter nahi dekhta, phir bhi `config={"recursion_limit": 5}` ne graph roka. Ye last guard hai, primary logic nahi.
- `_next` mein unknown key pe `ValueError` -- typo wala route silently kahin aur nahi jaata.

```python
# real version -- not run here, needs: pip install langgraph
from typing import Literal
from langgraph.graph import StateGraph, START, END
from langgraph.errors import GraphRecursionError


def route(state: S) -> Literal["retry", "auto", "human"]:     # type hint documents the keys
    ...

builder = StateGraph(S)
builder.add_node("classify", classify)
builder.add_node("auto_close", auto_close)
builder.add_node("human_review", human_review)
builder.add_edge(START, "classify")
builder.add_conditional_edges("classify", route, {"retry": "classify", "auto": "auto_close", "human": "human_review"})
builder.add_edge("auto_close", END)
builder.add_edge("human_review", END)
graph = builder.compile()
try:
    graph.invoke({"finding_id": "F3", "attempts": 0, "labels_seen": []}, config={"recursion_limit": 10})
except GraphRecursionError:
    ...  # log, alert, route the case to a human queue
```

Mapping optional hai (router seedha node name return kar sakta hai), aur `Command(goto=...)` se node khud bhi route kar sakta hai (M09-04) -- check the docs for your langgraph version.

### Mini-exercise (30-60 min)
`auditmesh/graph/nodes.py` mein `classify_finding` node aur `route_finding` router add karo.
- Labels: `critical | high | medium | low | unclear`; `critical/high -> human_approval`, `medium -> jira_ticket`, `low -> auto_close`, `unclear -> retry (max 2)`.
- Unknown label ya exception -> `human_approval` (safe default), aur `errors` list mein reason.
- Acceptance: parametrized pytest -- har label + "CRITICAL!!" + "" + `None` ka expected route; ek test jo recursion limit pe stop hota hai.

### Common pitfalls
- Router ke andar LLM call ya DB write -- router har step pe chalta hai, debug/trace mushkil, aur side effects duplicate. Kaam node mein karo.
- Default branch "auto_close" ya "approve" rakhna -- garbled output = unsafe action. Default = human ya reject.
- Retry loop sirf recursion limit ke bharose -- error pe poora run fail hota hai aur cost already lag chuki. Apna counter rakho.

### Checklist before moving on
- [ ] Router ko pure function rakhta hoon; LLM node mein.
- [ ] Har router ka safe default branch hai.
- [ ] Har loop ke liye state mein counter + max hai.
- [ ] `recursion_limit` config se set karta hoon aur `GraphRecursionError` handle karta hoon.

### Related
- M09-04 Supervisor and Router patterns
- M09-08 Compiling graphs
- M10-05 Detecting infinite ReAct loops
- M05-15 Managing hallucinated tool calls

### Self-quiz
1. Router ke andar LLM call karne mein kya problem hai? Kahan rakhoge?
2. Model ne label "Hgih" diya. Aapka router kahan bhejega, aur kyun?
3. Recursion limit ko primary loop guard kyun nahi maanna chahiye?
4. Mapping mein ek key ka typo hai. MiniGraph kya karta hai, aur silent fall-through kyun khatarnak hai?
