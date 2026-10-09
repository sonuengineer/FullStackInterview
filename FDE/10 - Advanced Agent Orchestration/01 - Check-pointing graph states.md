# Advanced Agent Orchestration

## Check-pointing graph states

> Core | Fast CP7 / Slow CP9 | ~1.2 h | Builds on: M09-05, M09-08

### Kahani
Ek insurance company ka compliance agent raat bhar 300 policies audit karta hai. Har policy ke liye 4 steps: evidence fetch (slow Jira + SharePoint calls), LLM analysis, risk scoring, report draft.
Raat 2:40 pe Kubernetes ne pod ko OOM pe kill kar diya. Agent ka poora state memory mein tha -- 180 policies ka kaam gaya. Restart hua to sab zero se: phir se Jira calls, phir se LLM tokens, phir se 3 ghante.
Subah customer ka sawaal: "Crash ke baad kahan se resume hota hai?" Jawab tha "shuru se". Ye production answer nahi hai.

### What it is
**Checkpointing** = har node ke baad graph ka poora state durable store (sqlite/Postgres) mein save karna, key = `thread_id` + `checkpoint_id`. Crash ke baad latest checkpoint load karo aur agla node chalao -- completed nodes dobara nahi chalte.
LangGraph mein ye `compile(checkpointer=...)` se milta hai; aaj hum same idea stdlib sqlite se khud banayenge taaki andar ka mechanism samajh aaye.

### Why it matters for an FDE
Bina checkpoint ke har crash, deploy ya timeout = duplicate side effects (do baar Jira ticket), double LLM cost aur "agent kahan tha?" ka koi audit trail nahi. Human-in-the-loop (M10-03/04) bhi isi pe khada hai -- pause matlab "state save karke ruk jao".

### Key concepts
- **thread_id** -- ek conversation/run ki identity; har run ka apna checkpoint history. Customer ID ya job ID se derive karo, random mat rakho.
- **checkpoint_id** -- har node ke baad naya, monotonic ID; latest = resume point, purane = time-travel/debug.
- **Super-step boundary** -- checkpoint node ke *baad* likha jaata hai; node ke beech crash = wo node dobara chalega, isliye side-effecting nodes idempotent hone chahiye (M14-01).
- **State must be serializable** -- JSON/msgpack; DB connections, file handles, LLM clients state mein nahi, sirf data.
- **Durable store** -- dev mein sqlite, prod mein Postgres (multi-pod, backups); in-memory saver sirf tests ke liye.

### Code example
`stdlib only`

```python
# runnable
import json
import sqlite3
import tempfile
from pathlib import Path

class SqliteCheckpointer:
    """Teaching stand-in for LangGraph's SqliteSaver: one row per (thread_id, checkpoint_id)."""
    def __init__(self, path):
        self.db = sqlite3.connect(path)
        self.db.execute("CREATE TABLE IF NOT EXISTS checkpoints (thread_id TEXT, checkpoint_id INTEGER,"
                        " next_node TEXT, state TEXT, PRIMARY KEY (thread_id, checkpoint_id))")
    def put(self, thread_id, next_node, state):
        cur = self.db.execute("SELECT COALESCE(MAX(checkpoint_id), 0) FROM checkpoints WHERE thread_id=?", (thread_id,))
        cid = cur.fetchone()[0] + 1
        with self.db:                                   # commit = durable before we move on
            self.db.execute("INSERT INTO checkpoints VALUES (?,?,?,?)", (thread_id, cid, next_node, json.dumps(state)))
        return cid
    def latest(self, thread_id):
        row = self.db.execute("SELECT checkpoint_id, next_node, state FROM checkpoints WHERE thread_id=? "
                              "ORDER BY checkpoint_id DESC LIMIT 1", (thread_id,)).fetchone()
        return (row[0], row[1], json.loads(row[2])) if row else None
    def history(self, thread_id):
        return [r[0] for r in self.db.execute("SELECT next_node FROM checkpoints WHERE thread_id=? ORDER BY checkpoint_id", (thread_id,))]

CALLS = {"fetch_evidence": 0, "analyze": 0, "draft_report": 0}
CRASH = {"armed": True}

def fetch_evidence(s):
    CALLS["fetch_evidence"] += 1
    return {**s, "evidence": ["JIRA-101: access review overdue", "SP: policy v3 unsigned"]}
def analyze(s):
    CALLS["analyze"] += 1
    if CRASH["armed"]:
        CRASH["armed"] = False
        raise MemoryError("simulated OOM kill in analyze")
    return {**s, "findings": [e.split(":")[0] for e in s["evidence"]]}
def draft_report(s):
    CALLS["draft_report"] += 1
    return {**s, "report": f"{len(s['findings'])} findings for {s['policy']}"}

GRAPH = {"fetch_evidence": (fetch_evidence, "analyze"), "analyze": (analyze, "draft_report"),
         "draft_report": (draft_report, "END")}

def run(cp, thread_id, inputs=None):
    saved = cp.latest(thread_id)
    node, state = (saved[1], saved[2]) if saved else ("fetch_evidence", inputs)
    if not saved:
        cp.put(thread_id, node, state)                  # checkpoint 1 = the input
    while node != "END":
        fn, nxt = GRAPH[node]
        state = fn(state)
        cp.put(thread_id, nxt, state)                   # checkpoint AFTER every node
        node = nxt
    return state

with tempfile.TemporaryDirectory() as d:
    db = Path(d) / "checkpoints.db"
    dead_pod = SqliteCheckpointer(db)
    try:
        run(dead_pod, "audit-POL-778", {"policy": "POL-778"})
    except MemoryError as e:
        print("crash:", e)
    dead_pod.db.close()                                  # the killed pod's memory is gone
    cp = SqliteCheckpointer(db)                          # "new pod": fresh process, same DB file
    print("resume from:", cp.latest("audit-POL-778")[1])
    final = run(cp, "audit-POL-778")
    print("final:", final["report"], "| history:", cp.history("audit-POL-778"))
    assert final["report"] == "2 findings for POL-778"
    assert CALLS["fetch_evidence"] == 1                 # slow fetch NOT repeated after the crash
    assert CALLS["analyze"] == 2                        # the crashed node re-runs (make it idempotent)
    assert cp.history("audit-POL-778") == ["fetch_evidence", "analyze", "draft_report", "END"]
    cp.db.close()
print("OK: crash survived, resumed from the last checkpoint")
```

- `put()` ke andar `with self.db:` -- transaction commit hone ke baad hi agla node chalta hai; "save karke aage badho" yahi hai.
- Checkpoint row mein `next_node` bhi store hai -- resume ko pata hai kahan se shuru karna hai, state ke saath "program counter" bhi.
- Crash ke baad naya `SqliteCheckpointer(db)` -- process memory khali, sirf DB file bachi; phir bhi `fetch_evidence` dobara nahi chala.
- `analyze` do baar chala -- crash node ke beech hua tha. Isliye side effects (Jira ticket create) wale nodes idempotency key ke saath likho.
- `history()` = time-travel ka base; LangGraph mein ye `get_state_history(config)` hai.

```python
# real version -- not run here, needs: pip install langgraph langgraph-checkpoint-sqlite
# Check the LangGraph docs for your version; import paths have moved between releases.
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import StateGraph, START, END

builder = StateGraph(AuditState)
builder.add_node("fetch_evidence", fetch_evidence)
builder.add_node("analyze", analyze)
builder.add_edge(START, "fetch_evidence")
builder.add_edge("fetch_evidence", "analyze")
builder.add_edge("analyze", END)

with SqliteSaver.from_conn_string("checkpoints.db") as checkpointer:
    graph = builder.compile(checkpointer=checkpointer)
    config = {"configurable": {"thread_id": "audit-POL-778"}}
    graph.invoke({"policy": "POL-778"}, config=config)
    graph.invoke(None, config=config)          # None input = resume this thread from its last checkpoint
    print(graph.get_state(config).values)
    for snap in graph.get_state_history(config):
        print(snap.config["configurable"]["checkpoint_id"], snap.next)

# Production: from langgraph.checkpoint.postgres import PostgresSaver
# with PostgresSaver.from_conn_string(os.environ["CHECKPOINT_DB_URL"]) as cp: cp.setup()
```

### Mini-exercise (30-60 min)
CP7 capstone: `auditmesh/checkpoint.py` banao.
- `SqliteCheckpointer` with `put / latest / history / delete_thread`; DB path env var `AUDITMESH_CHECKPOINT_DB` se.
- `run_graph(thread_id, inputs)` jo resume-aware ho; `thread_id = f"audit-{policy_id}"`.
- `tests/test_checkpoint.py`: node 2 mein exception inject karo, naya checkpointer object banao, resume karo -- assert node 1 ka call count 1, final state sahi, history order sahi.
- Acceptance: pytest green; DB file delete karke chalao to clean start; do alag thread_ids ek doosre ka state nahi dekhte.

### Common pitfalls
- State mein non-serializable cheezein (DB session, httpx client) daal dena -- checkpoint fail, ya resume pe stale object.
- `thread_id` har request pe random UUID -- resume kabhi hota hi nahi, aur DB bina cleanup ke badhta rehta hai; retention/TTL policy rakho.
- State mein raw PII/prompts plaintext checkpoint DB mein -- ye bhi ek data store hai; encryption at rest + retention + access control (M13-14).

### Checklist before moving on
- [ ] Bata sakta hoon checkpoint kab likha jaata hai (node ke baad) aur crash-in-node pe kya hota hai.
- [ ] `thread_id` aur `checkpoint_id` ka fark samajh aata hai.
- [ ] Crash -> new process -> resume test mere paas green hai.
- [ ] Jaanta hoon prod mein sqlite ki jagah Postgres saver kyon.

### Related
- M09-05 Defining graphs and state management
- M09-08 Compiling graphs
- M10-03 Interrupting graph execution
- M10-04 Requesting manual state approval
- M14-01 Idempotency keys for safe tool execution

### Self-quiz
1. `analyze` node ke beech crash hua. Resume pe kaunsa node pehle chalega, aur agar wo node Jira ticket banata to kya problem hoti?
2. Teen pods ek hi sqlite file share karein to kya ho sakta hai? Postgres saver isse kaise bachata hai?
3. Time-travel (purane checkpoint se fork) ka ek real debugging use-case batao.
4. Checkpoint DB ki retention policy kaun decide karega aur kyon customer se poochna zaroori hai?
