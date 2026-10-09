# OmniGuard - Secure AI Integration

## Defining data classifications

> Core | Fast CP6 / Slow CP8 | ~1.2 h | Builds on: M15-01, M12-07, M13-04

### Kahani
Discovery ke baad Kavach ke CISO Anil ne ek hi sawaal poocha: "Kaunsa column LLM tak jaayega, aur kaunsa kabhi nahi?"
Aapke paas jawab tha: "Sensitive cheezein mask kar denge." Anil: "Sensitive kaun decide karega? Claim amount sensitive hai? Medical notes? Policy brochure?"
Rahul ne ClaimsDB ke 140 columns ki list bhej di, Meera ne 3,000 PDFs. Har engineer apne hisaab se decide karega to ek din `aadhaar_no` vector store mein index ho jaayega aur logs mein bhi.
Isliye pehle ek likhit classification chahiye -- har data asset ka ek level, aur har level ke handling rules. Code baad mein usi ko enforce karta hai.

### What it is
**Data classification** = har data asset (table, column, document type) ko ek sensitivity level dena -- usually `public / internal / confidential / restricted` -- aur har level ke liye **handling rules** likhna: LLM ko ja sakta hai?, index ho sakta hai?, log ho sakta hai?, kaun dekh sakta hai?, kis region mein rahega?
Ye policy document bhi hai aur machine-readable config bhi.

### Why it matters for an FDE
Bina classification ke "secure AI" ek opinion hai. Classification ke saath har design decision (masking M13-05, retrieval filter M12-07, logging M13-14) ek rule se trace hota hai -- aur CISO usi pe sign karta hai.

### Key concepts
- **Level -> handling rules** -- level label akela bekaar hai; value uske rules mein hai (LLM, index, logs, roles, region, retention).
- **Fail closed** -- jo asset inventory mein nahi hai, woh `restricted` maana jaata hai jab tak koi owner classify na kare.
- **Data owner classifies, FDE proposes** -- aap draft banate ho, Rahul/Meera/DPO approve karte hain. Sign-off likhit.
- **Highest level wins** -- ek PDF mein ek page bhi medical info ho, to poora document us level pe.
- **Regulatory context** -- India mein DPDP Act 2023 aur insurance sector ke IRDAI guidelines relevant ho sakte hain; exact obligations customer ki legal/compliance team se confirm karo, khud interpret mat karo.

| Level | Kavach examples (fictional) | External LLM | Vector index | Logs | Who sees |
|---|---|---|---|---|---|
| public | product brochures, published FAQs | yes | yes | yes | everyone |
| internal | policy wording PDFs, SOPs | yes (approved provider, India region) | yes | yes | all staff |
| confidential | claim amount, claim status, customer name | masked only | yes, with ACL metadata | masked | role-based |
| restricted | Aadhaar, PAN, bank a/c, medical notes | never raw; masked tokens only, India region | never | never | named roles + audit |

### Code example
`pip install pyyaml`

```python
# runnable
from dataclasses import dataclass
import yaml

POLICY = yaml.safe_load("""
levels: [public, internal, confidential, restricted]
rules:
  public:       {llm: allow,  index: true,  log: allow,  regions: [any]}
  internal:     {llm: allow,  index: true,  log: allow,  regions: [ap-south-1]}
  confidential: {llm: masked, index: true,  log: masked, regions: [ap-south-1]}
  restricted:   {llm: masked, index: false, log: never,  regions: [ap-south-1]}
inventory:
  sharepoint/brochure:       public
  sharepoint/policy_wording: internal
  claims.claim_amount:       confidential
  claims.customer_name:      confidential
  claims.medical_notes:      restricted
  customers.pan:             restricted
""")

@dataclass
class Flow:
    asset: str
    action: str            # "llm" | "index" | "log"
    masked: bool = False
    region: str = "ap-south-1"

def level_of(asset: str) -> str:
    return POLICY["inventory"].get(asset, "restricted")      # fail closed

def check(flow: Flow) -> list[str]:
    level = level_of(flow.asset)
    rule = POLICY["rules"][level]
    problems = []
    if "any" not in rule["regions"] and flow.region not in rule["regions"]:
        problems.append(f"{flow.asset} ({level}) may not leave {rule['regions']}")
    if flow.action == "index" and not rule["index"]:
        problems.append(f"{flow.asset} ({level}) must never be indexed")
    if flow.action in ("llm", "log"):
        mode = rule[flow.action]
        if mode == "never" or (mode == "masked" and not flow.masked):
            problems.append(f"{flow.asset} ({level}) {flow.action} requires: {mode}")
    return problems

assert POLICY["levels"] == list(POLICY["rules"])               # every level has rules

proposed = [
    Flow("sharepoint/policy_wording", "index"),
    Flow("sharepoint/policy_wording", "llm", region="us-east-1"),
    Flow("claims.claim_amount", "llm", masked=True),
    Flow("claims.customer_name", "log"),                         # raw name in logs
    Flow("claims.medical_notes", "index", masked=True),          # masking does not help
    Flow("customers.pan", "llm", masked=True, region="us-east-1"),
    Flow("claims.aadhaar_no", "log", masked=True),               # not in inventory
]
report = {f"{f.asset}:{f.action}": check(f) for f in proposed}
for key, probs in report.items():
    print("OK  " if not probs else "FAIL", key, "|", "; ".join(probs))

assert report["sharepoint/policy_wording:index"] == []
assert report["sharepoint/policy_wording:llm"] != []          # India-only constraint (M15-01)
assert report["claims.claim_amount:llm"] == []
assert report["claims.customer_name:log"] != []
assert "never be indexed" in report["claims.medical_notes:index"][0]
assert any("may not leave" in p for p in report["customers.pan:llm"])
assert "requires: never" in report["claims.aadhaar_no:log"][0]   # unknown -> restricted
print("OK:", sum(1 for p in report.values() if p), "violations caught out of", len(proposed), "flows")
```

- `POLICY` YAML hai taaki data owner ise bina Python ke padh/approve kar sake; wahi file app config bhi ban sakti hai.
- `level_of(...).get(asset, "restricted")` -- fail closed. `claims.aadhaar_no` inventory mein nahi tha, phir bhi pakda gaya.
- `Flow` = "ye data, ye action, is region mein". Architecture review mein har arrow ek Flow hai.
- Medical notes masked hone ke baad bhi index nahi -- kuch levels pe masking kaafi nahi hota, rule explicit hai.
- Asserts dono taraf check karte hain: allowed flows pass, forbidden flows fail. Sirf "fail" test karna aadha test hai.

### Mini-exercise (30-60 min)
OmniGuard deliverable #9: `omniguard/docs/data-classification.md` + `omniguard/config/classification.yaml` + `omniguard/tools/flow_check.py`.
- Apne OmniGuard ke mock ClaimsDB schema (M11-13) ke har column aur har PDF type ko classify karo. Table template:
```text
| Asset | Level | Owner | Reason | Approved by | Date |
|---|---|---|---|---|---|
```
- Apne architecture ke har data flow (retrieval, LLM call, logging, cache, eval dataset) ko `Flow` list mein likho.
- Acceptance: `flow_check.py` CI mein chale; ek bhi violation pe exit 1; unknown asset restricted maana jaaye; README mein ek line: "classification draft -- pending owner sign-off" (honest status).

### Common pitfalls
- Sirf DB columns classify karna -- prompts, LLM responses, embeddings, eval datasets aur logs bhi data assets hain.
- Classification spreadsheet aur code alag-alag jagah -- drift ho jaata hai. Ek source (YAML) rakho, docs usse generate karo.
- Masking ko magic maan lena -- masked PAN bhi linkage se re-identify ho sakta hai; restricted data ko minimize karo, sirf mask nahi.

### Checklist before moving on
- [ ] Chaar levels aur unke handling rules bina dekhe bata sakta hoon.
- [ ] Fail-closed default aur "highest level wins" samjha sakta hoon.
- [ ] Mere OmniGuard ke har data flow ka classification check CI mein chalta hai.
- [ ] Classification doc mein owner + sign-off column hai.

### Related
- M15-01 Conducting technical discovery and scoping workshops
- M15-08 Implementing NeMo & Presidio guardrails
- M12-07 Enforcing data-level permissions in retrieval layers
- M13-05 Redacting sensitive entities (SSN, credit cards, emails)
- M13-14 Safe logging (never log PII or prompts)

### Self-quiz
1. Embeddings ko kis level pe classify karoge agar source text confidential tha? Kyun?
2. Fail-closed default ka ek production downside batao, aur use kaise manage karoge.
3. Masked restricted data ko external LLM pe bhejna allowed hai, par index karna nahi. Is asymmetry ka reason kya ho sakta hai?
4. Data owner aapke draft se disagree karta hai (claim amount ko internal bolta hai). Aap kya karoge?
