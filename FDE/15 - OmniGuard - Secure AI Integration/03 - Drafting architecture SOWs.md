# OmniGuard - Secure AI Integration

## Drafting architecture SOWs

> Core | Fast CP6 / Slow CP8 | ~1.2 h | Builds on: M15-01, M15-02

### Kahani
Kavach ke saath discovery achhi gayi. Procurement ne bola: "SOW bhejo, Friday tak sign karwa dete hain."
Pichhle project mein aapke senior ne SOW mein likha tha "AI assistant for claims team, including integrations as needed." Teen mahine baad customer ne "as needed" ke naam pe 4 extra systems maang liye, aur acceptance kabhi hui hi nahi kyunki "done" ki definition kahin nahi thi.
Is baar Priya, Anil aur Rahul teeno ek document pe sign karenge -- kya banega, kya nahi banega, kaise accept hoga, kaun kya karega, aur scope badla to kya hoga.
Woh document **architecture SOW** hai, aur iske har vague shabd ki keemat baad mein chukani padti hai.

### What it is
**Statement of Work (SOW)** = customer aur delivery team ke beech contractually binding scope document. **Architecture SOW** mein high-level architecture, data flows aur security controls bhi hote hain, taaki CISO usi document ko review kare.
Standard sections: objective, scope, out of scope, architecture, deliverables, assumptions, acceptance criteria, timeline, RACI, change control, risks.

### Why it matters for an FDE
FDE ka pilot SOW se hi judge hota hai. Vague SOW = endless scope creep + kabhi na milne wala sign-off. Clear SOW = "D3 done, acceptance test UAT-07 pass, sign here."

### Key concepts
- **Deliverable <-> acceptance criterion** -- har deliverable ka ek testable criterion; jo test nahi ho sakta woh deliverable nahi, wish hai.
- **Assumptions** -- "Kavach week 1 tak read-only ClaimsDB replica dega." Assumption toota to timeline/cost renegotiate -- ye aapki protection hai.
- **RACI** -- Responsible, Accountable, Consulted, Informed. Har activity ka exactly ek **A**.
- **Change control** -- naya scope = written change request -> impact (effort, timeline, cost) -> dono side approve. Hallway "bas ek chhota sa feature" nahi.
- **Risks with owner + mitigation** -- "MS SQL replica late" ek risk hai, owner Rahul, mitigation: synthetic schema pe build start.

Architecture section ke liye ASCII diagram kaafi hai (CISO ke liye data flow clear ho):
```text
Analyst (browser) --SSO (Azure AD, OAuth2)--> OmniGuard API (FastAPI, ap-south-1)
   OmniGuard API --> guardrails (Presidio mask, NeMo rails) --> LLM provider (masked text only)
   OmniGuard API --> Hybrid RAG index (SharePoint PDFs, internal/confidential, ACL metadata)
   OmniGuard API --> SQL guard --> MS SQL ClaimsDB read replica (read-only login)
   Audit log (no raw PII) --> customer SIEM
```

### Code example
stdlib only

```python
# runnable
import re

SOW = """
## Objective
Pilot OmniGuard for 40 claims analysts; median time-to-answer 2d -> 4h.
## Scope
Q&A over policy PDFs and read-only claim status from ClaimsDB replica.
## Out of scope
Writes to any Kavach system; customer-facing chat; mobile app.
## Architecture
See diagram v0.3; India region only; masked text to LLM provider.
## Deliverables
D1 Hybrid RAG over policy PDFs
D2 Secure Text-to-SQL on ClaimsDB replica
D3 SSO + RBAC for 2 roles
D4 UAT runbook and report
## Assumptions
Kavach provides read-only replica and test SSO tenant by end of week 1.
## Acceptance criteria
D1: 90% correct on 50-question golden set (UAT-01..05)
D2: 0 write statements executed in 200 adversarial prompts (UAT-06)
D3: two-user test returns role-correct answers (UAT-07)
D4: signed UAT report with no open Sev1 defects
## Timeline
Week 1-2: D1 | Week 3: D2 | Week 4: D3 | Week 5: D4
## RACI
| Activity | FDE | Rahul | Anil | Priya |
| Build pipeline | R/A | C | I | I |
| DB access | C | R/A | C | I |
| Security review | R | C | A | I |
| UAT sign-off | R | I | C | A |
## Change control
Changes via written CR with effort/timeline impact; both sides approve before work starts.
## Risks
Replica access late -- owner Rahul -- build on synthetic schema meanwhile.
"""

REQUIRED = ["Objective", "Scope", "Out of scope", "Architecture", "Deliverables", "Assumptions",
            "Acceptance criteria", "Timeline", "RACI", "Change control", "Risks"]
VAGUE = ["as needed", "etc", "best effort", "unlimited", "and more", "tbd"]

def lint(sow: str, max_weeks: int = 6) -> list[str]:
    secs = dict(re.findall(r"^## ([^\n]+)\n(.*?)(?=^## |\Z)", sow, re.S | re.M))
    issues = [f"missing/empty section: {s}" for s in REQUIRED if not secs.get(s, "").strip()]
    for word in VAGUE:
        if re.search(rf"\b{re.escape(word)}\b", sow, re.I):
            issues.append(f"vague wording: '{word}'")
    delivs = set(re.findall(r"^(D\d+) ", secs.get("Deliverables", ""), re.M))
    accepted = set(re.findall(r"^(D\d+):", secs.get("Acceptance criteria", ""), re.M))
    issues += [f"{d} has no acceptance criterion" for d in sorted(delivs - accepted)]
    weeks = [int(w) for w in re.findall(r"Week (?:\d+-)?(\d+)", secs.get("Timeline", ""))]
    if weeks and max(weeks) > max_weeks:
        issues.append(f"timeline {max(weeks)} weeks > pilot limit {max_weeks}")
    for row in secs.get("RACI", "").splitlines()[1:]:
        cells = [c.strip() for c in row.strip("| ").split("|")]
        if sum("A" in c.split("/") for c in cells[1:]) != 1:
            issues.append(f"RACI row '{cells[0]}' needs exactly one A")
    return issues

assert lint(SOW) == [], lint(SOW)
bad = (SOW.replace("D3 SSO + RBAC for 2 roles", "D3 SSO + RBAC for 2 roles\nD5 Integrations as needed")
          .replace("Week 5: D4", "Week 9: D4")
          .replace("| DB access | C | R/A | C | I |", "| DB access | A | R/A | C | I |")
          .replace("## Risks\nReplica access late -- owner Rahul -- build on synthetic schema meanwhile.\n", "## Risks\n"))
issues = lint(bad)
for i in issues:
    print("ISSUE:", i)
assert len(issues) == 5
assert {"vague wording: 'as needed'", "D5 has no acceptance criterion"} <= set(issues)
print("OK: clean SOW passes, bad SOW has", len(issues), "issues")
```

- `secs = dict(re.findall(...))` -- har `## Heading` ka body; empty section bhi "missing" count hota hai.
- `VAGUE` list -- "as needed", "etc", "best effort" contract mein scope creep ke darwaze hain. Linter CI mein inhe pakadta hai.
- `delivs - accepted` -- har deliverable ka acceptance criterion hona zaroori. D5 bina criterion ke pakda gaya.
- RACI row mein exactly ek `A` -- do log accountable matlab koi accountable nahi.
- Acceptance criteria UAT IDs (`UAT-06`) pe point karte hain -- yahi link M15-05 mein runbook banata hai.

### Mini-exercise (30-60 min)
OmniGuard deliverable #10: `omniguard/docs/SOW.md` (Kavach, fictional) + `omniguard/tools/sow_lint.py`.
- Upar wala structure use karo, par apne actual OmniGuard architecture ke hisaab se (M15-06..09 ke components). Architecture section mein ASCII data-flow diagram aur classification (M15-02) ka reference.
- Har deliverable ka acceptance criterion ek UAT test case ID pe point kare.
- Acceptance: `sow_lint.py docs/SOW.md` exit 0; GitHub Actions step jo PR pe linter chalaye; SOW ke top pe "Fictional customer -- portfolio sample" likha ho.

### Common pitfalls
- Acceptance criteria mein "customer satisfied" ya "works as expected" -- test nahi ho sakta, sign-off kabhi nahi milega.
- Assumptions na likhna -- customer ka replica 3 hafte late aaya to delay aapke naam pe aata hai.
- Real customer SOW public GitHub pe daalna -- NDA breach. Portfolio mein sirf fictional/anonymised version.

### Checklist before moving on
- [ ] SOW ke 11 sections aur har ek ka purpose bata sakta hoon.
- [ ] Har deliverable ka testable acceptance criterion likh sakta hoon.
- [ ] RACI mein ek A ka rule aur change control flow samjha sakta hoon.
- [ ] `omniguard/docs/SOW.md` linter pass karta hai.

### Related
- M15-01 Conducting technical discovery and scoping workshops
- M15-02 Defining data classifications
- M15-04 Preparing ROI presentations for CISO/executives
- M15-05 Delivering User Acceptance Testing (UAT) runbooks

### Self-quiz
1. "Integrations as needed" ko SOW mein kaise rewrite karoge taaki scope bounded rahe?
2. Assumption aur risk mein fark kya hai? Kavach ka ek-ek example do.
3. Week 3 mein Priya ek naya data source maangti hai. Change control ke steps batao.
4. Security review ka "A" CISO kyun hai aur "R" FDE kyun?
