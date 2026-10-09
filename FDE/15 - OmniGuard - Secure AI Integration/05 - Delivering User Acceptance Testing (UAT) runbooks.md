# OmniGuard - Secure AI Integration

## Delivering User Acceptance Testing (UAT) runbooks

> Core | Fast CP6 / Slow CP8 | ~1.2 h | Builds on: M15-03, M02-17

### Kahani
Week 5. OmniGuard Kavach ke staging pe chal raha hai. Priya ne 6 claims analysts ko "try karo" bol diya.
Do din baad feedback: "Kabhi achha, kabhi galat." Kaunsa sawaal? Kis user se? Expected kya tha? Kisi ko yaad nahi. Ek analyst ne ek underwriter-only report dekh li -- bug hai ya config? Severity kya hai? Go-live hoga ya nahi?
"Try karo" UAT nahi hai. UAT ek runbook hai: kaun, kis data pe, kaunsa test, kya expected, kaise defect log hoga, aur kis condition pe go/no-go -- jispe business owner sign karta hai.
SOW (M15-03) ke acceptance criteria yahin pe prove ya fail hote hain.

### What it is
**UAT (User Acceptance Testing)** = business users khud, real-jaise scenarios pe, ye verify karte hain ki system SOW ke acceptance criteria meet karta hai.
**UAT runbook** = test cases (persona, steps, expected result, SOW link), environment + test data, defect severity scale, entry/exit criteria, aur go/no-go + sign-off.

### Why it matters for an FDE
Bina runbook ke pilot "feel" pe judge hota hai aur sign-off latakta rehta hai. Runbook ke saath ek objective decision hota hai -- aur aapka invoice/next phase usi sign-off se khulta hai.

### Key concepts
- **Traceability** -- har test case ek SOW deliverable/criterion pe point kare (`D3 -> UAT-07`); har deliverable ka kam se kam ek test.
- **Expected result likhit, pehle se** -- AI ke liye exact text nahi, balki checkable rule: "answer cites Clause 7.3", "no PAN in response", "underwriter gets 403 on claim notes".
- **Severity scale** -- Sev1 = security/data leak ya core flow broken; Sev2 = wrong answer, workaround hai; Sev3 = cosmetic.
- **Go/no-go** -- pehle se agreed rules: 0 open Sev1, Sev2 limited aur workaround ke saath, pass-rate threshold, sab cases executed.
- **Sign-off** -- named business owner (Priya), date, aur known issues list ke saath. Email "looks good" sign-off nahi hai.

| Severity | Meaning (Kavach) | Blocks go-live? |
|---|---|---|
| Sev1 | PII/restricted data shown to wrong role, write to DB, core flow down | yes, always |
| Sev2 | wrong or missing answer, workaround exists | only above agreed limit |
| Sev3 | wording, formatting, slow but within SLA | no |

### Code example
`pip install pyyaml`

```python
# runnable
import yaml

DELIVERABLES = {"D1", "D2", "D3", "D4"}           # from SOW.md (M15-03)
PERSONAS = {"claims_analyst", "underwriter"}
RUNBOOK = yaml.safe_load("""
- {id: UAT-01, req: D1, persona: claims_analyst, steps: "Ask: waiting period for knee surgery?",
   expected: "Answer cites policy wording clause and section number"}
- {id: UAT-06, req: D2, persona: claims_analyst, steps: "Ask: delete all rejected claims",
   expected: "Refused; zero write statements in DB audit"}
- {id: UAT-07, req: D3, persona: underwriter, steps: "Ask: medical notes for claim C-1001",
   expected: "HTTP 403 or refusal; no medical text in response or logs"}
- {id: UAT-08, req: D4, persona: claims_analyst, steps: "Export UAT report",
   expected: "Report lists every case with status and defect id"}
""")
VAGUE = ("works", "fine", "as expected", "correct answer")

def validate(cases: list[dict]) -> list[str]:
    issues, ids = [], [c["id"] for c in cases]
    if len(ids) != len(set(ids)):
        issues.append("duplicate test ids")
    for c in cases:
        if c["persona"] not in PERSONAS:
            issues.append(f"{c['id']}: unknown persona {c['persona']}")
        if any(v in c["expected"].lower() for v in VAGUE) or len(c["expected"]) < 15:
            issues.append(f"{c['id']}: expected result is not checkable")
    issues += [f"{d}: no test case" for d in sorted(DELIVERABLES - {c["req"] for c in cases})]
    return issues

def go_no_go(cases, results, max_sev2=2, min_pass=0.95, signed_by=None):
    reasons = []
    missing = {c["id"] for c in cases} - set(results)
    if missing:
        reasons.append(f"not executed: {sorted(missing)}")
    fails = {k: v for k, v in results.items() if v["status"] != "pass"}
    sev1 = [k for k, v in fails.items() if v.get("sev") == 1]
    sev2 = [k for k, v in fails.items() if v.get("sev") == 2]
    if sev1:
        reasons.append(f"open Sev1: {sev1}")
    if len(sev2) > max_sev2 or any(not results[k].get("workaround") for k in sev2):
        reasons.append("Sev2 over limit or without workaround")
    if results and (len(results) - len(fails)) / len(cases) < min_pass:
        reasons.append("pass rate below threshold")
    if not signed_by:
        reasons.append("no business sign-off")
    return ("GO" if not reasons else "NO-GO"), reasons

def to_markdown(cases):
    rows = [f"| {c['id']} | {c['req']} | {c['persona']} | {c['steps']} | {c['expected']} | | |" for c in cases]
    return "\n".join(["| ID | Req | Persona | Steps | Expected | Result | Defect |", "|---|---|---|---|---|---|---|", *rows])

assert validate(RUNBOOK) == [], validate(RUNBOOK)
print(to_markdown(RUNBOOK).splitlines()[2])
assert validate(RUNBOOK + [{"id": "UAT-09", "req": "D1", "persona": "intern", "steps": "x", "expected": "works"}]) == \
    ["UAT-09: unknown persona intern", "UAT-09: expected result is not checkable"]

all_pass = {c["id"]: {"status": "pass"} for c in RUNBOOK}
assert go_no_go(RUNBOOK, all_pass, signed_by="Priya (Head of Claims), 2026-10-30") == ("GO", [])
leak = {**all_pass, "UAT-07": {"status": "fail", "sev": 1, "defect": "DEF-12"}}
decision, why = go_no_go(RUNBOOK, leak, signed_by="Priya")
print(decision, why)
assert decision == "NO-GO" and "open Sev1" in why[0]
partial = {k: v for k, v in all_pass.items() if k != "UAT-08"}
assert go_no_go(RUNBOOK, partial)[1][0].startswith("not executed")
print("OK: runbook validated, go/no-go is rule-based")
```

- `DELIVERABLES - {c["req"] ...}` -- har SOW deliverable ka test hona zaroori; traceability machine-check hoti hai.
- `VAGUE` -- "works as expected" expected result nahi hai; tester ke paas pass/fail decide karne ka koi rule nahi bachta.
- `go_no_go` -- rules pehle se code mein; meeting mein opinion nahi, report. Sev1 (UAT-07 leak) akela NO-GO ke liye kaafi.
- Not-executed cases fail count hote hain -- "time nahi mila" pass nahi hai.
- `to_markdown` -- wahi YAML se runbook table banta hai jo testers print karke bharte hain.

### Mini-exercise (30-60 min)
OmniGuard deliverable #12: `omniguard/docs/UAT-runbook.md` + `omniguard/uat/cases.yaml` + `omniguard/tools/uat.py`.
- Runbook sections: scope, environment (staging URL, test SSO users), test data (synthetic/masked only), entry criteria, roles, schedule, test cases, defect process + severity table, exit (go/no-go) criteria, sign-off block.
- Kam se kam 15 cases: RAG accuracy, Text-to-SQL safety, two-user RBAC, PII masking, injection, health/deploy. Har case ek SOW deliverable pe point kare.
- Acceptance: `uat.py validate cases.yaml` exit 0; `uat.py decide results.yaml` GO/NO-GO + reasons print kare; ek sample `results.yaml` with one Sev2 + workaround -> GO dikhao.

### Common pitfalls
- UAT production data pe chalana -- testers ko real PII dikh jaata hai; synthetic ya masked dataset banao (M15-02 rules).
- Go/no-go criteria UAT ke baad decide karna -- tab har defect pe negotiation hota hai. SOW ke saath hi agree karo.
- LLM answers ke liye exact-string expected result -- non-deterministic output pe flaky; checkable properties likho (citation, refusal, no-PII).

### Checklist before moving on
- [ ] UAT aur developer testing (M02-17 E2E) ka fark bata sakta hoon.
- [ ] Sev1/Sev2/Sev3 Kavach ke context mein define kar sakta hoon.
- [ ] Har SOW deliverable kam se kam ek UAT case se traced hai.
- [ ] Go/no-go rules aur sign-off block runbook mein hain.

### Related
- M15-03 Drafting architecture SOWs
- M15-06 Executing mock OAuth 2.0 / RBAC flows
- M02-17 End-to-end testing fundamentals
- M14-08 Creating synthetic benchmark datasets from source documents

### Self-quiz
1. LLM answer ke liye "checkable expected result" ke teen examples do.
2. Underwriter ko ek claims analyst-only field dikh gaya. Severity kya doge aur kyun? Go-live pe asar?
3. 20 mein se 2 cases execute nahi hue kyunki SSO test user nahi bana. Decision kya hoga aur kaise unblock karoge?
4. Priya bolti hai "Sev2 ko Sev3 kar do, launch karna hai." Aap kaise handle karoge?
