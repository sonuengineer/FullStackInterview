# OmniGuard - Secure AI Integration

## Technical discovery and scoping

> Deliverable 08 of 12 | Built in: Fast CP6 / Slow CP8 | Time box: 4 h

### Goal
Turn a one-line customer ask ("we want ChatGPT, but data must not leave") into a written, measurable 4-6 week pilot scope that every stakeholder can agree to. This document is the input to the classification (09), SOW (10), ROI (11) and UAT (12) deliverables.

### Customer context (Kavach Finserv)
Kavach Finserv is a fictional mid-size insurer and lender in Pune (~1,200 staff). Stakeholders: Anil Rao (CISO, can block), Priya (Head of Claims, economic buyer, owns the metric), Rahul (Data lead, owns MS SQL `ClaimsDB`), Meera (SharePoint/Ops, owns policy PDFs), procurement, and 40 claims analysts plus 12 underwriters as daily users. Known constraints: India region only, SSO via Azure AD, no unmasked PII to an external LLM, no writes to `ClaimsDB`.

### What to build
- Run a mock discovery workshop (2 x 90 min agenda from M15-01, or a 30-minute role-play with a friend acting as the CISO). Take notes live in the one-fact-per-line format.
- `omniguard/docs/discovery.md` with exactly these sections:
  - Business goal
  - Stakeholders (name, role, influence, can block?)
  - Users / personas (role, count, top 3 questions)
  - Data sources (system, owner, classification, access path)
  - Constraints and security requirements
  - Success metrics (metric | baseline | target | how measured)
  - Non-goals
  - Pilot scope (weeks, users, sources)
  - Open questions (question | owner | due)
- A stakeholder map (ASCII is fine) showing who decides, who can block, who uses.
- `omniguard/tools/scope_check.py notes.txt`: validates the notes and exits non-zero if the scope is invalid.
- `omniguard/docs/discovery-notes.txt`: the raw notes the doc was built from (synthetic, no real names or claim data).

### Inputs: lessons to (re)read
- M15-01 Conducting technical discovery and scoping workshops (template, question bank, validator pattern)
- M15-02 Defining data classifications (what the "classification" column will feed)
- M11-13 Mapping complex database schemas to LLM context (data source questions)
- M12-01 Authentication vs authorization (SSO and access questions)
- M02-02 Pydantic data validation

### Acceptance checks
Automated by `scope_check.py` and its pytest suite (pattern from M15-01):
1. Every metric has a baseline, a target and a measurement method; a target without a number (for example "faster") is rejected.
2. Pilot length is between 4 and 6 weeks; a 12-week "pilot" fails.
3. At least 2 success metrics and at least 2 non-goals; missing non-goals fail.
4. At least 1 open question with an owner and a due date; an unknown baseline (`?`) is reported as an open question, not hidden.
5. Every data source has an owner and one of `public / internal / confidential / restricted`.
6. A deliberately invalid notes file in `tests/` makes `scope_check.py` exit 1.
Manual review:
7. All 9 sections present in `discovery.md`, each non-empty.
8. The CISO's constraints are captured from the first session, not added at the end.

### Proof for the gate
`omniguard/docs/discovery.md` committed before the v1.0 tag (CP6), linked from the README, with the scope check green in CI.

### Definition of done
- `discovery.md`, notes file and `scope_check.py` in the repo; CI runs the check.
- The pilot scope names 1 user group, 1-2 data sources and the metric that must move in 4-6 weeks.
- The top of the doc states "Fictional customer -- portfolio sample".

### Out of scope
Architecture and solution design (that belongs in the SOW, Deliverable 10), pricing, legal terms, real customer data of any kind.

### Stretch goals
- Record a 5-minute mock workshop clip and add 3 lessons learned to the doc.
- Generate the markdown doc from the validated notes so the two never drift.
- Add a RAID log (risks, assumptions, issues, dependencies) seeded from the open questions.
