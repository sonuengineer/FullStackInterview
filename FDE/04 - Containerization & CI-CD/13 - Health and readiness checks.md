# Containerization & CI-CD

## Health and readiness checks

> Core | Fast CP4 / Slow CP6 | ~1.2 h | Builds on: M04-04, M04-06, M04-12

### Kahani
Logistics customer, Monday 9 AM. LLM provider ka ek region 4 minute slow hua. OmniGuard ka `/health` LLM ko call karta tha, 30 s mein reply nahi, ALB ne saare targets unhealthy mark kiye -- ECS ne saare tasks replace kar diye.
Naye tasks boot hote hi (index load = 40 s) health check fail -- `startPeriod` 10 s tha. Restart loop. LLM wapas aa gaya tha, par OmniGuard 25 minute down raha.
Ek slow dependency ne poori service gira di -- sirf isliye ki probes ka design galat tha.

### What it is
**Liveness** (`/healthz`) = "process zinda hai, restart ki zaroorat nahi?" -- cheap, dependencies nahi.
**Readiness** (`/readyz`) = "kya main abhi traffic le sakta hoon?" -- dependencies (DB, LLM gateway) bounded timeout ke saath check, warm-up ke baad hi ready, shutdown pe turant not-ready.
Platform dono ko alag use karta hai: ECS container `healthCheck` restart decide karta hai, ALB target group health check traffic.

### Why it matters for an FDE
Probes ka galat design outage ko chhota (ek dependency slow) se bada (poori service down) bana deta hai. Customer ke SRE ye sabse pehle poochte hain: "dependency down ho to aapki app kya karti hai?"

### Key concepts
- **Never check dependencies in liveness** -- warna dependency outage = restart storm.
- **Bounded readiness** -- har dependency check pe timeout (e.g. 300 ms); probe khud kabhi hang na ho.
- **Cache the result** -- 2-5 s TTL; 10 tasks x har 5 s probe se DB/LLM pe extra load nahi.
- **Startup grace** -- container `startPeriod` / service `healthCheckGracePeriodSeconds` >= real boot time.
- **Draining** -- SIGTERM pe readiness 503, phir in-flight requests khatam, phir exit (`stopTimeout`, deregistration delay).

### Code example
`pip install fastapi httpx`

```python
# runnable
import asyncio
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Response
from fastapi.testclient import TestClient

class FakeDep:
    """Stands in for a DB pool / LLM gateway client. mode: ok | down | slow. No network."""
    def __init__(self, name):
        self.name, self.mode, self.calls = name, "ok", 0
    async def ping(self):
        self.calls += 1
        if self.mode == "slow":
            await asyncio.sleep(5)                       # hung dependency
        if self.mode == "down":
            raise ConnectionError(self.name)

def create_app(deps, check_timeout=0.3, cache_ttl=2.0, warmup_s=0.0) -> FastAPI:
    state = {"warm": False, "draining": False, "cache": (0.0, None)}

    @asynccontextmanager
    async def lifespan(app):
        await asyncio.sleep(warmup_s)                    # e.g. load index / embeddings
        state["warm"] = True
        yield
        state["draining"] = True                         # SIGTERM: fail readiness first

    app = FastAPI(lifespan=lifespan)

    async def check(dep):
        try:
            await asyncio.wait_for(dep.ping(), timeout=check_timeout)
            return dep.name, "ok"
        except asyncio.TimeoutError:
            return dep.name, "timeout"
        except Exception:
            return dep.name, "down"

    @app.get("/healthz")
    async def healthz():
        return {"status": "ok"}

    @app.get("/readyz")
    async def readyz(response: Response):
        ts, cached = state["cache"]
        if cached is None or time.monotonic() - ts > cache_ttl:
            cached = dict(await asyncio.gather(*(check(d) for d in deps)))   # checks run in parallel
            state["cache"] = (time.monotonic(), cached)
        ready = state["warm"] and not state["draining"] and all(v == "ok" for v in cached.values())
        response.status_code = 200 if ready else 503
        return {"ready": ready, "checks": cached, "draining": state["draining"]}

    app.state.flags = state
    return app

db, llm = FakeDep("db"), FakeDep("llm_gateway")
app = create_app([db, llm], cache_ttl=0.0)
with TestClient(app) as c:
    assert c.get("/readyz").status_code == 200
    llm.mode = "slow"
    t0 = time.monotonic()
    r = c.get("/readyz")
    elapsed = time.monotonic() - t0
    print("llm slow ->", r.status_code, r.json()["checks"], f"{elapsed:.2f}s")
    assert r.status_code == 503 and r.json()["checks"]["llm_gateway"] == "timeout"
    assert elapsed < 3.0                                 # bounded: far below the 5 s hang
    assert c.get("/healthz").status_code == 200          # liveness ignores dependencies
    llm.mode, db.mode = "ok", "down"
    assert c.get("/readyz").json()["checks"]["db"] == "down"
    app.state.flags["draining"] = True                   # what lifespan shutdown does on SIGTERM
    assert c.get("/readyz").status_code == 503 and c.get("/healthz").status_code == 200

db2 = FakeDep("db")
with TestClient(create_app([db2], cache_ttl=60)) as c:
    for _ in range(5):
        c.get("/readyz")
    assert db2.calls == 1                                # cached: 5 probes, 1 real check
print("OK: bounded, cached readiness; cheap liveness; draining")
```

- `asyncio.wait_for(..., timeout=0.3)` -- hung LLM gateway 5 s sota hai, probe 0.3 s pe "timeout" bolke 503 deta hai. ALB ka probe timeout isse bada hona chahiye.
- `asyncio.gather` -- DB aur LLM check parallel; total time = slowest check, sum nahi.
- `cache_ttl` -- probes chahe kitne aayein, dependencies pe load fix. Doosra test isse prove karta hai (5 probes, 1 call).
- `draining` -- shutdown pe pehle readiness 503 (ALB naya traffic band karta hai), liveness 200 rehta hai (koi restart nahi).
- Ek design choice: kya LLM gateway down hone pe readiness fail ho? Agar saare tasks same gateway use karte hain, saare ek saath 503 -- ALB "fail open" karta hai jab saare targets unhealthy hon (check ALB docs). Kai teams sirf local dependencies readiness mein rakhti hain aur LLM failure ko app-level fallback se handle karti hain -- customer ke saath decide karo.

Probe numbers jo saath fit hone chahiye (OmniGuard, boot ~40 s):

```json
{
  "ecs_container_healthCheck": {"path": "/healthz", "interval": 30, "timeout": 5, "retries": 3, "startPeriod": 60},
  "ecs_service": {"healthCheckGracePeriodSeconds": 90},
  "alb_target_group": {"path": "/readyz", "interval": 15, "timeout": 5, "healthyThreshold": 2,
                       "unhealthyThreshold": 3, "deregistrationDelay": 30},
  "container_stopTimeout": 45,
  "uvicorn_timeout_graceful_shutdown": 20
}
```

```bash
# run later against your deployed service (M04-12) -- replace the URL
curl -s -o /dev/null -w "healthz %{http_code} %{time_total}s\n" https://YOUR-ALB-DNS/healthz
curl -s -w "\nreadyz %{http_code}\n" https://YOUR-ALB-DNS/readyz
aws elbv2 describe-target-health --target-group-arn "$TG_ARN" --query "TargetHealthDescriptions[].TargetHealth.State"
```

### Mini-exercise (30-60 min)
OmniGuard:
- `app/health.py` -- upar jaisa: per-check timeout, parallel checks, TTL cache, warm-up flag, draining flag. `/readyz` response mein koi secret/connection string nahi.
- `tests/test_health.py` -- ok, db down, llm slow (bounded time), cache (1 call), draining -- sab cases.
- `ecs/taskdef.json` healthCheck `/healthz` + `startPeriod`, ALB target group `/readyz` (M04-07) -- upar ke JSON jaisa table `docs/probes.md` mein, har number ka reason.
- CP4 gate check: live URL pe `/healthz` 200 aur `/readyz` 200; README mein dono links + CI badge.

### Common pitfalls
- `startPeriod` boot time se kam -- naya task kabhi healthy nahi hota, deploy rollback loop (M04-12 circuit breaker).
- `/readyz` response mein exception message ya DB host -- public endpoint pe internal info leak; sirf `ok/down/timeout`.
- Health check logs har 5 s -- log bill aur noise; health endpoints ko access log se exclude ya sample karo.

### Checklist before moving on
- [ ] Liveness mein koi dependency call nahi.
- [ ] Readiness bounded (timeout) aur cached hai.
- [ ] Draining: SIGTERM pe readiness 503, liveness 200.
- [ ] `startPeriod`, grace period, deregistration delay aur graceful shutdown ke numbers ek doosre se consistent.

### Related
- M04-04 Containerizing FastAPI backends
- M04-06 Configuring task definitions
- M04-07 Load balancer integration
- M04-12 Continuous deployment to AWS
- M14-04 Configuring rate limiting and fallback routing

### Self-quiz
1. Kahani mein 4-minute LLM slowdown 25-minute outage kaise bana? Do design galtiyan batao.
2. ALB unhealthy threshold 3, interval 15 s. Ek broken task kitni der mein traffic se hatega?
3. Readiness check ko cache karna kab galat ho sakta hai?
4. LLM gateway down hone pe `/readyz` 503 de ya 200 + degraded mode? Dono ke trade-offs batao.
