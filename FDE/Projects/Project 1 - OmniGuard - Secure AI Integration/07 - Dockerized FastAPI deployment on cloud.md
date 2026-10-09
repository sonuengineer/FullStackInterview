# OmniGuard - Secure AI Integration

## Dockerized FastAPI deployment on cloud

> Deliverable 07 of 12 | Built in: Fast CP4 / Slow CP6 | Time box: 12 h

### Goal
Ship OmniGuard as a hardened container to AWS through CI/CD, with a live URL, real liveness/readiness probes, and a post-deploy smoke suite that fails the deploy if the production config is unsafe. At CP6 the same pipeline delivers v1.0.

### Customer context (Kavach Finserv)
Kavach requires data to stay in the India region (`ap-south-1`). Anil's team scans every new endpoint on day one: an open `/docs`, a stack trace on bad JSON, missing security headers, or a container running as root are each treated as a serious finding. The UAT go/no-go depends on a stable staging/prod URL.

### What to build
- `Dockerfile` + `.dockerignore`: pinned base image, dependency layer cached, non-root `USER`, exec-form `CMD`, no `--reload`, no secrets in the image.
- `omniguard/main.py`: `create_app()` factory with `lifespan` (DB pool, HTTP client to the LLM gateway, both closed on shutdown).
- Probes: `GET /healthz` (process alive) and `GET /readyz` returning `{"status": "ok", "checks": {"db": "ok", "index": "ok", "llm": "ok"}}`, 503 if any check fails, per-check timeout, draining flag.
- Prod config from env (`APP_ENV=prod`): `docs_url=None`, `openapi_url=None`, debug off, auth mandatory, security headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Strict-Transport-Security`).
- Safe errors: generic message + `request_id`; details only in server logs, without PII.
- CI: `.github/workflows/ci.yml` (lint, pytest with coverage, Dockerfile lint) and `deploy.yml` (GitHub OIDC -> AWS role, build, push to ECR, deploy to ECS Fargate behind an ALB, circuit breaker on).
- `ecs/taskdef.json`: secrets from Secrets Manager / SSM, awslogs configured; ALB target group health check on `/readyz`.
- Post-deploy step: wait for `/readyz`, then run `omniguard/tests/acceptance/smoke.py` against `OMNIGUARD_BASE_URL`; failure = rollback.
- `docs/deploy.md` and `docs/probes.md` (every timeout/interval with a reason).

Config keys: `APP_ENV`, `OMNIGUARD_BASE_URL`, `OMNIGUARD_DOCKERFILE`, `AWS_REGION=ap-south-1`, `READY_CHECK_TIMEOUT_MS`.

### Inputs: lessons to (re)read
- M04-01 Writing optimized Dockerfiles; M04-04 Containerizing FastAPI backends
- M04-06 Configuring task definitions; M04-07 Load balancer integration
- M04-09 Creating workflow YAML files; M04-11 Managing GitHub secrets
- M04-12 Continuous deployment to AWS; M04-13 Health and readiness checks
- M03-05 Creating virtual private clouds; M03-08 Configuring strict security groups
- M03-09 Principle of least privilege; M03-13 Setting automated budget thresholds
- M02-13 Test coverage analysis
- M15-09 Finalizing Dockerized FastAPI cloud deployments (the smoke harness)

### Acceptance checks
Automated by the M15-09 harness (`smoke.py`, with `OMNIGUARD_BASE_URL` set to the live URL):
1. `/healthz` -> 200.
2. `/readyz` -> 200 and every entry in `checks` is `"ok"`.
3. Security headers present: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Strict-Transport-Security: max-age=...`.
4. `/docs`, `/openapi.json`, `/redoc` -> 404 in prod.
5. Malformed JSON to `/v1/ask` -> not 5xx, no `Traceback` or file paths in the body.
6. `/v1/ask` without auth -> 401.
7. Dockerfile lint (`OMNIGUARD_DOCKERFILE=Dockerfile`): base image pinned, last `USER` not root, no `--reload`, no secret in `ENV`.
Pipeline checks:
8. A deliberately broken commit (`/readyz` 503) is rolled back by the circuit breaker (M04-12).
9. `docker stop` shuts down gracefully within the stop timeout (M04-04).
10. At CP6: `pytest omniguard/tests/acceptance -q` runs auth, RAG/SQL, guardrails and smoke in one command.

### Proof for the gate
CP4: live URL in README, `curl <url>/readyz` = 200, CI badge green. CP6: `v1.0` tag + GitHub release notes with harness results + 5-minute demo video link.

### Definition of done
- Smoke harness green on the live URL and wired as a post-deploy CI step.
- No long-lived AWS keys in GitHub (OIDC role only); the deploy role is scoped to one ECR repo and one service.
- Service scaled to 0 (or torn down) when not demoing; budget alarm set.

### Out of scope
Kubernetes, multi-region, custom domain and WAF tuning, blue/green beyond the ECS circuit breaker, autoscaling policies (M04-08 is optional here).

### Stretch goals
- Auto-scaling on request count (M04-08).
- Image vulnerability scan in CI with a fail threshold.
- A staging environment with required reviewer approval before prod (M04-11).
