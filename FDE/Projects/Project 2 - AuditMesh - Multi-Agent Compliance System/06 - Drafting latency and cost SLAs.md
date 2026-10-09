# AuditMesh - Multi-Agent Compliance System

## Drafting latency and cost SLAs

> Deliverable 06 of 8 | Built in: Fast CP8 / Slow CP10 | Time box: 3 h

### Goal
Write a measurable SLA for AuditMesh that covers only what you control, keep its numbers in a config file, and check it automatically against real trace exports so pass/fail is never a matter of opinion.

### Customer context (Kavach Finserv compliance team)
- Kavach procurement wants one page before signing the SOW: how fast, how cheap, how reliable -- in numbers.
- Meera wants "audit in 1 hour", Finance wants a fixed cost per run, Anil asks who answers when it is down.
- The previous vendor wrote "near real-time" while human review took 3 days; the breach dispute lasted 2 months.
- Human review wait is real but is not agent latency; it gets its own SLO, outside the SLA clock.

### What to build
```text
auditmesh/
  docs/sla.md           # SLI / SLO / SLA table, measurement window, out-of-scope section
  sla.yaml              # machine-checkable targets
  tools/sla_check.py    # reads a JSON-lines trace export, prints a markdown weekly report
tests/acceptance/test_sla.py
```
- `sla.yaml` keys: `window_runs` (e.g. 200), `steps_p95_seconds` (`collect`, `check`, `flag`, `draft_tickets`), `max_cost_per_run_usd`, `availability_target`, `price_per_mtok` (`input`, `output`) with a "measured on" date.
- SLA table columns: SLI | SLO (internal) | SLA (customer) | Source. Rows at least: p95 agent latency per step, cost per run (p95), availability (runs finishing), human review cleared (reported, not penalised).
- Rules: p95 (state the percentile method), latency on successful runs only, failures count against the error budget, retries included in latency.
- Error budget = `(1 - availability_target) x runs in window`; report `error_budget_used` (above 1 = breach).
- Out of scope section in the doc: human review wait, Jira downtime, customer network.
- Every number in the doc carries "measured on <date>, N runs".

### Inputs: lessons to (re)read
- M14-02 Exponential backoff (retries in latency), M14-10 Span-level traces, M14-11 Token costs and endpoint latency, M14-16 Model selection and routing.
- M16-01 Mapping the 5-step workflow, M16-02 HITL bottlenecks (review queue SLO).
- M16-03 Drafting latency/cost SLAs (the SLA checker), M16-08 dashboards (SLO lines on panels).

### Acceptance checks
Using the M16-03 checker pattern on your own export:
1. Calibrated on at least 20 local runs from your own traces (not invented numbers).
2. Healthy export -> no violations, `error_budget_used <= 1`.
3. Deliberately slowed `check` step -> a "p95 check" violation.
4. Raised failure rate -> an "error budget" violation.
5. Cost p95 above `max_cost_per_run_usd` -> a cost violation.
6. Report output is markdown, suitable to paste into the weekly review with Meera.
7. The checker runs in CI on a fixture export and fails the build on any violation.

### Proof for the gate
- `auditmesh/docs/sla.md` committed with measured numbers and dates.
- CI log showing the healthy pass and the regressed fail.

### Definition of done
- Targets live only in `sla.yaml`; the doc and the checker read the same values.
- No SLA line depends on something Kavach controls (reviewers, Jira, network).
- You can explain SLI vs SLO vs SLA vs error budget with the Kavach example.

### Out of scope
- Contractual penalties and credits (legal owns those).
- Uptime of Kavach's own Jira.

### Stretch goals
- Compare two models in the report: cost per run vs p95 `check` latency, as input to a routing decision.
- Rolling 30-day window alongside the last-200-runs window.
