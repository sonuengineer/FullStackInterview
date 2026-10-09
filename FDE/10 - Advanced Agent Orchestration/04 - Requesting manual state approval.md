# Advanced Agent Orchestration

## Requesting manual state approval

> Core | Fast CP7 / Slow CP9 | ~1.2 h | Builds on: M10-03, M02-05, M12-06

### Kahani
M10-03 ke baad AuditMesh ruk-ke-resume karna seekh gaya. Ab compliance team ka next sawaal: "Approve kaun karega, kahan se, aur auditor ko kaise prove karein ki kisne kya approve kiya?"
Pehla version: Slack mein bot message, koi bhi "yes" likh de to resume. Ek din agent ne khud ka ticket raise kiya aur usi on-call engineer ne approve kar diya jisne finding banayi thi -- SOX auditor ne isse "segregation of duties" violation likha.
Ek reviewer ne severity P1 se P2 karni chahi -- system mein sirf approve/reject tha, to usne reject karke manually ticket banaya. Audit trail toot gaya.

### What it is
**Manual state approval** = interrupted graph ka pending action ek **approval record** banta hai (action, args, reason, requester, expiry), jise authorized insaan API/UI se **approve, edit ya reject** karta hai; decision validate hoke graph ko resume value ki tarah jaata hai aur poora decision audit log mein likha jaata hai.
Interrupt (M10-03) mechanism hai; approval workflow uske upar ka product + policy layer hai.

### Why it matters for an FDE
Regulated customer ke liye "human in the loop" tabhi count hota hai jab wo human authorized ho, requester se alag ho, aur decision tamper-evident log mein ho. Bina iske HITL sirf theatre hai.

### Key concepts
- **Approval record** -- `id, thread_id, action, args, status, requested_by, decided_by, expires_at`; ek pending action = ek row.
- **Approve / edit / reject** -- edit ke args wahi Pydantic schema se validate hon jo tool use karta hai; reject ke saath reason mandatory.
- **Segregation of duties** -- requester (ya agent ka owner) apna khud ka action approve nahi kar sakta; role check (M12-06).
- **Single decision + expiry** -- pending se hi decide ho sakta hai (409 warna), expired pe 410; double-click se double resume nahi.
- **Audit trail** -- kisne, kab, kya decide kiya, original vs edited args -- append-only (M12-10).

### Code example
`pip install fastapi httpx pydantic`

```python
# runnable
import json
import sqlite3
import time
from typing import Literal

from fastapi import FastAPI, Header, HTTPException
from fastapi.testclient import TestClient
from pydantic import BaseModel, ConfigDict, Field, ValidationError

class CreateIssueArgs(BaseModel):                      # same schema the jira tool uses
    model_config = ConfigDict(extra="forbid")
    summary: str = Field(min_length=5, max_length=200)
    severity: Literal["P1", "P2", "P3"]

class Decision(BaseModel):
    decision: Literal["approve", "edit", "reject"]
    edited_args: dict | None = None
    reason: str | None = None
ROLES = {"meera": "compliance_approver", "arjun": "engineer"}      # stand-in for JWT claims (M12-02)
db = sqlite3.connect(":memory:", check_same_thread=False)
db.execute("CREATE TABLE approvals (id INTEGER PRIMARY KEY, thread_id TEXT, action TEXT, args TEXT,"
           " requested_by TEXT, status TEXT, decided_by TEXT, expires_at REAL)")
db.execute("CREATE TABLE audit (approval_id INTEGER, actor TEXT, event TEXT, detail TEXT, at REAL)")
RESUMED = []                                           # stand-in for graph.invoke(Command(resume=...))
def request_approval(thread_id, action, args, requested_by, ttl_s=3600):
    cur = db.execute("INSERT INTO approvals VALUES (NULL,?,?,?,?, 'pending', NULL, ?)",
                     (thread_id, action, json.dumps(args), requested_by, time.time() + ttl_s))
    return cur.lastrowid

app = FastAPI()
@app.get("/approvals")
def pending():
    rows = db.execute("SELECT id, action, args FROM approvals WHERE status='pending'")
    return [{"id": i, "action": a, "args": json.loads(g)} for i, a, g in rows]

@app.post("/approvals/{aid}/decision")
def decide(aid: int, body: Decision, x_user: str = Header()):
    row = db.execute("SELECT thread_id, args, requested_by, status, expires_at FROM approvals WHERE id=?", (aid,)).fetchone()
    if not row: raise HTTPException(404, "unknown approval")  # noqa: E701
    thread_id, args, requested_by, status, expires_at = row
    for failed, code, msg in [(ROLES.get(x_user) != "compliance_approver", 403, "approver role required"),
                              (x_user == requested_by, 403, "segregation of duties: not your own request"),
                              (status != "pending", 409, f"already {status}"),
                              (time.time() > expires_at, 410, "approval expired; re-run the assessment")]:
        if failed:
            raise HTTPException(code, msg)
    final_args = json.loads(args)
    if body.decision == "edit":
        try:
            final_args = CreateIssueArgs.model_validate(body.edited_args or {}).model_dump()
        except ValidationError as e:
            raise HTTPException(422, e.errors()[0]["msg"])
    if body.decision == "reject" and not body.reason:
        raise HTTPException(422, "reason required for reject")
    new_status = "rejected" if body.decision == "reject" else "approved"
    with db:   # status update + audit row in ONE transaction
        n = db.execute("UPDATE approvals SET status=?, decided_by=? WHERE id=? AND status='pending'",
                       (new_status, x_user, aid)).rowcount
        if n != 1:
            raise HTTPException(409, "decided concurrently")
        db.execute("INSERT INTO audit VALUES (?,?,?,?,?)", (aid, x_user, body.decision,
                   json.dumps({"original": json.loads(args), "final": final_args, "reason": body.reason}), time.time()))
    RESUMED.append((thread_id, {"type": body.decision, "args": final_args, "reason": body.reason}))
    return {"id": aid, "status": new_status, "args": final_args}

c = TestClient(app)
post = lambda aid, user, **body: c.post(f"/approvals/{aid}/decision", json=body, headers={"x-user": user})
a1 = request_approval("t-prod", "jira.create_issue", {"summary": "Public S3 bucket in prod", "severity": "P1"}, "arjun")
assert c.get("/approvals").json()[0]["id"] == a1
assert post(a1, "arjun", decision="approve").status_code == 403                 # requester cannot approve
assert post(a1, "meera", decision="edit", edited_args={"summary": "x", "severity": "P0"}).status_code == 422
ok = post(a1, "meera", decision="edit", edited_args={"summary": "Public S3 bucket in prod", "severity": "P2"})
print("edit:", ok.json())
assert ok.json()["args"]["severity"] == "P2" and RESUMED[0][0] == "t-prod"
assert post(a1, "meera", decision="approve").status_code == 409                 # already decided
a2 = request_approval("t-old", "jira.create_issue", {"summary": "Old finding here", "severity": "P1"}, "arjun", ttl_s=-1)
assert post(a2, "meera", decision="approve").status_code == 410                 # expired
assert db.execute("SELECT COUNT(*) FROM audit").fetchone()[0] == 1 and len(RESUMED) == 1
print("OK: role check, SoD, edit validation, single decision, expiry, audit")
```

- `x_user` header ek stand-in hai -- real mein JWT verify karke `sub` + role claim lo (M12-02); header pe bharosa kabhi nahi.
- `edit` ke args usi `CreateIssueArgs` se validate -- reviewer bhi "P0" jaisi invalid value nahi bhej sakta.
- `UPDATE ... WHERE status='pending'` + `rowcount` -- do approvers ek saath click karein to sirf ek jeetega (optimistic concurrency).
- Status update aur audit row ek hi transaction mein -- "approved hua par log nahi hua" state possible hi nahi.
- `RESUMED.append(...)` ki jagah real code `graph.invoke(Command(resume=decision), {"configurable": {"thread_id": thread_id}})` chalayega -- ideally background worker se, request thread se nahi.

```python
# real version -- not run here, needs: pip install langgraph langgraph-checkpoint-postgres
# Check the LangGraph docs for your version.
from langgraph.types import Command

def resume_after_decision(thread_id: str, decision: dict) -> None:
    config = {"configurable": {"thread_id": thread_id}}
    graph.invoke(Command(resume=decision), config)   # inside file_ticket: decision = interrupt(...)
```

### Mini-exercise (30-60 min)
CP7 capstone gate: `auditmesh/approvals.py` (FastAPI router) + `auditmesh/checkpoint.py` (M10-01) + interrupt runtime (M10-03) ko jodo.
- Graph P1 finding pe interrupt kare -> `request_approval()` row bane -> `POST /approvals/{id}/decision` -> graph resume -> fake Jira client mein ticket.
- `GET /approvals` mein evidence links aur agent ka reason dikhao (reviewer ko context chahiye).
- Acceptance (gate): ek test jo run start kare, `status == "interrupted"` assert kare, naya TestClient/app instance bana ke approve kare, aur final state mein `ticket` assert kare. Reject path pe ticket count 0.

### Common pitfalls
- Approval UI mein sirf "Approve?" button, bina args/evidence ke -- reviewer rubber-stamp karta hai; diff-style "agent kya karega" dikhao.
- Resume ko HTTP request ke andar synchronously chalana -- lamba graph = request timeout, retry = double resume; queue/worker + idempotency key use karo.
- Audit log mein poora prompt/PII dump karna -- log bhi data store hai; sirf IDs, args aur decision (M13-14).

### Checklist before moving on
- [ ] Approve/edit/reject teeno paths tested hain, edit schema-validated hai.
- [ ] Requester apna action approve nahi kar sakta (SoD).
- [ ] Double decision aur expired approval sahi status code dete hain.
- [ ] Har decision ka audit row same transaction mein likha jaata hai.
- [ ] CP7 gate: run pause hota hai aur approval ke baad resume hota hai.

### Related
- M10-03 Interrupting graph execution
- M12-06 Implementing Role-Based Access Control
- M12-10 Audit logging
- M14-01 Idempotency keys for safe tool execution
- M16 AuditMesh capstone

### Self-quiz
1. Approval expire hone ke baad graph ka kya hona chahiye -- auto-reject, re-assess, ya escalate? Kaun decide karega?
2. Do approvers ne same second pe approve dabaya. Is code mein kya hota hai, aur bina `WHERE status='pending'` ke kya hota?
3. Reviewer ne args edit kiye. Agent ko ye pata chalna chahiye ya nahi -- aur kyon (agle steps ke reasoning ke liye socho)?
4. Kaunse actions ko approval chahiye aur kaunse nahi -- ye policy code mein kahan rakhoge taaki customer badal sake?
