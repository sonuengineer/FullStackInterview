# OmniGuard - Secure AI Integration

## Finalizing Dockerized FastAPI cloud deployments

> Core | Fast CP6 / Slow CP8 | ~1.2 h | Builds on: M04-04, M04-12, M04-13, M15-06, M15-07, M15-08

### Kahani
UAT ka go/no-go meeting kal hai. Aaj raat CI ne `main` ko AWS pe deploy kiya, health check green.
Anil ki team ne subah ek 10-minute scan chalaya: `/docs` khula tha (poora API map public), ek galat JSON pe 500 ke saath stack trace aaya jisme DB host ka naam tha, response pe koi security header nahi, aur container `root` user se chal raha tha.
Health check green tha -- par "chal raha hai" aur "production-ready hai" alag cheezein hain. Ye sab ek 30-second smoke suite pakad leti jo har deploy ke baad chale.
Aur yahi aapke CP6 gate ka last step hai: v1.0 tag, demo video, aur docs repo mein.

### What it is
**Deployment finalization** = Docker image (M04-04) ko hardened config ke saath deploy karna (M04-12) aur har deploy ke baad **smoke tests** chalana: liveness/readiness (M04-13), security headers, debug/docs off, safe errors, auth on.
Runnable block ek **deployment smoke harness** hai -- stand-in app pe yahan chalta hai, aur `OMNIGUARD_BASE_URL` set karke aapke live URL pe.

### Why it matters for an FDE
Customer ka security team pehle din hi scan karta hai. Ek open `/docs` ya stack trace aapke poore guardrail kaam ki credibility gira deta hai -- aur usually Sev1 ban jaata hai.

### Key concepts
- **Liveness vs readiness** -- `/healthz` = process zinda; `/readyz` = dependencies (DB replica, index, LLM gateway) reachable. Load balancer readiness pe route karta hai (M04-13).
- **Prod config is different** -- `docs_url=None`, `openapi_url=None`, debug off, auth mandatory; ye env se aaye (`APP_ENV=prod`), code branch se nahi.
- **Security headers** -- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Strict-Transport-Security`; cheap, aur scanners sabse pehle yahi dekhte hain.
- **Safe errors** -- client ko generic message + request id; stack trace sirf server logs mein (bina PII, M13-14).
- **Image hygiene** -- pinned base tag, non-root `USER`, no `--reload`, secrets env/secret manager se, image mein nahi (M04-11).

Deployed architecture:
```text
GitHub Actions (M04-09/12) --build+push--> ECR --deploy--> ECS Fargate service (ap-south-1)
Internet -> ALB (TLS) --/readyz gate--> OmniGuard container (non-root, APP_ENV=prod)
   container -> Secrets Manager (DB + LLM creds) | MS SQL replica (Encrypt=yes) | LLM gateway
post-deploy: smoke harness (this lesson) -> fail = rollback
```

### Code example
`pip install fastapi httpx`

```python
# runnable
import os, re
import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

SECURITY_HEADERS = {"x-content-type-options": "nosniff", "x-frame-options": "DENY",
                    "strict-transport-security": "max-age="}

def standin_app(prod: bool = True) -> FastAPI:
    """STAND-IN, not OmniGuard: minimal endpoints so the smoke harness executes here."""
    app = FastAPI(docs_url=None if prod else "/docs", openapi_url=None if prod else "/openapi.json")
    @app.middleware("http")
    async def headers(request: Request, call_next):
        resp = await call_next(request)
        resp.headers.update({"X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
                             "Strict-Transport-Security": "max-age=31536000; includeSubDomains"})
        return resp
    app.get("/healthz")(lambda: {"status": "ok"})
    app.get("/readyz")(lambda: {"status": "ok", "checks": {"db": "ok", "index": "ok", "llm": "ok"}})
    @app.post("/v1/ask")
    async def ask(request: Request):
        if not request.headers.get("authorization"):
            return JSONResponse({"detail": "not authenticated"}, status_code=401)
        return {"answer": "ok"}
    return app

def smoke(c) -> list[str]:
    fails = []
    h = c.get("/healthz")
    if h.status_code != 200: fails.append(f"/healthz {h.status_code}")
    r = c.get("/readyz")
    if r.status_code != 200 or any(v != "ok" for v in r.json().get("checks", {"none": "missing"}).values()):
        fails.append(f"/readyz not ready: {r.text[:80]}")
    for name, want in SECURITY_HEADERS.items():
        if want not in h.headers.get(name, ""): fails.append(f"missing header {name}")
    for path in ("/docs", "/openapi.json", "/redoc"):
        if c.get(path).status_code != 404: fails.append(f"{path} exposed in prod")
    bad = c.post("/v1/ask", content=b"{not json", headers={"content-type": "application/json"})
    if bad.status_code >= 500 or re.search(r"Traceback|File \"/", bad.text): fails.append("unsafe error on bad JSON")
    if c.post("/v1/ask", json={"question": "hi"}).status_code != 401: fails.append("/v1/ask works without auth")
    return fails

def lint_dockerfile(text: str) -> list[str]:
    fails = []
    if re.search(r"^FROM\s+\S+:latest\b|^FROM\s+[^:\s]+\s*$", text, re.M): fails.append("base image not pinned")
    users = re.findall(r"^USER\s+(\S+)", text, re.M)
    if not users or users[-1] in ("root", "0"): fails.append("runs as root")
    if "--reload" in text: fails.append("--reload in prod image")
    if re.search(r"^ENV\s+\S*(KEY|SECRET|PASSWORD)\S*[ =]", text, re.M | re.I): fails.append("secret baked into image")
    return fails

base = os.environ.get("OMNIGUARD_BASE_URL")        # e.g. https://omniguard.example.com
client = httpx.Client(base_url=base, timeout=10) if base else TestClient(standin_app())
fails = smoke(client)
print("smoke  :", fails or "all deployment checks passed")
assert fails == []
dev_fails = smoke(TestClient(standin_app(prod=False)))
print("dev cfg:", dev_fails)
assert dev_fails == ["/docs exposed in prod", "/openapi.json exposed in prod", "/redoc exposed in prod"]

EXAMPLE = """FROM python:3.12-slim\nRUN useradd -m app\nUSER app\nCMD ["uvicorn", "omniguard.main:app", "--host", "0.0.0.0"]\n"""
path = os.environ.get("OMNIGUARD_DOCKERFILE")
assert lint_dockerfile(open(path).read() if path else EXAMPLE) == []
assert len(lint_dockerfile("FROM python\nENV OPENAI_API_KEY=x\nCMD uvicorn app:app --reload\n")) == 4
print("OK: deployment smoke harness + Dockerfile lint")
```

- `smoke(c)` -- `TestClient` aur `httpx.Client` ka API same hai, isliye ek hi function stand-in aur live URL dono pe chalta hai.
- `/readyz` ke `checks` sab `ok` hone chahiye -- sirf 200 dekhna kaafi nahi; dependency down ho to readiness red ho.
- Bad JSON pe 422 theek hai, 500 ya `Traceback` nahi. FastAPI default 422 safe hai; custom exception handlers mein trace leak hota hai.
- `standin_app(prod=False)` -- dev config pe harness `/docs`, `/openapi.json` aur `/redoc` teeno pakadta hai (FastAPI teeno default on rakhta hai). Prod/dev ka fark env se aana chahiye.
- `lint_dockerfile` -- `OMNIGUARD_DOCKERFILE=Dockerfile` se aapki real file; bad example pe chaaron rules fail.

Post-deploy smoke step (CI ke deploy job ke baad, M04-12):
```bash
#!/usr/bin/env bash
set -euo pipefail
: "${OMNIGUARD_BASE_URL:?set the deployed URL}"
for i in $(seq 1 30); do
  if curl -fsS "$OMNIGUARD_BASE_URL/readyz" > /dev/null; then break; fi
  echo "waiting for readiness ($i)"; sleep 5
done
OMNIGUARD_BASE_URL="$OMNIGUARD_BASE_URL" python tests/acceptance/smoke.py
```

### Mini-exercise (30-60 min)
OmniGuard deliverable #7 + **CP6 gate**: `omniguard/tests/acceptance/smoke.py` + post-deploy CI step + release.
- Smoke harness ko apne live URL pe chalao; fail pe deploy job red ho (rollback M04-12 se).
- Saare acceptance harnesses (M15-06 auth, M15-07 RAG/SQL, M15-08 guardrails, M15-09 smoke) ek command se: `pytest tests/acceptance -q`.
- `omniguard/docs/` mein: `discovery.md`, `data-classification.md`, `SOW.md`, `ROI.md`, `UAT-runbook.md` + filled UAT results (M15-01..05).
- Release: `git tag -a v1.0 -m "OmniGuard v1.0"` aur `git push origin v1.0`; GitHub release notes mein harness results.
- 5-min demo video (English -- public material is English, MASTER_PLAN section 8). Script outline:
  1. 0:00-0:30 -- problem: Kavach (fictional) claims analysts, 2-day answers, CISO constraints.
  2. 0:30-1:15 -- architecture diagram: auth, router, Hybrid RAG, T-SQL guard, guardrails, AWS.
  3. 1:15-2:30 -- live: two-user demo (analyst vs underwriter, same question, different answers).
  4. 2:30-3:30 -- live: attacks blocked (DROP/SELECT INTO, PAN in question, injected chunk, jailbreak).
  5. 3:30-4:15 -- `pytest tests/acceptance` green + CI badge + smoke on live URL.
  6. 4:15-5:00 -- business side: SOW scope, ROI payback with sensitivity, UAT go/no-go. Close with what you'd do in phase 2.

### Common pitfalls
- Readiness = liveness (dono sirf `return ok`) -- DB replica down hone pe bhi ALB traffic bhejta rehta hai.
- Smoke tests sirf staging pe -- prod config (docs off, HSTS) prod pe hi verify hota hai; post-deploy pe chalao.
- Demo video mein real-looking customer data ya real API keys screen pe -- sirf synthetic data, keys env mein.

### Checklist before moving on (CP6 gate)
- [ ] `pytest tests/acceptance -q` green: auth, RAG/SQL, guardrails, smoke.
- [ ] Live URL pe smoke harness green; `/docs` 404; security headers present; container non-root.
- [ ] `omniguard/docs/` mein discovery, classification, SOW, ROI, UAT runbook + results.
- [ ] `v1.0` tag pushed, GitHub release with notes.
- [ ] 5-min demo video recorded (English) aur README mein link.

### Related
- M04-04 Containerizing FastAPI backends
- M04-12 Continuous deployment to AWS
- M04-13 Health and readiness checks
- M15-05 Delivering User Acceptance Testing (UAT) runbooks
- M15-06 Executing mock OAuth 2.0 / RBAC flows
- M15-08 Implementing NeMo & Presidio guardrails

### Self-quiz
1. `/healthz` 200 de raha hai par `/readyz` 503. Load balancer kya karega aur kyun ye sahi behaviour hai?
2. Prod mein `/docs` khula rehne ka actual risk kya hai, jab endpoints auth ke peeche hain?
3. Bad JSON pe 422 aur 500 mein se kaunsa acceptable hai, aur 500 ke saath kya leak ho sakta hai?
4. Demo video ke 5 minute mein business section kyun rakha? FDE interview mein iska kya signal jaata hai?
