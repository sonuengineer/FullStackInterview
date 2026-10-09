# Agentic Frameworks & LangGraph

## Creating nodes and edges

> Core | Fast CP7 / Slow CP9 | ~1.2 h | Builds on: M09-05

### Kahani
Logistics customer ke vendor-audit graph mein do checks parallel the: `check_mfa` (1 step) aur `check_logs` -> `check_logs_deep` (2 steps). Dono ke baad `report` node Jira mein summary ticket banata tha.
Pehle hi din Jira mein har vendor ke **do** report tickets aaye -- ek adhoora (deep log check ke bina), ek poora. Customer ka compliance head khush nahi tha.
Bug ek line ka tha: `report` ke do alag edges the, to wo har predecessor ke khatam hone pe ek baar chala. Use "dono ka wait karo" wala join chahiye tha.

### What it is
**Node** = ek function `state -> partial update` (LLM call, tool call, ya plain Python). **Edge** = "ye node khatam ho to agla kaun". Ek source se do edges = **fan-out** (parallel, same superstep). Kai sources se ek target = **fan-in**; LangGraph mein `add_edge(["a", "b"], "c")` ka matlab hai "a AUR b dono ke baad c ek baar".

### Why it matters for an FDE
Graph ka shape hi side effects ki ginti decide karta hai -- galat fan-in = duplicate Jira tickets, duplicate emails, double LLM cost. Ye bug unit tests mein nahi, real data ke uneven branches pe dikhta hai.

### Key concepts
- **Node = small, single-purpose function** -- ek kaam (classify, fetch, write); naam verb-style (`check_mfa`), taaki trace padhne layak ho.
- **Normal edge** -- fixed transition; `START` se entry, `END` pe exit.
- **Fan-out** -- ek node ke kai outgoing edges; targets agle superstep mein saath chalte hain.
- **Fan-in trigger vs join** -- alag-alag edges = har predecessor pe trigger; list-source edge = sab ka wait.
- **Side-effect nodes last** -- Jira/email jaise irreversible kaam ek hi jagah, join ke baad.

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
        self.nodes, self.edges, self.joins = {}, {}, {}

    def add_node(self, name, fn): self.nodes[name] = fn
    def add_edge(self, src, dst):
        if isinstance(src, list): self.joins[dst] = set(src)       # join: wait for ALL sources
        else: self.edges.setdefault(src, []).append(dst)
    def compile(self): return self                                  # validation: M09-08

    def invoke(self, state, config=None):
        limit, state, tasks, done, self.trace = (config or {}).get("recursion_limit", 25), dict(state), self.edges.get(START, []), set(), []
        while tasks := [t for t in tasks if t != END]:
            if len(self.trace) >= limit: raise RecursionError(f"hit recursion_limit={limit}")
            self.trace.append(tasks)
            snapshot = dict(state)
            for t in tasks:
                for k, v in (self.nodes[t](dict(snapshot)) or {}).items():
                    state[k] = self.reducers[k](state.get(k, []), v) if k in self.reducers else v
            done |= set(tasks)
            nxt = [n for t in tasks for n in self.edges.get(t, [])]
            for dst, srcs in self.joins.items():
                if srcs <= done and srcs & set(tasks): nxt.append(dst); done -= srcs
            tasks = list(dict.fromkeys(nxt))
        return state


class S(TypedDict):
    vendor: str
    findings: Annotated[list, operator.add]
    tickets: Annotated[list, operator.add]


def fake_jira_create(summary):                     # stand-in for a real Jira client call
    return f"AUD-{sum(map(ord, summary)) % 900 + 100}"

def load(s): return {}
def check_mfa(s): return {"findings": ["MFA: missing on 2 admin accounts"]}
def check_logs(s): return {"findings": ["LOGS: retention 30d"]}
def check_logs_deep(s): return {"findings": ["LOGS: no tamper protection"]}
def report(s): return {"tickets": [(fake_jira_create(s["vendor"]), len(s["findings"]))]}


def build(use_join):
    g = MiniGraph(S)
    for fn in (load, check_mfa, check_logs, check_logs_deep, report):
        g.add_node(fn.__name__, fn)
    g.add_edge(START, "load")
    g.add_edge("load", "check_mfa"); g.add_edge("load", "check_logs")          # fan-out
    g.add_edge("check_logs", "check_logs_deep")
    if use_join: g.add_edge(["check_mfa", "check_logs_deep"], "report")         # fan-in join
    else: g.add_edge("check_mfa", "report"); g.add_edge("check_logs_deep", "report")
    g.add_edge("report", END)
    return g.compile()


for use_join in (False, True):
    g = build(use_join)
    out = g.invoke({"vendor": "acme-logistics", "findings": [], "tickets": []})
    print("join" if use_join else "two edges", "-> steps:", g.trace, "| tickets:", out["tickets"])

bad, good = build(False), build(True)
bad_out = bad.invoke({"vendor": "v1", "findings": [], "tickets": []})
good_out = good.invoke({"vendor": "v1", "findings": [], "tickets": []})
assert len(bad_out["tickets"]) == 2 and bad_out["tickets"][0][1] == 2, "first ticket was incomplete"
assert len(good_out["tickets"]) == 1 and good_out["tickets"][0][1] == 3
assert good.trace[1] == ["check_mfa", "check_logs"], "fan-out runs in the same superstep"
print("OK: join fires report once, after all findings exist")
```

- `g.trace` -- har superstep mein kaun se nodes chale; step 2 mein `check_mfa` aur `check_logs` saath (fan-out).
- Two-edges version: step 3 mein `report` already chal gaya (sirf 2 findings ke saath), step 4 mein dobara -- 2 tickets.
- `add_edge([...], "report")` -- MiniGraph `done` set track karta hai; dono sources khatam hone pe hi `report` schedule hota hai.
- `fake_jira_create` -- side effect node ke andar; isliye shape galat = duplicate side effects. M14-01 idempotency keys yahan second safety net hain.

```python
# real version -- not run here, needs: pip install langgraph
from langgraph.graph import StateGraph, START, END

builder = StateGraph(S)
for fn in (load, check_mfa, check_logs, check_logs_deep, report):
    builder.add_node(fn.__name__, fn)          # node name defaults to the function name if omitted
builder.add_edge(START, "load")
builder.add_edge("load", "check_mfa")
builder.add_edge("load", "check_logs")
builder.add_edge("check_logs", "check_logs_deep")
builder.add_edge(["check_mfa", "check_logs_deep"], "report")   # waits for both
builder.add_edge("report", END)
graph = builder.compile()
print(graph.get_graph().draw_mermaid())        # paste into a Mermaid viewer to see the shape
```

Newer versions mein linear chains ke liye `add_sequence` jaise helpers bhi hain -- check the docs for your langgraph version.

### Mini-exercise (30-60 min)
`auditmesh/graph/nodes.py` banao (state M09-05 wala `auditmesh/graph/state.py`).
- Nodes: `load_ticket`, `collect_evidence`, `check_controls`, `draft_report`, `create_jira_ticket` (abhi fake client; real MCP Jira server M16-07 mein).
- Har node pure function: input state, output partial dict; koi global mutation nahi.
- `collect_evidence` aur `check_controls` parallel, `draft_report` join se.
- Acceptance: pytest -- (a) `create_jira_ticket` exactly ek baar chalta hai, (b) trace mein dono parallel nodes same step mein hain, (c) draw_mermaid / apna text diagram README mein.

### Common pitfalls
- Fan-in ke liye alag-alag edges jab branches uneven hon -- downstream node kai baar chalta hai. Join (list source) use karo.
- Ek giant node jo LLM call + tool call + Jira write sab kare -- retry, trace aur HITL (M10-03) sab mushkil. Chhote nodes banao.
- Side-effect node ko bina idempotency key ke chalana -- retries pe duplicate tickets (M14-01).

### Checklist before moving on
- [ ] Node ko `state -> partial update` function ki tarah likhta hoon.
- [ ] Fan-out aur join ka farak trace se dikha sakta hoon.
- [ ] Side-effect nodes ko graph ke end pe, ek jagah rakhta hoon.

### Related
- M09-05 Defining graphs and state management
- M09-07 Conditional routing logic
- M09-09 Running agent tasks concurrently using async execution
- M14-01 Idempotency keys for safe tool execution

### Self-quiz
1. `report` ke do alag incoming edges hain aur branches ki length alag hai. Kitni baar chalega, aur kyun?
2. Fan-out branches ek hi snapshot kyun dekhti hain? Isse kya fayda aur kya limitation hai?
3. Jira ticket banane wala kaam ek alag node mein kyun hona chahiye, LLM node ke andar kyun nahi?
