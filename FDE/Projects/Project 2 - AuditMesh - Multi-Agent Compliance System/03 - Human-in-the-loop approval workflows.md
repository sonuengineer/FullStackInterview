# AuditMesh - Multi-Agent Compliance System

## Human-in-the-loop approval workflows

> Deliverable 03 of 8 | Built in: Fast CP7 / Slow CP9 | Time box: 6 h

### Goal
Turn the graph's approval interrupt into a real workflow: a pending approval record, an authorized human decision through an API, a durable resume from checkpoint, and an append-only audit trail. This is the CP7 / CP9 gate: a run that pauses for human approval and resumes.

### Customer context (Kavach Finserv compliance team)
- Kavach internal audit requires that sign-off on findings is done by a named human, never by the agent.
- Earlier attempt: a Slack bot where anyone typing "yes" resumed the run. The engineer who raised a finding approved it himself -- a segregation-of-duties violation.
- A reviewer wanted to change severity P1 -> P2, but only approve/reject existed, so they rejected and filed by hand, breaking the audit trail.
- Approvals can wait days; the run must survive restarts while it waits.

### What to build
```text
auditmesh/
  checkpoint.py       # durable checkpointer, DB path from AUDITMESH_CHECKPOINT_DB (M10-01)
  graph_runtime.py    # interrupt before ticket_writer + list_pending() (M10-03)
  approvals/
    api.py            # create_app(...) -> FastAPI app (shared with deliverable 08)
    store.py          # approval records + append-only audit table
tests/acceptance/test_hitl_resume.py
```
- Approval record: `id, thread_id, action, args, requested_by, status, decided_by, expires_at`. The interrupt payload also carries `finding_id` and `evidence_links`.
- `GET /approvals` -> `[{"id": "ap-1", "action": "create_compliance_ticket", "args": {...}, "requested_by": "agent:auditmesh", "status": "pending"}]` (pending only).
- `POST /approvals/{id}/decision` body -> `{"decision": "approve" | "edit" | "reject", "reason": "...", "edited_args": {...}}`; response -> `{"id": "ap-1", "status": "approved", "args": {...}}` with the final args.
- Status codes: 401 no/invalid token, 403 not a reviewer, 403 own request, 404 unknown id, 409 already decided, 410 expired, 422 invalid edit or missing reason.
- Edited args are validated with the same schema the Jira tool uses.
- Status update and audit row commit in one transaction. Resume uses `Command(resume=decision)` on the stored `thread_id`, preferably from a worker rather than inside the HTTP request.
- The ticket writer uses the approved args only; the args hash must match the approval (M16-04 approval binding).

### Inputs: lessons to (re)read
- M10-01 Check-pointing graph states, M10-03 Interrupting graph execution, M10-04 Requesting manual state approval.
- M12-02 JWT tokens, M12-06 RBAC, M12-10 Audit logging, M13-14 Safe logging.
- M14-01 Idempotency keys (no double resume, no double ticket).
- M16-02 HITL bottlenecks (risk tiers decide which findings need approval).
- M16-06 supervisor harness and M16-09 approval API harness.

### Acceptance checks
The M10-04 gate test (you write it), plus the rules the M10-04 example asserts:
1. Start a run on a P1 finding; assert `status == "interrupted"` and ticket count 0.
2. Create a new app/runtime instance (simulated restart), approve via the API, assert the final state has a `ticket` and ticket count is 1.
3. Reject path: ticket count stays 0 and the reason is stored.
4. Requester approving their own request -> 403; a non-reviewer -> 403.
5. Edit with invalid args (`severity: P0`) -> 422; a valid edit resumes with the edited args.
6. A second decision -> 409; an expired record -> 410.
7. Exactly one audit row and one resume per decided approval.
Also green: M16-06 checks for "approval before ticket" and "no ticket after reject".

### Proof for the gate
- Terminal recording or log: run pauses, process restarts, approval via curl, run resumes, one ticket in the fake Jira.
- CI link with the HITL tests green.

### Definition of done
- All checks pass; restart-resume is proven with a fresh process or fresh objects, not the same in-memory graph.
- No decision is possible without an authenticated reviewer.

### Out of scope
- The reviewer-facing UI (deliverable 08).
- Slack/Teams interactive approval buttons.

### Stretch goals
- Risk-tiered routing from M16-02: high risk -> approval, medium -> 1-in-10 sample, low -> auto-accept with an audit row.
- Concurrency test: two reviewers decide at the same time, exactly one wins, the graph resumes once.
