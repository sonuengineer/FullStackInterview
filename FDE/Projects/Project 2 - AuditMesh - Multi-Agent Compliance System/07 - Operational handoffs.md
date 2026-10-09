# AuditMesh - Multi-Agent Compliance System

## Operational handoffs

> Deliverable 07 of 8 | Built in: Fast CP8 / Slow CP10 | Time box: 4 h

### Goal
Hand AuditMesh over so Kavach's compliance and IT teams can run it and handle an incident without you: runbooks per alert, an on-call rota, a RACI, a role-based training plan, and objective exit criteria -- all in one validated package.

### Customer context (Kavach Finserv compliance team)
- UAT has passed and your engagement ends in 3 weeks.
- Last quarter another vendor's bot failed at 2 AM; the alert went to a vendor engineer who had already left. The quarter-end report was 4 days late and Meera apologised to the board.
- Meera's rule: "Handoff is done when my team and Anil's team handle an incident without you."
- Fictional people for the docs: Meera (compliance lead), Anil (IT), analysts Priya and others, on-call engineers Ravi and Sana.

### What to build
```text
auditmesh/docs/handoff/
  handoff.yaml        # single source: slos, dashboards, alerts, runbooks, raci, oncall, trained
  runbooks.md         # RB-01 .. RB-03, generated from or checked against handoff.yaml
  training-plan.md    # 3 x 60 min sessions by role, each with a hands-on exercise
  raci.md             # activities x people, with a sign-off line
auditmesh/tools/handoff_check.py
```
- Alerts -> runbooks (names match deliverable 04): `run_failed_rate_high` -> RB-01, `cost_per_run_spike` -> RB-02, `review_queue_stale` -> RB-03.
- Each runbook: symptom, first 3 checks, a safe action (for example rerun from checkpoint), escalation, owner. Steps under 15 words, each with a command or link.
- RACI activities at least: approve exceptions, respond to alerts, change risk thresholds. Exactly one A per activity; you end as C, not R.
- On-call: primary and secondary are different people and both ops-trained; you are secondary only during shadow weeks.
- Training sessions: Reviewing (analysts, Meera), Running (Kavach IT on-call, game day), Owning (Meera, CISO delegate).
- Exit criteria: customer led at least 2 incidents with you shadowing; every SLO has a live panel; every runbook dry-run tested.

### Inputs: lessons to (re)read
- M10-01 Check-pointing (the "rerun from checkpoint" action).
- M15-05 UAT runbooks.
- M16-03 SLAs, M16-05 Leading operations and training handoffs (the readiness validator), M16-08 dashboards, M16-09 approval UI (reviewer training).

### Acceptance checks
Using the M16-05 validator pattern on your `handoff.yaml`:
1. Complete package -> 0 gaps.
2. Every SLO from deliverable 06 has a dashboard panel.
3. Every alert maps to a runbook with steps and an owner.
4. Every RACI activity has exactly one A and at least one R.
5. Every on-call week has distinct primary/secondary, both ops-trained.
6. Every role (ops, reviewer, admin) has at least one trained person.
7. A deliberately broken copy (missing panel, missing runbook, two As, same person twice, zero shadow incidents) reports every gap.
8. Your extra check: runbook steps are short and carry a command or link.

### Proof for the gate
- CI step running the validator on `handoff.yaml`, green, plus the broken-copy test.
- A timed game-day log: you followed RB-01 end to end (Jira MCP down, rerun from checkpoint).

### Definition of done
- Validator green; docs and YAML agree.
- A 15-minute reviewer training script (English) covering approve, reject with reason, and "cannot approve own request".
- RACI names Meera and Anil (fictional) with a sign-off line.

### Out of scope
- Kavach's company-wide incident process and paging tool setup.
- Recording the actual training sessions.

### Stretch goals
- Generate `runbooks.md` and `raci.md` from `handoff.yaml` so they cannot drift.
- A second game day for RB-02 (cost spike) run by someone else using only the runbook.
