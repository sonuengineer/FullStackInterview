# AuditMesh - Multi-Agent Compliance System

## Drafting latency/cost SLAs

> Core | Fast CP8 / Slow CP10 | ~1.2 h | Builds on: M16-01, M16-02, M14-11

### Kahani
Kavach ka procurement SOW sign karne se pehle ek page maangta hai: "AuditMesh kitna fast, kitna sasta, kitna reliable hoga -- numbers mein."
Meera chahti hai "audit 1 ghante mein", finance chahta hai "per run cost fixed", aur Anil (IT) poochta hai "down hua to kaun jawab dega?"
Pichhle vendor ne likha tha "near real-time" -- jab human review 3 din leta tha, to SLA breach ka jhagda 2 mahine chala.
Aapko aisa SLA draft karna hai jo measurable ho, sirf aapke control wale hisson pe ho, aur jiske liye ek script har roz check kar sake ki pass hai ya fail.

### What it is
**SLI** = jo measure karte ho (p95 latency per step, cost per run, success rate). **SLO** = internal target (p95 check < 300 s). **SLA** = customer se vaada, aksar SLO se thoda loose, consequences ke saath.
**Error budget** = `(1 - target) x runs` -- itne failures allowed hain; budget khatam -> features freeze, reliability pe kaam.

### Why it matters for an FDE
Vague SLA = endless disputes. Agent latency aur human wait mix kar diya to aap us cheez ke liye zimmedar ban jaate ho jo aapke haath mein hai hi nahi.

### Key concepts
- **p95, not average** -- average ek slow run chhupa deta hai; p95 batata hai 20 mein se 1 run kitna bura hai.
- **Per-step SLO** -- collect/check/flag/draft alag; regression kis step mein hai turant dikhta hai (M14-10 spans se).
- **Cost per audit run** -- tokens x price, per run; price ek config value hai (provider price page se, date ke saath).
- **Scope the clock** -- human review queue ka apna SLO (M16-02), agent latency SLA se bahar.
- **Measurement window** -- "last 200 runs" ya "rolling 30 days"; bina window ke p95 ka koi matlab nahi.

Draft SLA table (illustrative inputs -- calibrate on your pilot data):

| SLI | SLO (internal) | SLA (customer) | Source |
|---|---|---|---|
| p95 agent latency per step | collect 120 s, check 300 s, flag 90 s, draft 60 s | full agent pass < 15 min | trace spans |
| Cost per audit run (p95) | < USD 1.50 | monthly cap agreed in SOW | token counts x price |
| Availability (runs finishing) | 99% per 200 runs | 98% per month | run status |
| Human review cleared | 5 working days | reported, not penalised | approval queue |

### Code example
`pip install pyyaml`

```python
# runnable
import math, random
import yaml

SLA_YAML = """
window_runs: 200            # evaluate over the last 200 audit runs
steps_p95_seconds:          # agent time only -- human review wait is a separate SLO
  collect: 120
  check: 300
  flag: 90
  draft_tickets: 60
max_cost_per_run_usd: 1.50
availability_target: 0.99   # share of runs that finish without a hard failure
price_per_mtok: {input: 3.00, output: 15.00}   # illustrative -- read your provider's price page
"""
SLA = yaml.safe_load(SLA_YAML)

def p95(xs):                                   # nearest-rank percentile
    s = sorted(xs)
    return s[max(0, math.ceil(0.95 * len(s)) - 1)]

def fake_runs(n=200, seed=3, slow_check=1.0, fail_rate=0.005):
    rnd, base = random.Random(seed), {"collect": 60, "check": 150, "flag": 40, "draft_tickets": 25}
    runs = []
    for i in range(n):
        steps = {k: {"latency_s": rnd.lognormvariate(math.log(v * (slow_check if k == "check" else 1)), 0.35),
                     "in_tok": rnd.randint(20_000, 60_000), "out_tok": rnd.randint(2_000, 8_000)}
                 for k, v in base.items()}
        runs.append({"run_id": f"r{i}", "ok": rnd.random() > fail_rate, "steps": steps})
    return runs

def run_cost(run, price):
    return sum(s["in_tok"] * price["input"] + s["out_tok"] * price["output"] for s in run["steps"].values()) / 1e6

def check_sla(runs, sla):
    runs = runs[-sla["window_runs"]:]
    report, violations = {}, []
    for step, limit in sla["steps_p95_seconds"].items():
        v = p95([r["steps"][step]["latency_s"] for r in runs if r["ok"]])
        report[f"p95_{step}_s"] = round(v, 1)
        if v > limit:
            violations.append(f"p95 {step} {v:.0f}s > {limit}s")
    costs = [run_cost(r, sla["price_per_mtok"]) for r in runs]
    report["cost_per_run_p95_usd"] = round(p95(costs), 2)
    if p95(costs) > sla["max_cost_per_run_usd"]:
        violations.append(f"cost p95 ${p95(costs):.2f} > ${sla['max_cost_per_run_usd']}")
    failures = sum(not r["ok"] for r in runs)
    budget = (1 - sla["availability_target"]) * len(runs)          # allowed failed runs in window
    report["availability"] = round(1 - failures / len(runs), 4)
    report["error_budget_used"] = round(failures / budget, 2)
    if failures > budget:
        violations.append(f"error budget exhausted: {failures} failures > {budget:.0f} allowed")
    return report, violations

healthy, v1 = check_sla(fake_runs(), SLA)
print("healthy:", healthy, v1)
assert v1 == [] and healthy["error_budget_used"] <= 1

regressed, v2 = check_sla(fake_runs(slow_check=2.5, fail_rate=0.03), SLA)   # e.g. new model, bigger prompts
print("regressed:", v2)
assert any(v.startswith("p95 check") for v in v2) and any("error budget" in v for v in v2)
print("OK: SLA checker")
```

- SLA YAML mein hai, code mein nahi -- customer ke saath negotiate hone wala document hi machine-checkable config hai.
- `p95` nearest-rank hai -- simple aur explainable; jo method use karo woh SLA doc mein likho.
- Latency sirf `ok` runs pe; failed runs error budget mein count hote hain -- double counting nahi.
- `error_budget_used` 0.5 = aadha budget kharch; 1 se upar = breach. Ye number weekly review mein Meera ko dikhao.
- `regressed` scenario: model change se `check` 2.5x slow aur failures badhe -- checker dono pakadta hai. Deploy se pehle isi ko CI mein chalao.

### Mini-exercise (30-60 min)
AuditMesh deliverable "drafting latency and cost SLAs": `auditmesh/docs/sla.md` + `auditmesh/sla.yaml` + `auditmesh/tools/sla_check.py`.
- SLA table apne pilot ke numbers se bharo (kam se kam 20 local runs ke traces, M14-11 se token counts).
- Checker ko apne real trace export pe chalao (JSON lines file); output weekly report ki tarah markdown mein.
- Doc mein "out of scope" section: human wait, Jira downtime, customer network.
- Acceptance: healthy data pe pass, ek deliberately slow step pe fail; har number ke saath "measured on <date>, N runs".

### Common pitfalls
- Demo ke 3 runs se SLA number banana -- pilot traffic pe calibrate karo, pehle SLO, SLA baad mein.
- Token price hard-code karke bhool jaana -- price badalta hai; config + date rakho.
- Retries ko latency se bahar rakhna -- user ko retry ke saath wala time dikhta hai (M14-02); wahi measure karo.

### Checklist before moving on
- [ ] SLI, SLO, SLA aur error budget ka fark Kavach example se samjha sakta hoon.
- [ ] Human review wait SLA se bahar kyun hai, bata sakta hoon.
- [ ] Mera checker healthy aur regressed dono data pe sahi result deta hai.
- [ ] Cost per run ka formula aur uske inputs ka source pata hai.

### Related
- M14-10 Capturing deep span-level execution traces
- M14-11 Monitoring granular token costs and endpoint latency
- M14-02 Exponential backoff strategies
- M16-02 Identifying Human-in-the-Loop bottlenecks
- M16-08 Building comprehensive token cost/trace dashboards

### Self-quiz
1. Average latency 90 s hai par p95 600 s. Meera ko kya bologe aur kahan dekhoge?
2. 200 runs, target 99%, 3 failures -- error budget used kitna hai aur ab kya karna chahiye?
3. SLA mein "audit 1 ghante mein" kyun nahi likh sakte? Kya likhoge iski jagah?
4. Naya model 30% sasta hai par `check` step 2x slow. SLA doc kaise decide karne mein madad karta hai?
