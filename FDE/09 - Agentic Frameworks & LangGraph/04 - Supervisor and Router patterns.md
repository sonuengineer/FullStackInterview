# Agentic Frameworks & LangGraph

## Supervisor and Router patterns

> Core | Fast CP7 / Slow CP9 | ~1.2 h | Builds on: M09-01, M09-02, M09-03

### Kahani
Ek healthcare SaaS customer ne ek "super agent" banaya tha: ek LLM, 14 tools -- evidence fetch, control check, Jira create, user disable, sab ek saath.
Ek din prompt injection wale document (M13-02) ko padhte waqt model ne `disable_user` call kar diya -- evidence padhne wale step ke paas wo tool hona hi nahi chahiye tha.
Saath hi 14 tools ki descriptions har call mein jaati thin -- tokens zyada, aur model galat tool chunta.
Fix: kaam ko chhote **workers** mein baanto, har worker ko sirf uske tools do, aur upar ek **supervisor** ya **router** rakho jo decide kare kaunsa worker chalega.

### What it is
**Router** = ek LLM call request ko classify karke **ek** worker pe bhejta hai, phir khatam (one-shot). **Supervisor** = ek LLM node loop mein baar-baar decide karta hai "ab kaunsa worker?" -- worker kaam karke supervisor ko wapas report karta hai, jab tak supervisor `FINISH` na bole. Dono mein **worker isolation**: har worker ka apna tool allow-list.

### Why it matters for an FDE
Multi-step compliance kaam (evidence -> check -> ticket) ke liye supervisor; simple request triage ke liye router -- sasta aur predictable. Worker isolation blast radius chhota karta hai: injected evidence worker Jira ya user-admin tools tak pahunch hi nahi sakta. AuditMesh (M16-06) isi supervisor pe bana hai.

### Key concepts
- **Router (one-shot)** -- 1 LLM call, 1 worker, END; jab request ka type hi kaam decide karta hai.
- **Supervisor (loop)** -- har worker ke baad wapas supervisor; multi-step, order runtime pe decide hota hai.
- **Worker isolation** -- har worker ka apna ToolBox; allow-list ke bahar call = `PermissionError`, execute nahi.
- **Validate the supervisor's choice** -- LLM ne non-existent worker bola to safe exit (human), crash ya guess nahi.
- **Bounded supervisor turns** -- max turns + recursion limit; supervisor bhi ek loop hai (M09-02).

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
    def _next(self, n, s):
        return [self.branches[n][1][self.branches[n][0](s)]] if n in self.branches else self.edges.get(n, [])
    def invoke(self, state, config=None):
        limit, state, tasks, steps = (config or {}).get("recursion_limit", 25), dict(state), self._next(START, state), 0
        while tasks := [t for t in tasks if t != END]:
            steps += 1
            if steps > limit: raise RecursionError(f"hit recursion_limit={limit}")
            snap = dict(state)
            for t in tasks:
                for k, v in (self.nodes[t](dict(snap)) or {}).items():
                    state[k] = self.reducers[k](state.get(k, []), v) if k in self.reducers else v
            tasks = list(dict.fromkeys(n for t in tasks for n in self._next(t, state)))
        return state

ALL_TOOLS = {"fetch_evidence": lambda v: [f"{v}: mfa_report.pdf"], "check_control": lambda ev: "fail",
             "create_ticket": lambda v: f"AUD-{len(v)}", "disable_user": lambda u: "disabled"}
class ToolBox:                                  # worker isolation: each worker sees only its tools
    def __init__(self, worker, allowed): self.worker, self.allowed = worker, set(allowed)
    def call(self, name, *args):
        if name not in self.allowed: raise PermissionError(f"{self.worker} may not call {name}")
        return ALL_TOOLS[name](*args)
BOXES = {w: ToolBox(w, [tool]) for w, tool in
         [("evidence_collector", "fetch_evidence"), ("control_checker", "check_control"), ("jira_writer", "create_ticket")]}
WORKERS = {"evidence_collector": lambda s, b: {"evidence": b.call("fetch_evidence", s["vendor"])},
           "control_checker": lambda s, b: {"verdict": b.call("check_control", s["evidence"])},
           "jira_writer": lambda s, b: {"ticket": b.call("create_ticket", s["vendor"])}}
class FakeLLM:                                  # stand-in for a structured "pick next worker" call
    def __init__(self): self.calls = 0
    def pick(self, s):
        self.calls += 1
        if s.get("force"): return s["force"]                        # simulate a hallucinated choice
        if not s.get("evidence"): return "evidence_collector"
        if not s.get("verdict"): return "control_checker"
        return "jira_writer" if s["verdict"] == "fail" and not s.get("ticket") else "FINISH"
class S(TypedDict):
    vendor: str
    evidence: list
    verdict: str
    ticket: str
    next: str
    trail: Annotated[list, operator.add]
def build(llm, mode):
    def supervisor(s):
        choice = llm.pick(s) if len(s["trail"]) < 6 else "FINISH"
        return {"next": choice if choice in WORKERS or choice == "FINISH" else "ESCALATE", "trail": [choice]}
    g = MiniGraph(S); g.add_node("supervisor", supervisor)
    for name, fn in WORKERS.items():
        g.add_node(name, lambda s, fn=fn, name=name: fn(s, BOXES[name]))
        g.add_edge(name, "supervisor" if mode == "supervisor" else END)   # loop back vs one-shot
    g.add_node("escalate", lambda s: {"ticket": "HUMAN-REVIEW"}); g.add_edge("escalate", END); g.add_edge(START, "supervisor")
    g.add_conditional_edges("supervisor", lambda s: s["next"], {**{w: w for w in WORKERS}, "FINISH": END, "ESCALATE": "escalate"})
    return g.compile()
sup_llm = FakeLLM()
out = build(sup_llm, "supervisor").invoke({"vendor": "acme", "trail": []}, config={"recursion_limit": 15})
print("supervisor trail:", out["trail"], "| ticket:", out["ticket"], "| llm calls:", sup_llm.calls)
assert out["trail"] == ["evidence_collector", "control_checker", "jira_writer", "FINISH"]
one = build(rt_llm := FakeLLM(), "router").invoke({"vendor": "acme", "trail": []})   # one-shot router
assert one["trail"] == ["evidence_collector"] and rt_llm.calls == 1 and "ticket" not in one
bad = build(FakeLLM(), "supervisor").invoke({"vendor": "acme", "trail": [], "force": "sql_admin"})
assert bad["ticket"] == "HUMAN-REVIEW", "unknown worker -> escalate, never guess"
try:
    BOXES["evidence_collector"].call("disable_user", "u1"); raise AssertionError("isolation broken")
except PermissionError as e:
    print("blocked:", e)
print("OK: supervisor loops, router is one-shot, workers isolated")
```

- `ToolBox` -- har worker ka allow-list; `evidence_collector` ne `disable_user` try kiya to `PermissionError` (Kahani wala incident yahan rukta).
- `mode` -- same workers, sirf edges alag: supervisor mode mein worker -> supervisor (loop), router mode mein worker -> END (one-shot).
- `supervisor` -- choice validate hoti hai; `sql_admin` jaisa hallucinated worker `ESCALATE` -> human review, kabhi guess nahi.
- `len(s["trail"]) < 6` -- supervisor turns bounded; `recursion_limit` backstop.
- LLM calls: supervisor 4 (3 workers + FINISH), router 1 -- supervisor flexible hai lekin har hop ek LLM call hai.

```python
# real version -- not run here, needs: pip install langgraph langchain-anthropic
import os
from typing import Literal
from pydantic import BaseModel
from langchain_anthropic import ChatAnthropic
from langgraph.graph import StateGraph, START, END
from langgraph.types import Command

class Route(BaseModel):
    next: Literal["evidence_collector", "control_checker", "jira_writer", "FINISH"]

picker = ChatAnthropic(model=os.environ["LLM_MODEL"]).with_structured_output(Route)

def supervisor(state: S) -> Command[Literal["evidence_collector", "control_checker", "jira_writer", "__end__"]]:
    choice = picker.invoke(f"Audit state: {summarise(state)}. Pick the next worker or FINISH.").next
    return Command(goto=END if choice == "FINISH" else choice, update={"trail": [choice]})

builder = StateGraph(S)
builder.add_node("supervisor", supervisor)
for name in ("evidence_collector", "control_checker", "jira_writer"):
    builder.add_node(name, make_worker(name))       # each worker binds ONLY its own tools
    builder.add_edge(name, "supervisor")
builder.add_edge(START, "supervisor")
graph = builder.compile()
out = graph.invoke({"vendor": "acme", "trail": []}, config={"recursion_limit": 15})
```

`Command(goto=...)` node se hi routing karta hai (conditional edges ka alternative); prebuilt supervisor helper libraries bhi hain -- check the docs for your langgraph version.

### Mini-exercise (30-60 min)
`auditmesh/graph/supervisor.py` banao -- ye AuditMesh ka core hai (M16-06 isi ko extend karega).
- Workers: `evidence_collector`, `control_checker`, `jira_writer` (abhi fake; real Jira MCP server M16-07), har ek `ToolBox` ke saath.
- Supervisor ka output Pydantic `Route` (Literal choices); unknown/invalid -> `human_approval` node.
- `jira_writer` se pehle hamesha `human_approval` (abhi stub; M10-03/M10-04 mein interrupt + checkpoint).
- Acceptance: pytest -- (a) happy path trail exact, (b) evidence worker ka `create_ticket` call `PermissionError`, (c) hallucinated worker -> human, (d) max 6 supervisor turns.

### Common pitfalls
- Ek agent ko saare tools dena -- prompt injection ka blast radius poora system; tokens aur galat-tool rate bhi badhte hain.
- Supervisor ki choice ko bina validate kiye `goto` karna -- typo/hallucination = crash ya galat worker.
- Har chhoti request pe supervisor -- 1-step kaam ke liye router (1 call) kaafi; supervisor har hop pe LLM cost aur latency jodta hai.

### Checklist before moving on
- [ ] Router aur supervisor ka farak graph edges se dikha sakta hoon.
- [ ] Har worker ko sirf uske tools deta hoon.
- [ ] Supervisor choice ko validate karke safe default rakhta hoon.
- [ ] Supervisor loop ko turns se bound karta hoon.

### Related
- M09-07 Conditional routing logic
- M09-10 Managing nested parent-child graph architectures
- M10-11 Standardizing tool access boundaries
- M16-06 Developing a LangGraph Multi-Agent Supervisor

### Self-quiz
1. Router aur supervisor mein LLM calls ki ginti kaise alag hoti hai? Ek example do jahan router kaafi hai.
2. Worker isolation prompt injection ka risk kaise kam karta hai? Kya ye poora solution hai?
3. Supervisor ne "sql_admin" worker bola jo exist nahi karta. Aapka graph kya karega aur kyun?
4. AuditMesh mein `jira_writer` se pehle human approval kyun hona chahiye?
