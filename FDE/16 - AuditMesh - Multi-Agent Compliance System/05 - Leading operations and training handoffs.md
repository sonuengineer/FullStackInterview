# AuditMesh - Multi-Agent Compliance System

## Leading operations and training handoffs

> Core | Fast CP8 / Slow CP10 | ~1.2 h | Builds on: M16-03, M16-04, M15-05

### Kahani
AuditMesh UAT pass ho gaya. Aapka engagement 3 hafte mein khatam hai, phir aap agle customer pe.
Pichhle quarter ek doosre vendor ka bot raat 2 baje fail hua -- alert kisi ke paas gaya hi nahi, kyunki on-call list mein vendor ka engineer tha jo chala gaya tha. Quarter-end report 4 din late, Meera ko board ke saamne sorry bolna pada.
Ab Meera clear hai: "Handoff tab hoga jab meri team aur Anil ki team bina aapke ek incident sambhaal le." 
Aapka kaam: runbooks, on-call, dashboards, training aur RACI ka ek package -- aur ek objective check ki package complete hai.

### What it is
**Ops + training handoff** = system ki ownership FDE se customer ki teams ko transfer karna: kaun kya chalaata hai (RACI), alert aaye to kya karna hai (runbook), kaun phone uthayega (on-call), kya dekhna hai (dashboards), aur kisne training li (training plan).
Handoff ek event nahi, ek **shadow period** hai: pehle aap lead, customer shadow; phir customer lead, aap shadow.

### Why it matters for an FDE
FDE ka kaam "deploy" pe khatam nahi hota -- system tab successful hai jab aapke jaane ke baad bhi chale. Bura handoff = aapka next project bhi purane customer ke escalations mein doob jaata hai.

### Key concepts
- **Runbook per alert** -- har alert ka link ek runbook pe: symptom, first 3 checks, safe action (e.g. checkpoint se rerun, M10-01), escalation.
- **RACI** -- har activity: R (karta hai), A (accountable, exactly ek), C (consulted), I (informed). Do A = koi A nahi.
- **On-call rota** -- primary + secondary, alag log, dono trained; FDE sirf shadow weeks mein secondary.
- **Training plan by role** -- reviewer (approval UI, reject with reason), ops (dashboards, runbooks), admin (thresholds, access). Har session ke end pe hands-on exercise.
- **Exit criteria** -- objective: N incidents customer ne lead kiye, saare SLO panels live, runbooks ek dry-run mein test hue.

Training session plan (example, 3 x 60 min):

| Session | Audience | Hands-on | Pass signal |
|---|---|---|---|
| Reviewing in AuditMesh | analysts, Meera | approve/reject 10 seeded items, one with injected text | correct decisions + reasons written |
| Running AuditMesh | Kavach IT on-call | game day: Jira MCP down, rerun from checkpoint | RB-01 followed without FDE help |
| Owning AuditMesh | Meera, CISO delegate | change a risk threshold via PR, read SLA report | change reviewed, report explained back |

### Code example
`pip install pyyaml`

```python
# runnable
import copy
import yaml

PACKAGE = yaml.safe_load("""
slos: [agent_latency_p95, cost_per_run, availability, review_queue_age]
dashboards: {ops-overview: [agent_latency_p95, availability], finops: [cost_per_run], hitl: [review_queue_age]}
alerts:
  - {name: run_failed_rate_high, runbook: RB-01}
  - {name: cost_per_run_spike, runbook: RB-02}
  - {name: review_queue_stale, runbook: RB-03}
runbooks:
  RB-01: {owner: kavach-it, steps: [check trace, check Jira MCP health, rerun from checkpoint]}
  RB-02: {owner: kavach-it, steps: [open finops dashboard, find run, check model routing]}
  RB-03: {owner: compliance-lead, steps: [check reviewer load, reassign, escalate to Meera]}
raci:   # R=does it, A=accountable (exactly one), C=consulted, I=informed
  approve_exceptions: {R: [analysts], A: meera, C: [], I: [internal-audit]}
  respond_to_alerts: {R: [kavach-it], A: anil, C: [fde], I: [meera]}
  change_risk_thresholds: {R: [meera], A: ciso, C: [fde, internal-audit], I: [analysts]}
oncall:
  - {week: 1, primary: ravi, secondary: fde}
  - {week: 2, primary: sana, secondary: ravi}
trained: {ravi: [ops], sana: [ops], fde: [ops], priya: [reviewer], meera: [reviewer, admin]}
roles_needing_training: [ops, reviewer, admin]
shadow_incidents_handled_by_customer: 2
""")

def readiness_gaps(p, min_shadow=2):
    gaps = []
    covered = {s for panels in p["dashboards"].values() for s in panels}
    gaps += [f"SLO {s} has no dashboard panel" for s in p["slos"] if s not in covered]
    for a in p["alerts"]:
        rb = p["runbooks"].get(a["runbook"])
        if not rb or not rb.get("steps") or not rb.get("owner"):
            gaps.append(f"alert {a['name']} has no usable runbook")
    for act, r in p["raci"].items():
        if not isinstance(r.get("A"), str) or not r["A"]:
            gaps.append(f"RACI {act}: needs exactly one A")
        if not r.get("R"):
            gaps.append(f"RACI {act}: nobody is R")
    for w in p["oncall"]:
        if w["primary"] == w["secondary"]:
            gaps.append(f"on-call week {w['week']}: primary == secondary")
        for who in sorted({w["primary"], w["secondary"]}):
            if "ops" not in p["trained"].get(who, []):
                gaps.append(f"on-call week {w['week']}: {who} not ops-trained")
    have = {r for roles in p["trained"].values() for r in roles}
    gaps += [f"nobody trained for role {r}" for r in p["roles_needing_training"] if r not in have]
    if p["shadow_incidents_handled_by_customer"] < min_shadow:
        gaps.append("customer has not yet led enough incidents with FDE shadowing")
    return gaps

assert readiness_gaps(PACKAGE) == [], readiness_gaps(PACKAGE)
print("complete package: ready")

broken = copy.deepcopy(PACKAGE)
broken["dashboards"].pop("hitl")
broken["runbooks"].pop("RB-02")
broken["raci"]["approve_exceptions"]["A"] = ["meera", "ciso"]      # two accountable = none accountable
broken["oncall"][1] = {"week": 2, "primary": "priya", "secondary": "priya"}
broken["shadow_incidents_handled_by_customer"] = 0
gaps = readiness_gaps(broken)
for g in gaps:
    print(" gap:", g)
assert len(gaps) == 6 and any("exactly one A" in g for g in gaps)
print("OK: handoff-readiness validator")
```

- Poora handoff package ek YAML hai -- doc aur check ek hi source se; Confluence page isi se generate kar sakte ho.
- Dashboard check SLOs (M16-03) se cross-reference karta hai -- "SLO hai par koi dekh nahi raha" pakda jaata hai.
- RACI rule: `A` ek string hona chahiye; list = do accountable = jhagde ke time koi nahi.
- On-call check training se jodta hai -- untrained insaan on-call pe = runbook bekaar.
- `shadow_incidents_handled_by_customer` -- exit criteria number mein; "lagta hai woh ready hain" nahi.

### Mini-exercise (30-60 min)
AuditMesh deliverable "operational handoffs": `auditmesh/docs/handoff/` mein `handoff.yaml`, `runbooks.md`, `training-plan.md`, `raci.md`.
- Apne real alerts (M16-08 dashboards se) ke liye 3 runbooks likho; har ek ko ek game day mein khud follow karke time karo.
- Validator ko CI mein `handoff.yaml` pe chalao; ek extra check add karo: har runbook step 15 words se kam aur ek command/link ke saath.
- 15-min training video script (English) reviewers ke liye: approve, reject with reason, "cannot approve own request" dikhana.
- Acceptance: validator 0 gaps; broken copy pe saare gaps; RACI Meera aur Anil ke naam ke saath (fictional), sign-off line ke saath.

### Common pitfalls
- Runbook mein "investigate the issue" -- 2 baje koi investigate nahi karta; exact commands aur links do.
- Training sirf slides -- hands-on ke bina reviewers pehle real din pe hi galti karte hain.
- FDE ko RACI mein permanently R rakhna -- handoff kabhi complete nahi hota; end date ke saath "C" pe le aao.

### Checklist before moving on
- [ ] RACI ka "exactly one A" rule aur uski wajah samjha sakta hoon.
- [ ] Har alert -> runbook -> owner chain apne system ke liye bana chuka hoon.
- [ ] Shadow period aur objective exit criteria define kar sakta hoon.
- [ ] Mera validator complete package pe pass aur broken pe fail hota hai.

### Related
- M15-05 Delivering User Acceptance Testing (UAT) runbooks
- M10-01 Check-pointing graph states
- M16-03 Drafting latency/cost SLAs
- M16-08 Building comprehensive token cost/trace dashboards
- M16-09 Creating Streamlit/Gradio UIs for human approval workflows

### Self-quiz
1. RACI mein do log "A" hain -- incident ke time practically kya hota hai?
2. Runbook RB-01 "rerun from checkpoint" kehta hai. Iske liye system mein pehle se kya hona zaroori hai?
3. Meera kehti hai "training ho gayi, slides bhej di." Aap kaise prove karoge ki team ready hai?
4. Aapke jaane ke 2 hafte baad cost spike alert aaya. Ideal handoff mein kaun kya karega?
