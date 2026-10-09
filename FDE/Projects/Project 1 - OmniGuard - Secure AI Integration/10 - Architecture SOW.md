# OmniGuard - Secure AI Integration

## Architecture SOW

> Deliverable 10 of 12 | Built in: Fast CP6 / Slow CP8 | Time box: 4 h

### Goal
Write the Statement of Work that Priya, Anil and Rahul would sign: what will be built, what will not, how each piece is accepted, who does what, and what happens when scope changes. It must include the architecture and data flows so the CISO can review security from the same document.

### Customer context (Kavach Finserv)
Procurement wants the SOW by Friday. A previous vendor's SOW said "AI assistant for claims team, including integrations as needed"; the customer later asked for four extra systems and acceptance never happened because "done" was never defined. This time every deliverable needs a testable acceptance criterion tied to a UAT case ID.

### What to build
- `omniguard/docs/SOW.md` with exactly these `##` sections: Objective, Scope, Out of scope, Architecture, Deliverables, Assumptions, Acceptance criteria, Timeline, RACI, Change control, Risks.
- Architecture section: ASCII data-flow diagram of your real OmniGuard (SSO -> API -> guardrails -> LLM with masked text only; Hybrid RAG index with ACL metadata; SQL guard -> read-only replica; audit log without raw PII), region `ap-south-1`, and a reference to the classification (Deliverable 09).
- Deliverables numbered `D1..Dn` (SOW numbering, separate from the 12 portfolio deliverables), each with an `Dn:` acceptance criterion that names UAT case IDs (for example `D3: two-user test returns role-correct answers (UAT-07)`).
- Assumptions that protect the timeline (for example "read-only replica and test SSO tenant by end of week 1").
- RACI table: activities x (FDE, Rahul, Anil, Priya), exactly one `A` per row.
- Change control: written change request -> effort/timeline/cost impact -> both sides approve before work starts.
- Risks with owner and mitigation.
- `omniguard/tools/sow_lint.py docs/SOW.md` plus a GitHub Actions step that runs it on every PR.
- First line of the SOW: "Fictional customer -- portfolio sample".

### Inputs: lessons to (re)read
- M15-03 Drafting architecture SOWs (section list, linter pattern, example SOW)
- M15-01 Conducting technical discovery and scoping workshops (scope, metrics, non-goals feed this)
- M15-02 Defining data classifications (architecture section references it)
- M15-05 Delivering User Acceptance Testing (UAT) runbooks (UAT IDs the criteria point to)
- M04-09 Creating workflow YAML files (CI step for the linter)

### Acceptance checks
Automated by `sow_lint.py` and its pytest suite (pattern from M15-03):
1. All 11 required sections present and non-empty.
2. No vague wording: "as needed", "etc", "best effort", "unlimited", "and more", "TBD".
3. Every `Dn` in Deliverables has a matching `Dn:` line in Acceptance criteria.
4. Timeline does not exceed the pilot limit (6 weeks).
5. Every RACI row has exactly one `A`.
6. A bad SOW fixture (extra deliverable with no criterion, 9-week timeline, two `A`s in a row, empty Risks) produces exactly those issues.
7. CI runs the linter on PRs; a PR that adds "as needed" goes red.
Cross-document checks:
8. Every acceptance criterion's UAT ID exists in `omniguard/uat/cases.yaml` (Deliverable 12).
9. Scope and Out of scope agree with the non-goals in `discovery.md` (Deliverable 08).

### Proof for the gate
`omniguard/docs/SOW.md` committed before the v1.0 tag (CP6), linter green in CI, SOW summary shown in the business section of the demo video.

### Definition of done
- Linter exit 0 on your SOW; the bad fixture test proves the linter has teeth.
- The architecture diagram matches what is actually deployed (Deliverable 07).
- Every deliverable is testable; anything not testable has moved to Out of scope.

### Out of scope
Commercial terms, pricing, payment milestones, legal clauses, signatures from real people.

### Stretch goals
- A one-page "SOW at a glance" for executives generated from the same file.
- A sample change request (CR-001) with impact analysis, filed against the SOW.
- Check in CI that every UAT case points back to an existing `Dn`.
