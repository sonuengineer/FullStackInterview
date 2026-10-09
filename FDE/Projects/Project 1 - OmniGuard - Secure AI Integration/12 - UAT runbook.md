# OmniGuard - Secure AI Integration

## UAT runbook

> Deliverable 12 of 12 | Built in: Fast CP6 / Slow CP8 | Time box: 5 h

### Goal
Replace "try it and tell us" with a runbook business users can execute: who tests what, on which data, with which checkable expected result, how defects are logged and graded, and the pre-agreed rules for go/no-go and sign-off. This is where the SOW acceptance criteria are proven or failed.

### Customer context (Kavach Finserv)
Week 5 of the pilot, OmniGuard is on staging. Priya told 6 analysts to "try it"; two days later the feedback was "sometimes good, sometimes wrong" and one analyst saw an underwriter-only report. Nobody knew which question, which user, or whether it blocks go-live. Priya (Head of Claims) is the named business owner who signs off.

### What to build
- `omniguard/docs/UAT-runbook.md` with sections: scope, environment (staging URL, test SSO users), test data (synthetic or masked only), entry criteria, roles, schedule, test cases, defect process and severity table, exit (go/no-go) criteria, sign-off block.
- `omniguard/uat/cases.yaml`: at least 15 cases. Each case: `id` (`UAT-NN`), `req` (SOW deliverable `Dn`), `persona` (`claims_analyst` | `underwriter`), `steps`, `expected` (a checkable rule, not "works as expected").
- Coverage across: RAG accuracy (cites the clause), Text-to-SQL safety (zero writes), two-user RBAC, PII masking, prompt injection, deploy/health.
- Keep the IDs used elsewhere: UAT-01 (D1 RAG citation), UAT-06 (D2 refused delete, zero writes), UAT-07 (D3 underwriter gets 403 or refusal on medical notes, nothing in logs), UAT-08 (D4 report export).
- Severity table: Sev1 = restricted data to the wrong role, any DB write, core flow down (always blocks); Sev2 = wrong or missing answer with a workaround (blocks above the agreed limit); Sev3 = cosmetic (never blocks).
- `omniguard/tools/uat.py validate cases.yaml` and `omniguard/tools/uat.py decide results.yaml` (prints GO or NO-GO with reasons).
- Where a case is automated, link its acceptance test (for example UAT-07 -> `test_auth.py` two-user check from M15-06).
- `omniguard/uat/results.yaml` and a filled results table from your own UAT run.

### Inputs: lessons to (re)read
- M15-05 Delivering User Acceptance Testing (UAT) runbooks (case format, validator, go/no-go rules)
- M15-03 Drafting architecture SOWs (deliverables and criteria to trace)
- M15-06 Executing mock OAuth 2.0 / RBAC flows; M15-07 Constructing Hybrid RAG alongside secure Text-to-SQL for MS SQL databases
- M15-08 Implementing NeMo & Presidio guardrails; M15-09 Finalizing Dockerized FastAPI cloud deployments
- M02-17 End-to-end testing fundamentals

### Acceptance checks
Automated by `uat.py` and its pytest suite (pattern from M15-05):
1. `validate`: no duplicate IDs, only known personas, every `expected` is checkable (rejects "works", "fine", "as expected", "correct answer", or under 15 characters).
2. `validate`: every SOW deliverable `Dn` has at least one case.
3. `decide`: all pass + named sign-off -> GO.
4. `decide`: any open Sev1 (for example UAT-07 leak) -> NO-GO.
5. `decide`: Sev2 above the limit or without a workaround -> NO-GO; one Sev2 with a workaround -> GO (include this sample `results.yaml`).
6. `decide`: any case not executed -> NO-GO ("not executed" is not a pass).
7. `decide`: pass rate below threshold or no sign-off -> NO-GO.
Cross-document checks:
8. Every UAT ID referenced in `SOW.md` exists in `cases.yaml`.
9. Cases marked automated have a passing test in `omniguard/tests/acceptance/`.

### Proof for the gate
`UAT-runbook.md`, `cases.yaml` and filled `results.yaml` committed before the v1.0 tag (CP6); the go/no-go output appears in the GitHub release notes and the business section of the demo video.

### Definition of done
- At least 15 cases, all traceable to SOW deliverables; validator exit 0.
- A real (self-run) UAT on the deployed instance with results recorded and a GO/NO-GO decision.
- Test data is synthetic; no real-looking customer data in screenshots.

### Out of scope
Load/performance testing, accessibility audits, real business users, a test management tool (YAML + markdown is enough).

### Stretch goals
- Generate the printable tester table from `cases.yaml` (M15-05 pattern) and a defect log template.
- Auto-fill results for automated cases from the pytest JSON report.
- A rollback/hypercare section for the first week after go-live.
