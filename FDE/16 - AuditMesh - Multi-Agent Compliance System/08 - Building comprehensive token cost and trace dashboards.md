# AuditMesh - Multi-Agent Compliance System

## Building comprehensive token cost/trace dashboards

> Core | Fast CP8 / Slow CP10 | ~1.2 h | Builds on: M14-10, M14-11, M14-12, M13-14, M16-03

### Kahani
AuditMesh ka pehla full quarterly run hua. Finance ka email aaya: "LLM bill pichhle mahine se 4x kyun hai?" Meera ka sawaal: "Kitne approvals pending hain?" Anil: "Kal raat wala run kitna slow tha?"
Aapke paas traces the (M14-10), par jawab dene ke liye 3 alag tools mein 40 minute khodna pada -- aur pending approvals ka number galat nikla, kyunki aap "requested" events gin rahe the, decided wale minus nahi kiye.
Upar se ek screenshot mein prompt text dikh gaya jismein ek PAN number tha.
Aapko ek dashboard chahiye jiske numbers trace data se derive hon, ek fixed **data contract** follow karein, aur jinhe test kiya ja sake.

### What it is
**Token cost + trace dashboard** = span-level traces (run, LLM call, tool call, approval events) ko aggregate karke panels: per-run tokens aur cost, cost by model, p95 run latency, runs in flight, approvals pending.
Dashboard ka **data contract** = backend function jo spans leke fixed shape ka JSON de; UI (Grafana, Streamlit, Langfuse view) sirf usse render kare.

### Why it matters for an FDE
Cost spike ya SLA breach pe customer pehle dashboard dekhta hai. Galat number (jaise pending approvals) pe trust ek baar gaya to har report pe sawaal uthega -- aur PII leak hua to project band.

### Key concepts
- **Spans -> metrics** -- har metric spans se derive ho, alag counters se nahi; ek source of truth (M14-10).
- **Cost = tokens x price per model** -- price table config mein, date ke saath; cost by model se routing decisions (M14-16) dikhte hain (M14-11).
- **In-flight vs finished** -- p95 latency sirf finished runs pe; running runs alag panel mein.
- **State from events** -- pending = requested minus decided; events gino, state nahi maano.
- **No content on dashboards** -- prompt, ticket text, PII kabhi aggregate output mein nahi (M13-14); sirf ids, counts, hashes.

```text
 AuditMesh (supervisor, workers, MCP calls, approvals)
     | spans: run / llm / tool / approval events  (M14-10 tracer, exported as JSON lines)
     v
 build_dashboard(spans, prices)  -> contract JSON  <-- acceptance harness tests THIS
     v
 panels: cost today | cost by model | per-run table | p95 latency vs SLO (M16-03) | approvals pending | in flight
```

Panels and alerts (feed M16-05 runbooks):

| Panel | Source | Alert |
|---|---|---|
| Cost per run (p95), cost by model | llm spans x price table | cost_per_run_spike -> RB-02 |
| p95 run latency vs SLO | run spans (finished) | latency SLO burn |
| Approvals pending, oldest age | approval events | review_queue_stale -> RB-03 |
| Failed runs / error budget | run status | run_failed_rate_high -> RB-01 |

### Code example
stdlib only

```python
# runnable
import importlib, json, math, os, random

PRICES = {"model-large": (3.00, 15.00), "model-small": (0.25, 1.25)}   # USD per 1M in/out tokens, illustrative
CONTRACT = {"runs", "p95_run_latency_s", "cost_total_usd", "cost_by_model_usd", "approvals_pending", "runs_in_flight"}
RUN_KEYS = {"run_id", "tokens", "cost_usd", "latency_s"}

def p95(xs):
    s = sorted(xs); return s[max(0, math.ceil(0.95 * len(s)) - 1)]

def synthetic_traces(n_runs=40, seed=11):
    """Span records like the ones your tracer exports (M14-10), plus the ground truth computed independently."""
    rnd, spans, truth = random.Random(seed), [], {"tokens": {}, "latency": [], "cost": 0.0, "pending": 0}
    for i in range(n_runs):
        rid, t0, dur = f"run-{i:03d}", 1000.0 * i, rnd.uniform(200, 900)
        finished = i < n_runs - 2                                  # last 2 runs still running
        spans.append({"run_id": rid, "kind": "run", "start": t0, "end": t0 + dur if finished else None})
        tok = 0
        for _ in range(rnd.randint(3, 6)):
            m, it, ot = rnd.choice(list(PRICES)), rnd.randint(1000, 30000), rnd.randint(100, 3000)
            spans.append({"run_id": rid, "kind": "llm", "model": m, "in_tok": it, "out_tok": ot,
                          "prompt": "Review grant for PAN ABCDE1234F"})   # sensitive -- must never reach the dashboard
            tok += it + ot
            truth["cost"] += (it * PRICES[m][0] + ot * PRICES[m][1]) / 1e6
        spans.append({"run_id": rid, "kind": "approval", "approval_id": f"ap-{i}", "event": "requested"})
        if i % 4:                                                  # 1 in 4 approvals still waiting
            spans.append({"run_id": rid, "kind": "approval", "approval_id": f"ap-{i}", "event": "approved"})
        else:
            truth["pending"] += 1
        truth["tokens"][rid] = tok
        if finished:
            truth["latency"].append(dur)
    return spans, truth

def standin_build_dashboard(spans, prices, naive_pending=False):
    """STAND-IN, not AuditMesh: the aggregation your dashboard backend must do."""
    runs, by_model, decided, requested = {}, {}, set(), set()
    for s in spans:
        r = runs.setdefault(s["run_id"], {"run_id": s["run_id"], "tokens": 0, "cost_usd": 0.0, "latency_s": None})
        if s["kind"] == "run" and s["end"] is not None:
            r["latency_s"] = s["end"] - s["start"]
        elif s["kind"] == "llm":
            c = (s["in_tok"] * prices[s["model"]][0] + s["out_tok"] * prices[s["model"]][1]) / 1e6
            r["tokens"] += s["in_tok"] + s["out_tok"]; r["cost_usd"] += c
            by_model[s["model"]] = by_model.get(s["model"], 0.0) + c
        elif s["kind"] == "approval":
            (requested if s["event"] == "requested" else decided).add(s["approval_id"])
    done = [r["latency_s"] for r in runs.values() if r["latency_s"] is not None]
    return {"runs": list(runs.values()), "p95_run_latency_s": p95(done), "cost_by_model_usd": by_model,
            "cost_total_usd": sum(by_model.values()), "runs_in_flight": len(runs) - len(done),
            "approvals_pending": len(requested) if naive_pending else len(requested - decided)}

# Point at your real code later: AUDITMESH_DASHBOARD_FN="auditmesh.dashboard.data:build_dashboard"
spec = os.environ.get("AUDITMESH_DASHBOARD_FN", "")
build = getattr(importlib.import_module(spec.split(":")[0]), spec.split(":")[1]) if spec else standin_build_dashboard

def run_harness(fn) -> list[str]:
    spans, truth = synthetic_traces()
    d, fails = fn(spans, PRICES), []
    if missing := CONTRACT - d.keys(): return [f"contract keys missing: {missing}"]
    if any(RUN_KEYS - r.keys() for r in d["runs"]): fails.append("per-run row missing keys")
    if {r["run_id"]: r["tokens"] for r in d["runs"]} != truth["tokens"]: fails.append("per-run tokens wrong")
    if abs(d["cost_total_usd"] - truth["cost"]) > 1e-6: fails.append(f"cost {d['cost_total_usd']:.4f} != {truth['cost']:.4f}")
    if abs(d["p95_run_latency_s"] - p95(truth["latency"])) > 1e-6: fails.append("p95 latency wrong (in-flight runs included?)")
    if d["runs_in_flight"] != 2: fails.append("in-flight runs not counted")
    if d["approvals_pending"] != truth["pending"]: fails.append(f"pending {d['approvals_pending']} != {truth['pending']}")
    if "ABCDE1234F" in json.dumps(d, default=str): fails.append("prompt/PII leaked into dashboard data")
    return fails

fails = run_harness(build)
print("target:", fails or "all dashboard contract checks passed")
assert fails == []
broken = run_harness(lambda s, p: standin_build_dashboard(s, p, naive_pending=True))
print("broken:", broken)
assert broken == ["pending 40 != 10"]                     # the harness has teeth
print("OK: dashboard data-contract harness")
```

- `synthetic_traces` ground truth alag se calculate karta hai -- harness target ke code pe depend nahi karta, isliye bug pakad sakta hai.
- Prompt mein fake PAN (`ABCDE1234F`, synthetic) daala hai; harness poore output JSON mein search karta hai -- leak ka cheap automated test.
- Last 2 runs `end=None` -- p95 mein include kiya to latency galat; harness ye bhi check karta hai.
- `broken` run wahi Kahani wala bug hai: requested events gine, decided minus nahi kiye -> 40 vs 10.
- `AUDITMESH_DASHBOARD_FN` -- aapka real aggregation function plug karo; UI baad mein isi contract pe banti hai.

Warehouse version of the per-run panel (once spans land in a table):
```sql
SELECT s.run_id,
       SUM(s.in_tok + s.out_tok) AS tokens,
       SUM(s.in_tok * p.in_per_mtok + s.out_tok * p.out_per_mtok) / 1e6 AS cost_usd
FROM spans AS s
JOIN model_prices AS p ON p.model = s.model
WHERE s.kind = 'llm' AND s.day = DATE('now')
GROUP BY s.run_id
ORDER BY cost_usd DESC
LIMIT 20;
```

### Mini-exercise (30-60 min)
AuditMesh deliverable #4 (token cost and traceability dashboards): `auditmesh/dashboard/data.py` + `tests/acceptance/test_dashboard.py` + ek UI.
- Apne tracer ke real export format pe `build_dashboard` likho; harness ko us format ke synthetic spans pe adapt karo.
- UI: Streamlit page ya Grafana/Langfuse dashboard -- jo bhi, contract JSON se hi render ho. Panels upar wali table se.
- Ek "trace drill-down": run_id click -> us run ke spans ka timeline (M14-12 debugging ke liye).
- Acceptance: harness green; naive pending bug pe red; dashboard screenshot README mein, koi prompt/PII nahi; har alert ka runbook link (M16-05).

### Common pitfalls
- Price hard-coded aur purana -- cost panel chupke se galat. Price table + "last updated" date panel pe dikhao.
- Average latency panel -- p95 dikhao aur SLO line saath mein (M16-03).
- Debugging ke liye prompt text dashboard pe -- trace UI mein access-controlled drill-down rakho, aggregate panels pe kabhi nahi.

### Checklist before moving on
- [ ] Har panel ka source span type aur formula bata sakta hoon.
- [ ] Pending approvals events se kaise nikalte hain, samjha sakta hoon.
- [ ] Harness ka ground truth target code se independent kyun hona chahiye, bata sakta hoon.
- [ ] Mera dashboard data function harness pe green aur PII-free hai.

### Related
- M14-10 Capturing deep span-level execution traces
- M14-11 Monitoring granular token costs and endpoint latency
- M14-12 Debugging multi-step agent reasoning and tool inputs
- M13-14 Safe logging (never log PII or prompts)
- M16-05 Leading operations and training handoffs

### Self-quiz
1. Finance kehta hai bill 4x hai. Dashboard ke kaunse do panels se aap 5 minute mein reason dhundhoge?
2. Pending approvals "requested" events gin ke kyun nahi nikalte? Event-sourcing ka ye kaunsa principle hai?
3. In-flight runs ko p95 mein include karne se number upar jaayega ya neeche? Kyun?
4. Harness ka ground truth agar stand-in function hi se calculate karte to kya problem hoti?
