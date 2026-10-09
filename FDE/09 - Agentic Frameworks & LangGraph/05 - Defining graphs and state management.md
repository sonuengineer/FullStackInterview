# Agentic Frameworks & LangGraph

## Defining graphs and state management

> Core | Fast CP7 / Slow CP9 | ~1.2 h | Builds on: M09-01, M09-04, M05-07

### Kahani
Ek bank ki compliance team ka "audit bot" ek bada Python dict har function ko pass karta tha. Har function dict ko seedha mutate karta -- koi `findings` reset kar deta, koi `status` overwrite.
Ek din MFA check ki failure report se gayab ho gayi: log-retention check ne `findings = [its_own_result]` likh diya tha. Auditor ne poocha "step 3 ne state mein kya badla?" -- kisi ke paas jawab nahi tha.
Problem code ki nahi, **state ke contract** ki thi: kaun sa field kaun likhta hai, aur do updates milke kya bante hain -- ye kahin define hi nahi tha.

### What it is
LangGraph mein graph = **state schema** (ek TypedDict) + **nodes** (functions jo state padhke ek *partial update* return karte hain) + **edges**. Har field ka ek merge rule hota hai: default = overwrite (last writer wins), ya `Annotated[list, operator.add]` jaisa **reducer** jo purane aur naye value ko combine karta hai.

### Why it matters for an FDE
Customer ka auditor har step ka effect dekhna chahta hai. Typed state + reducers ke bina findings chup-chaap overwrite hote hain, aur parallel nodes (M09-09) ke saath ye bug random ho jaata hai.

### Key concepts
- **State schema** -- TypedDict jo graph ka shared "whiteboard" define karta hai; har field ka owner aur meaning clear.
- **Partial update** -- node poora state return nahi karta, sirf wo keys jo usne badli: `{"status": "failed"}`.
- **Reducer** -- `Annotated[list, operator.add]` = "naya value purane mein append karo"; bina reducer ke overwrite.
- **Snapshot in, update out** -- node ko state ki copy milti hai; mutate karna bug hai, return karna contract.
- **Superstep** -- ek step mein chalne wale saare nodes ek hi snapshot dekhte hain; updates step ke end mein merge hote hain.

### Code example
stdlib only

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
        self.nodes, self.edges = {}, {}

    def add_node(self, name, fn): self.nodes[name] = fn
    def add_edge(self, src, dst): self.edges.setdefault(src, []).append(dst)
    def compile(self): return self          # validation is the topic of M09-08

    def _apply(self, state, update):
        for k, v in (update or {}).items():
            state[k] = self.reducers[k](state.get(k, []), v) if k in self.reducers else v

    def invoke(self, state, config=None):
        limit, state, tasks, steps = (config or {}).get("recursion_limit", 25), dict(state), self.edges.get(START, []), 0
        while tasks := [t for t in tasks if t != END]:
            steps += 1
            if steps > limit: raise RecursionError(f"hit recursion_limit={limit}")
            snapshot = dict(state)                          # every node in a step sees the same snapshot
            for t in tasks: self._apply(state, self.nodes[t](dict(snapshot)))
            tasks = list(dict.fromkeys(n for t in tasks for n in self.edges.get(t, [])))
        return state


class AuditState(TypedDict):
    ticket_id: str
    status: str                                   # no reducer: last writer wins
    findings: Annotated[list, operator.add]       # reducer: updates are appended
    log: Annotated[list, operator.add]


def load(s): return {"status": "loaded", "log": ["load"]}
def check_mfa(s): return {"findings": [{"control": "MFA", "ok": False}], "log": ["check_mfa"]}
def check_logs(s): return {"findings": [{"control": "LOG-RET", "ok": True}], "log": ["check_logs"]}
def check_logs_buggy(s): return {"findings": s["findings"] + [{"control": "LOG-RET", "ok": True}]}
def summarise(s):
    failed = [f["control"] for f in s["findings"] if not f["ok"]]
    return {"status": "failed" if failed else "passed", "log": ["summarise"]}


def build(logs_node):
    g = MiniGraph(AuditState)
    for name, fn in [("load", load), ("check_mfa", check_mfa), ("check_logs", logs_node), ("summarise", summarise)]:
        g.add_node(name, fn)
    for a, b in [(START, "load"), ("load", "check_mfa"), ("check_mfa", "check_logs"),
                 ("check_logs", "summarise"), ("summarise", END)]:
        g.add_edge(a, b)
    return g.compile()


inp = {"ticket_id": "AUD-7", "findings": [], "log": []}
out = build(check_logs).invoke(inp)
print("status:", out["status"], "| findings:", [f["control"] for f in out["findings"]], "| log:", out["log"])
assert out["status"] == "failed" and len(out["findings"]) == 2
assert out["log"] == ["load", "check_mfa", "check_logs", "summarise"]
assert inp["findings"] == [], "caller's input must not be mutated"

bad = build(check_logs_buggy).invoke(inp)
print("buggy node findings:", [f["control"] for f in bad["findings"]])
assert [f["control"] for f in bad["findings"]] == ["MFA", "MFA", "LOG-RET"], "full list + reducer = duplicates"
print("OK: partial updates + reducers behave as expected")
```

- `get_type_hints(..., include_extras=True)` -- `Annotated` metadata padhke MiniGraph pata karta hai ki kis field ka reducer hai; real LangGraph bhi schema se yahi nikalta hai.
- `status` bina reducer -- `load` ne "loaded" likha, `summarise` ne "failed"; last writer wins.
- `findings` with `operator.add` -- har check sirf **apna** naya item return karta hai, reducer append karta hai.
- `check_logs_buggy` -- poori list + naya item return kiya, reducer ne usse phir append kiya -> MFA do baar. Reducer wali key pe hamesha sirf delta bhejo.
- `dict(snapshot)` -- node ko copy milti hai; input dict untouched rehta hai (last assert).

```python
# real version -- not run here, needs: pip install langgraph
import operator
from typing import Annotated, TypedDict
from langgraph.graph import StateGraph, START, END
from langgraph.graph.message import add_messages


class AuditState(TypedDict):
    ticket_id: str
    status: str
    findings: Annotated[list, operator.add]
    messages: Annotated[list, add_messages]     # appends, and updates a message with the same id


builder = StateGraph(AuditState)
for name, fn in [("load", load), ("check_mfa", check_mfa), ("check_logs", check_logs), ("summarise", summarise)]:
    builder.add_node(name, fn)
builder.add_edge(START, "load")
builder.add_edge("load", "check_mfa")
builder.add_edge("check_mfa", "check_logs")
builder.add_edge("check_logs", "summarise")
builder.add_edge("summarise", END)
graph = builder.compile()
out = graph.invoke({"ticket_id": "AUD-7", "findings": [], "messages": []}, config={"recursion_limit": 10})
```

LangGraph state schema TypedDict ke alawa Pydantic model ya dataclass bhi ho sakta hai, aur alag input/output schemas bhi -- details ke liye check the docs for your langgraph version.

### Mini-exercise (30-60 min)
Apne AuditMesh repo mein `auditmesh/graph/state.py` banao.
- `AuditState` TypedDict: `ticket_id`, `framework` (e.g. "SOC2"), `status`, `findings: Annotated[list, operator.add]`, `evidence: Annotated[list, operator.add]`, `next_worker: str`, `errors: Annotated[list, operator.add]`.
- Har field ke upar one-line comment: kaun sa node likhta hai, overwrite ya append.
- `Finding` ko Pydantic model banao (M05-07) aur ek `to_update(findings)` helper jo `{"findings": [f.model_dump() ...]}` return kare.
- Acceptance: pytest -- (a) do nodes ke findings append hote hain, (b) `status` overwrite hota hai, (c) ek test jo "full list return" bug ko duplicate count se pakadta hai.

### Common pitfalls
- Node ke andar `state["findings"].append(x)` -- shared object mutate; LangGraph mein ye update record hi nahi hota aur debugging nightmare banta hai. Hamesha return karo.
- Reducer wali key pe poori list return karna -- duplicates; aur bade lists ke saath state (aur checkpoint storage, M10-01) har step phoolta hai.
- State mein raw PII ya poore documents rakhna -- checkpoints aur traces mein permanently log ho jaata hai. IDs aur short summaries rakho, data apne store mein.

### Checklist before moving on
- [ ] TypedDict state with reducers bina dekhe likh sakta hoon.
- [ ] Overwrite vs reducer ka farak ek example se samjha sakta hoon.
- [ ] Node se sirf partial update (delta) return karta hoon.
- [ ] Superstep snapshot ka matlab samajhta hoon.

### Related
- M09-06 Creating nodes and edges
- M09-12 Handling state conflicts during concurrent node execution
- M10-01 Check-pointing graph states
- M05-07 Defining complex nested Pydantic models

### Self-quiz
1. `status` field pe reducer kyun nahi lagaya, aur `findings` pe kyun lagaya?
2. Ek node ne `{"findings": state["findings"] + [new]}` return kiya. Reducer ke saath kya hoga, bina reducer ke kya?
3. Node state ko mutate kare aur kuch return na kare -- ye galat kyun hai, chahe output sahi dikhe?
4. AuditMesh ke state mein poora evidence PDF text rakhna kyun bura idea hai?
