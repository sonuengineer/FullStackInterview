# Agentic Frameworks & LangGraph

## Compiling graphs

> Core | Fast CP7 / Slow CP9 | ~1.2 h | Builds on: M09-05, M09-06, M09-07

### Kahani
SaaS customer ke audit graph mein ek developer ne node rename kiya: `create_ticket` -> `create_jira_ticket`. Ek conditional mapping mein purana naam reh gaya.
Graph deploy hua, 95% cases theek chale -- sirf "medium" severity wale case us branch pe gaye aur 2 AM pe crash hue. On-call engineer ko stack trace mila "KeyError: create_ticket", customer ko adhoore audits.
Ye bug **build time** pe pakda ja sakta tha: graph ka shape (nodes, edges, mapping) run se pehle hi poora pata hota hai. Isi check ka naam hai `compile()`.

### What it is
`builder.compile()` builder (nodes + edges ka blueprint) ko ek **runnable graph** mein badalta hai -- aur pehle structure validate karta hai: edges unknown nodes pe to nahi, entry point hai ya nahi. Compile ke waqt hi runtime options judte hain: checkpointer (M10-01), interrupts (M10-03). Builder pe `invoke` nahi hota; compiled graph pe hota hai.

### Why it matters for an FDE
Customer prod mein "rare branch" crash sabse mehenga bug hai -- kam hota hai, isliye late pakda jaata hai. Compile ko app startup aur CI test mein chalao, taaki galat graph deploy hi na ho.

### Key concepts
- **Builder vs compiled graph** -- builder mutable blueprint; compiled graph runnable object jo `invoke/ainvoke/stream` deta hai.
- **Structural validation** -- unknown node names, missing entry point; MiniGraph aur bhi strict hai (unreachable nodes, no path to END).
- **Compile once, invoke many** -- startup pe ek baar compile; har request apna state/thread leke `invoke` kare.
- **Runtime config** -- `recursion_limit` (aur checkpointer ke saath `thread_id`) `config` dict mein, per invoke.
- **Graph as artifact** -- compiled graph ka diagram (Mermaid) customer review aur docs ke liye.

### Code example
stdlib only

```python
# runnable
from typing import TypedDict

START, END = "__start__", "__end__"
class GraphError(ValueError): pass


class MiniGraph:
    """MiniGraph -- mimics the LangGraph StateGraph API shape, for learning only (no reducers here)."""
    def __init__(self, schema): self.nodes, self.edges, self.branches = {}, {}, {}
    def add_node(self, name, fn): self.nodes[name] = fn
    def add_edge(self, src, dst): self.edges.setdefault(src, []).append(dst)
    def add_conditional_edges(self, src, router, mapping): self.branches[src] = (router, mapping)
    def _targets(self, n):
        return self.edges.get(n, []) + (list(self.branches[n][1].values()) if n in self.branches else [])

    def compile(self):
        named = {*self.edges, *self.branches} | {t for n in [START, *self.nodes] for t in self._targets(n)}
        if bad := named - set(self.nodes) - {START, END}: raise GraphError(f"unknown node(s): {sorted(bad)}")
        if not self._targets(START): raise GraphError("no entry point: add an edge from START")
        seen, todo = set(), [START]
        while todo:
            if (n := todo.pop()) not in seen: seen.add(n); todo += self._targets(n)
        if bad := set(self.nodes) - seen: raise GraphError(f"unreachable node(s): {sorted(bad)}")
        can_end, changed = {END}, True
        while changed:                                   # which nodes can still reach END?
            changed = False
            for n in [START, *self.nodes]:
                if n not in can_end and set(self._targets(n)) & can_end: can_end.add(n); changed = True
        if stuck := sorted(seen - can_end): raise GraphError(f"no path to END from: {stuck}")
        return Compiled(self)


class Compiled:
    def __init__(self, g): self.g = g
    def _next(self, n, state):
        if n not in self.g.branches: return self.g.edges.get(n, [])
        router, mapping = self.g.branches[n]
        return [mapping[router(state)]]
    def invoke(self, state, config=None):
        limit, state, steps = (config or {}).get("recursion_limit", 25), dict(state), 0
        tasks = self._next(START, state)
        while tasks := [t for t in tasks if t != END]:
            steps += 1
            if steps > limit: raise RecursionError(f"hit recursion_limit={limit}")
            snapshot = dict(state)
            for t in tasks: state.update(self.g.nodes[t](dict(snapshot)) or {})
            tasks = list(dict.fromkeys(n for t in tasks for n in self._next(t, state)))
        return state


class S(TypedDict):
    count: int

def make(edges, cond=None, names=("a", "b")):
    g = MiniGraph(S)
    for n in names: g.add_node(n, lambda s: {"count": s["count"] + 1})
    for src, dst in edges: g.add_edge(src, dst)
    if cond: g.add_conditional_edges("a", lambda s: "again" if s["count"] < 3 else "done", cond)
    return g

broken = {
    "typo in edge": (make([(START, "a"), ("a", "bb"), ("b", END)]), "unknown node(s): ['bb']"),
    "no entry": (make([("a", "b"), ("b", END)]), "no entry point"),
    "orphans": (make([(START, "a"), ("a", END), ("b", "c"), ("c", END)], names="abc"), "unreachable"),
    "loop, no exit": (make([(START, "a"), ("a", "b"), ("b", "a")]), "no path to END"),
    "stale mapping": (make([(START, "a"), ("b", "a")], {"again": "create_ticket", "done": END}), "create_ticket"),
}
for name, (builder, expected) in broken.items():
    try:
        builder.compile(); raise AssertionError(f"{name}: should not compile")
    except GraphError as e:
        assert expected in str(e), (name, e); print(f"{name:14} -> {e}")

ok = make([(START, "a"), ("b", "a")], {"again": "b", "done": END})
graph = ok.compile()                                   # compile once at startup
assert not hasattr(ok, "invoke"), "builders are blueprints, not runnables"
for _ in range(3):                                     # invoke many times, state is per call
    assert graph.invoke({"count": 0}, config={"recursion_limit": 10})["count"] == 3
print("OK: broken graphs rejected at build time, valid graph compiled once and reused")
```

- `named - set(self.nodes)` -- edges/mapping mein jo bhi naam hai wo registered node hona chahiye; Kahani wala "stale mapping" yahin pakda gaya, run se pehle.
- `seen` (forward reachability) -- orphan nodes ka matlab aksar ek bhooli hui edge hai.
- `can_end` loop -- har reachable node se END tak koi raasta; "loop, no exit" wala graph kabhi khatam nahi hota.
- `Compiled` alag class -- builder pe `invoke` nahi; runtime (`config`, recursion limit) sirf compiled graph pe.
- Real LangGraph ke exact checks MiniGraph se kam/alag ho sakte hain (e.g. unreachable nodes pe shayad error na de) -- isliye apna graph-shape test bhi likho.

```python
# real version -- not run here, needs: pip install langgraph
from langgraph.graph import StateGraph, START, END
from langgraph.checkpoint.memory import InMemorySaver   # older versions: MemorySaver

builder = StateGraph(AuditState)
# ... add_node / add_edge / add_conditional_edges ...
graph = builder.compile(
    checkpointer=InMemorySaver(),                 # dev only; use a durable saver in prod (M10-01)
    interrupt_before=["create_jira_ticket"],      # pause for human approval (M10-03)
)
print(graph.get_graph().draw_mermaid())
out = graph.invoke(
    {"ticket_id": "AUD-7", "findings": []},
    config={"configurable": {"thread_id": "AUD-7"}, "recursion_limit": 25},
)
```

Unknown node ya missing entry point pe real `compile()` `ValueError` deta hai; exact checks aur messages version ke saath badalte hain -- check the docs for your langgraph version.

### Mini-exercise (30-60 min)
AuditMesh repo mein `auditmesh/graph/build.py`: `build_graph(checkpointer=None)` jo M09-05/06/07 ke state, nodes aur routers jodke compiled graph return kare.
- App startup pe ek baar compile (module-level ya FastAPI lifespan), har request pe sirf `invoke`.
- `tests/test_graph_shape.py`: (a) compile pass, (b) expected node names ka set exact match, (c) har conditional mapping ki har value ek real node ya END hai, (d) Mermaid output `docs/graph.md` mein likho aur CI mein diff check.
- Acceptance: kisi node ka naam badlo -> test fail hona chahiye, prod nahi.

### Common pitfalls
- Har request pe `builder.compile()` -- bekaar CPU, aur agar checkpointer bhi har baar naya bana to memory/threads gayab.
- Ye maanna ki compile = poora correctness check -- router galat key return kare to wo sirf runtime pe dikhega. Router unit tests alag likho (M09-07).
- Prod mein `InMemorySaver` -- restart pe saare paused HITL approvals lost. Durable checkpointer use karo.

### Checklist before moving on
- [ ] Builder aur compiled graph ka farak bata sakta hoon.
- [ ] Compile ko startup + CI test mein chalata hoon.
- [ ] `config` mein `recursion_limit` (aur `thread_id`) pass karta hoon.
- [ ] Graph ka Mermaid diagram generate karke customer ko dikha sakta hoon.

### Related
- M09-07 Conditional routing logic
- M10-01 Check-pointing graph states
- M10-03 Interrupting graph execution
- M16-06 Developing a LangGraph Multi-Agent Supervisor

### Self-quiz
1. Kahani wala stale mapping bug compile pe kyun pakda ja sakta hai, lekin router ka galat return value kyun nahi?
2. Har request pe graph compile karne mein kya nuksaan hai?
3. "no path to END" aur "unreachable node" mein farak kya hai? Dono ka ek example do.
4. Checkpointer compile pe kyun diya jaata hai, invoke pe kyun nahi?
