# AI Observability & Gateway Management

## Monitoring granular token costs and endpoint latency

> Core | Fast CP8 / Slow CP10 | ~1.2 h | Builds on: M14-10, M14-03, M05-03, M03-13

### Kahani
Ek fintech customer ke paas teen AI endpoints hain: `/kyc-summary`, `/dispute-draft`, `/chat`. Provider ka monthly invoice ek single number hai -- is mahine pichhle se 2.4x.
CFO poochta hai: "Kaunsa tenant, kaunsa endpoint? Aur kya ye growth hai ya bug?" Engineering ke paas average latency ka ek graph hai -- 1.8 s, "sab theek".
Baad mein pata chala: ek tenant ka retry loop `/dispute-draft` ko 6x call kar raha tha, aur us endpoint ka p99 14 s tha -- average ne sab chhupa diya.
Aapko per-request cost aur percentile latency chahiye, tenant aur endpoint ke hisaab se.

### What it is
**Per-request cost** = `input_tokens x input_price + cache_read_tokens x cache_price + output_tokens x output_price`, prices "per 1M tokens" se. Prices config se aate hain -- provider pricing page check karo, code mein hard-code mat karo.
**Endpoint latency** ko average se nahi, **p50/p95/p99** se dekho; group by tenant + endpoint + model, aur budget/SLA cross hone pe alert.

### Why it matters for an FDE
Customer ka pehla escalation aksar bill hota hai, accuracy nahi. Chargeback (kaunsi team pay kare), SLA reports (M16-03) aur "kya ye cost cut ho sakta hai" -- sab isi data pe chalte hain.

### Key concepts
- **Usage fields per provider** -- Anthropic `usage` mein `input_tokens` aur `cache_read_input_tokens` alag aate hain; OpenAI `prompt_tokens` mein cached tokens shamil hote hain (`prompt_tokens_details.cached_tokens`). Field names check the docs for your version.
- **Price table as input** -- `{model: {input, output, cache_read}}` per 1M tokens, versioned config; price badle to purane records purane price se hi rahein.
- **Percentiles** -- p95 = 95% requests isse tez; tail latency hi users ko yaad rehti hai. Average ek slow tail ko chhupa deta hai.
- **Cost per successful outcome** -- per request se zyada useful: retries aur failures bhi cost karte hain.
- **Budget projection** -- `spent / days_elapsed * days_in_month`; 80% pe warn, 100% pe page.

### Code example
`pip install numpy`

```python
# runnable
from collections import defaultdict
import numpy as np

PRICES = {  # USD per 1M tokens -- INPUT from config; check the provider pricing page, never trust these
    "large": {"input": 3.00, "cache_read": 0.30, "output": 15.00},
    "small": {"input": 0.25, "cache_read": 0.03, "output": 1.25},
}

def request_cost(rec, prices, cached_included_in_input=False):
    p = prices[rec["model"]]
    fresh = rec["input_tokens"] - (rec["cache_read_tokens"] if cached_included_in_input else 0)
    return (fresh * p["input"] + rec["cache_read_tokens"] * p["cache_read"]
            + rec["output_tokens"] * p["output"]) / 1_000_000

def synthetic_logs(n=6000, seed=1):
    rng = np.random.default_rng(seed)
    eps = {"/kyc-summary": ("small", 1200, 300), "/dispute-draft": ("large", 4000, 900), "/chat": ("small", 800, 200)}
    logs = []
    for i in range(n):
        tenant = ["acme", "globex", "initech"][i % 3]
        ep = list(eps)[rng.integers(0, 3)]
        model, tin, tout = eps[ep]
        slow = tenant == "globex" and ep == "/dispute-draft" and rng.random() < 0.08   # the hidden tail
        logs.append({"tenant": tenant, "endpoint": ep, "model": model, "ok": rng.random() > 0.02,
                     "input_tokens": int(rng.normal(tin, tin * 0.1)), "cache_read_tokens": int(tin * 0.5),
                     "output_tokens": int(rng.normal(tout, tout * 0.2)),
                     "latency_ms": float(rng.lognormal(7.2, 0.3) * (8 if slow else 1))})
    return logs

def report(logs, prices):
    g = defaultdict(list)
    for r in logs:
        g[(r["tenant"], r["endpoint"])].append(r)
    rows = []
    for (tenant, ep), rs in sorted(g.items()):
        lat = np.array([r["latency_ms"] for r in rs])
        cost = sum(request_cost(r, prices) for r in rs)
        p50, p95, p99 = np.percentile(lat, [50, 95, 99])
        rows.append({"tenant": tenant, "endpoint": ep, "n": len(rs), "cost": cost, "mean": lat.mean(),
                     "p50": p50, "p95": p95, "p99": p99,
                     "cost_per_ok": cost / max(1, sum(r["ok"] for r in rs))})
    return rows

def budget_alerts(logs, prices, budgets, day, days_in_month=30, sla_p95_ms=3000):
    spent = defaultdict(float)
    for r in logs:
        spent[r["tenant"]] += request_cost(r, prices)
    alerts = []
    for t, b in budgets.items():
        projected = spent[t] / day * days_in_month
        if projected >= b:
            alerts.append((t, "PAGE" if spent[t] >= b else "WARN_PROJECTED", round(projected, 2)))
    alerts += [(r["tenant"], f"SLA_P95 {r['endpoint']}", round(r["p95"])) for r in report(logs, prices) if r["p95"] > sla_p95_ms]
    return alerts

one = {"model": "large", "input_tokens": 1_000_000, "cache_read_tokens": 1_000_000, "output_tokens": 100_000}
assert abs(request_cost(one, PRICES) - (3.00 + 0.30 + 1.50)) < 1e-9          # Anthropic-style usage
assert abs(request_cost(one, PRICES, cached_included_in_input=True) - 1.80) < 1e-9   # OpenAI-style usage
logs = synthetic_logs()
rows = report(logs, PRICES)
for r in rows:
    print(f"{r['tenant']:8} {r['endpoint']:15} n={r['n']:4} ${r['cost']:7.3f} "
          f"mean={r['mean']:6.0f} p50={r['p50']:6.0f} p95={r['p95']:6.0f} p99={r['p99']:6.0f}")
g = next(r for r in rows if r["tenant"] == "globex" and r["endpoint"] == "/dispute-draft")
a = next(r for r in rows if r["tenant"] == "acme" and r["endpoint"] == "/dispute-draft")
assert g["p99"] > 4 * a["p99"] and g["mean"] < 2 * a["mean"]     # the mean hides what p99 shows
alerts = budget_alerts(logs, PRICES, {"acme": 100.0, "globex": 25.0, "initech": 15.0}, day=10)
print("alerts:", alerts)
kinds = {(t, k) for t, k, _ in alerts}
assert ("globex", "WARN_PROJECTED") in kinds and ("initech", "PAGE") in kinds
assert not any(t == "acme" for t, _ in kinds)                    # on track: no noise
assert ("globex", "SLA_P95 /dispute-draft") in kinds
print("OK: cost from usage x input prices, cache reads priced separately, p50/p95/p99 per tenant+endpoint, alerts")
```

- `request_cost` -- prices parameter se aate hain; `cached_included_in_input` flag provider ke usage semantics ko handle karta hai. Galat flag = cache reads double count.
- Hand-checked test (`one`) -- 1M in, 1M cache read, 100k out ka cost haath se calculate karke assert; cost code mein unit test zaroori hai, ye paisa hai.
- `globex /dispute-draft` -- mean sirf thoda zyada, p99 4x+ -- yahi Kahani wala hidden tail hai.
- `cost_per_ok` -- failed requests bhi bill hote hain; retries badhne pe ye number pehle chillata hai.
- `budget_alerts` -- day 10 pe projection se warn, actual cross pe page; SLA alert p95 pe, mean pe nahi.

### Mini-exercise (30-60 min)
AuditMesh v1.0 ke liye `auditmesh/obs/costs.py` banao: input = M14-10 ke `traces/*.jsonl` ke LLM spans (`gen_ai.usage.*`, model, latency_ms, tenant, endpoint), output = `dashboard/cost_latency.json`.
- Price table `auditmesh/obs/prices.yaml` mein (version + `effective_from` date); script yaml se padhe.
- JSON shape: per tenant+endpoint rows (n, cost, p50/p95/p99, cost_per_ok) + alerts list -- ye M16-08 dashboard ka data feed hai.
- Acceptance: pytest -- hand-calculated cost case pass; p95 numpy se match; prices.yaml change karne pe code change nahi lagta.

### Common pitfalls
- Average latency pe SLA likhna -- tail users ko marta hai; SLA hamesha percentile pe (p95/p99) aur window ke saath.
- Prices code mein hard-code -- provider price badalta hai, report chupke se galat. Config + effective date.
- Cost sirf provider invoice se reconcile na karna -- apna estimate aur invoice monthly compare karo; 5%+ gap = missing usage logging (jaise streaming responses ka usage).

### Checklist before moving on
- [ ] Ek request ka cost haath se calculate kar sakta hoon, cache reads ke saath.
- [ ] Apne provider ke usage fields mein cached tokens kaise report hote hain, pata hai.
- [ ] p50/p95/p99 per tenant+endpoint nikal sakta hoon aur average kyun misleading hai samjha sakta hoon.
- [ ] Budget projection aur SLA alert rules likhe hain.

### Related
- M14-10 Capturing deep span-level execution traces
- M14-15 Prompt caching strategies
- M03-13 Setting automated budget thresholds
- M16-08 Building comprehensive token cost and trace dashboards

### Self-quiz
1. Mean latency 1.8 s aur p99 14 s -- ye kya batata hai, aur customer ko kaunsa number report karoge?
2. OpenAI-style usage pe cached tokens ko alag se add kar diya -- cost report pe kya asar hoga?
3. "Cost per request" ke bajaye "cost per successful outcome" kab better metric hai?
4. Day 5 pe tenant ka spend budget ka 25% hai. Alert chahiye ya nahi? Calculate karke batao (30-day month).
