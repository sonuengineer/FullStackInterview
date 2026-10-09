# Agentic Frameworks & LangGraph

## Plan & Execute structures

> Core | Fast CP7 / Slow CP9 | ~1.2 h | Builds on: M09-02, M05-07, M05-09

### Kahani
Ek bank ki internal audit team ka kaam: "S3 data retention policy ke against actual access logs check karo." ReAct agent se karwaya -- har step pe ek LLM call, 7 steps = 7 calls, aur beech mein model kabhi raasta bhool ke policy dobara fetch karta.
Auditor ka sawal bhi tha: "Agent ne kya karne ka plan kiya tha? Mujhe run se **pehle** dikhao." ReAct mein plan kahin likha hi nahi hota -- wo har turn pe ban-ta hai.
Aur jab log API down hui, agent ne poora kaam chhod diya, jabki archive logs ek valid alternative the.
Plan & Execute isi ke liye hai: pehle ek reviewable plan, phir sasta execution, aur failure pe sirf baaki hissa replan.

### What it is
**Plan & Execute** = (1) **planner** LLM ek structured plan deta hai (steps ki list), jise code **validate** karta hai; (2) **executor** steps ek-ek karke chalata hai (aksar bina LLM ke, ya chhote model se); (3) step fail ho to **replanner** sirf bache hue kaam ka naya plan deta hai. ReAct "har step pe socho", Plan & Execute "ek baar socho, phir karo".

### Why it matters for an FDE
Regulated customers (bank, hospital) ko run se pehle plan approve karna hota hai (HITL, M10-04). Validated plan galat/khatarnak tools ko execution se pehle hi rok deta hai, aur LLM calls kam hone se cost predictable hoti hai.

### Key concepts
- **Plan as data** -- Pydantic `Plan(steps: list[Step])`; allowed tools `Literal[...]` se, max steps, unique ids -- validate before run.
- **Retry with feedback** -- invalid plan pe validation error planner ko wapas (M05-09), limited attempts.
- **Executor is mostly code** -- steps deterministic tools chalate hain; LLM calls sirf plan aur replan pe.
- **Replan on failure** -- poora restart nahi; jo ho gaya wo results mein rehta hai, naya plan sirf remaining ka.
- **vs ReAct** -- ReAct adaptive hai (har observation pe faisla); Plan & Execute sasta, auditable, lekin naye info pe tabhi badalta hai jab replan ho.

### Code example
`pip install pydantic`

> Needs API key for the real version: ANTHROPIC_API_KEY (or OPENAI_API_KEY)

```python
# runnable
import json, operator
from typing import Annotated, Literal, TypedDict, get_args, get_origin, get_type_hints
from pydantic import BaseModel, Field, ValidationError, model_validator
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

class Step(BaseModel):
    id: int
    tool: Literal["fetch_policy", "fetch_access_log", "fetch_archive_log", "compare"]   # allow-list
class Plan(BaseModel):
    steps: list[Step] = Field(min_length=1, max_length=6)
    @model_validator(mode="after")
    def unique_ids(self):
        if len({s.id for s in self.steps}) != len(self.steps): raise ValueError("duplicate step ids")
        return self
def plan_json(*tools): return json.dumps({"steps": [{"id": i, "tool": t} for i, t in enumerate(tools, 1)]})
class FakeLLM:                      # mimics a structured-output call; scripted, no network
    def __init__(self, script): self.script, self.calls = script, 0
    def create(self, prompt): self.calls += 1; return self.script.pop(0)
def fetch_access_log(results): raise ConnectionError("access-log API down")
TOOLS = {"fetch_policy": lambda r: {"retention_days": 90}, "fetch_access_log": fetch_access_log,
         "fetch_archive_log": lambda r: {"oldest_log_days": 45},
         "compare": lambda r: {"compliant": r[-1]["oldest_log_days"] >= r[0]["retention_days"]}}
class S(TypedDict):
    plan: list
    cursor: int
    results: Annotated[list, operator.add]
    failed: str
    replans: int
def build(llm):
    def get_plan(prompt):
        for _ in range(2):                                            # retry with validation feedback
            try: return [s.model_dump() for s in Plan.model_validate_json(llm.create(prompt)).steps]
            except ValidationError as e: prompt += f"\nYour last plan was invalid: {e.errors()[0]['msg']}"
        raise RuntimeError("planner kept producing invalid plans")
    def planner(s): return {"plan": get_plan("Plan: check S3 retention vs logs"), "cursor": 0}
    def executor(s):
        step = s["plan"][s["cursor"]]
        try: return {"results": [TOOLS[step["tool"]](s["results"])], "cursor": s["cursor"] + 1}
        except Exception as e: return {"failed": f"step {step['id']} {step['tool']}: {e}"}
    def replanner(s):
        return {"plan": get_plan(f"Failed: {s['failed']}. Done: {s['results']}. Plan the rest."),
                "cursor": 0, "failed": "", "replans": s["replans"] + 1}
    def route(s):                       # failed -> replan once; more steps -> execute; else stop
        return ("replan" if s["replans"] < 1 else "stop") if s["failed"] else "execute" if s["cursor"] < len(s["plan"]) else "stop"
    g = MiniGraph(S); g.add_node("planner", planner); g.add_node("executor", executor); g.add_node("replanner", replanner)
    g.add_edge(START, "planner"); g.add_edge("planner", "executor"); g.add_edge("replanner", "executor")
    g.add_conditional_edges("executor", route, {"execute": "executor", "replan": "replanner", "stop": END})
    return g.compile()
llm = FakeLLM([plan_json("fetch_policy", "delete_bucket"),                        # rejected by allow-list
               plan_json("fetch_policy", "fetch_access_log", "compare"),          # valid first plan
               plan_json("fetch_archive_log", "compare")])                        # replan after failure
out = build(llm).invoke({"plan": [], "cursor": 0, "results": [], "failed": "", "replans": 0})
print("results:", out["results"], "| llm calls:", llm.calls)
assert out["results"][-1] == {"compliant": False} and out["replans"] == 1 and llm.calls == 3  # 2 plan tries + 1 replan
print("OK: validated plan, cheap execution, replan only the remaining work")
```

- `Step.tool: Literal[...]` -- allow-list; planner ka `delete_bucket` validation pe hi reject, kabhi execute nahi hua.
- `get_plan` -- invalid plan pe error message prompt mein jodke ek retry (M05-09); 2 baar fail = clear error.
- `executor` -- koi LLM call nahi; sirf plan ka next step. Failure `failed` mein, exception graph nahi todta.
- `replanner` -- results rakhta hai, sirf "archive log + compare" ka naya plan; `replans < 1` replan ko bhi bound karta hai.
- `llm.calls == 3` -- 4 tool steps ke liye; ReAct mein har step + final = 5+ calls, aur plan kabhi reviewable form mein nahi hota.

```python
# real version -- not run here, needs: pip install langgraph langchain-anthropic
import os
from langchain_anthropic import ChatAnthropic
from langgraph.graph import StateGraph, START, END

planner_llm = ChatAnthropic(model=os.environ["LLM_MODEL"]).with_structured_output(Plan)

def planner(state: S):
    plan = planner_llm.invoke("Plan: check S3 retention vs access logs. Allowed tools: ...")
    return {"plan": [s.model_dump() for s in plan.steps], "cursor": 0}

builder = StateGraph(S)
builder.add_node("planner", planner)
builder.add_node("executor", executor)
builder.add_node("replanner", replanner)
builder.add_edge(START, "planner")
builder.add_edge("planner", "executor")
builder.add_edge("replanner", "executor")
builder.add_conditional_edges("executor", route, {"execute": "executor", "replan": "replanner", "stop": END})
graph = builder.compile()
out = graph.invoke({"plan": [], "cursor": 0, "results": [], "failed": "", "replans": 0},
                   config={"recursion_limit": 20})
```

Structured output helper (`with_structured_output`) ka exact behaviour model/provider pe depend karta hai -- check the docs for your langgraph / langchain version.

### Mini-exercise (30-60 min)
AuditMesh `auditmesh/graph/planner.py`: compliance request ("SOC 2 CC6.1 for vendor X") -> validated `AuditPlan`.
- `Step` mein `tool: Literal[...]` (sirf read-only evidence tools), `depends_on: list[int]` jo sirf pehle ke ids ko point kare (validator).
- Plan ko `docs/sample-plan.json` mein dump karo -- ye wahi cheez hai jo M10-04 mein human approve karega.
- Acceptance: pytest -- (a) disallowed tool wala plan reject, (b) forward `depends_on` reject, (c) step 2 fail -> replan sirf remaining steps, (d) LLM call count assert.

### Common pitfalls
- Plan ko free text rakhna ("1. fetch policy 2. ...") aur regex se parse karna -- wahi 2022 ReAct wali fragility. Structured output + Pydantic use karo.
- Executor ke andar har step pe LLM se "next kya?" poochna -- ye phir se ReAct ban gaya, cost ka fayda gaya.
- Replan ka koi limit nahi -- failing dependency pe infinite replan loop. Counter rakho, phir human ko escalate.

### Checklist before moving on
- [ ] Plan ko Pydantic model ki tarah define aur validate kar sakta hoon.
- [ ] Planner / executor / replanner ka graph draw kar sakta hoon.
- [ ] ReAct vs Plan & Execute -- kab kaunsa, cost aur adaptivity ke terms mein bata sakta hoon.
- [ ] Replan ko bound karta hoon aur completed results nahi khota.

### Related
- M09-02 ReAct framework loops
- M05-09 Handling and retrying output parsing errors gracefully
- M10-04 Requesting manual state approval
- M09-11 Aggregating parallel outputs with map-reduce patterns

### Self-quiz
1. Plan & Execute ReAct se sasta kyun hai? Kis situation mein ReAct better rahega?
2. Planner ne `delete_bucket` step diya. Aapke code mein ye kahan aur kaise rukta hai?
3. Replanner ko poore plan ki jagah sirf remaining steps kyun plan karne chahiye?
4. Customer ka auditor run se pehle plan dekhna chahta hai. Is architecture mein wo hook kahan lagega?
