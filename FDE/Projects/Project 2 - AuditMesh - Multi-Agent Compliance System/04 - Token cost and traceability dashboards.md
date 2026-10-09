# AuditMesh - Multi-Agent Compliance System

## Token cost and traceability dashboards

> Deliverable 04 of 8 | Built in: Fast CP8 / Slow CP10 | Time box: 6 h

### Goal
Derive every operational number Kavach asks about -- cost per run, cost by model, p95 latency, runs in flight, pending approvals -- from span-level traces through one tested data contract, and render it in a dashboard that never shows prompt text or PII.

### Customer context (Kavach Finserv compliance team)
- After the first full quarterly run: Finance asked why the LLM bill was 4x, Meera asked how many approvals were pending, Anil asked how slow last night's run was.
- Answering took 40 minutes across 3 tools, and the pending count was wrong (requested events counted, decided ones not subtracted).
- A screenshot leaked a prompt containing a PAN number. Dashboards must carry ids, counts and hashes only.

### What to build
```text
auditmesh/
  tracing.py               # span export as JSON lines (M14-10)
  dashboard/
    data.py                # build_dashboard(spans, prices) -> contract JSON
    prices.yaml            # USD per 1M input/output tokens per model, with "last_updated"
    app.py                 # Streamlit page, or a Grafana/Langfuse board fed by data.py
tests/acceptance/test_dashboard.py
```
- Span kinds: `run` (start, end or null), `llm` (model, in_tok, out_tok), `tool`, `approval` (approval_id, event: requested/approved/rejected).
- Contract (top-level keys): `runs`, `p95_run_latency_s`, `cost_total_usd`, `cost_by_model_usd`, `approvals_pending`, `runs_in_flight`.
- Each `runs[]` row: `run_id`, `tokens`, `cost_usd`, `latency_s` (null while running).
- Rules: cost = tokens x price per model from config; p95 over finished runs only; pending = requested minus decided.
- Panels and alerts (alert names must match the deliverable 07 runbooks):

| Panel | Alert -> runbook |
|---|---|
| Cost per run (p95), cost by model | `cost_per_run_spike` -> RB-02 |
| p95 run latency vs SLO line | latency SLO burn |
| Approvals pending, oldest age | `review_queue_stale` -> RB-03 |
| Failed runs / error budget | `run_failed_rate_high` -> RB-01 |

- Trace drill-down: click a run_id -> timeline of that run's spans (access-controlled, no prompt text on aggregate panels).
- Harness hook: `AUDITMESH_DASHBOARD_FN="auditmesh.dashboard.data:build_dashboard"`.

### Inputs: lessons to (re)read
- M14-10 Span-level execution traces, M14-11 Token costs and endpoint latency, M14-15 Prompt caching, M14-16 Model selection and routing.
- M14-12 Debugging multi-step agent reasoning (slow track; drill-down).
- M13-14 Safe logging (never log PII or prompts).
- M16-03 SLAs (SLO lines), M16-08 Token cost/trace dashboards (the acceptance harness).

### Acceptance checks
Automated by the M16-08 harness against your function:
1. All six contract keys are present.
2. Every per-run row has `run_id`, `tokens`, `cost_usd`, `latency_s`.
3. Per-run token totals match ground truth.
4. Total cost matches ground truth (tolerance 1e-6).
5. p95 latency excludes in-flight runs.
6. `runs_in_flight` counts the 2 unfinished runs.
7. `approvals_pending` equals requested minus decided.
8. The synthetic PAN `ABCDE1234F` does not appear anywhere in the output.
Teeth test: the naive pending count (requested only) must fail check 7.

### Proof for the gate
- CI link with `pytest tests/acceptance/test_dashboard.py -q` green.
- README screenshot of the dashboard on synthetic data -- no prompt text or PII visible -- with the price table "last updated" date.

### Definition of done
- 8/8 checks green, adapted to your tracer's real export format.
- Every panel names its source span kind and formula in the README.
- Each alert links to a runbook from deliverable 07.

### Out of scope
- A production metrics backend or long-term trace storage.
- Billing reconciliation against the provider invoice.

### Stretch goals
- SQL version of the per-run panel once spans land in a warehouse table.
- Cost saved by prompt caching and model routing as its own panel.
