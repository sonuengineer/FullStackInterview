# Agentic Frameworks & LangGraph

## Defining agency

> Core | Fast CP7 / Slow CP9 | ~1.2 h | Builds on: M05-14, M05-15

### Kahani
Ek logistics customer ka CFO bola: "Humein invoice exceptions ke liye ek AI **agent** chahiye." Team ne autonomous agent banaya -- LLM khud decide karta tha kaunsa tool, kitni baar.
Demo shandaar tha. Production mein: har invoice pe 4-9 LLM calls, latency 3 s se 25 s, aur kabhi-kabhi agent same PO lookup baar-baar karta raha jab tak timeout nahi hua.
Phir kisi ne dhyan se dekha: har invoice ka process same tha -- classify, PO lookup, reply draft. Ek fixed **workflow** 2 LLM calls mein wahi kaam karta, predictable cost ke saath.
FDE ka pehla sawal "agent kaise banaye" nahi, "kitni agency chahiye" hai.

### What it is
**Agency** = kitna control flow LLM decide karta hai. Spectrum: single LLM call -> fixed workflow (code decides steps) -> router (LLM ek baar branch chunta hai) -> autonomous agent (LLM loop mein tools aur "kab rukna hai" khud chunta hai). Jitni zyada agency, utni flexibility -- aur utna hi cost, latency aur unpredictability.

### Why it matters for an FDE
Customer "agent" bolta hai, lekin unhe chahiye reliable outcome aur fixed bill. Galat level chunoge to ya flexibility kam (workflow jahan steps unknown hain) ya bill aur incidents zyada (agent jahan steps fixed hain).

### Key concepts
- **Single call** -- ek prompt, ek answer (summarise, extract); sabse sasta, sabse predictable.
- **Workflow** -- steps code mein fixed, LLM sirf steps ke andar; testable, cost bounded.
- **Router** -- LLM ek baar classify karke branch chunta hai; branches fixed (M09-04).
- **Autonomous agent** -- LLM loop: tool chuno, result dekho, phir chuno, khud "done" bolo; tab use karo jab steps pehle se pata hi na hon.
- **When NOT to build an agent** -- steps fixed hain, latency SLA tight hai, galti ki keemat badi hai (payments, deletes), ya audit trail chahiye -- workflow chuno, agency sirf jahan zaroori.

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

class FakeLLM:
    """Stand-in for client.messages.create(...); counts calls and rough tokens. No network."""
    def __init__(self, script=None): self.calls, self.tokens, self.script = 0, 0, list(script or [])
    def create(self, prompt):
        self.calls += 1; self.tokens += len(str(prompt)) // 4 + 50
        return self.script.pop(0) if self.script else {"text": "qty_mismatch"}
PO_DB = {"PO-881": {"qty": 100, "received": 90}}
def lookup_po(po): return PO_DB[po]
class S(TypedDict):
    po: str
    category: str
    facts: dict
    reply: str
    history: Annotated[list, operator.add]

def workflow(llm):                                  # code decides the steps
    g = MiniGraph(S)
    g.add_node("classify", lambda s: {"category": llm.create(f"classify {s['po']}")["text"]})
    g.add_node("lookup", lambda s: {"facts": lookup_po(s["po"])})
    g.add_node("draft", lambda s: {"reply": llm.create(f"reply for {s['category']} {s['facts']}")["text"]})
    for a, b in [(START, "classify"), ("classify", "lookup"), ("lookup", "draft"), ("draft", END)]: g.add_edge(a, b)
    return g.compile()
def agent(llm):                                     # LLM decides the steps, in a loop
    def think(s):
        out = llm.create(s["history"])
        return {"history": [out]} if "tool" in out else {"reply": out["text"], "history": [out]}
    def act(s):
        return {"history": [{"observation": lookup_po(s["history"][-1]["args"]["po"])}]}
    g = MiniGraph(S)
    g.add_node("think", think); g.add_node("act", act)
    g.add_edge(START, "think"); g.add_edge("act", "think")
    g.add_conditional_edges("think", lambda s: "done" if s.get("reply") else "act", {"act": "act", "done": END})
    return g.compile()

inp = {"po": "PO-881", "history": [{"user": "invoice for PO-881 says 100 units"}]}
wf_llm, ag_llm = FakeLLM([{"text": "qty_mismatch"}, {"text": "Billed 100, received 90."}]), FakeLLM(
    [{"tool": "lookup_po", "args": {"po": "PO-881"}}, {"tool": "lookup_po", "args": {"po": "PO-881"}},
     {"text": "Billed 100, received 90."}])
wf, ag = workflow(wf_llm).invoke(inp), agent(ag_llm).invoke(inp)
print(f"workflow: calls={wf_llm.calls} tokens~{wf_llm.tokens} | agent: calls={ag_llm.calls} tokens~{ag_llm.tokens}")
assert wf["reply"] == ag["reply"], "same answer"
assert wf_llm.calls < ag_llm.calls and wf_llm.tokens < ag_llm.tokens, "agency costs more"

looping = FakeLLM([{"tool": "lookup_po", "args": {"po": "PO-881"}}] * 50)    # agent that never says done
try:
    agent(looping).invoke(inp, config={"recursion_limit": 8}); raise AssertionError("should stop")
except RecursionError as e:
    print("looping agent stopped:", e, "| calls burned:", looping.calls)
print("OK: same task, workflow is cheaper and bounded; agent needs guards")
```

- `workflow()` -- edges fixed: classify -> lookup -> draft. Exactly 2 LLM calls, har invoice pe.
- `agent()` -- `think` node LLM se poochta hai "tool ya answer?", router `act` ya `END` chunta hai. Steps ki ginti LLM decide karta hai -- yahan usne PO do baar lookup kiya.
- Tokens -- agent har turn pe poori `history` bhejta hai, isliye tokens turn ke saath badhte hain (M05-04).
- `looping` -- model kabhi "done" nahi bolta; sirf recursion limit ne roka, tab tak 4 calls jal chuki. Agent = guards zaroori (M10-05).
- Dono ka answer same -- yahi point hai: jab steps fixed hain, agency sirf cost aur risk badhati hai.

```python
# real version -- not run here, needs: pip install langgraph langchain-anthropic
import os
from langgraph.graph import StateGraph, START, END
from langchain_anthropic import ChatAnthropic

llm = ChatAnthropic(model=os.environ["LLM_MODEL"])

def classify(s): return {"category": llm.invoke(f"Classify this invoice exception: {s['po']}").content}
def draft(s): return {"reply": llm.invoke(f"Draft a reply for {s['category']}: {s['facts']}").content}

builder = StateGraph(S)
builder.add_node("classify", classify)
builder.add_node("lookup", lambda s: {"facts": lookup_po(s["po"])})
builder.add_node("draft", draft)
builder.add_edge(START, "classify")
builder.add_edge("classify", "lookup")
builder.add_edge("lookup", "draft")
builder.add_edge("draft", END)
graph = builder.compile()
out = graph.invoke({"po": "PO-881", "history": []}, config={"recursion_limit": 10})
```

Agent version (tool-calling loop) M09-02 mein; LangGraph ke prebuilt agent helpers ka naam/location versions mein badla hai -- check the docs for your langgraph version.

### Mini-exercise (30-60 min)
AuditMesh ke liye ek `docs/agency-decision.md` + `auditmesh/graph/README.md` likho (apne repo mein).
- AuditMesh ke 5 kaam list karo (evidence collect, control check, finding classify, Jira ticket, human approval) aur har ek ko spectrum pe rakho: single call / workflow / router / agent -- ek line reason ke saath (cost, latency, cost of error).
- Ek kaam ko dono tarah implement karo (MiniGraph se): workflow aur agent; 20 sample inputs pe LLM calls aur tokens compare karo.
- Acceptance: table + numbers; Jira ticket aur approval kabhi "autonomous" nahi (irreversible side effect).

### Common pitfalls
- "Agent" by default -- fixed process ke liye bhi; 3-5x cost aur flaky latency bina fayde ke.
- Agent ko irreversible tools (refund, delete, ticket close) bina human approval ke dena -- cost of error unbounded (M10-04).
- Cost/latency ka estimate sirf happy path pe -- loop aur retries ke worst case ko SLA mein count karo (M16-03).

### Checklist before moving on
- [ ] Agency spectrum ke 4 levels ek-ek example ke saath bata sakta hoon.
- [ ] "Agent mat banao" ke 3 reasons customer ko samjha sakta hoon.
- [ ] Same task ka workflow vs agent cost compare kar sakta hoon.
- [ ] Har agent loop ke liye limit aur stop condition rakhta hoon.

### Related
- M05-14 Processing tool results into chat history
- M09-02 ReAct framework loops
- M09-04 Supervisor and Router patterns
- M16-03 Drafting latency and cost SLAs

### Self-quiz
1. Customer bolta hai "agent chahiye". Kaunse 3 sawal poochke aap decide karoge ki workflow kaafi hai?
2. Router aur autonomous agent mein exact farak kya hai -- control flow kaun decide karta hai?
3. Agent ke tokens har turn pe kyun badhte hain, workflow ke kyun nahi?
4. Ek kaam ka example do jahan agent sach mein zaroori hai, aur bataao kyun.
