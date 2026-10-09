# OmniGuard - Secure AI Integration

## Data classification

> Deliverable 09 of 12 | Built in: Fast CP6 / Slow CP8 | Time box: 4 h

### Goal
Give every data asset OmniGuard touches a sensitivity level and turn each level into enforceable handling rules: may it go to the LLM, be indexed, be logged, who may see it, in which region. The same file is a policy the CISO signs and a config the code and CI enforce.

### Customer context (Kavach Finserv)
Anil (CISO) asked one question after discovery: "Which column reaches the LLM, and which never does?" Rahul sent 140 `ClaimsDB` columns and Meera 3,000 PDFs. Without a written classification, sooner or later `aadhaar_no` gets indexed and logged. Relevant regulation may include the DPDP Act 2023 and IRDAI guidelines; exact obligations are confirmed by Kavach's compliance team, not interpreted by you.

### What to build
- `omniguard/config/classification.yaml`: the single source of truth.
  - `levels: [public, internal, confidential, restricted]`
  - `rules.<level>`: `llm` (allow | masked | never), `index` (true | false), `log` (allow | masked | never), `regions`, `roles`
  - `inventory`: every asset -> level (tables, columns, PDF types, and also prompts, LLM responses, embeddings, eval datasets, logs, caches)
- Fail closed: any asset not in the inventory is treated as `restricted`.
- Highest level wins: a document with one restricted page is restricted.
- `omniguard/tools/flow_check.py`: reads a list of data flows (asset, action, masked, region) and exits 1 on any violation.
- A flow list covering your real architecture: retrieval, LLM call, logging, cache, eval dataset, SQL rows in the answer.
- `omniguard/docs/data-classification.md`: the level table with handling rules, and the asset table:
  `| Asset | Level | Owner | Reason | Approved by | Date |`
- Wire-up points (consumed by other deliverables): chunk `classification` metadata (01), restricted columns excluded from schema context (04), masking policy (06), log policy (06).

### Inputs: lessons to (re)read
- M15-02 Defining data classifications (levels table, YAML policy, flow checker pattern)
- M15-01 Conducting technical discovery and scoping workshops (data sources and constraints)
- M12-07 Enforcing data-level permissions in retrieval layers
- M13-04 Implementing Microsoft Presidio analyzers and anonymizers
- M13-05 Redacting sensitive entities (SSN, credit cards, emails)
- M13-14 Safe logging (never log PII or prompts)
- M11-13 Mapping complex database schemas to LLM context (data dictionary PII list)

### Acceptance checks
Automated by `flow_check.py` and its pytest suite (pattern from M15-02):
1. Every level in `levels` has a rules entry.
2. Allowed flows pass: internal policy wording indexed; masked confidential claim amount sent to the LLM in `ap-south-1`.
3. Forbidden flows fail: internal data to an LLM outside the India region; raw confidential name in logs; restricted medical notes indexed even when masked; restricted PAN to a non-India region.
4. An asset missing from the inventory (for example `claims.aadhaar_no`) is treated as restricted and its log flow fails.
5. CI runs `flow_check.py` on your real flow list; one injected violation turns CI red.
6. The schema context test from Deliverable 04 (no restricted columns) and the log scan from Deliverable 06 both read levels from this file, not from hard-coded lists.
Manual review:
7. Every asset row has an owner and an approval status; unapproved rows say so.

### Proof for the gate
`data-classification.md` and `classification.yaml` committed before the v1.0 tag (CP6), CI green on `flow_check.py`, README line: "classification draft -- pending owner sign-off" (honest status).

### Definition of done
- One YAML source; the markdown tables are generated from it or verified against it in CI.
- Every flow in your architecture diagram appears in the flow list.
- Both directions tested: allowed flows pass and forbidden flows fail.

### Out of scope
Legal interpretation of DPDP or IRDAI rules, data retention automation, classifying Kavach's systems outside the pilot scope.

### Stretch goals
- Generate `docs/data-classification.md` from the YAML in a pre-commit hook.
- Add retention days per level and a test that log retention config matches.
- Classify embeddings derived from confidential text and document the reasoning.
