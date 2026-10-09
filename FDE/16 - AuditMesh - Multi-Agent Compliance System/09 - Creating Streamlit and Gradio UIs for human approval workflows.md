# AuditMesh - Multi-Agent Compliance System

## Creating Streamlit/Gradio UIs for human approval workflows

> Core | Fast CP8 / Slow CP10 | ~1.2 h | Builds on: M10-03, M10-04, M12-06, M12-10, M16-02, M16-06

### Kahani
AuditMesh ka graph approval pe ruk jaata hai (M16-06), par Meera ki team ke paas approve karne ki jagah sirf ek curl command thi.
Unki maang: "Ek page jahan pending list dikhe, approve/reject ek click mein ho, aur reason likhna zaroori ho."
Internal audit ne shart jodi: "Jisne finding raise ki, woh khud approve na kar sake, aur har decision ka log ho." Pilot mein Priya ne galti se apna hi raised item approve kar diya tha. UI 1 din mein ban jaata hai; asli kaam hai woh **backend contract** jo UI ke peeche hai -- kyunki rules button pe nahi, API pe enforce hote hain.

### What it is
**Human approval UI** = Streamlit ya Gradio ka chhota internal app jo approval API (M10-04) call karta hai: pending list, action ke exact args, approve/reject with reason.
Rules API mein, UI sirf client hai -- isliye acceptance harness API ko test karta hai, UI ko nahi.

### Why it matters for an FDE
HITL tabhi valid hai jab approver authorized ho, requester se alag ho, aur decision logged ho. Check UI mein lagaya aur API mein nahi = koi bhi curl se bypass kar dega.

### Key concepts
- **Thin UI, strict API** -- har rule API pe (401/403/409/422), UI sirf dikhata hai (M12-06).
- **Segregation of duties** -- `requested_by == current user` -> 403.
- **Show exact args** -- approver wahi dekhe jo execute hoga (M16-04 approval binding), summary nahi.
- **Reason mandatory + audit event** -- who, what, decision, reason, time (M12-10).
- **Streamlit vs Gradio** -- Streamlit: script-rerun model, internal forms/dashboards. Gradio: component events, quick demos. Jo team maintain kar sake woh chuno.

```text
 Streamlit / Gradio UI (SSO login, M12-03)
     | GET /approvals            POST /approvals/{id}/decision {decision, reason}
     v
 Approval API: authn 401 -> reviewer role 403 -> not own request 403 -> pending 409 -> reason 422
     +--> audit event (M12-10)     +--> resume value: LangGraph interrupt resumes (M10-03) -> ticket_writer -> Jira MCP (M16-07)
```

Failure list the harness covers: no token, wrong role, empty reason, self-approval, double decision, unknown id, stale pending list, missing audit event. Not covered: expiry (410), two reviewers clicking together -- add with your DB.

### Code example
`pip install fastapi httpx pydantic`

```python
# runnable
import importlib, os
from typing import Literal
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.testclient import TestClient
from pydantic import BaseModel, Field

USERS = {"tok-priya": ("priya", {"reviewer"}), "tok-meera": ("meera", {"reviewer", "admin"}),
         "tok-ravi": ("ravi", {"ops"})}                                  # test tokens only
SEED = [{"id": "ap-1", "action": "create_compliance_ticket", "args": {"summary": "Orphaned admin LMS-03"}, "requested_by": "agent:auditmesh"},
        {"id": "ap-2", "action": "create_compliance_ticket", "args": {"summary": "Shared login CRM-11"}, "requested_by": "priya"}]
class Decision(BaseModel):
    decision: Literal["approve", "reject"]
    reason: str = Field(min_length=5, max_length=500)
def standin_create_app(users: dict, seed: list, check_self: bool = True) -> FastAPI:
    """STAND-IN, not AuditMesh: the approval API your Streamlit/Gradio UI calls."""
    app, items = FastAPI(), {a["id"]: {**a, "status": "pending"} for a in seed}
    app.state.audit = []
    def user(authorization: str = Header(default="")):
        if (u := users.get(authorization.removeprefix("Bearer "))) is None:
            raise HTTPException(401, "invalid token")
        return u
    @app.get("/approvals")
    def pending(u=Depends(user)):
        return [i for i in items.values() if i["status"] == "pending"]
    @app.post("/approvals/{aid}/decision")
    def decide(aid: str, d: Decision, u=Depends(user)):
        name, roles = u
        if "reviewer" not in roles:
            raise HTTPException(403, "reviewer role required")
        if (item := items.get(aid)) is None:
            raise HTTPException(404, "unknown approval")
        if check_self and item["requested_by"] == name:
            raise HTTPException(403, "cannot decide your own request")
        if item["status"] != "pending":
            raise HTTPException(409, f"already {item['status']}")
        item["status"] = "approved" if d.decision == "approve" else "rejected"
        app.state.audit.append({"approval_id": aid, "by": name, "decision": d.decision, "reason": d.reason})
        return {"id": aid, "status": item["status"]}
    return app

# Point at your real API later: AUDITMESH_APPROVAL_APP="auditmesh.approvals.api:create_app"
spec = os.environ.get("AUDITMESH_APPROVAL_APP", "")
factory = getattr(importlib.import_module(spec.split(":")[0]), spec.split(":")[1]) if spec else standin_create_app

def run_harness(app) -> list[str]:
    c, fails = TestClient(app), []
    h = lambda tok: {"Authorization": f"Bearer {tok}"}
    post = lambda aid, tok, **body: c.post(f"/approvals/{aid}/decision", json=body, headers=h(tok)).status_code
    expect = {
        "no token": (c.get("/approvals").status_code, 401),
        "pending list": (len(c.get("/approvals", headers=h("tok-priya")).json()), 2),
        "ops cannot approve": (post("ap-1", "tok-ravi", decision="approve", reason="looks fine"), 403),
        "reason required": (post("ap-1", "tok-priya", decision="reject", reason=""), 422),
        "own request": (post("ap-2", "tok-priya", decision="approve", reason="my own finding"), 403),
        "approve": (post("ap-1", "tok-priya", decision="approve", reason="evidence checked: LMS export Q3"), 200),
        "double decision": (post("ap-1", "tok-meera", decision="reject", reason="second click"), 409),
        "unknown id": (post("ap-9", "tok-meera", decision="approve", reason="does not exist"), 404),
        "pending after": (len(c.get("/approvals", headers=h("tok-priya")).json()), 1),
    }
    fails = [f"{k}: got {got}, want {want}" for k, (got, want) in expect.items() if got != want]
    audit = app.state.audit
    if [(e["approval_id"], e["by"], e["decision"]) for e in audit] != [("ap-1", "priya", "approve")]:
        fails.append(f"audit trail wrong: {audit}")
    if audit and not audit[0].get("reason"): fails.append("audit event has no reason")
    return fails

fails = run_harness(factory(USERS, SEED))
print("target:", fails or "all approval API checks passed")
assert fails == []
broken = run_harness(standin_create_app(USERS, SEED, check_self=False))
print("broken:", broken)
assert broken[0] == "own request: got 200, want 403"     # self-approval is caught
print("OK: approval API acceptance harness")
```

- `standin_create_app` sirf approval API ka stand-in hai; aapka real API (graph resume ke saath) `AUDITMESH_APPROVAL_APP` se plug hota hai.
- `expect` dict ka order hi test sequence hai (approve ke baad double decision 409, pending 2 se 1); `Decision` model ka `min_length=5` khali reason pe 422 deta hai.
- `broken` run (self-check off) -- Priya wala pilot bug pakda gaya, saath mein uske side effects (pending count, audit) bhi.

```python
# real version -- not run here, needs: pip install streamlit httpx
import os
import httpx
import streamlit as st
API = os.environ["AUDITMESH_API_URL"]
HEADERS = {"Authorization": f"Bearer {os.environ['AUDITMESH_UI_TOKEN']}"}   # demo only; real: per-user SSO token
st.title("AuditMesh -- pending approvals")
for item in httpx.get(f"{API}/approvals", headers=HEADERS, timeout=10).json():
    with st.expander(f"{item['id']} -- {item['action']}"):
        st.json(item["args"])                                            # exactly what will run
        reason = st.text_input("Reason", key=f"reason-{item['id']}")
        for col, decision in zip(st.columns(2), ("approve", "reject")):
            if col.button(decision.title(), key=f"{decision}-{item['id']}"):
                r = httpx.post(f"{API}/approvals/{item['id']}/decision", headers=HEADERS, timeout=10,
                               json={"decision": decision, "reason": reason})
                if r.is_success:
                    st.rerun()                                   # stops this run, reloads the list
                st.error(r.json().get("detail"))
```

```python
# real version -- not run here, needs: pip install gradio httpx
import os
import gradio as gr
import httpx
API, H = os.environ["AUDITMESH_API_URL"], {"Authorization": f"Bearer {os.environ['AUDITMESH_UI_TOKEN']}"}

def load():
    return [[i["id"], i["action"], str(i["args"])] for i in httpx.get(f"{API}/approvals", headers=H, timeout=10).json()]
def decide(aid, decision, reason):
    r = httpx.post(f"{API}/approvals/{aid}/decision", headers=H, timeout=10, json={"decision": decision, "reason": reason})
    return r.json().get("status") or str(r.json().get("detail")), load()
with gr.Blocks(title="AuditMesh approvals") as demo:
    table = gr.Dataframe(headers=["id", "action", "args"], value=load)
    aid, reason = gr.Textbox(label="Approval id"), gr.Textbox(label="Reason")
    decision, out = gr.Radio(["approve", "reject"], label="Decision"), gr.Textbox(label="Result")
    gr.Button("Submit").click(decide, [aid, decision, reason], [out, table])
demo.launch()
```

### Mini-exercise (30-60 min)
AuditMesh deliverables #3 + #8 (HITL workflows, interfaces for human approval) + **CP8 gate**.
- `auditmesh/approvals/api.py` (aapka, graph resume ke saath) + ye harness as `tests/acceptance/test_approvals.py`; ek UI jo sirf API call kare. Saare harnesses ek command se: `pytest tests/acceptance -q` (M16-06, M16-07, M16-08, M16-09) + M16-03 SLA check + M16-05 handoff validator.
- `auditmesh/docs/`: process map, HITL capacity, SLA, trust boundaries, handoff package (M16-01..05). Release: `git tag -a v1.0 -m "AuditMesh v1.0"` aur `git push origin v1.0`; release notes mein harness results.
- 5-min demo video (English). Script outline:
  1. 0:00-0:30 -- problem: Kavach (fictional) quarterly access review, 3 weeks, ~100 analyst hours, sign-off waits.
  2. 0:30-1:15 -- architecture: supervisor + workers, approval interrupt, Jira MCP server, traces.
  3. 1:15-2:30 -- live: run pauses, reviewer approves with reason in the UI, ticket appears once (retry = same ticket).
  4. 2:30-3:15 -- live: self-approval blocked, injected ticket text does nothing, runaway worker stops at step limit.
  5. 3:15-4:15 -- dashboard: cost per run, p95 vs SLO, pending approvals; `pytest tests/acceptance` green.
  6. 4:15-5:00 -- business: hours saved, risk-tiered review, handoff (RACI, runbooks); close with phase 2.
- Full mock interview loop (4 rounds) with Claude, scored -- Module 18 in the portal (M18-07 project deep-dive, M18-10 demo critique, M18-12 full mock loop).

### Presenting both capstones in an FDE interview
- Customer problem aur measured result se shuru karo, stack se nahi: "3-week review -> agent pass in minutes, humans see only high-risk items."
- OmniGuard = secure integration (auth, RAG + SQL, guardrails, deploy). AuditMesh = controlled agent orchestration (HITL, MCP boundaries, SLAs, handoff). Saath mein: "I can ship AI into a regulated customer and hand it over."
- Har project ki ek "what broke" STAR story (duplicate tickets on retry -> idempotency key; self-approval -> 403). Code nahi, harness dikhao: "Here is how I proved it" interviewer ko zyada convince karta hai.

### Common pitfalls
- Rules sirf UI mein (button disable) -- direct API call se bypass. Harness API pe chalao.
- Sab reviewers ke liye ek shared UI token -- audit mein "by" hamesha ek hi naam. Per-user SSO token use karo.

### Checklist before moving on (CP8 gate)
- [ ] `pytest tests/acceptance -q` green: supervisor, Jira MCP, dashboard, approvals; SLA + handoff checks pass.
- [ ] Approval UI (Streamlit ya Gradio) sirf API ke through kaam karta hai; self-approval 403.
- [ ] `auditmesh/docs/` mein M16-01..05 ke documents; `v1.0` tag pushed, GitHub release with notes; 5-min demo video (English) README mein linked.
- [ ] Module 18 full mock loop done aur scored; dono capstones ki STAR stories ready.

### Related
- M10-04 Requesting manual state approval
- M12-06 Implementing Role-Based Access Control
- M12-10 Audit logging
- M16-06 Developing a LangGraph Multi-Agent Supervisor
- M15-09 Finalizing Dockerized FastAPI cloud deployments

### Self-quiz
1. Self-approval check UI mein hai, API mein nahi. Ek reviewer ise kaise bypass karega?
2. Approver ko action ka summary ke bajaye exact args kyun dikhane chahiye?
3. Do reviewers ne ek saath approve dabaya. Kise kaunsa response code mile aur graph kitni baar resume ho?
4. Interview mein 2 minute mein AuditMesh explain karo: problem, design, kya toota, kaise prove kiya.
