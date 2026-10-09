# OmniGuard - Secure AI Integration

## Presidio guardrails

> Deliverable 06 of 12 | Built in: Fast CP6 / Slow CP8 | Time box: 6 h

### Goal
Make sure personal data never reaches the LLM provider unmasked, never appears in answers to the wrong person, and never lands in logs, including error logs. Detection must handle Indian identifiers and must not over-mask business IDs that users need to see.

### Customer context (Kavach Finserv)
Analysts paste PAN numbers, mobile numbers and emails into questions. Source PDFs and claim records also contain PAN, Aadhaar and bank details, all `restricted` in Kavach's classification (Deliverable 09). Constraint from discovery: no unmasked PII to an external LLM, data stays in the India region. A policy number like `KVF-2026-001234` must not be masked as a phone number.

### What to build
- `omniguard/guardrails/pii.py` with a `PIIService` interface: `analyze(text) -> list[result]`, `anonymize(text, results) -> str`.
  - `StandInPII` (regex, CI default) and `PresidioPII` (real, optional dependency), selected by `PII_BACKEND`.
  - Custom recognizers: `IN_PAN`, Aadhaar (with checksum validation), Indian mobile, plus email and card numbers.
- `config/pii_policy.yaml`: per-entity operator (replace, mask, hash) linked to classification levels.
- Masking at two points on the request path: the user question before the LLM call, and every retrieved chunk / SQL row before the prompt (see the rail order in Deliverable 05).
- Output scan for PII in the final answer (last line of defence).
- `omniguard/guardrails/logging_filter.py`: `RedactingFilter` on the root logger reusing the same detector, plus secret patterns (Bearer tokens, `sk-`, `AKIA...`). Logs carry `request_id`, route, latency, entity counts, never text.
- Exception handler that returns a generic message plus `request_id` and never logs the request body.
- `docs/data-retention.md`: what is logged, where, for how long, who can read it.

Config keys: `PII_BACKEND` (`standin` | `presidio`), `PII_POLICY`, `PII_SCORE_THRESHOLD`, `LOG_LEVEL`.

### Inputs: lessons to (re)read
- M13-04 Implementing Microsoft Presidio analyzers and anonymizers
- M13-05 Redacting sensitive entities (SSN, credit cards, emails)
- M13-06 Customizing regex patterns for domain-specific PII
- M13-07 Reversing masks safely post-generation
- M13-08 Evaluating false-positive redaction rates
- M13-14 Safe logging (never log PII or prompts)
- M15-02 Defining data classifications
- M15-08 Implementing NeMo & Presidio guardrails (the harness)

### Acceptance checks
Automated by the M15-08 harness (`omniguard/tests/acceptance/test_guardrails.py`, `OMNIGUARD_APP=omniguard.main:app`):
1. Question containing a PAN and an email -> no PII in the response (harness uses its own independent detector).
2. Question about C-1001 where the source chunk holds a PAN and mobile -> `route == "rag"` and no PII in the answer.
3. Captured logs for all attacks contain no PAN, email, mobile or Aadhaar-shaped values.
4. Captured logs contain no raw prompt text.
5. Forced exception with PII in the request -> PII absent from logs and from the error response.
6. Policy number `KVF-2026-001234` appears unmasked in the answer (false-positive check).
7. Fault injection: add a `log.info(question)` in a branch -> CI red.
Supporting unit suites:
8. With FakeLLM, assert the prompt the provider received contains no email/phone/card/PAN for 10 sample notes (M13-04).
9. 20 positive samples: recall 100%; 20 hard negatives (tracking ids, invoice numbers, dates): false positives <= 1/20 (M13-05, M13-08).

### Proof for the gate
Part of the CP6 v1.0 tag: README "Guardrail evidence" table rows for PII (attack -> control -> test name), CI run link, and the PAN-in-question segment of the demo video.

### Definition of done
- Harness green on the real app in both `standin` and (locally) `presidio` backends.
- The harness detector and the app masker are separate implementations.
- `docs/data-retention.md` exists and matches the logging code.

### Out of scope
Jailbreak, topical and injection rails (Deliverable 05), encryption at rest, DPDP legal interpretation (confirm with the customer's compliance team), reversible masking in the UI unless done per M13-07.

### Stretch goals
- Safe unmasking of placeholders for authorised roles only, after generation (M13-07).
- Per-entity precision/recall report in CI output.
- Hinglish and mixed-script test samples.
