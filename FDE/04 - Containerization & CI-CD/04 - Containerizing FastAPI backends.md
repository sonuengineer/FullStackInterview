# Containerization & CI-CD

## Containerizing FastAPI backends

> Core | Fast CP4 / Slow CP6 | ~1.2 h | Builds on: M04-01, M02-03, M01-13, M01-15

### Kahani
SaaS customer pe OmniGuard ECS pe live hai. Har deploy pe 20-30 users ko `502` milta hai, aur har deploy exactly 30 second extra leta hai.
Investigation: Dockerfile mein `CMD uvicorn app.main:app` (shell form). PID 1 `/bin/sh` hai, woh `SIGTERM` uvicorn ko forward hi nahi karta. ECS 30 s wait karke `SIGKILL` maarta hai -- in-flight requests beech mein kat jaati hain, DB connections clean close nahi hote.
Upar se `/health` endpoint har call pe LLM gateway ko ping karta tha -- gateway slow hua to ECS ne healthy containers bhi maar diye.

### What it is
**Containerizing FastAPI** = app ko aisa banana ki container platform usse sahi chala sake: config env vars se (M01-15), ASGI server (uvicorn) exec form mein PID 1, `lifespan` mein startup/shutdown resources, aur do alag probes -- `/healthz` (liveness) aur `/readyz` (readiness).

### Why it matters for an FDE
Customer ka platform (ECS, Kubernetes, App Runner) sirf signals aur health endpoints se baat karta hai. Ye galat ho to har deploy pe errors aur random restarts -- aur blame aapki app pe aata hai.

### Key concepts
- **Exec form CMD** -- `CMD ["uvicorn", ...]`; uvicorn PID 1 banta hai aur `SIGTERM` pe graceful shutdown karta hai.
- **lifespan** -- `@asynccontextmanager`; `yield` se pehle pools open, baad mein close. (`on_event` purana style hai.)
- **/healthz (liveness)** -- sasta, koi dependency call nahi; "process zinda hai?".
- **/readyz (readiness)** -- DB + LLM gateway check; down ho to `503` taaki load balancer traffic na bheje.
- **12-factor config** -- `PORT`, `DATABASE_URL`, `LLM_GATEWAY_URL` env se; image har environment mein same.

### Code example
`pip install fastapi httpx`

```python
# runnable
import os
import sqlite3
from contextlib import asynccontextmanager

from fastapi import FastAPI, Response
from fastapi.testclient import TestClient

class FakeLLMGateway:
    """Stands in for the real LLM gateway client (same idea: a cheap ping). No network, no key."""
    def __init__(self):
        self.up = True
    def ping(self) -> bool:
        return self.up

EVENTS: list[str] = []

def create_app(db_url: str, gateway: FakeLLMGateway) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.db = sqlite3.connect(db_url, check_same_thread=False)   # real app: async pool
        app.state.llm = gateway
        app.state.draining = False
        EVENTS.append("startup")
        yield                                              # app serves requests here
        app.state.draining = True                          # SIGTERM -> stop being "ready" first
        app.state.db.close()
        EVENTS.append("shutdown: db closed")

    app = FastAPI(lifespan=lifespan)

    @app.get("/healthz")
    def healthz():
        return {"status": "ok"}                            # no DB/LLM call: liveness must be cheap

    @app.get("/readyz")
    def readyz(response: Response):
        checks = {"db": "ok", "llm_gateway": "ok"}
        try:
            app.state.db.execute("SELECT 1")
        except sqlite3.Error:
            checks["db"] = "down"
        if not app.state.llm.ping():
            checks["llm_gateway"] = "down"
        ready = all(v == "ok" for v in checks.values()) and not app.state.draining
        response.status_code = 200 if ready else 503
        return {"ready": ready, "checks": checks}

    return app

def is_exec_form(cmd_line: str) -> bool:
    return cmd_line.removeprefix("CMD").strip().startswith("[")

gw = FakeLLMGateway()
app = create_app(os.environ.get("DATABASE_URL", ":memory:"), gw)
with TestClient(app) as client:                            # context manager runs lifespan
    assert EVENTS == ["startup"]
    assert client.get("/healthz").status_code == 200
    r = client.get("/readyz")
    assert r.status_code == 200 and r.json()["ready"] is True
    gw.up = False                                          # LLM gateway outage
    r = client.get("/readyz")
    print("gateway down ->", r.status_code, r.json()["checks"])
    assert r.status_code == 503 and r.json()["checks"]["llm_gateway"] == "down"
    assert client.get("/healthz").status_code == 200       # liveness unaffected: no restart storm
    gw.up = True
    app.state.db.close()                                   # simulate DB connection lost
    r = client.get("/readyz")
    assert r.status_code == 503 and r.json()["checks"]["db"] == "down"
    app.state.db = sqlite3.connect(":memory:", check_same_thread=False)
assert EVENTS[-1] == "shutdown: db closed"                 # graceful shutdown ran
assert is_exec_form('CMD ["uvicorn", "app.main:app"]') and not is_exec_form("CMD uvicorn app.main:app")
print("OK: liveness vs readiness, lifespan startup/shutdown, exec-form CMD")
```

- `create_app(...)` factory -- tests aur prod dono same code; dependencies inject hoti hain (M02-03).
- `with TestClient(app)` -- lifespan startup/shutdown chalata hai; bina `with` ke lifespan run nahi hota.
- LLM gateway down -> `/readyz` 503 par `/healthz` 200: LB traffic hatata hai, container restart nahi hota.
- Shutdown mein pehle `draining = True`, phir connections close -- graceful shutdown ka order yahi hai.
- Real app mein `sqlite3` ki jagah async DB pool (SQLAlchemy 2 `create_async_engine`) aur `httpx.AsyncClient` gateway client with timeout.

Runtime ke do common options:

```dockerfile
# Option A (default): one uvicorn process per container, scale with more tasks
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*", "--timeout-graceful-shutdown", "20"]

# Option B: gunicorn as process manager (uvicorn worker class; package name differs by version -- check the uvicorn docs)
# CMD ["gunicorn", "app.main:app", "-k", "uvicorn_worker.UvicornWorker", "-w", "2", "-b", "0.0.0.0:8000", "--graceful-timeout", "20"]
```

```bash
# run later on your own machine -- needs Docker Desktop
docker build -t omniguard:dev .
docker run -d --name og -p 8000:8000 -e DATABASE_URL=sqlite:///tmp/og.db omniguard:dev
curl -s localhost:8000/healthz
curl -s -o /dev/null -w "%{http_code}\n" localhost:8000/readyz
docker stop og        # sends SIGTERM; logs should show a clean shutdown, not a kill after 10 s
docker logs og | tail -n 5
```

### Mini-exercise (30-60 min)
OmniGuard `app/main.py`:
- `create_app()` factory + `lifespan` (DB pool, `httpx.AsyncClient` with timeout for the LLM gateway; dono shutdown pe close).
- `/healthz` aur `/readyz` (DB `SELECT 1` + gateway ping, `503` on failure, `draining` flag).
- `tests/test_health.py` -- TestClient se: normal 200, gateway down 503, healthz still 200, lifespan shutdown hook chala.
- Dockerfile ka `CMD` exec form, `--proxy-headers`; acceptance: `docker stop` ke logs mein "Shutting down" + aapka shutdown log, 10 s kill nahi.

### Common pitfalls
- `/healthz` mein DB/LLM check -- dependency outage pe platform saare healthy containers restart karta hai (restart storm).
- `uvicorn --reload` production image mein -- file watcher CPU khata hai aur behaviour badalta hai.
- `--workers 4` ke saath 0.25 vCPU task -- workers CPU ke liye ladte hain; ECS pe zyada tasks chalana usually behtar hai.

### Checklist before moving on
- [ ] Exec-form CMD aur PID 1 / SIGTERM ka connection samjha sakte ho.
- [ ] `lifespan` mein resources open/close hote hain, `on_event` nahi.
- [ ] `/healthz` cheap hai, `/readyz` dependencies check karta hai aur 503 deta hai.
- [ ] Saara config env vars se, image mein koi environment-specific value nahi.

### Related
- M04-01 Writing optimized Dockerfiles
- M04-13 Health and readiness checks
- M04-06 Configuring task definitions
- M02-03 Dependency injection
- M01-13 Process monitoring

### Self-quiz
1. Shell-form `CMD` se deploy pe 502 kyun aate hain? PID 1 aur SIGTERM se explain karo.
2. LLM gateway 5 minute down hai. `/healthz` aur `/readyz` kya return karein, aur platform kya karega?
3. Shutdown pe `draining = True` pehle aur DB close baad mein -- order ulta ho to kya hoga?
4. Ek container mein 4 gunicorn workers vs 4 ECS tasks with 1 worker -- trade-off kya hai?
