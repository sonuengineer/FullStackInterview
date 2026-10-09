# OmniGuard - Secure AI Integration

## Preparing ROI presentations for CISO/executives

> Core | Fast CP6 / Slow CP8 | ~1.2 h | Builds on: M15-01, M15-03, M14-11

### Kahani
Kavach ka SOW draft ready hai. Ab steering committee: CISO Anil, CFO Sunita, Head of Claims Priya. 20 minute slot.
Pichhli vendor ne slide dikhayi thi: "AI will save 10 crore and eliminate data breach risk." Sunita ne poocha "10 crore kaise?" -- jawab nahi tha. Anil ne poocha "eliminate?" -- room mein silence. Project wahin mar gaya.
Aapko teeno ko alag cheez dikhani hai: Priya ko time saved, Sunita ko payback period, Anil ko risk aur controls. Aur sab numbers aise jo ek spreadsheet mein reproduce ho sakein.
Honest, assumption-driven ROI hi credibility banata hai -- inflated ROI ek sawaal mein gir jaata hai.

### What it is
**ROI presentation** = business case jo benefits (time saved x loaded cost, risk reduction) ko total costs (build people, LLM tokens, infra, support) ke against rakhta hai, aur **payback period** + **sensitivity table** dikhata hai.
CISO version mein risk ko expected-loss estimate ki tarah frame karte hain, guaranteed savings ki tarah nahi.

### Why it matters for an FDE
Pilot ke baad production budget isi deck pe milta hai. FDE ke paas usage data aur cost data dono hote hain -- isliye ROI ka sabse credible author wahi hai.

### Key concepts
- **Loaded cost** -- salary + benefits + overhead per hour; sirf salary use karna benefit ko kam dikhata hai, inflated "rate" use karna jhooth.
- **Adoption rate** -- 40 analysts licensed != 40 analysts daily use. Benefit hamesha adoption se multiply karo.
- **Total cost** -- one-time build (people) + run (LLM tokens, infra, support FTE). Token cost per query x queries/year explicitly dikhao.
- **Risk reduction (honest framing)** -- probability x impact x estimated reduction = expected annual loss avoided, range ke saath, cash payback se alag line.
- **Sensitivity table** -- 2 sabse uncertain inputs (adoption, hours saved) vary karo; dikhao kis point pe ROI negative hota hai.

Deck outline (6 slides): 1) problem + baseline metric, 2) solution + security controls (Anil ke liye), 3) benefits, 4) costs, 5) payback + sensitivity, 6) ask (budget, decision, date). Har number ke neeche: "illustrative input, source: discovery workshop / pilot logs".

### Code example
stdlib only

```python
# runnable
# ALL NUMBERS BELOW ARE ILLUSTRATIVE INPUTS for a fictional customer. Replace with pilot data.
from dataclasses import dataclass, replace

@dataclass(frozen=True)
class Inputs:
    analysts: int = 40
    adoption: float = 0.60                 # share of analysts actually using it weekly
    hours_saved_per_week: float = 4.0      # per active analyst, from pilot time study
    loaded_cost_per_hour: float = 900.0    # INR, salary + overhead (ask HR/finance)
    working_weeks: int = 48
    queries_per_active_day: int = 15
    working_days: int = 250
    tokens_in: int = 6_000                 # per query (prompt + retrieved context)
    tokens_out: int = 500
    price_in_per_m: float = 250.0          # INR per 1M input tokens -- check provider pricing
    price_out_per_m: float = 1_250.0       # INR per 1M output tokens
    infra_per_month: float = 60_000.0      # INR: container service, DB replica, logs
    support_fte: float = 0.25
    fte_cost_per_year: float = 3_000_000.0
    build_cost: float = 1_800_000.0        # one-time: people for the 5-week pilot + hardening

def roi(i: Inputs) -> dict:
    active = i.analysts * i.adoption
    benefit = active * i.hours_saved_per_week * i.working_weeks * i.loaded_cost_per_hour
    cost_per_query = i.tokens_in / 1e6 * i.price_in_per_m + i.tokens_out / 1e6 * i.price_out_per_m
    tokens = active * i.queries_per_active_day * i.working_days * cost_per_query
    run = tokens + i.infra_per_month * 12 + i.support_fte * i.fte_cost_per_year
    net_month = (benefit - run) / 12
    payback = i.build_cost / net_month if net_month > 0 else float("inf")
    return {"benefit": benefit, "tokens": tokens, "run": run, "cost_per_query": cost_per_query,
            "net_per_year": benefit - run, "payback_months": payback}

def risk_reduction(p_incident: float, impact: float, reduction: float) -> float:
    """Expected annual loss avoided. An ESTIMATE -- present as a range, never as cash."""
    return p_incident * impact * reduction

base = Inputs()
r = roi(base)
print(f"benefit/yr  INR {r['benefit']:>12,.0f}")
print(f"tokens/yr   INR {r['tokens']:>12,.0f}  ({r['cost_per_query']:.3f} per query)")
print(f"run cost/yr INR {r['run']:>12,.0f}")
print(f"payback     {r['payback_months']:.1f} months")
assert abs(r["cost_per_query"] - 2.125) < 1e-9                  # 6k*250/1M + 500*1250/1M
assert abs(r["benefit"] - 24 * 4 * 48 * 900) < 1e-6             # 24 active analysts
assert 8 < r["payback_months"] < 10

low, high = risk_reduction(0.05, 20_000_000, 0.2), risk_reduction(0.15, 20_000_000, 0.4)
print(f"risk: expected loss avoided INR {low:,.0f} - {high:,.0f} / yr (estimate, not in payback)")
assert low < high

print("\nSensitivity: payback months (rows = adoption, cols = hours saved/week)")
hours = [2.0, 4.0, 6.0]
print("adoption | " + " | ".join(f"{h:>5}" for h in hours))
grid = {}
for a in [0.3, 0.6, 0.9]:
    row = [roi(replace(base, adoption=a, hours_saved_per_week=h))["payback_months"] for h in hours]
    grid[a] = row
    print(f"  {a:>4.0%}   | " + " | ".join("never" if p == float("inf") else f"{p:5.1f}" for p in row))
assert grid[0.3][0] == float("inf")                             # low adoption + low savings: no payback
assert grid[0.9][2] < grid[0.6][1] < grid[0.3][2]               # more usage -> faster payback
print("OK: ROI is reproducible, and the deck shows where it breaks")
```

- `Inputs` frozen dataclass -- har assumption ek naam aur comment ke saath. Sunita kisi bhi number pe "ye kahan se aaya?" pooche, jawab line mein hai.
- `cost_per_query` -- token cost explicitly; context size (6k tokens) badhao to cost seedha badhta hai. Ye M14-11 ke token dashboard se real ho jaata hai.
- `risk_reduction` alag function aur range -- CISO ko "eliminate" nahi, "expected loss 2 lakh - 12 lakh/yr kam, estimate" dikhate ho, aur payback mein add nahi karte.
- Sensitivity grid -- 30% adoption + 2 hours pe "never". Ye slide pe dikhana weakness nahi, credibility hai: "adoption hi key risk hai, isliye training plan hai."
- Asserts formula ko hand-calc se tie karte hain -- deck ke numbers aur code ke numbers kabhi drift nahi karenge.

### Mini-exercise (30-60 min)
OmniGuard deliverable #11: `omniguard/docs/ROI.md` + `omniguard/tools/roi.py` + 6-slide outline (`omniguard/docs/roi-deck-outline.md`).
- Inputs ko YAML/JSON file se load karo; har input ke saath `source` field ("illustrative", "pilot logs", "HR").
- Apne OmniGuard ke real token usage (M14-11 logs ya `count_tokens`) se `tokens_in/out` bharo.
- Acceptance: `roi.py inputs.yaml` markdown table print kare (benefit, costs, payback, 3x3 sensitivity); pytest mein formula ka hand-calc test; ROI.md ke top pe "All figures are illustrative inputs for a fictional customer."

### Common pitfalls
- Risk avoided ko cash savings mein jod dena -- CFO turant pakad leta hai, aur poora deck suspect ho jaata hai.
- People cost (build + support FTE) chhod dena aur sirf tokens + infra dikhana -- AI project ka sabse bada cost aksar log hote hain.
- Pilot ke 10 power users ka adoption poore org pe extrapolate karna -- adoption assumption ko conservative rakho aur sensitivity mein dikhao.

### Checklist before moving on
- [ ] Time-saved benefit formula aur adoption ka role bata sakta hoon.
- [ ] Token cost per query calculate kar sakta hoon (input + output alag price).
- [ ] Risk reduction ko honestly (range, expected loss, alag line) frame kar sakta hoon.
- [ ] Sensitivity table se "ROI kahan toot-ta hai" dikha sakta hoon.

### Related
- M15-03 Drafting architecture SOWs
- M15-05 Delivering User Acceptance Testing (UAT) runbooks
- M14-11 Monitoring granular token costs and endpoint latency
- M14-16 Model selection and routing

### Self-quiz
1. Adoption 60% se 30% hua to benefit aur token cost dono pe kya asar hoga? Payback kyun non-linearly badhta hai?
2. CISO ko risk reduction kaise present karoge bina "eliminate" ya guaranteed savings bole?
3. Context ko 6k se 3k tokens karne ka ROI pe kya effect hai, aur iska quality trade-off kya ho sakta hai?
4. CFO poochti hai "loaded cost 900/hr kahan se aaya?" Aapka ideal jawab kya hai?
