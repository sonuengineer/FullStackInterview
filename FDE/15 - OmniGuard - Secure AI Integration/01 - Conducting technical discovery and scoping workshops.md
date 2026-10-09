# OmniGuard - Secure AI Integration

## Conducting technical discovery and scoping workshops

> Core | Fast CP6 / Slow CP8 | ~1.2 h | Builds on: M11-13, M12-01

### Kahani
Kavach Finserv (Pune, mid-size insurance + lending, ~1,200 log) ka CISO Anil Rao call pe bolta hai: "Humein bhi ChatGPT jaisa kuch chahiye, par data bahar nahi jaana chahiye." Bas itna hi brief hai.
Room mein 6 log hain: CISO, Head of Claims (Priya), Data team lead (Rahul, MS SQL wale), SharePoint owner (Meera), ek procurement wala, aur aap.
Har koi alag cheez soch raha hai -- Priya ko claims analysts ka time bachana hai, Rahul ko darr hai ki LLM `DELETE` chala dega, CISO ko audit trail chahiye.
Agar aap seedha code likhne baith gaye, to 6 hafte baad demo mein sunoge: "Ye to humne maanga hi nahi tha."
Discovery workshop ka kaam hai: is fog ko ek likhit, measurable, 4-6 week pilot scope mein badalna.

### What it is
**Technical discovery** = structured workshop(s) jahan FDE business goal, users, data sources, constraints, security, success metrics aur non-goals nikaalta hai.
Output ek **scope doc** hai jo SOW (M15-03) ka input banta hai. Agenda fix hota hai, question bank ready hota hai, aur har answer ka ek owner hota hai.

### Why it matters for an FDE
FDE ka asli product "sahi problem ka chhota, jeetne layak version" hai. Bina discovery ke pilot ya to bahut bada ho jaata hai (kabhi khatam nahi hota) ya galat metric pe judge hota hai.

### Key concepts
- **Stakeholder map** -- kaun decide karta hai (economic buyer), kaun block kar sakta hai (CISO, DPO), kaun roz use karega (analyst).
- **Success metric = baseline + target + measurement method** -- "faster answers" metric nahi hai; "median 2 din -> 4 ghante, ticket timestamps se" metric hai.
- **Non-goals** -- jo pilot mein nahi hoga, likh ke. Ye scope creep ka sabse sasta ilaaj hai.
- **Pilot scoping** -- 1 user group, 1-2 data sources, 1 metric jo 4-6 hafte mein move ho sake.
- **Open questions log** -- har "pata nahi" ek owner + due date ke saath track hota hai, chupaya nahi jaata.

Stakeholder map (Kavach):
```text
                 high influence
  Anil (CISO) ----------+---------- Priya (Head of Claims)
  can BLOCK: security   |           economic buyer, owns metric
                        |
  Rahul (Data/MS SQL) --+-- Meera (SharePoint/Ops)
  owns ClaimsDB access  |   owns policy PDFs
                 low influence
  40 claims analysts (daily users)  |  procurement (SOW, paperwork)
```

Workshop agenda (2 x 90 min):

| Block | Time | Output |
|---|---|---|
| Business goal + pain story (Priya) | 20 min | 1-line goal + current process |
| Users + a "day in the life" | 20 min | personas with counts |
| Data sources walk-through (Rahul, Meera) | 30 min | source list + owner + access path |
| Security + constraints (Anil) | 30 min | constraints, data residency, SSO, audit |
| Success metrics + non-goals | 30 min | baseline/target pairs, non-goal list |
| Pilot cut + open questions | 20 min | 4-6 week scope, owners for unknowns |

Question bank (pick, don't read all): *Goal* -- "Agar ye kaam kar gaya to 3 mahine baad kaunsa number badla hoga?" *Users* -- "Kitne log, kaunse roles, aaj kis tool mein kaam karte hain?" *Data* -- "Source of truth kahan hai, owner kaun, read replica hai?" *Constraints* -- "Data kis region mein rehna chahiye, kaunsa IdP?" *Security* -- "Kaunsa data LLM ko kabhi nahi dikhna chahiye, audit kaun padhega?" *Metrics* -- "Aaj ka baseline kaise measure hota hai?" *Non-goals* -- "Pilot mein kya bilkul nahi chahiye?"

### Code example
`pip install pydantic`

```python
# runnable
from typing import Literal
from pydantic import BaseModel, Field, ValidationError, field_validator

NOTES = """
goal: Cut claim-query turnaround for claims analysts from ~2 days to same day
user: claims analyst | 40 | policy-wording + claim-status questions
user: underwriter | 12 | portfolio questions, must not see medical notes
source: SharePoint policy PDFs | owner=Meera (Ops) | class=internal
source: MS SQL ClaimsDB | owner=Rahul (Data) | class=restricted
constraint: data stays in India region; no unmasked PII to an external LLM
constraint: SSO via Azure AD only
metric: median time-to-answer | baseline=2d | target=4h | how=ticket timestamps
metric: accuracy on 50-question golden set | baseline=? | target=90% | how=UAT
non_goal: no writes to ClaimsDB; no customer-facing chatbot
pilot_weeks: 5
"""

class Persona(BaseModel):
    role: str; count: int = Field(gt=0); needs: str

class DataSource(BaseModel):
    name: str; owner: str = Field(min_length=2)
    classification: Literal["public", "internal", "confidential", "restricted"]

class Metric(BaseModel):
    name: str; baseline: str; target: str; how: str = Field(min_length=3)

    @field_validator("target")
    @classmethod
    def target_is_measurable(cls, v: str) -> str:
        if not any(ch.isdigit() for ch in v):
            raise ValueError("target must be a number, not an adjective")
        return v

class ScopeDoc(BaseModel):
    goal: str = Field(min_length=15)
    users: list[Persona] = Field(min_length=1)
    sources: list[DataSource] = Field(min_length=1)
    constraints: list[str] = Field(min_length=1)
    metrics: list[Metric] = Field(min_length=1)
    non_goals: list[str] = Field(min_length=1)
    pilot_weeks: int = Field(ge=4, le=6)

    def open_questions(self) -> list[str]:
        return [f"Baseline unknown for '{m.name}' -- who measures it, by when?"
                for m in self.metrics if m.baseline.strip() in {"", "?"}]

def parse_notes(text: str) -> dict:
    out: dict = {"users": [], "sources": [], "constraints": [], "metrics": [], "non_goals": []}
    for line in filter(None, (l.strip() for l in text.splitlines())):
        key, _, rest = line.partition(":")
        parts = [p.strip() for p in rest.split("|")]
        kv = dict(p.split("=", 1) for p in parts[1:] if "=" in p)
        if key == "user":
            out["users"].append({"role": parts[0], "count": parts[1], "needs": parts[2]})
        elif key == "source":
            out["sources"].append({"name": parts[0], "owner": kv.get("owner", ""), "classification": kv.get("class")})
        elif key == "metric":
            out["metrics"].append({"name": parts[0], **kv})
        elif key in ("constraint", "non_goal"):
            out[key + "s"].append(rest.strip())
        else:
            out[key] = rest.strip()
    return out

scope = ScopeDoc.model_validate(parse_notes(NOTES))
print("pilot:", scope.pilot_weeks, "weeks |", len(scope.users), "personas |", len(scope.sources), "sources")
print("open :", scope.open_questions())
assert scope.sources[1].classification == "restricted" and len(scope.open_questions()) == 1
bad = NOTES.replace("pilot_weeks: 5", "pilot_weeks: 12").replace("target=4h", "target=faster")
bad = "\n".join(l for l in bad.splitlines() if not l.startswith("non_goal"))
try:
    ScopeDoc.model_validate(parse_notes(bad))
    raise AssertionError("bad scope must fail")
except ValidationError as e:
    locs = {str(err["loc"][0]) for err in e.errors()}
    print("bad scope errors:", sorted(locs))
    assert locs == {"metrics", "non_goals", "pilot_weeks"}
print("OK: discovery notes -> validated pilot scope")
```

- `NOTES` wahi format hai jo aap workshop ke dauraan live type karte ho -- ek line, ek fact. Baad mein tool ise structured doc banata hai.
- `Metric.target_is_measurable` -- "faster" jaisa adjective reject. Number nahi to metric nahi.
- `pilot_weeks: ge=4, le=6` -- 12 week ka "pilot" asal mein project hai; validator yahi pakadta hai.
- `non_goals min_length=1` -- non-goal na likhna khud ek error hai.
- `open_questions()` -- `baseline=?` error nahi hai, ek tracked open question hai. Discovery ka honest output.

### Mini-exercise (30-60 min)
OmniGuard deliverable #8: `omniguard/docs/discovery.md` + `omniguard/tools/scope_check.py`.
- Kavach ke liye ek mock workshop khud chalao (ya kisi dost ko CISO banao, 30 min). Notes upar wale format mein lo.
- Template copy karo:
```text
# Discovery and pilot scope -- Kavach Finserv (fictional)
## Business goal
## Stakeholders (name, role, influence, can block?)
## Users / personas (role, count, top 3 questions)
## Data sources (system, owner, classification, access path)
## Constraints and security requirements
## Success metrics (metric | baseline | target | how measured)
## Non-goals
## Pilot scope (weeks, users, sources)
## Open questions (question | owner | due)
```
- Acceptance: `scope_check.py notes.txt` exit 0 sirf tab jab scope valid ho; kam se kam 2 metrics, 2 non-goals, 1 open question with owner; pytest mein ek invalid notes file fail hoti dikhe.

### Common pitfalls
- Solution pehle bechna ("hum RAG + agents lagayenge") -- discovery mein problem sunni hai, architecture M15-03 mein aata hai.
- CISO ko last workshop mein bulana -- woh pehle din block kar sakta hai; security constraints day 1 pe lo.
- Notes mein real customer PII (claim numbers, naam) copy karna -- notes bhi data hain; examples masked rakho.

### Checklist before moving on
- [ ] Kavach ka stakeholder map bana sakta hoon aur bata sakta hoon kaun block kar sakta hai.
- [ ] 2 x 90 min workshop agenda aur question bank ready hai.
- [ ] Har metric mein baseline + target + measurement method hai.
- [ ] `omniguard/docs/discovery.md` repo mein hai, non-goals aur open questions ke saath.

### Related
- M15-02 Defining data classifications
- M15-03 Drafting architecture SOWs
- M11-13 Mapping complex database schemas to LLM context
- M12-01 Authentication vs authorization

### Self-quiz
1. "Answers should be faster" ko ek valid success metric mein kaise badloge? Teen parts batao.
2. CISO pilot ko block kar sakta hai par budget nahi deta. Stakeholder map mein use kahan rakhoge aur kyun?
3. Workshop mein Rahul bolta hai "baseline ka data hamare paas nahi hai." Aap kya likhoge aur kya nahi karoge?
4. 12-week scope ko 5-week pilot mein kaise kaatoge? Kaunse teen levers hain?
