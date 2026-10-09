# AuditMesh - Multi-Agent Compliance System

## Developing a LangGraph Multi-Agent Supervisor

> Core | Fast CP8 / Slow CP10 | ~1.2 h | Builds on: M09-04, M09-05, M09-07, M09-08, M09-11, M10-01, M10-03, M10-04, M10-05

### Kahani
Ab AuditMesh ka dil banana hai: ek **supervisor** jo Kavach ke quarterly review ke kaam ko sahi agent ko de -- evidence collector, policy checker, ticket writer, reporter.
Pilot ke dauraan ek bug aaya: policy checker ko ek corrupt export mila, woh baar baar "need more data" bolta raha, supervisor use baar baar bhejta raha -- 40 minute aur USD 30 ke tokens, phir timeout.
Doosra bug zyada dangerous tha: ek task type `file_ticket` ka spelling galat aaya aur supervisor ne use "closest" worker ko de diya.
Meera ki condition: "Mujhe proof chahiye ki agent kabhi bina approval ke ticket nahi banata aur kabhi loop mein nahi phansta." Woh proof ek acceptance harness hai -- aapka graph aap likhoge.

### What it is
**Multi-agent supervisor** = ek LangGraph graph jismein ek supervisor node state dekh ke conditional edge se next worker chunta hai, workers result state mein likhte hain, aur graph approval pe interrupt hota hai.
Is lesson mein aap supervisor ka **contract** fix karte ho aur use test karne wala harness banate ho; implementation aapke capstone repo mein.

### Why it matters for an FDE
Multi-agent demo 10 min mein ban jaata hai; production mein woh loop, galat routing aur bina approval ke action se fail hota hai. Harness hi customer ko dikhata hai ki ye teen cheezein nahi hongi.

### Key concepts
- **Pieces you already have** -- supervisor/router pattern (M09-04), typed state (M09-05), conditional edges (M09-07), compile with checkpointer (M09-08, M10-01), parallel evidence collection via map-reduce (M09-11).
- **Approval as interrupt** -- `ticket_writer` se pehle `human_approval` node interrupt karta hai (M10-03), decision approval API se aata hai (M10-04, M16-09).
- **Step cap** -- `recursion_limit` + loop detection (M10-05); limit hit = status `step_limit`, crash nahi.
- **Unknown = human** -- unknown task type kabhi "closest worker" ko nahi; `human_triage` pe jaata hai.
- **Harness contract** -- `run(task, step_limit) -> {"trace": [node names], "status": ...}`; ek chhota adapter aapke graph ko is shape mein laata hai.

```text
 trigger (quarterly run / on demand)
    v
 [supervisor] --task.type--> evidence_collector | policy_checker | reporter   (results back into state)
    |-- file_ticket --> [human_approval: interrupt] --approved--> ticket_writer --MCP--> Jira (M16-07)
    |                                                --rejected--> end (status rejected, reason logged)
    |-- unknown -----> human_triage (status needs_human)
 checkpointer saves state after every step; recursion_limit caps total steps
```

Request flow: trigger -> supervisor reads `task.type` -> worker updates state -> supervisor decides again -> approval interrupt (graph paused, checkpoint saved) -> approval API resumes -> ticket writer -> report.
Failure list the harness covers: wrong routing, worker leakage (do workers ek task pe), unknown type auto-routed, ticket without approval, ticket after reject, runaway loop. Not covered here: checkpoint resume after crash (add a test with your checkpointer), parallel fan-out conflicts (M09-12).

### Code example
stdlib only (the real adapter below needs `pip install langgraph`)

```python
# runnable
import importlib, os

ROUTES = {"collect_evidence": "evidence_collector", "policy_check": "policy_checker",
          "file_ticket": "ticket_writer", "report": "reporter"}
WORKERS = set(ROUTES.values())
STEP_LIMIT = 12

class StepLimit(Exception): pass

def standin_run(task: dict, step_limit: int, enforce_limit: bool = True) -> dict:
    """STAND-IN, not AuditMesh: a 20-line plain-Python supervisor so the harness executes here."""
    trace, limit = [], step_limit if enforce_limit else step_limit * 10
    def step(node):
        if len(trace) >= limit:
            raise StepLimit
        trace.append(node)
    try:
        done, approved = False, None
        while True:
            step("supervisor")
            if done:
                return {"trace": trace, "status": "done"}
            worker = ROUTES.get(task["type"])
            if worker is None:
                step("human_triage"); return {"trace": trace, "status": "needs_human"}
            if worker == "ticket_writer" and approved is None:
                step("human_approval"); approved = task.get("approval") == "approved"
                if not approved:
                    return {"trace": trace, "status": "rejected"}
                continue
            step(worker)
            done = not task.get("worker_never_finishes")
    except StepLimit:
        return {"trace": trace, "status": "step_limit"}

# Point at your real graph later: AUDITMESH_SUPERVISOR="auditmesh.harness_adapter:run"
def load_target():
    if spec := os.environ.get("AUDITMESH_SUPERVISOR"):
        mod, attr = spec.split(":")
        return getattr(importlib.import_module(mod), attr)
    return standin_run

def run_harness(run) -> list[str]:
    fails = []
    def check(name, task, want_status, must=(), must_not=()):
        r = run(task, STEP_LIMIT)
        t = r["trace"]
        if r["status"] != want_status: fails.append(f"{name}: status {r['status']}, want {want_status}")
        if len(t) > STEP_LIMIT: fails.append(f"{name}: {len(t)} steps > limit {STEP_LIMIT}")
        fails.extend(f"{name}: {n} missing" for n in must if n not in t)
        fails.extend(f"{name}: {n} must not run" for n in must_not if n in t)
        return t
    for ttype, worker in ROUTES.items():
        if ttype != "file_ticket":
            check(f"route {ttype}", {"type": ttype}, "done", [worker], WORKERS - {worker})
    check("unknown type", {"type": "delete_all_users"}, "needs_human", ["human_triage"], WORKERS)
    t = check("ticket approved", {"type": "file_ticket", "approval": "approved"}, "done", ["human_approval", "ticket_writer"])
    if "ticket_writer" in t and t.index("human_approval") > t.index("ticket_writer"):
        fails.append("ticket approved: ticket_writer ran before human_approval")
    check("ticket rejected", {"type": "file_ticket", "approval": "rejected"}, "rejected", ["human_approval"], ["ticket_writer"])
    check("runaway worker", {"type": "policy_check", "worker_never_finishes": True}, "step_limit")
    return fails

fails = run_harness(load_target())
print("target:", fails or "all supervisor checks passed")
assert fails == []
broken = run_harness(lambda task, limit: standin_run(task, limit, enforce_limit=False))
print("broken:", broken)
assert broken == ["runaway worker: 120 steps > limit 12"]       # the harness has teeth
print("OK: supervisor acceptance harness")
```

- `standin_run` jaan-boojh ke plain Python hai -- ye AuditMesh nahi, sirf harness ko yahan chalane ke liye. Real graph `AUDITMESH_SUPERVISOR` se plug hota hai.
- `check(... must, must_not)` -- routing test sirf "sahi worker chala" nahi, "baaki workers nahi chale" bhi check karta hai.
- Approval order check `index()` se -- trace mein `human_approval` hamesha `ticket_writer` se pehle.
- `runaway worker` -- worker kabhi done nahi bolta; correct supervisor `step_limit` pe rukta hai.
- `broken` run -- limit enforce na karne wala supervisor pakda gaya (120 steps). Har harness ko ek broken target pe chala ke dekho.

```python
# real version -- not run here, needs: pip install langgraph
# auditmesh/harness_adapter.py -- adapts YOUR compiled graph to the harness contract
from langgraph.errors import GraphRecursionError
from langgraph.types import Command
from auditmesh.graph import build_graph      # yours: StateGraph(...).compile(checkpointer=...)

graph = build_graph()

def run(task: dict, step_limit: int) -> dict:
    config = {"recursion_limit": step_limit, "configurable": {"thread_id": f"harness-{id(task)}"}}
    trace, inp = [], {"task": task}
    try:
        while True:
            paused = False
            for chunk in graph.stream(inp, config, stream_mode="updates"):
                for node in chunk:
                    if node == "__interrupt__":          # interrupt marker in "updates" mode; check docs for your version
                        paused = True
                    else:
                        trace.append(node)
            if not paused:
                return {"trace": trace, "status": graph.get_state(config).values.get("status", "done")}
            inp = Command(resume=task.get("approval", "rejected"))   # harness plays the approver
    except GraphRecursionError:
        return {"trace": trace, "status": "step_limit"}
```

### Mini-exercise (30-60 min)
AuditMesh deliverable #1 (supervisor-based architecture): `auditmesh/graph.py` (aapka) + `auditmesh/tests/acceptance/test_supervisor.py`.
- Harness ko pytest mein convert karo (har check ek test); adapter apne graph ke liye likho aur `AUDITMESH_SUPERVISOR` set karke chalao.
- Ek test add karo: approval pe pause -> process restart (naya graph object, same checkpointer DB) -> resume -> ticket ek hi baar.
- Acceptance: saare checks green; `recursion_limit` hata ke PR -> CI red; README mein graph ka diagram (`graph.get_graph().draw_mermaid()` output).

### Common pitfalls
- Supervisor LLM ko free-text routing dena -- structured output (enum of worker names) do, aur unknown pe `human_triage`.
- Recursion limit bahut bada rakhna "safe side" -- cost cap hi to wahi hai; SLA (M16-03) ke hisaab se rakho.
- Approval node ke baad graph mein args dobara LLM se banwana -- approved args hi use karo (M16-04 approval binding).

### Checklist before moving on
- [ ] Supervisor ka routing, approval interrupt aur step cap -- teeno ka diagram bana sakta hoon.
- [ ] Harness contract (`run(task, step_limit)`) aur adapter ka role samjha sakta hoon.
- [ ] Harness mere real graph pe green aur broken config pe red hai.
- [ ] Restart ke baad resume wala test likh chuka hoon.

### Related
- M09-04 Supervisor and Router patterns
- M09-07 Conditional routing logic
- M10-03 Interrupting graph execution
- M10-05 Detecting infinite ReAct loops
- M16-07 Deploying a custom MCP server for secure Jira ticketing

### Self-quiz
1. Unknown task type ko "closest worker" ko dena kyun dangerous hai Kavach ke context mein?
2. `recursion_limit` hit hone pe graph crash karne ke bajaye `step_limit` status kyun return kare?
3. Routing test mein `must_not` ke bina kaunsa bug miss hota?
4. Approval ke baad process crash ho gaya. Ticket do baar na bane, iske liye kaunse do pieces chahiye?
