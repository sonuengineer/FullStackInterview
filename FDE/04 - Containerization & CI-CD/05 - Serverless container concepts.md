# Containerization & CI-CD

## Serverless container concepts

> Core | Fast CP4 / Slow CP6 | ~1.2 h | Builds on: M03-04, M03-12, M04-04

### Kahani
Ek insurance customer ka CTO workshop mein poochta hai: "Hamare OmniGuard pilot ke liye Kubernetes cluster chahiye kya? Hamare paas platform team nahi hai."
Traffic: din mein 9 se 6, ~200 claims adjusters, raat ko lagbhag zero. Kuch document-processing jobs 25 minute chalte hain.
Agar aap bina soche "Lambda pe daal dete hain" bolo, to 25-minute job fail. "Fargate pe 24x7" bolo, to raat bhar idle compute ka bill. FDE ka kaam: requirement -> platform mapping, numbers ke saath.

### What it is
**Serverless containers** = aap sirf container image dete ho; servers, OS patching, cluster capacity provider manage karta hai. Options: **AWS Lambda (container image)**, **AWS App Runner**, **ECS on Fargate**, **Google Cloud Run**.
Farak: scale-to-zero, max request duration, cold start, networking control aur billing model mein.

### Why it matters for an FDE
Galat platform = ya to reliability fail (timeouts, cold starts in demo) ya cost surprise (M03-12). Customer ko trade-off ek table mein samjhana aapka deliverable hai.

### Key concepts
- **Scale to zero** -- idle pe koi instance nahi, koi compute bill nahi; price = pehli request pe **cold start**.
- **Billing model** -- per-request + GB-second (Lambda), per-instance-second (Fargate), hybrid (Cloud Run, App Runner).
- **Max duration** -- Lambda invocation max 15 min; long jobs ke liye Fargate task ya queue + worker.
- **Concurrency per instance** -- Lambda: 1 request per execution environment; Cloud Run/App Runner: ek instance kai requests.
- **Control vs convenience** -- Fargate: VPC, security groups, sidecars, full control, zyada config; App Runner/Cloud Run: kam knobs.

| | Lambda (container image) | App Runner | ECS Fargate | Cloud Run (GCP) |
|---|---|---|---|---|
| Scale to zero | Yes | No (min 1 provisioned, idle billed lower) | No (min tasks you set) | Yes (or min instances) |
| Max request time | 15 min | check docs (short, HTTP only) | No limit (long-running) | Up to 60 min |
| Cold start | Yes, image size matters | Low once provisioned | Task start = tens of seconds+ | Yes unless min instances |
| App contract | Lambda Runtime API (or Web Adapter) | Any HTTP server on a port | Any process | Any HTTP server on `$PORT` |
| Ops effort | Low | Lowest | Medium-high (ALB, VPC, scaling) | Low |
| Good for | Spiky, short requests | Simple HTTP API, small team | Steady traffic, workers, full control | GCP customers, spiky HTTP |

Limits and availability change -- confirm every number in the provider docs for your region before a customer proposal (App Runner ki current availability bhi check karo).

### Code example
stdlib only

```python
# runnable
from dataclasses import dataclass

@dataclass
class Workload:
    cloud: str                 # "aws" or "gcp"
    max_request_s: int         # longest single request/job
    idle_hours_per_day: float
    needs_private_vpc: bool
    long_lived_connections: bool = False   # websockets, streaming for minutes
    ops_team: bool = False

def choose_platform(w: Workload) -> tuple[str, str]:
    if w.cloud == "gcp":
        if w.max_request_s > 3600:
            return "GKE / Compute Engine job", "longer than Cloud Run request limit"
        return "Cloud Run", "scale to zero, any HTTP container"
    if w.max_request_s > 15 * 60 or w.long_lived_connections:
        return "ECS Fargate", "exceeds Lambda 15 min limit or needs long-lived connections"
    if w.idle_hours_per_day >= 12 and not w.needs_private_vpc:
        return "Lambda (container image)", "mostly idle -> pay per request"
    if not w.ops_team and not w.needs_private_vpc:
        return "App Runner", "simple HTTP service, minimal ops (check availability)"
    return "ECS Fargate", "VPC control / steady traffic"

# ILLUSTRATIVE prices only -- not real. Read the AWS/GCP pricing pages for real numbers.
PRICE = {"vcpu_hour": 0.04, "gb_hour": 0.0045, "gb_second": 0.0000167, "per_million_req": 0.20}

def always_on_monthly(vcpu: float, gb: float, tasks: int) -> float:
    return round(tasks * 730 * (vcpu * PRICE["vcpu_hour"] + gb * PRICE["gb_hour"]), 2)

def per_request_monthly(req_per_month: int, avg_s: float, gb: float) -> float:
    compute = req_per_month * avg_s * gb * PRICE["gb_second"]
    return round(compute + req_per_month / 1e6 * PRICE["per_million_req"], 2)

pilot = Workload(cloud="aws", max_request_s=20, idle_hours_per_day=15, needs_private_vpc=False)
batch = Workload(cloud="aws", max_request_s=25 * 60, idle_hours_per_day=15, needs_private_vpc=True)
bank = Workload(cloud="aws", max_request_s=30, idle_hours_per_day=2, needs_private_vpc=True, ops_team=True)
gcp = Workload(cloud="gcp", max_request_s=120, idle_hours_per_day=10, needs_private_vpc=False)

for name, w in [("pilot", pilot), ("batch", batch), ("bank", bank), ("gcp", gcp)]:
    print(f"{name:6} -> {choose_platform(w)}")
assert choose_platform(pilot)[0].startswith("Lambda")
assert choose_platform(batch)[0] == "ECS Fargate"
assert choose_platform(bank)[0] == "ECS Fargate"
assert choose_platform(gcp)[0] == "Cloud Run"

fargate = always_on_monthly(vcpu=0.5, gb=1, tasks=2)
low = per_request_monthly(req_per_month=50_000, avg_s=2.0, gb=1)
high = per_request_monthly(req_per_month=20_000_000, avg_s=2.0, gb=1)
print(f"always-on={fargate}  per-request low={low}  per-request high={high}")
assert low < fargate < high        # break-even exists: busy services favour always-on
print("OK: platform choice + break-even shape")
```

- `choose_platform` -- order matters: pehle hard limits (15 min, long connections), phir cost (idle hours), phir ops/VPC.
- Lambda `needs_private_vpc` -- Lambda VPC mein ja sakta hai, par yahan simplification hai: VPC + steady traffic = Fargate default.
- `PRICE` dict jaan-boojh ke fake hai -- lesson shape sikhata hai (break-even), number nahi. Customer ko real pricing calculator se number do.
- Last assert -- kam traffic pe per-request sasta, bahut traffic pe always-on sasta; beech mein break-even point.

```bash
# run later on your own AWS account (free tier; budget alarm from M03-13 already set) -- read-only commands
aws lambda get-account-settings --query AccountLimit
aws ecs list-clusters
```

### Mini-exercise (30-60 min)
OmniGuard `docs/platform-decision.md`:
- 3 workloads likho: OmniGuard API (business hours), nightly document indexing (40 min), admin UI (rare use).
- Har ek ke liye `choose_platform` chalao (`tools/platform_choice.py` + test), reasoning ke saath table.
- AWS Pricing Calculator se real monthly estimate (2 tasks 0.5 vCPU/1 GB vs Lambda at 50k requests) -- screenshot ya numbers doc mein.
- CP4 decision: OmniGuard API ke liye ECS Fargate (M04-06, M04-12) -- doc mein ek line "kyun".

### Common pitfalls
- Lambda container ko normal FastAPI image samajhna -- Runtime API ya Lambda Web Adapter chahiye; seedha `uvicorn` CMD kaam nahi karega.
- Demo se pehle warm-up bhool jana -- scale-to-zero platform pe customer ki pehli click cold start pe atki.
- Fargate pe "serverless = automatically cheap" samajhna -- min tasks 24x7 chalte hain, bill bhi 24x7.

### Checklist before moving on
- [ ] Chaaron platforms ka scale-to-zero aur max duration bina dekhe bata sakte ho.
- [ ] Break-even ka idea: kam traffic per-request, steady traffic always-on.
- [ ] OmniGuard ke liye platform choice ka written reason hai.

### Related
- M03-04 Event-driven serverless function basics
- M03-12 Navigating the AWS Billing console
- M04-06 Configuring task definitions
- M04-08 Auto-scaling policy configuration

### Self-quiz
1. 25-minute document job Lambda pe kyun nahi chalega? Do alternatives batao.
2. Cold start kis cheez se badhta hai container image ke case mein, aur use kaise kam karoge?
3. Customer GCP pe hai, traffic spiky. Kya recommend karoge aur kya caveat bataoge?
4. Kis traffic pattern pe Fargate always-on Lambda se sasta padta hai? Reasoning se samjhao.
