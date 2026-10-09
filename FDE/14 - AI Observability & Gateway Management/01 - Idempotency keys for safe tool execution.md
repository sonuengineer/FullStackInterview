# AI Observability & Gateway Management

## Idempotency keys for safe tool execution

> Core | Fast CP8 / Slow CP10 | ~1.2 h | Builds on: M10-09, M05-13, M02-05

### Kahani
Ek logistics customer ka support agent "shipment delayed" complaints pe Jira ticket banata hai aur customer ko email bhejta hai.
Ek din Jira API ne 30 second mein response diya, agent ka HTTP client 20 s pe timeout ho gaya, aur framework ne tool call retry kar diya.
Jira ne dono requests process kar li -- ek complaint, teen tickets, aur customer ko teen "we are on it" emails.
Ops manager poochta hai: "Retry to theek hai, lekin retry ka matlab duplicate kaam kyun?"
Fix model mein nahi hai -- fix tool layer mein hai: har side-effecting call ke saath ek idempotency key.

### What it is
**Idempotency key** = ek unique string jo ek "logical operation" ko identify karti hai. Server pehli baar kaam karta hai aur `(key, request_hash, result)` store kar leta hai; same key dobara aaye to kaam dobara nahi hota, stored result wapas milta hai.
Same key + alag payload = client bug, isliye `409 Conflict`. Keys ek TTL ke baad expire hoti hain.

### Why it matters for an FDE
Agents retry karte hain (timeouts, M14-02 backoff, graph resume after interrupt). Bina idempotency ke har retry ek naya ticket, naya refund, naya email -- aur customer trust seedha khatam.

### Key concepts
- **Side-effecting vs read-only tools** -- `search_docs` retry safe hai; `create_ticket`, `send_email`, `refund` ko key chahiye.
- **Deterministic key** -- `hash(run_id, step_no, tool_name)` se banao, random UUID har retry pe nahi; warna retry naya key bhejega aur protection zero.
- **Request hash** -- canonical JSON (`sort_keys=True`) ka sha256; same key pe hash match na kare to 409.
- **In-progress state** -- pehli request abhi chal rahi ho aur retry aa jaye to dobara execute mat karo; `409` (ya 425) + "retry later".
- **TTL** -- keys 24 h jaise window ke baad delete; table infinite nahi badhni chahiye.

### Code example
`pip install fastapi httpx`

```python
# runnable
import hashlib, json, sqlite3
from fastapi import FastAPI, Header, HTTPException, Response
from fastapi.testclient import TestClient
from pydantic import BaseModel

TTL_S = 24 * 3600
NOW = [1_000_000.0]                      # fake clock so the TTL test does not sleep
db = sqlite3.connect(":memory:", check_same_thread=False)
db.execute("""CREATE TABLE idem (key TEXT PRIMARY KEY, req_hash TEXT NOT NULL,
              status TEXT NOT NULL, response TEXT, created_at REAL NOT NULL)""")
JIRA = []                                # fake Jira: every append = a real side effect

class Ticket(BaseModel):
    summary: str
    priority: str = "P3"

def req_hash(body: dict) -> str:
    return hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()

def agent_key(run_id: str, step: int, tool: str) -> str:
    return hashlib.sha256(f"{run_id}:{step}:{tool}".encode()).hexdigest()[:32]

app = FastAPI()

@app.post("/tools/create_ticket")
def create_ticket(t: Ticket, response: Response, idempotency_key: str = Header(...)):
    h = req_hash(t.model_dump())
    db.execute("DELETE FROM idem WHERE created_at < ?", (NOW[0] - TTL_S,))   # TTL sweep
    try:                                 # claim the key atomically (PRIMARY KEY)
        db.execute("INSERT INTO idem VALUES (?, ?, 'in_progress', NULL, ?)", (idempotency_key, h, NOW[0]))
    except sqlite3.IntegrityError:
        old_hash, status, stored = db.execute(
            "SELECT req_hash, status, response FROM idem WHERE key = ?", (idempotency_key,)).fetchone()
        if old_hash != h:
            raise HTTPException(409, "Idempotency-Key reused with a different payload")
        if status == "in_progress":
            raise HTTPException(409, "Original request still in progress, retry later")
        response.headers["Idempotent-Replayed"] = "true"
        return json.loads(stored)
    JIRA.append(t.summary)               # the side effect happens exactly once
    result = {"ticket_id": f"OPS-{len(JIRA)}", "summary": t.summary}
    db.execute("UPDATE idem SET status = 'done', response = ? WHERE key = ?", (json.dumps(result), idempotency_key))
    db.commit()
    return result

c = TestClient(app)
key = agent_key("run-42", step=3, tool="create_ticket")
body = {"summary": "Shipment SH-981 delayed", "priority": "P2"}
r1 = c.post("/tools/create_ticket", json=body, headers={"Idempotency-Key": key})
r2 = c.post("/tools/create_ticket", json={"priority": "P2", "summary": "Shipment SH-981 delayed"},
            headers={"Idempotency-Key": agent_key("run-42", 3, "create_ticket")})   # agent retry
assert r1.json() == r2.json() and len(JIRA) == 1
assert r2.headers["Idempotent-Replayed"] == "true"
r3 = c.post("/tools/create_ticket", json={"summary": "Different!"}, headers={"Idempotency-Key": key})
assert r3.status_code == 409 and len(JIRA) == 1
db.execute("INSERT INTO idem VALUES ('busy', ?, 'in_progress', NULL, ?)", (req_hash({"summary": "x", "priority": "P3"}), NOW[0]))
assert c.post("/tools/create_ticket", json={"summary": "x"}, headers={"Idempotency-Key": "busy"}).status_code == 409
assert c.post("/tools/create_ticket", json=body).status_code == 422          # key is mandatory
NOW[0] += TTL_S + 1                                                           # a day later
r4 = c.post("/tools/create_ticket", json=body, headers={"Idempotency-Key": key})
assert r4.json()["ticket_id"] == "OPS-2" and "Idempotent-Replayed" not in r4.headers
print("tickets created:", JIRA)
print("OK: replay returns stored result, 409 on payload mismatch / in-progress, TTL expiry")
```

- `agent_key(run_id, step, tool)` -- retry same step pe same key banata hai. `uuid4()` har retry pe naya hota, isliye wo galat choice hai.
- `INSERT ... PRIMARY KEY` -- "check then insert" race-prone hai; DB constraint pe claim karna atomic hai. Postgres mein `INSERT ... ON CONFLICT DO NOTHING RETURNING` same kaam karta hai.
- `req_hash` `sort_keys=True` ke saath -- r2 mein keys ka order alag hai, phir bhi same hash, isliye replay.
- `in_progress` row -- pehla call abhi Jira pe atka hai to doosra call execute nahi hota; 409 aur client baad mein retry karta hai.
- Real system mein agar side effect fail ho to row delete karo (ya `failed` mark karo) taaki retry dobara try kar sake -- warna key hamesha "in_progress" pe phans jaayegi.

```python
# real version -- not run here, needs: pip install anthropic
# Pass the key through from the agent's tool_use id when your framework retries the same tool_use block.
import os, anthropic, httpx
client = anthropic.Anthropic()
msg = client.messages.create(model=os.environ["LLM_MODEL"], max_tokens=1024, tools=TOOLS, messages=history)
for block in msg.content:
    if block.type == "tool_use" and block.name == "create_ticket":
        httpx.post(f"{TOOL_API}/tools/create_ticket", json=block.input, timeout=20,
                   headers={"Idempotency-Key": agent_key(run_id, step_no, block.name)})
```

### Mini-exercise (30-60 min)
AuditMesh v1.0 ke liye `auditmesh/tools/idempotency.py` banao -- ek FastAPI dependency `require_idempotency(table)` jo kisi bhi side-effecting route pe lag sake (Jira ticket, email notify).
- Key format: `sha256(run_id:step:tool)`; agent graph (M10) ka retry node same key pass kare.
- Failure path: side effect raise kare to row delete ho, retry dobara execute ho.
- Acceptance: pytest -- (1) same key 3 baar -> fake Jira mein 1 ticket; (2) same key alag body -> 409; (3) TTL ke baad naya ticket; (4) side effect pehli baar fail -> doosri baar success, 1 ticket.

### Common pitfalls
- Key client-side random per attempt banana -- retry pe naya key, duplicate wapas. Key logical operation se derive karo.
- Response mein PII store karna aur kabhi expire na karna -- idem table bhi data store hai; TTL + sirf zaroori fields (M13-14).
- Sirf apne API pe key lagana jab downstream (Stripe, Jira) khud idempotency support karta ho -- jahan provider `Idempotency-Key` header leta hai, wahan bhi forward karo.

### Checklist before moving on
- [ ] Bata sakta hoon kaun se tools side-effecting hain aur kaun retry-safe.
- [ ] Deterministic key bana sakta hoon jo agent retry pe same rahe.
- [ ] Replay, 409 mismatch, in-progress aur TTL -- chaaron cases test kiye.
- [ ] Atomic claim (unique constraint) aur "check-then-insert" race ka farak samajhta hoon.

### Related
- M10-09 Connecting agents to external tools safely
- M05-13 Handling multi-tool parallel execution
- M14-02 Exponential backoff strategies
- M16-07 Deploying a custom MCP server for secure Jira ticketing

### Self-quiz
1. Agent ne `uuid4()` se key banayi aur timeout ke baad retry kiya. Kya duplicate ticket bachega? Kyun?
2. Same key, alag payload pe 409 dena better hai ya naya kaam karna? Dono ke risks batao.
3. Pehli request in-progress hai aur retry aa gaya -- aap kya return karoge aur kyun?
4. TTL bahut chhota (1 minute) rakhne se kya galat ho sakta hai?
