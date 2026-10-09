# Advanced Agent Orchestration

## Interrupting graph execution

> Core | Fast CP7 / Slow CP9 | ~1.2 h | Builds on: M10-01, M09-07

### Kahani
Ek fintech customer ka AuditMesh pilot. Agent findings nikaalta hai aur Jira mein "P1 control failure" ticket file karta hai -- jo seedha CFO ke dashboard pe jaata hai.
Demo ke din agent ne ek test-environment ki misconfiguration ko production control failure samajh ke P1 file kar diya. CFO ka phone aaya.
Compliance head ka rule: "Koi bhi ticket file hone se pehle ek insaan dekhega." Problem: agent ek Python loop hai -- usse "beech mein rok ke, kal subah resume" kaise karein, jab tak pod restart bhi ho chuka ho?

### What it is
**Interrupt** = graph ko ek specific node se pehle (static: `interrupt_before`) ya node ke andar (dynamic: `interrupt(payload)`) rokna, state checkpoint mein save karna aur caller ko pending payload lauta dena. Baad mein -- minutes ya din baad, kisi bhi process se -- same `thread_id` pe **resume value** ke saath graph wahin se chalta hai.
Interrupt ke bina checkpointing sirf crash recovery hai; interrupt ke saath ye "pause button" ban jaata hai.

### Why it matters for an FDE
Regulated customers (bank, pharma, insurance) irreversible actions pe human gate maangte hain. Thread ko memory mein `input()` pe block karna scale nahi karta aur deploy pe kho jaata hai -- interrupt + durable checkpoint hi production-safe tareeka hai.

### Key concepts
- **Static interrupt** -- compile time pe `interrupt_before=["file_ticket"]`; simple, poora node gated.
- **Dynamic interrupt** -- node ke andar `interrupt({...})`; sirf condition pe ruko (e.g. severity P1), aur reviewer ko context payload do.
- **Resume re-runs the node** -- resume pe interrupted node shuru se chalta hai, `interrupt()` is baar resume value return karta hai; isliye side effects interrupt ke *baad* rakho.
- **Pending payload** -- reviewer ko dikhane layak data (action, args, reason), JSON-serializable.
- **Resume anywhere** -- state DB mein hai, isliye resume kisi aur pod/process se bhi ho sakta hai.

### Code example
`stdlib only`

```python
# runnable
import json
import sqlite3

class Interrupted(Exception):
    def __init__(self, payload):
        self.payload = payload

class Runtime:
    """Teaching stand-in for LangGraph interrupt()/Command(resume=...). One sqlite table = checkpointer."""
    def __init__(self, db):
        self.db = db
        db.execute("CREATE TABLE IF NOT EXISTS ckpt (thread TEXT PRIMARY KEY, node TEXT, state TEXT, pending TEXT)")
        self.resume_value = None
    def interrupt(self, payload):
        if self.resume_value is not None:              # second pass: return the human's answer
            value, self.resume_value = self.resume_value, None
            return value
        raise Interrupted(payload)                     # first pass: stop here
    def save(self, thread, node, state, pending=None):
        with self.db:
            self.db.execute("REPLACE INTO ckpt VALUES (?,?,?,?)", (thread, node, json.dumps(state), json.dumps(pending)))
    def run(self, graph, thread, inputs=None, resume=None):
        row = self.db.execute("SELECT node, state FROM ckpt WHERE thread=?", (thread,)).fetchone()
        node, state = (row[0], json.loads(row[1])) if row else (graph["start"], inputs)
        self.resume_value = resume
        while node != "END":
            fn, nxt = graph[node]
            try:
                state = fn(self, state)
            except Interrupted as i:
                self.save(thread, node, state, i.payload)   # persist BEFORE returning to the caller
                return {"status": "interrupted", "pending": i.payload}
            node = nxt
            self.save(thread, node, state)
        return {"status": "done", "state": state}

LOG = {"file_ticket_runs": 0, "tickets": []}
def assess(rt, s):
    return {**s, "severity": "P1" if "prod" in s["finding"] else "P3"}
def file_ticket(rt, s):
    LOG["file_ticket_runs"] += 1                                   # code BEFORE interrupt runs twice
    if s["severity"] == "P1":
        decision = rt.interrupt({"action": "jira.create_issue", "severity": "P1", "summary": s["finding"]})
        if decision["type"] == "reject":
            return {**s, "ticket": None, "note": decision["reason"]}
    LOG["tickets"].append(s["finding"])                       # side effect AFTER the interrupt
    return {**s, "ticket": f"AUD-{len(LOG['tickets'])}"}

GRAPH = {"start": "assess", "assess": (assess, "file_ticket"), "file_ticket": (file_ticket, "END")}
db = sqlite3.connect(":memory:")

r = Runtime(db).run(GRAPH, "t-prod", {"finding": "prod S3 bucket public"})
print("run 1:", r)
assert r["status"] == "interrupted" and LOG["tickets"] == []      # nothing filed yet
# ... hours later, a different worker process picks it up (fresh Runtime, same DB)
r = Runtime(db).run(GRAPH, "t-prod", resume={"type": "approve"})
print("run 2:", r["status"], r["state"]["ticket"])
assert r["state"]["ticket"] == "AUD-1" and LOG["file_ticket_runs"] == 2

r = Runtime(db).run(GRAPH, "t-test", {"finding": "prod-like flag in test env"})
r = Runtime(db).run(GRAPH, "t-test", resume={"type": "reject", "reason": "test environment"})
assert r["state"]["ticket"] is None and len(LOG["tickets"]) == 1

r = Runtime(db).run(GRAPH, "t-low", {"finding": "stale wiki page"})
assert r["status"] == "done" and r["state"]["ticket"] == "AUD-2"  # P3: no human needed
print("OK: paused before the risky side effect, resumed from another process")
```

- `interrupt()` pehli baar exception phenkta hai, resume pe value return karta hai -- LangGraph ka `interrupt()` bhi isi "node dobara chalao" model pe kaam karta hai.
- `save(..., pending)` caller ko return karne se *pehle* -- agar API response fail ho jaaye tab bhi pending action DB mein safe hai.
- `LOG["file_ticket_runs"] == 2` -- interrupt se pehle ka code resume pe dobara chala. Wahan koi side effect hota to do baar hota.
- `t-low` (P3) bina ruke chala -- dynamic interrupt sirf jahan risk hai wahan; har cheez pe approval = reviewer fatigue.
- Resume ek naye `Runtime(db)` se -- process boundary cross karke bhi kaam karta hai, kyonki truth DB mein hai.

```python
# real version -- not run here, needs: pip install langgraph langgraph-checkpoint-sqlite
# Check the LangGraph docs for your version -- interrupt/Command APIs evolve.
from langgraph.types import interrupt, Command

def file_ticket(state):
    if state["severity"] == "P1":
        decision = interrupt({"action": "jira.create_issue", "summary": state["finding"]})
        if decision["type"] == "reject":
            return {"ticket": None}
    return {"ticket": jira.create_issue(state["finding"])}

graph = builder.compile(checkpointer=checkpointer)        # static option: interrupt_before=["file_ticket"]
config = {"configurable": {"thread_id": "t-prod"}}
out = graph.invoke({"finding": "prod S3 bucket public"}, config)
print(out.get("__interrupt__"))                           # pending payload(s) for the reviewer
graph.invoke(Command(resume={"type": "approve"}), config)
```

### Mini-exercise (30-60 min)
CP7 capstone: `auditmesh/graph_runtime.py` mein interrupt support jodo (M10-01 ka `checkpoint.py` reuse karo).
- `file_jira_ticket` node P1/P2 pe interrupt kare; payload mein `action`, `args`, `finding_id`, `evidence_links`.
- `list_pending()` function jo saare interrupted threads + payload lautaye (M10-04 ka API isi ko use karega).
- Acceptance tests: interrupt ke baad ticket count 0; naye Runtime object se resume pe 1; reject pe 0; P3 bina interrupt ke done.

### Common pitfalls
- Side effect (Jira call, email) ko `interrupt()` se *pehle* likhna -- resume pe duplicate ticket.
- Pending state sirf memory/queue message mein rakhna -- deploy ke baad approval ka "kis cheez ka approval?" pata nahi.
- Interrupt pe koi timeout/expiry nahi -- 3 hafte purana pending P1 approve hua, jab evidence badal chuka tha; approval pe `expires_at` rakho (M10-04).

### Checklist before moving on
- [ ] Static vs dynamic interrupt ka use-case bata sakta hoon.
- [ ] Jaanta hoon resume pe interrupted node shuru se chalta hai.
- [ ] Side effects interrupt ke baad hain, aur test isse prove karta hai.
- [ ] Resume ek naye process/object se kaam karta hai.

### Related
- M10-01 Check-pointing graph states
- M10-04 Requesting manual state approval
- M09-07 Conditional routing logic
- M14-01 Idempotency keys for safe tool execution

### Self-quiz
1. Resume pe interrupted node shuru se kyon chalta hai, beech se kyon nahi? Python mein beech se resume karna kyon mushkil hai?
2. Ek node mein do `interrupt()` calls hain. Resume values kaise match hongi -- kya order badalna safe hai?
3. `interrupt_before` aur node ke andar conditional `interrupt()` -- AuditMesh ke liye kaunsa aur kyon?
4. Interrupted thread kabhi resume hi nahi hua. Uska cleanup aur alerting kaun karega?
