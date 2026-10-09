# AuditMesh - Multi-Agent Compliance System

## Interfaces for human approval

> Deliverable 08 of 8 | Built in: Fast CP8 / Slow CP10 | Time box: 4 h

### Goal
Give Kavach reviewers a simple page to clear the approval queue -- pending list, exact args, approve or reject with a mandatory reason -- as a thin client over the approval API, with every rule enforced in the API so nobody can bypass it with curl. This deliverable closes the CP8 / CP10 gate for AuditMesh v1.0.

### Customer context (Kavach Finserv compliance team)
- The graph pauses for approval, but Meera's team only had a curl command.
- Their ask: one page with the pending list, one-click approve/reject, reason required.
- Internal audit's rule: whoever raised a finding cannot approve it, and every decision is logged. In the pilot, Priya approved her own item by mistake.
- Reviewers are analysts (Priya), Meera (reviewer + admin); IT on-call (Ravi) has ops rights only.

### What to build
```text
auditmesh/approvals/
  api.py         # create_app(users, seed) -> approval API (from deliverable 03, hardened)
  ui_streamlit.py  or  ui_gradio.py   # pick one; it calls the API only
tests/acceptance/test_approvals.py
```
- `GET /approvals` -> `[{"id": "ap-1", "action": "create_compliance_ticket", "args": {...}, "requested_by": "agent:auditmesh", "status": "pending"}]`
- `POST /approvals/{id}/decision` body -> `{"decision": "approve" | "reject", "reason": "<5-500 chars>"}`; response -> `{"id": "ap-1", "status": "approved"}`. Keep `edit` from deliverable 03 if you built it.
- Order of checks: 401 no token -> 403 no reviewer role -> 404 unknown id -> 403 own request -> 409 not pending -> 422 invalid body.
- Audit event per decision: approval_id, by, decision, reason, time.
- UI shows the exact args that will execute (not a summary), evidence links, and API error messages. Config: `AUDITMESH_API_URL`; per-user SSO token in production (a shared `AUDITMESH_UI_TOKEN` is demo only).
- Harness hook: `AUDITMESH_APPROVAL_APP="auditmesh.approvals.api:create_app"`.

### Inputs: lessons to (re)read
- M10-03 Interrupting graph execution, M10-04 Requesting manual state approval.
- M12-03 OAuth grant types (SSO), M12-06 RBAC, M12-08 Session and token lifecycle, M12-10 Audit logging.
- M16-02 HITL bottlenecks (show queue age), M16-06 supervisor (resume), M16-09 Streamlit/Gradio approval UIs (the acceptance harness).

### Acceptance checks
Automated by the M16-09 harness against your API:
1. No token -> 401.
2. Pending list returns both seeded items.
3. Ops user (no reviewer role) -> 403.
4. Empty reason -> 422.
5. Approving your own request -> 403.
6. Valid approve with reason -> 200.
7. Second decision on the same item -> 409.
8. Unknown id -> 404.
9. Pending list drops to 1 after the decision.
10. Audit trail holds exactly one event (ap-1, priya, approve) and it has a reason.
Teeth test: with the self-approval check off, check 5 fails.

### Proof for the gate
- `pytest tests/acceptance -q` green for all four harnesses (M16-06, M16-07, M16-08, M16-09), plus the SLA checker (deliverable 06) and handoff validator (deliverable 07).
- `v1.0` tag pushed with a GitHub release whose notes include the harness results.
- 5-minute English demo video linked in the README: run pauses, reviewer approves in the UI, one ticket appears; self-approval blocked.

### Definition of done
- The UI never decides anything itself; disabling a button is cosmetic, the API is the control.
- All 10 checks green; docs from deliverables 05-07 are in `auditmesh/docs/`.

### Out of scope
- Mobile layout, theming, and a production SSO integration beyond a documented plan.
- Expiry (410) and simultaneous clicks in this harness -- add them with your DB.

### Stretch goals
- Build the second UI (Gradio if you chose Streamlit) on the same API and the same harness.
- Show the oldest pending item's age and a rubber-stamp warning (decision under 5 seconds).
