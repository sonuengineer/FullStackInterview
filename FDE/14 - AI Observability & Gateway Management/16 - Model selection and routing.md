# AI Observability & Gateway Management

## Model selection and routing

> Core | Fast CP8 / Slow CP10 | ~1.2 h | Builds on: M14-04, M14-05, M14-11, M14-15

### Kahani
Ek telecom customer ka support assistant har request pe sabse bada model use karta hai -- "password reset kaise karoon?" bhi, aur "mere 3 bills mein roaming charges ka dispute, contract clause 7 ke hisaab se" bhi.
Cost dashboard (M14-11) dikhata hai: 70% traffic simple FAQ hai, lekin bill ka 70% bhi wahi.
Kisi ne sab kuch chhote model pe switch kar diya -- bill 80% gira, aur do hafte baad dispute cases mein galat answers ki complaints aa gayi.
Customer bolta hai: "Sasta bhi chahiye, sahi bhi. Aur agli baar switch se pehle proof chahiye."

### What it is
**Model routing** = har request ke liye model choose karna -- task difficulty, latency budget aur cost ke hisaab se. Do common patterns: **router** (pehle ek cheap classifier decide kare small ya large) aur **cascade** (pehle small model, confidence kam ho to large pe escalate).
Har routing change pehle **offline eval** (M14-05..08) pe prove hota hai, phir traffic pe.

### Why it matters for an FDE
Cost cut karna customer ka sabse common ask hai, aur galat routing quality regression ka sabse common cause. Aapka kaam hai numbers ke saath trade-off dikhana: "itna saving, itna quality loss, ye threshold."

### Key concepts
- **Difficulty signals** -- input length, multi-step/tool need, domain keywords (dispute, legal), user tier; ek cheap heuristic ya small classifier.
- **Cascade + confidence** -- small model ka answer + confidence (self-check, schema validity, judge score); threshold ke neeche escalate. Cost = small hamesha + large kabhi-kabhi.
- **Overconfident small model** -- cascade ka asli risk: galat answer high confidence ke saath. Isliye eval mein "confident but wrong" alag count karo.
- **Offline gate** -- labelled set pe accuracy, cost, p95 latency; rule jaise "accuracy large se max 2 points kam, cost 40%+ kam" tabhi ship.
- **Model ids config mein** -- env/config se padho, kabhi hard-coded "truth" nahi; provider ka current model list check karo, models retire hote rehte hain.

### Code example
stdlib only

```python
# runnable
import hashlib, os, re

MODELS = {"small": os.environ.get("SMALL_MODEL", "small-model-id-from-config"),   # check current model list
          "large": os.environ.get("LARGE_MODEL", "large-model-id-from-config")}
PRICE = {"small": 0.4, "large": 6.0}          # USD per 1M blended tokens -- INPUT, check provider pricing
LATENCY = {"small": 400, "large": 2200}       # ms, measured from your own traces (M14-11)
HARD = re.compile(r"dispute|clause|contract|refund|compare|why", re.I)

def h(s, mod=100): return int(hashlib.sha256(s.encode()).hexdigest(), 16) % mod

class FakeModel:      # stand-in for a chat call that returns text + a confidence score
    def __init__(self, size): self.size = size
    def answer(self, item):
        hard, r = item["hard"], h(self.size + item["q"])
        if self.size == "large":
            return {"correct": r < 95, "confidence": 0.9}
        correct = r < (40 if hard else 97)
        confident = correct or r > 85                              # some wrong answers are overconfident
        return {"correct": correct, "confidence": 0.9 if confident else 0.4}

def classify(q):
    return "large" if HARD.search(q) or len(q.split()) > 25 else "small"

def run(strategy, items, threshold=0.7):
    small, large = FakeModel("small"), FakeModel("large")
    correct = cost = 0.0; lat = []; tokens = 1500
    for it in items:
        if strategy in ("small", "large"):
            path = [strategy]
        elif strategy == "router":
            path = [classify(it["q"])]
        else:                                                       # cascade
            path = ["small"] if small.answer(it)["confidence"] >= threshold else ["small", "large"]
        out = (small if path[-1] == "small" else large).answer(it)
        correct += out["correct"]
        cost += sum(PRICE[m] * tokens / 1e6 for m in path)
        lat.append(sum(LATENCY[m] for m in path))
    lat.sort()
    return {"acc": correct / len(items), "cost": cost, "p95": lat[int(0.95 * len(lat)) - 1]}

EASY = ["how do I reset my password {}", "what is my data balance {}", "change billing address {}"]
HARDQ = ["dispute roaming charges on bill {} under contract clause 7", "why was refund {} rejected twice"]
items = [{"q": EASY[i % 3].format(i), "hard": False} for i in range(700)] + \
        [{"q": HARDQ[i % 2].format(i), "hard": True} for i in range(300)]

res = {s: run(s, items) for s in ["large", "small", "router", "cascade"]}
for s, r in res.items():
    print(f"{s:8} acc={r['acc']:.3f} cost=${r['cost']:.2f} p95={r['p95']}ms")

def gate(candidate, baseline, max_acc_drop=0.02, min_saving=0.4):
    return (baseline["acc"] - candidate["acc"] <= max_acc_drop
            and candidate["cost"] <= (1 - min_saving) * baseline["cost"])

assert not gate(res["small"], res["large"])            # cheap but quality regression -> blocked
assert gate(res["router"], res["large"])               # router passes the offline gate
assert res["cascade"]["acc"] < res["router"]["acc"]    # overconfident small answers leak through
assert res["router"]["p95"] == LATENCY["large"] and res["cascade"]["p95"] == sum(LATENCY.values())
print("models from config:", MODELS)
print("OK: classifier router + cascade compared offline; gate blocks the all-small switch")
```

- `MODELS` env se -- code mein koi model id "sach" nahi; gateway alias (M14-03) ho to aur better.
- `classify()` -- cheap regex/length heuristic; real mein ek chhota classifier ya small-model call, lekin pehle simple shuru karo aur eval se prove karo.
- `FakeModel("small")` hard items pe 40% sahi, aur kuch galat answers bhi confidence 0.9 ke saath -- isliye cascade ka accuracy router se kam aaya.
- `gate()` -- all-small 80%+ sasta hai lekin accuracy drop limit se zyada, isliye blocked; Kahani wali galti yahin pakdi jaati.
- p95 -- cascade mein escalated requests do calls ka latency dete hain; latency SLA (M16-03) tight ho to cascade nuksaan kar sakta hai.

```python
# real version -- not run here, needs: pip install anthropic
import os, anthropic
client = anthropic.Anthropic()
def route_and_answer(question):
    model = MODELS[classify(question)]                     # ids from env/config, check current model list
    msg = client.messages.create(model=model, max_tokens=800,
                                 messages=[{"role": "user", "content": question}])
    log_span(model=model, route=classify(question), usage=msg.usage)   # M14-10 / M14-11
    return msg.content[0].text
```

### Mini-exercise (30-60 min)
AuditMesh v1.0 mein `auditmesh/obs/routing.py`: supervisor-level decisions `supervisor-large` pe, simple field extraction workers `worker-small` pe (gateway aliases, M14-03).
- `evals/routing_set.jsonl` -- 40 labelled AuditMesh tasks (easy/hard, expected output). `run_eval.py --routing` har strategy ka acc, cost, p95 table banaye.
- Gate rule `evals/gates.yaml` mein; CI fail ho agar routing change gate cross na kare.
- Acceptance: report mein "confident but wrong" count; route decision har LLM span ka attribute ho (`route=small|large`) taaki dashboard (M16-08) per-route cost dikhaye.

### Common pitfalls
- Routing change direct production pe bina offline eval -- quality regression complaints se pata chalta hai, metrics se nahi.
- Cascade mein small model ka self-reported confidence pe andha bharosa -- calibrate karo (M14-05 jaisa), ya schema/judge check use karo.
- Classifier khud ek mehenga LLM call -- routing ka overhead saving kha jaata hai. Router ka cost aur latency bhi measure karo.

### Checklist before moving on
- [ ] Router aur cascade ka farak aur dono ke latency/cost trade-offs bata sakta hoon.
- [ ] Offline eval pe acc, cost, p95 teeno compare karta hoon.
- [ ] Ek written gate rule hai jo all-small jaisi galti block kare.
- [ ] Model ids config/env se aate hain.

### Related
- M14-04 Configuring rate limiting and fallback routing
- M14-05 Automating LLM-as-a-judge scoring pipelines
- M14-08 Creating synthetic benchmark datasets from source documents
- M14-11 Monitoring granular token costs and endpoint latency

### Self-quiz
1. Cascade router se kab better hai, aur kab worse? Latency aur accuracy dono ke hisaab se batao.
2. Small model "confident but wrong" hai -- ye eval mein kaise pakdoge aur production mein kaise mitigate karoge?
3. Customer bolta hai "sab small pe daal do, 80% bachat". Aap kaunsa data dikhaoge?
4. Model ids hard-code karne se kya break hota hai jab provider purana model retire kare?
