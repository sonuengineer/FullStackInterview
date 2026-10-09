# Agentic Frameworks & LangGraph

## ReAct framework loops

> Core | Fast CP7 / Slow CP9 | ~1.2 h | Builds on: M09-01, M05-14, M05-15

### Kahani
Ek insurance customer ke vendor-risk team ka sawal: "Vendor V-77 ka SOC 2 report valid hai?" Steps pehle se fixed nahi -- pehle vendor record, phir report, kabhi contract bhi.
Pehle version mein tool error aate hi (galat vendor ID format) code exception phenk ke ruk jaata tha. User ko "Internal error" dikhta tha, jabki model khud ID theek kar sakta tha agar use error dikhta.
Doosre version mein errors model ko wapas bheje -- lekin limit nahi thi. Ek din model ek hi tool 30 baar call karta raha.
ReAct loop ka sahi version teen cheezein karta hai: observation wapas do, errors bhi, aur loop ko bound karo.

### What it is
**ReAct** (Reason + Act, 2022 paper) = loop: **Thought** (model sochta hai) -> **Action** (tool call) -> **Observation** (tool result wapas model ko) -> repeat jab tak model final answer na de. 2022 mein ye text format tha ("Action: search[query]") jise regex se parse karte the; aaj native **tool calling** (M05-11..14) wahi kaam structured `tool_use` / `tool_result` blocks se karta hai -- loop same, parsing ki fragility gayab.

### Why it matters for an FDE
Customer ke "agent" ka 80% yahi loop hai. Error ko observation banane se agent self-correct karta hai; max iterations aur give-up path ke bina wo bill aur latency dono uda deta hai.

### Key concepts
- **Agent node + tools node + conditional edge** -- LangGraph mein ReAct = 2 nodes ka cycle; router dekhta hai "tool_use hai ya final?"
- **Thought = text block, Action = tool_use, Observation = tool_result** -- modern APIs mein teeno structured.
- **Errors are observations** -- tool exception ko `is_error: true` tool_result banao; model next turn pe fix kar sakta hai.
- **Max iterations + give-up node** -- counter state mein; limit pe safe message + escalate, crash nahi.
- **Unknown tool name** -- hallucinated tool call bhi error observation (M05-15), execute kabhi nahi.

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

def call(i, name, **args): return {"type": "tool_use", "id": f"tu_{i}", "name": name, "input": args}
def say(text): return {"type": "text", "text": text}

class FakeLLM:                     # mimics client.messages.create(...); scripted ReAct run, no network
    def __init__(self, script): self.script, self.saw_error = script, False
    def create(self, messages, tools):
        self.saw_error |= any(isinstance(b, dict) and b.get("is_error") for b in messages[-1]["content"])
        content = self.script.pop(0)
        return {"stop_reason": "tool_use" if content[-1]["type"] == "tool_use" else "end_turn", "content": content}
VENDORS = {"V-077": {"soc2_expires": "2026-03-31"}}
def get_vendor(vendor_id):
    if vendor_id not in VENDORS: raise KeyError(f"unknown vendor {vendor_id!r}; ids look like V-077")
    return {"id": vendor_id, **VENDORS[vendor_id]}
TOOLS, MAX_ITER = {"get_vendor": get_vendor}, 6
class S(TypedDict):
    messages: Annotated[list, operator.add]
    iterations: int
    final: str

def build(llm):
    def agent(s):                                               # Thought + Action
        r = llm.create(s["messages"], tools=list(TOOLS))
        return {"messages": [{"role": "assistant", "content": r["content"]}], "iterations": s["iterations"] + 1,
                **({"final": r["content"][-1]["text"]} if r["stop_reason"] != "tool_use" else {})}
    def tools(s):                                               # Observation (errors included)
        results = []
        for b in (b for b in s["messages"][-1]["content"] if b["type"] == "tool_use"):
            try: out, err = str(TOOLS[b["name"]](**b["input"])), False
            except Exception as e: out, err = f"{type(e).__name__}: {e}", True
            results.append({"type": "tool_result", "tool_use_id": b["id"], "content": out, "is_error": err})
        return {"messages": [{"role": "user", "content": results}]}
    def route(s): return "done" if s.get("final") else "give_up" if s["iterations"] >= MAX_ITER else "tools"
    g = MiniGraph(S); g.add_node("agent", agent); g.add_node("tools", tools)
    g.add_node("give_up", lambda s: {"final": f"Stopped after {s['iterations']} steps; escalated to a human."})
    g.add_edge(START, "agent"); g.add_edge("tools", "agent"); g.add_edge("give_up", END)
    g.add_conditional_edges("agent", route, {"tools": "tools", "give_up": "give_up", "done": END})
    return g.compile()
q = {"messages": [{"role": "user", "content": "Is vendor V-77's SOC 2 report valid?"}], "iterations": 0}
llm = FakeLLM([[say("Thought: need the vendor record."), call(1, "get_vendor", vendor_id="V-77")],
               [say("Thought: error says ids look like V-077."), call(2, "get_vendor", vendor_id="V-077")],
               [say("V-077 SOC 2 report expired on 2026-03-31. Flag for review.")]])
out = build(llm).invoke(q)
for b in (b for m in out["messages"][1:] for b in m["content"]):
    print({"text": "THOUGHT", "tool_use": "ACTION", "tool_result": "OBSERVATION"}[b["type"]], b.get("text") or b.get("input") or b["content"])
assert llm.saw_error and "expired" in out["final"] and out["iterations"] == 3

stuck = FakeLLM([[say("Thought: again."), call(i, "get_vendor", vendor_id="V-077")] for i in range(9)])
out2 = build(stuck).invoke(q, config={"recursion_limit": 25})
print("stuck agent ->", out2["final"]); assert out2["iterations"] == MAX_ITER and "escalated" in out2["final"]
print("OK: errors fed back, model self-corrected, loop bounded")
```

- `call()` / `say()` -- FakeLLM wahi block shape return karta hai jo Anthropic Messages API: `text` (Thought) aur `tool_use` (Action).
- `tools` node -- exception ko `is_error: True` wala `tool_result` banata hai; `llm.saw_error` assert proof hai ki error sach mein model tak wapas gaya (self-correction ka base).
- `route` -- `final` hai to END, counter limit pe `give_up`, warna `tools`. Ye `MAX_ITER` aapka business guard hai; `recursion_limit` sirf framework backstop.
- Unknown tool name `TOOLS[b["name"]]` pe `KeyError` -> wo bhi error observation; hallucinated tool kabhi execute nahi hota.
- 2022 wala text ReAct ("Action: get_vendor[V-77]" + regex) aaj mat banao -- native tool calling ka structured output parse failures khatam karta hai; idea same hai.

```python
# real version -- not run here, needs: pip install langgraph langchain-anthropic
import os
from langchain_anthropic import ChatAnthropic
from langchain_core.tools import tool
from langgraph.graph import StateGraph, START, MessagesState
from langgraph.prebuilt import ToolNode, tools_condition

@tool
def get_vendor(vendor_id: str) -> dict:
    """Fetch a vendor record by id (format V-077)."""
    ...

llm = ChatAnthropic(model=os.environ["LLM_MODEL"]).bind_tools([get_vendor])

def agent(state: MessagesState):
    return {"messages": [llm.invoke(state["messages"])]}

builder = StateGraph(MessagesState)
builder.add_node("agent", agent)
builder.add_node("tools", ToolNode([get_vendor]))   # can turn tool errors into messages
builder.add_edge(START, "agent")
builder.add_conditional_edges("agent", tools_condition)          # -> "tools" or END
builder.add_edge("tools", "agent")
graph = builder.compile()
out = graph.invoke({"messages": [("user", "Is vendor V-77's SOC 2 report valid?")]},
                   config={"recursion_limit": 12})
```

`ToolNode` ka error handling option aur prebuilt ReAct agent helpers versions mein badle hain -- check the docs for your langgraph version.

### Mini-exercise (30-60 min)
`auditmesh/graph/nodes.py` mein `evidence_agent` ReAct subgraph: tools `list_policies`, `get_policy(policy_id)`, `get_access_log(system, days)` (fake data).
- Tool errors -> `is_error` observations; unknown tool -> error observation; `MAX_ITER` env var se.
- Give-up node `errors` list mein reason likhe aur supervisor ko wapas de (M09-04).
- Acceptance: pytest -- (a) galat ID ke baad model ka corrected call chalta hai, (b) looping script `MAX_ITER` pe rukta hai, (c) har run ka trace (Thought/Action/Observation) log hota hai -- bina PII ke.

### Common pitfalls
- Tool exception pe loop tod dena -- model ko kabhi pata nahi chalta kya galat tha; self-correction ka mauka gaya.
- Sirf `recursion_limit` pe bharosa -- run error ke saath marta hai, user ko kuch useful nahi milta. Apna give-up path do.
- Observation mein raw stack trace ya secrets bhejna -- model context aur logs mein leak. Short, safe error message bhejo.

### Checklist before moving on
- [ ] ReAct loop ko agent/tools/router graph ki tarah draw kar sakta hoon.
- [ ] Tool errors ko observation banake wapas bhejta hoon.
- [ ] Har loop ke liye max iterations + give-up node hai.
- [ ] Text-parsing ReAct aur native tool calling ka farak samjha sakta hoon.

### Related
- M05-14 Processing tool results into chat history
- M05-15 Managing hallucinated tool calls
- M09-03 Plan & Execute structures
- M10-05 Detecting infinite ReAct loops

### Self-quiz
1. ReAct ke Thought, Action, Observation modern tool-calling API mein kaun se blocks hain?
2. Tool error ko exception ki jagah observation banane se kya fayda hai? Kab ye galat hoga?
3. `MAX_ITER` aur `recursion_limit` dono kyun? Pehle kaunsa trigger hona chahiye?
4. 2022 ka text-format ReAct production mein kyun toot-ta tha?
