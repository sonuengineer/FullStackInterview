# AuditMesh - Multi-Agent Compliance System

## Mapping 5-step manual compliance workflows

> Core | Fast CP8 / Slow CP10 | ~1.2 h | Builds on: M15-01, M09-03, M09-04

### Kahani
OmniGuard live hone ke baad Kavach Finserv (fictional Indian fintech/insurer) ki Head of Compliance, Meera, ne aapko apni team se milwaya.
Har quarter unka **access review** hota hai: 40 internal apps, ~1,200 access grants, 3 analysts, aur ek Excel jo 3 hafte chalta hai.
Meera ka first message: "Agents lagao, sab automate karo." Par jab aapne poocha "sign-off kaun karta hai aur auditor kya dekhta hai?", room chup ho gaya.
Agar aap bina map banaye agent bana doge to aap galat step automate karoge -- jaise sign-off, jo internal audit policy ke hisaab se ek named insaan ka hi hona chahiye.
Pehla deliverable code nahi, ek **as-is vs to-be process map** hai, step timings ke saath.

### What it is
**Workflow mapping** = har step ka actor, input, output, touch time (actual kaam) aur wait time (queue mein pada rehna) likhna -- pehle aaj jaisa hai (**as-is**), phir agent ke saath (**to-be**).
Har step pe ek label: `auto` (agent kare, human spot-check), `assist` (agent draft kare, human review kare), `human` (unchanged).

### Why it matters for an FDE
Bina map ke ROI claim hawa mein hai, aur aap wo step automate kar dete ho jo customer legally automate nahi kar sakta. Map hi SOW scope (M15-03) aur SLA (M16-03) ka base hai.

### Key concepts
- **Touch time vs lead time** -- touch = kaam ke minutes; lead = start se end tak calendar time. Zyada dard aksar wait mein hota hai, touch mein nahi.
- **Swimlane** -- har actor (analyst, agent, approver, Jira) ki ek lane; handoffs lanes ke beech arrows hain -- wahi delays aur errors ki jagah hai.
- **Automation label per step** -- `auto / assist / human`; sign-off jaise control steps hamesha `human`.
- **Evidence trail** -- har step ka output auditor ko dikhana padta hai; agent ka output bhi evidence hai, to woh traceable hona chahiye.
- **Measure, don't guess** -- timings analysts se 2-3 real items pe stopwatch se lo; "roughly 2 din" pe ROI mat banao.

Kavach quarterly access review -- the 5 steps:
```text
AS-IS (3 analysts, Excel, email)
Analyst  | 1 Collect evidence -> 2 Check vs policy -> 3 Flag exceptions --------------------> 5 File Jira + report
Approver |                                                            \-> 4 Sign-off (wait ~5 days) -/

TO-BE (AuditMesh)
Agent    | 1 Collect (auto) -> 2 Check (auto) -> 3 Flag + risk score (assist) ----------------> 5 Draft tickets + report (assist)
Analyst  |                                         \-> review high-risk only ---\
Approver |                                                                       -> 4 Sign-off (human, UI) -/
Jira     |                                                                                         <- tickets via MCP server
```

### Code example
stdlib only

```python
# runnable
from dataclasses import dataclass

@dataclass
class Step:
    name: str
    actor: str
    items: int            # how many units this step touches per quarter
    min_per_item: float   # measured touch time (stopwatch, not guess)
    wait_days: float      # calendar wait before the step can finish
    label: str = "human"  # to-be automation label: auto | assist | human

# Illustrative numbers from a discovery session (replace with your measurements)
AS_IS = [
    Step("1 collect evidence", "analyst", 40,   45, 4.0),
    Step("2 check vs policy",  "analyst", 1200,  2, 3.0),
    Step("3 flag exceptions",  "analyst", 90,   10, 1.0),
    Step("4 human sign-off",   "approver", 90,   5, 5.0),
    Step("5 file jira+report", "analyst", 90,    6, 2.0),
]
# What the agent changes: remaining human minutes per item, and the wait
TO_BE = {
    "1 collect evidence": ("auto",   0.1 * 45, 0.5),   # 10% spot-check of exports
    "2 check vs policy":  ("auto",   0.1 * 2,  0.2),
    "3 flag exceptions":  ("assist", 4,        0.5),   # analyst reviews agent draft
    "4 human sign-off":   ("human",  5,        2.0),   # same work, less waiting (UI + reminders)
    "5 file jira+report": ("assist", 1,        0.2),   # approve drafted tickets
}
CONTROL_STEPS = {"4 human sign-off"}   # policy: a named human must do these

def hours(steps): return sum(s.items * s.min_per_item for s in steps) / 60
def lead_days(steps): return sum(s.wait_days for s in steps)

def apply_to_be(as_is, plan):
    out = []
    for s in as_is:
        label, mins, wait = plan[s.name]
        if s.name in CONTROL_STEPS and label != "human":
            raise ValueError(f"{s.name} is a control step and cannot be '{label}'")
        out.append(Step(s.name, "agent" if label == "auto" else s.actor, s.items, mins, wait, label))
    return out

to_be = apply_to_be(AS_IS, TO_BE)
for a, b in zip(AS_IS, to_be):
    print(f"{a.name:20} {a.items * a.min_per_item / 60:6.1f}h -> {b.items * b.min_per_item / 60:5.1f}h  [{b.label}]")
saved = hours(AS_IS) - hours(to_be)
print(f"touch hours {hours(AS_IS):.1f} -> {hours(to_be):.1f} (saved {saved:.1f}h/quarter)")
print(f"lead time  {lead_days(AS_IS):.1f} -> {lead_days(to_be):.1f} days")

assert round(hours(AS_IS), 1) == 101.5 and saved > 70
assert lead_days(to_be) < lead_days(AS_IS) / 2
assert [s.label for s in to_be if s.name in CONTROL_STEPS] == ["human"]
try:   # a "just automate everything" plan must be rejected
    apply_to_be(AS_IS, {**TO_BE, "4 human sign-off": ("auto", 0, 0)})
    raise AssertionError("auto sign-off was accepted")
except ValueError as e:
    print("rejected:", e)
print("OK: as-is vs to-be workflow model")
```

- `Step` mein touch (`min_per_item`) aur wait (`wait_days`) alag hain -- Meera ko dikhaoge ki 15 din ka lead time mostly waiting hai, kaam nahi.
- Saare numbers "illustrative inputs" hain; real map mein har number ke saath source likho ("stopwatch, 3 items, analyst Priya, 12 Aug").
- `CONTROL_STEPS` -- policy code mein hai, slide pe nahi. Koi `auto sign-off` plan banaye to model hi fail ho jaata hai.
- `auto` steps pe bhi 10% spot-check ka time rakha hai -- zero human time wala claim CISO turant pakad leta hai.
- Output table seedha ROI slide (M15-04) aur SOW scope mein jaata hai.

### Mini-exercise (30-60 min)
AuditMesh deliverable "operational handoffs" ka base: `auditmesh/docs/process-map.md`.
- Kavach ke 5 steps ka as-is aur to-be swimlane (ASCII ya Mermaid) banao, har handoff pe arrow.
- Upar wala model apne repo mein `auditmesh/tools/process_model.py` ki tarah rakho; numbers ek YAML se load karo, har number ke saath `source:`.
- Har step ke liye table: actor, input, output (evidence), touch, wait, label, "agent kya kabhi nahi karega".
- Acceptance: model run karke table generate ho; sign-off ko `auto` karne pe script fail ho; 3 assumptions jo customer se confirm karne hain alag list mein.

### Common pitfalls
- Sirf touch time automate karna aur wait ignore karna -- agent 2 ghante mein kaam kar de, phir bhi sign-off ke liye 5 din pada rahe.
- Exceptions ke path ko map na karna (missing export, app owner chhutti pe) -- real time wahi kha jaata hai.
- Analysts ke saamne "aapka kaam automate ho raha hai" framing -- adoption mar jaata hai. Bolo "boring 80% agent karega, judgement aapka".

### Checklist before moving on
- [ ] Touch time aur lead time ka fark Kavach ke example se samjha sakta hoon.
- [ ] Har step ka label (`auto/assist/human`) aur uski wajah bata sakta hoon.
- [ ] Sign-off kyun `human` hi rehta hai, policy reference ke saath.
- [ ] Mera process model sign-off automate karne pe fail hota hai.

### Related
- M15-01 Conducting technical discovery and scoping workshops
- M15-03 Drafting architecture SOWs
- M15-04 Preparing ROI presentations for CISO and executives
- M09-04 Supervisor and Router patterns
- M16-02 Identifying Human-in-the-Loop bottlenecks

### Self-quiz
1. As-is mein 101 touch hours hain par lead time 15 din. Agent sirf touch hours kam kare to Meera ko kya farak padega?
2. Step 3 `assist` kyun hai, `auto` kyun nahi? Kis condition pe aap use `auto` karne ka suggest karoge?
3. Process map ka koi ek output AuditMesh ke kaunse code component ka requirement banta hai?
4. Analyst kehti hai "step 2 mein 2 min lagte hain." Aap ye number kaise verify karoge?
