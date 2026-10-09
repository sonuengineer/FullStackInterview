# AuditMesh - Multi-Agent Compliance System

## Identifying Human-in-the-Loop bottlenecks

> Core | Fast CP8 / Slow CP10 | ~1.2 h | Builds on: M16-01, M10-03, M10-04

### Kahani
AuditMesh ka pehla pilot: agent ne raat bhar mein 1,200 access grants check kar diye. Subah Meera khush thi.
Phir policy aayi: "har item ek analyst approve karega, safety ke liye." Teen analysts, jo din mein sirf ~2 ghante review ko de sakte hain.
Do hafte baad bhi approval queue mein 600 items pade the -- agent fast tha, insaan bottleneck ban gaya, aur quarter-end deadline miss hone lagi.
Ab Meera kehti hai "agent slow hai". Aapko numbers se dikhana hai ki problem agent nahi, **queue design** hai -- aur fix hai risk-tiered review, na ki zyada agents.

### What it is
**HITL bottleneck analysis** = human review step ko ek queue ki tarah model karna: kitna kaam aata hai (**arrival rate**), reviewers kitna nipta sakte hain (**capacity**), aur kya ye SLA window mein clear hoga.
Fix aksar ye hota hai ki sirf **high-risk** items insaan ko jaayein; baaki sample ya auto-accept (with audit log).

### Why it matters for an FDE
"Human approves everything" sabse safe lagta hai par queue kabhi clear nahi hoti; log rubber-stamp karne lagte hain aur control asal mein kamzor ho jaata hai. Ye maths aapko CISO aur Meera dono ke saath defend karni hai.

### Key concepts
- **Utilization (rho)** = demand / capacity = `lambda / (c * mu)`. rho >= 1 -> queue hamesha badhti hai; rho ~0.8 se upar wait time tezi se badhta hai.
- **Little's law** -- `L = lambda * W`: queue mein average items = arrival rate x average time in system. Do maalum ho to teesra nikal lo.
- **Risk tiers** -- high = full human review, medium = sampled (e.g. 1 in 10), low = auto-accept + logged. Thresholds compliance ke saath sign-off karo.
- **Effective capacity** -- reviewers ka 8 ghanta nahi, real available time (yahan 2 h/day) lo.
- **Rubber-stamping signal** -- approval time per item suddenly 5 second -> insaan padh nahi raha; ye bhi metric hai.

```text
agent (fast) --1,200 items--> [ review queue ] --c=3 reviewers, 2 h/day--> sign-off
                               ^ bottleneck: rho = demand / capacity
tiered:  high (score>=0.6) -> human 10 min | medium -> 1 in 10 sampled | low -> auto + audit log
```

### Code example
stdlib only

```python
# runnable
import heapq, random

DAY_MIN = 120        # each analyst can give ~2 h/day to reviews (they have day jobs)
REVIEWERS = 3
SLA_DAYS = 5         # Meera's target: review done within 5 working days

def make_items(n=1200, seed=7):
    rnd = random.Random(seed)
    return [round(rnd.betavariate(1.5, 4), 3) for _ in range(n)]   # risk score 0..1, most items low

def review_minutes(risk, policy):
    """Human minutes this item costs under a policy (0 = no human needed)."""
    if policy == "review_all":
        return 4
    if risk >= 0.6:                     # high: full review with evidence
        return 10
    if risk >= 0.25:                    # medium: 1 in 10 sampled
        return 4 if int(risk * 1000) % 10 == 0 else 0
    return 0                            # low: auto-accept, logged for audit

def simulate(arrivals, services, c):
    """FIFO queue, c servers. arrivals/services in reviewer-minutes. Returns time-in-system per item."""
    free = [0.0] * c
    heapq.heapify(free)
    done = []
    for t, s in sorted(zip(arrivals, services)):
        start = max(t, heapq.heappop(free))
        heapq.heappush(free, start + s)
        done.append((t, start + s))
    return done

items = make_items()
for policy in ("review_all", "tiered"):
    work = [review_minutes(r, policy) for r in items]
    queued = [w for w in work if w > 0]
    spans = simulate([0.0] * len(queued), queued, REVIEWERS)   # agent drops the batch overnight
    days = max(end for _, end in spans) / DAY_MIN
    rho = sum(queued) / (REVIEWERS * DAY_MIN * SLA_DAYS)       # demand / capacity inside the SLA window
    print(f"{policy:10} human items={len(queued):4}  work={sum(queued) / 60:5.1f}h  rho={rho:4.2f}  done in {days:4.1f} days")
    if policy == "review_all":
        assert rho > 1 and days > SLA_DAYS          # the bottleneck: queue cannot clear in time
    else:
        assert rho < 0.8 and days <= SLA_DAYS   # keep slack: target rho <= ~0.8
        assert all(review_minutes(r, policy) == 10 for r in items if r >= 0.6)   # high risk always human

# Little's law on continuous monitoring mode: L = lambda * W
rnd = random.Random(1)
arr, t = [], 0.0
while t < 20 * DAY_MIN:
    t += rnd.expovariate(1 / 6)                     # one high-risk item every ~6 reviewer-minutes
    arr.append(t)
svc = [rnd.expovariate(1 / 10) for _ in arr]        # ~10 min each
spans = simulate(arr, svc, REVIEWERS)
horizon = max(e for _, e in spans)
lam = len(spans) / horizon
W = sum(e - a for a, e in spans) / len(spans)
L_sampled = sum(sum(1 for a, e in spans if a <= m < e) for m in range(int(horizon))) / int(horizon)
print(f"lambda={lam:.3f}/min  W={W:.1f} min  lambda*W={lam * W:.2f}  L(sampled)={L_sampled:.2f}")
assert abs(L_sampled - lam * W) / (lam * W) < 0.05
print("OK: HITL queue model")
```

- `DAY_MIN = 120` -- capacity real available time se, job description se nahi. Yahi ek number poora result badal deta hai.
- `rho` SLA window ke andar demand/capacity hai: `review_all` pe 2.67 (impossible), `tiered` pe 0.50 (slack bacha).
- `simulate` ek simple FIFO multi-server queue hai (heap of "next free time"); batch arrival = agent ka overnight run.
- Medium tier ka sampling yahan deterministic hai (test repeatable rahe); production mein random sample + seed audit log mein save karo.
- Little's law block continuous-monitoring mode dikhata hai: sampled queue length aur `lambda * W` match karte hain -- aap dashboard se queue length dekh ke wait time estimate kar sakte ho.

### Mini-exercise (30-60 min)
AuditMesh deliverable "human-in-the-loop approval workflows" ka sizing: `auditmesh/docs/hitl-capacity.md` + `auditmesh/tools/queue_model.py`.
- Apne seed data ke risk scores pe ye model chalao; 3 policies compare karo (review_all, tiered, tiered + 4th reviewer).
- Table: items to human, human hours, rho, days to clear. Thresholds (0.6 / 0.25 / 1-in-10) ek config file mein.
- Ek "what if": ek reviewer chhutti pe (c=2) -- kya SLA abhi bhi bachta hai?
- Acceptance: script asserts pass; doc mein recommended policy + rho target + Meera ke sign-off ke liye ek line "low-risk auto-accept ki audit evidence kya hogi".

### Common pitfalls
- Average pe plan karna -- quarter-end pe saara batch ek saath aata hai; peak rho dekho, average nahi.
- Thresholds khud decide karna -- risk appetite customer ka decision hai; aap data do, woh sign karein.
- Auto-accepted items ka log na rakhna -- auditor poochega "low-risk kisne dekha?" Answer: rule + sample + log.

### Checklist before moving on
- [ ] rho >= 1 ka matlab aur Kavach ke numbers pe uska result bata sakta hoon.
- [ ] Little's law se queue length se wait time nikal sakta hoon.
- [ ] Risk-tiered review ke 3 tiers aur unka audit evidence samjha sakta hoon.
- [ ] Mera model ek reviewer kam hone ka scenario chala chuka hai.

### Related
- M10-03 Interrupting graph execution
- M10-04 Requesting manual state approval
- M16-01 Mapping 5-step manual compliance workflows
- M16-03 Drafting latency/cost SLAs
- M16-09 Creating Streamlit/Gradio UIs for human approval workflows

### Self-quiz
1. Agent 10x fast ho jaaye par policy `review_all` rahe -- days to clear pe kya asar padega aur kyun?
2. Dashboard pe approval queue mein average 30 items hain aur 6 items/hour aate hain. Average wait kitna hai?
3. rho 0.97 pe "SLA meet ho raha hai" -- phir bhi aap ise risky kyun bologe?
4. Low-risk auto-accept ke against CISO ka objection kya hoga, aur aap kaunsa evidence doge?
