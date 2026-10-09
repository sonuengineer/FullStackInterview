# AuditMesh - Multi-Agent Compliance System

## Supervisor-based agent architecture (LangGraph)

> Deliverable 01 of 8 | Built in: Fast CP7 / Slow CP9 | Time box: 8 h

### Goal
Build the LangGraph supervisor that runs the Kavach Finserv quarterly access review: it routes each task to the right worker, pauses for human approval before any Jira write, never auto-routes an unknown task, and always stops at a step limit instead of looping.

### Customer context (Kavach Finserv compliance team)
- Meera (Head of Compliance) runs a quarterly access review: 40 internal apps, ~1,200 access grants, 3 analysts, 3 weeks in Excel.
- Pilot bugs she will ask about: a policy checker that looped for 40 minutes and USD 30 of tokens, and a misspelled `file_ticket` task sent to the "closest" worker.
- Her condition: "Prove the agent never files a ticket without approval and never gets stuck in a loop."

### What to build
Layout (your code, your names inside the files):
```text
auditmesh/
  graph.py              # build_graph() -> StateGraph(...).compile(checkpointer=...)
  state.py              # typed state: task, evidence, findings, status, approval
  checkpoint.py         # checkpointer wiring, DB path from AUDITMESH_CHECKPOINT_DB (M10-01)
  harness_adapter.py    # run(task, step_limit) -> {"trace": [...], "status": ...}
tests/acceptance/test_supervisor.py
```
- Nodes: `supervisor`, `evidence_collector`, `policy_checker`, `reporter`, `human_approval` (interrupt), `ticket_writer`, `human_triage`.
- Routing table (task.type -> worker): `collect_evidence` -> `evidence_collector`, `policy_check` -> `policy_checker`, `file_ticket` -> `human_approval` then `ticket_writer`, `report` -> `reporter`. Anything else -> `human_triage`.
- Supervisor decisions use structured output (enum of worker names), never free text.
- Status values the adapter must return: `done`, `rejected`, `needs_human`, `step_limit`.
- `recursion_limit` set from config (default 12 for the harness); hitting it returns `step_limit`, not an exception.
- Harness contract: `run(task: dict, step_limit: int) -> dict`, exposed as `AUDITMESH_SUPERVISOR="auditmesh.harness_adapter:run"`.
- README: graph diagram from `graph.get_graph().draw_mermaid()`.

### Inputs: lessons to (re)read
- M09-04 Supervisor and Router patterns, M09-05 Graphs and state, M09-06 Nodes and edges, M09-07 Conditional routing, M09-08 Compiling graphs.
- M09-11 Map-reduce for parallel evidence collection (M09-10, M09-12 on the slow track).
- M10-01 Check-pointing, M10-03 Interrupting execution, M10-05 Detecting infinite loops, M10-12 Vendor agent SDKs (your framework decision).
- M16-06 Developing a LangGraph Multi-Agent Supervisor (the acceptance harness).

### Acceptance checks
Automated by the M16-06 harness, run against your graph via `AUDITMESH_SUPERVISOR`:
1. `collect_evidence`, `policy_check`, `report` each run exactly their own worker, status `done`, and no other worker appears in the trace.
2. Unknown type (`delete_all_users`) -> status `needs_human`, `human_triage` in trace, no worker ran.
3. `file_ticket` approved -> status `done`, `human_approval` appears before `ticket_writer`.
4. `file_ticket` rejected -> status `rejected`, `ticket_writer` never runs.
5. Runaway worker (never reports done) -> status `step_limit`, trace length <= step limit.
6. No trace ever exceeds the step limit.
7. Restart test (yours): pause at approval, build a new graph object on the same checkpointer DB, resume, ticket written exactly once.
8. Teeth test: a PR that removes `recursion_limit` turns CI red.

### Proof for the gate
- CI run link with `pytest tests/acceptance/test_supervisor.py -q` green.
- Screenshot or log of the red CI run from check 8.
- Mermaid graph diagram in the README.

### Definition of done
- All 8 checks pass locally and in CI.
- No worker can call Jira directly; only `ticket_writer`, and only after approval.
- You can explain why "unknown = human" and why a step cap is a cost control.

### Out of scope
- The Jira MCP server itself (deliverable 02) -- use a fake client here.
- The approval API and UI (deliverables 03 and 08) -- the harness plays the approver.
- Real model quality tuning of each worker.

### Stretch goals
- Parallel evidence collection across the 40 apps with map-reduce, plus a test for state conflicts (M09-12).
- A per-run token budget that ends the run with status `budget_exceeded`.
