# Legacy Systems & Integrations

## Automating ticket creation

> Core | Fast CP5 / Slow CP7 | ~1.2 h | Builds on: M11-03, M14-01, M05-12

### Kahani
Bank ke ops team ne kaha: "Jab OmniGuard ko koi failed payment pattern dikhe, Jira mein ticket khol do." Agent ne kholna shuru kiya.
Monday subah: ek hi incident ke 37 tickets. Retry logic ne har timeout pe naya ticket bana diya, aur LLM ne har baar summary thodi alag likhi to dedupe bhi nahi hua.
Ek ticket mein priority "Super Urgent!!" thi -- Jira ne 400 diya aur agent loop mein phas gaya.
Fix: deterministic external id, create se pehle search, LLM output ko schema se validate, aur create call ko idempotent banao.

### What it is
**Ticket automation** = aapka service (ya agent tool) Jira REST API `POST /rest/api/3/issue` call karta hai -- `project`, `issuetype`, `summary`, ADF `description`, `labels`, `priority`.
Production-grade version **idempotent** hota hai: same incident = same ticket, chahe call 5 baar retry ho.

### Why it matters for an FDE
Duplicate tickets customer ke ops team ka trust turant khatam karte hain ("AI spam kar raha hai"). Aur agent-generated fields bina validation ke bheje to API errors ya galat team ko assign.

### Key concepts
- **External id** -- incident ke stable fields (source, error code, account, date bucket) ka hash; LLM text se nahi, kyunki wo har baar badalta hai.
- **Search-then-create** -- `labels = "og-<id>"` JQL se pehle check; mila to update/comment, nahi mila to create. Race window ke liye local DB unique constraint bhi.
- **ADF description** -- v3 API plain string description nahi leta; `{"type":"doc","version":1,"content":[...]}` chahiye.
- **Validate before send** -- Pydantic model with `Literal` priority, summary max length; LLM ka output M05-12 jaisa parse + validate.
- **Least privilege** -- service account ko sirf target project mein "Create issues" + "Add comments", delete nahi.

### Code example
`pip install httpx pydantic`

```python
# runnable
import hashlib, json
from typing import Literal
import httpx
from pydantic import BaseModel, Field, ValidationError

class TicketDraft(BaseModel):                       # what the LLM/tool is allowed to produce
    summary: str = Field(min_length=5, max_length=120)
    details: str = Field(max_length=4000)
    priority: Literal["Highest", "High", "Medium", "Low"]

def external_id(source: str, error_code: str, account: str, day: str) -> str:
    return "og-" + hashlib.sha256(f"{source}|{error_code}|{account}|{day}".encode()).hexdigest()[:12]

def adf(text: str) -> dict:
    return {"type": "doc", "version": 1, "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": line}]} for line in text.splitlines() if line]}

STORE: dict[str, dict] = {}                         # fake Jira's issues
def fake_jira(req: httpx.Request):
    if req.url.path == "/rest/api/3/search/jql":
        label = req.url.params["jql"].split('"')[1]
        hits = [{"key": k, "fields": {"labels": v["labels"]}} for k, v in STORE.items() if label in v["labels"]]
        return httpx.Response(200, json={"issues": hits, "isLast": True})
    if req.url.path == "/rest/api/3/issue" and req.method == "POST":
        fields = json.loads(req.content)["fields"]
        if fields["description"].get("type") != "doc":
            return httpx.Response(400, json={"errors": {"description": "Operation value must be an Atlassian Document"}})
        key = f"OPS-{len(STORE) + 1}"
        STORE[key] = fields
        return httpx.Response(201, json={"id": str(len(STORE)), "key": key})
    if req.url.path.endswith("/comment"):
        return httpx.Response(201, json={"id": "c1"})
    return httpx.Response(404)

http = httpx.Client(base_url="https://example.atlassian.net", transport=httpx.MockTransport(fake_jira),
                    headers={"Authorization": "Basic ZmFrZTpmYWtl"}, timeout=10.0)

def ensure_ticket(raw_llm_json: str, ext_id: str, project: str = "OPS") -> tuple[str, str]:
    try:
        draft = TicketDraft.model_validate_json(raw_llm_json)
    except ValidationError as e:
        return "", f"rejected: {e.error_count()} validation error(s)"      # never send garbage to Jira
    found = http.get("/rest/api/3/search/jql", params={"jql": f'labels = "{ext_id}"', "fields": "labels"}).json()["issues"]
    if found:
        key = found[0]["key"]
        http.post(f"/rest/api/3/issue/{key}/comment", json={"body": adf("Seen again: " + draft.summary)})
        return key, "existing"
    r = http.post("/rest/api/3/issue", json={"fields": {
        "project": {"key": project}, "issuetype": {"name": "Task"}, "summary": draft.summary,
        "description": adf(draft.details), "labels": ["omniguard", ext_id], "priority": {"name": draft.priority}}})
    r.raise_for_status()
    return r.json()["key"], "created"

eid = external_id("payments", "E_DECLINED_51", "acct-889", "2026-10-09")
good = json.dumps({"summary": "Spike in declined payments for acct-889", "details": "42 declines in 10 min\nCode 51", "priority": "High"})
reworded = json.dumps({"summary": "Declines spiking on acct-889", "details": "Same incident, new wording", "priority": "High"})
bad = json.dumps({"summary": "Help", "details": "x", "priority": "Super Urgent!!"})

r1 = ensure_ticket(good, eid); r2 = ensure_ticket(reworded, eid); r3 = ensure_ticket(bad, eid)
print(r1, r2, r3)
assert r1 == ("OPS-1", "created") and r2 == ("OPS-1", "existing") and len(STORE) == 1
assert r3[0] == "" and r3[1].startswith("rejected")
assert STORE["OPS-1"]["description"]["content"][1]["content"][0]["text"] == "Code 51"
assert eid in STORE["OPS-1"]["labels"]
print("OK: validated draft, ADF body, idempotent create via external-id label")
```

- `TicketDraft` -- LLM ka JSON yahan validate; `Literal` priority se "Super Urgent!!" Jira tak pahunchta hi nahi.
- `external_id` -- stable inputs ka hash, LLM summary ka nahi; reworded summary bhi same ticket pe jaati hai.
- `ensure_ticket` -- search (label) -> mila to comment, warna create. Retry safe hai.
- `adf()` -- v3 description ADF document hona chahiye; plain string pe Jira 400 deta hai (fake server bhi wahi karta hai).
- Search aur create ke beech race: do workers ek saath create kar sakte hain. Local table `tickets(external_id UNIQUE, jira_key)` mein pehle row insert karo -- jo insert jeete wahi create kare.

### Mini-exercise (30-60 min)
OmniGuard `omniguard/integrations/jira.py` mein `JiraWriter.ensure_ticket(draft, ext_id)` add karo.
- sqlite table `jira_tickets(external_id TEXT PRIMARY KEY, jira_key TEXT, created_at)`; insert-first pattern se race fix.
- Agent tool `create_ticket` ka JSON schema `TicketDraft` se generate (M05-11); tool call validate fail ho to model ko error message wapas (M05-09), Jira call nahi.
- Rate limit: per-hour max 20 tickets per project; limit cross = Slack alert (M11-01) instead of ticket.
- Tests: create, retry same id, reworded summary, invalid priority, Jira 400, Jira timeout (ticket row "pending" rahe, duplicate na bane).

### Common pitfalls
- Timeout pe blind retry -- pehli request shayad succeed ho chuki thi; bina idempotency key ke duplicate ticket.
- Custom fields ke ids (`customfield_10042`) hardcode -- har Jira instance mein alag; `/rest/api/3/field` se config time pe resolve karo.
- Ticket description mein customer PII ya poora prompt daal dena -- Jira mein sab log padh sakte hain; redact karo (M13-05).

### Checklist before moving on
- [ ] Create payload (project, issuetype, ADF description, labels) bina docs ke likh sakta hoon.
- [ ] Same incident ke liye retry/reword pe ek hi ticket banta hai.
- [ ] LLM output Pydantic se validate hota hai, invalid = Jira call nahi.
- [ ] Race condition ka DB-level guard samajh aata hai.

### Related
- M11-03 Reading internal Jira pages
- M14-01 Idempotency keys for safe tool execution
- M05-12 Parsing and validating tool arguments
- M13-05 Redacting sensitive entities (SSN, credit cards, emails)

### Self-quiz
1. External id ko LLM summary se kyun nahi banana chahiye?
2. Search-then-create mein race kaise hoti hai, aur DB unique constraint use kaise rokta hai?
3. Jira ne create pe timeout diya. Aapka code agle retry pe kya karega?
4. Agent ne 200 tickets ek ghante mein banane ki koshish ki. Kaunse guards isko rokte?
