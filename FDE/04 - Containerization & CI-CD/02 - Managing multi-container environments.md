# Containerization & CI-CD

## Managing multi-container environments

> Core | Fast CP4 / Slow CP6 | ~1.2 h | Builds on: M04-01, M03-03

### Kahani
Hospital customer ke saath on-site demo. OmniGuard API, Postgres aur ek fake LLM gateway -- teen containers. `docker compose up` chala, API ne turant crash kiya: "connection refused to db:5432".
Postgres container "started" tha, par abhi initialize ho raha tha. Aapne `sleep 10` daala, demo laptop pe chal gaya, customer ke slow VM pe phir crash.
Plus junior ne `- ~/.aws:/root/.aws` mount kar diya tha "testing ke liye". Ab woh compose file customer ke git mein hai.

### What it is
**Docker Compose** = ek YAML (`compose.yaml`) jisme saare services, unke networks, volumes, env aur start order declare hote hain; `docker compose up` poora stack ek command mein uthata hai.
Start order sirf `depends_on` se nahi -- `condition: service_healthy` + service ka `healthcheck` chahiye, tab dependency "ready" maani jaati hai.

### Why it matters for an FDE
Customer ke engineers aapka local stack 5 minute mein chalana chahte hain. Flaky start order aur machine-specific mounts = "works on my machine" aur pehli impression kharab.

### Key concepts
- **depends_on + condition** -- `service_started` sirf container start; `service_healthy` healthcheck pass hone tak rukta hai.
- **healthcheck** -- Postgres ke liye `pg_isready`; bina healthcheck ke `service_healthy` kaam nahi karta.
- **Named volumes** -- `pgdata:` top-level `volumes:` mein declare; container hata do, data rehta hai.
- **Networks** -- services ek user-defined network pe service name se ek doosre ko dhoondte hain (`db:5432`).
- **env_file / secrets** -- `.env` git mein nahi; host ke credentials folders (`~/.aws`, `~/.ssh`) kabhi mount nahi.

### Code example
`pip install pyyaml`

Target `compose.yaml` for OmniGuard:

```yaml
services:
  api:
    build: .
    image: omniguard-api:dev
    ports: ["8000:8000"]
    env_file: [.env]
    environment:
      DATABASE_URL: postgresql://omni:omni@db:5432/omniguard
      LLM_GATEWAY_URL: http://llm-fake:9000
    depends_on:
      db: {condition: service_healthy}
      llm-fake: {condition: service_started}
    networks: [backend]
  db:
    image: postgres:16.4-bookworm
    environment: {POSTGRES_USER: omni, POSTGRES_PASSWORD: omni, POSTGRES_DB: omniguard}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U omni -d omniguard"]
      interval: 5s
      timeout: 3s
      retries: 10
    volumes: ["pgdata:/var/lib/postgresql/data"]
    networks: [backend]
  llm-fake:
    build: ./fake_llm
    networks: [backend]
volumes:
  pgdata: {}
networks:
  backend: {}
```

```python
# runnable
import yaml

FORBIDDEN_HOST_PATHS = ("~/.aws", "~/.ssh", "/var/run/docker.sock", ".env:")

def lint_compose(doc: dict) -> list[str]:
    errs = []
    services = doc.get("services", {})
    declared_vols = set((doc.get("volumes") or {}).keys())
    declared_nets = set((doc.get("networks") or {}).keys())
    for name, svc in services.items():
        image = svc.get("image", "")
        if "build" not in svc and (":" not in image or image.endswith(":latest")):
            errs.append(f"{name}: unpinned image '{image}'")
        deps = svc.get("depends_on", {})
        if isinstance(deps, list):
            errs.append(f"{name}: depends_on list form = start order only, not readiness")
            deps = {d: {"condition": "service_started"} for d in deps}
        for dep, cfg in deps.items():
            if dep not in services:
                errs.append(f"{name}: depends on unknown service {dep}")
            elif cfg.get("condition") == "service_healthy" and "healthcheck" not in services[dep]:
                errs.append(f"{name}: waits for {dep} healthy but {dep} has no healthcheck")
            if dep == "db" and cfg.get("condition") != "service_healthy":
                errs.append(f"{name}: db dependency should use condition: service_healthy")
        for v in svc.get("volumes", []):
            spec = v if isinstance(v, str) else f"{v.get('source', '')}:{v.get('target', '')}"
            src = spec.split(":")[0]
            if any(bad in spec for bad in FORBIDDEN_HOST_PATHS):
                errs.append(f"{name}: host secret/credential mount '{v}'")
            elif src and not src.startswith((".", "/", "~")) and src not in declared_vols:
                errs.append(f"{name}: named volume '{src}' not declared at top level")
        for n in svc.get("networks", []):
            if n not in declared_nets:
                errs.append(f"{name}: network '{n}' not declared")
        if not svc.get("networks"):
            errs.append(f"{name}: on default network (declare an explicit one)")
    return errs

GOOD = yaml.safe_load("""
services:
  api:
    build: .
    depends_on:
      db: {condition: service_healthy}
    networks: [backend]
  db:
    image: postgres:16.4-bookworm
    healthcheck: {test: ["CMD-SHELL", "pg_isready -U omni"], interval: 5s, retries: 10}
    volumes: ["pgdata:/var/lib/postgresql/data"]
    networks: [backend]
volumes: {pgdata: {}}
networks: {backend: {}}
""")
BAD = yaml.safe_load("""
services:
  api:
    build: .
    depends_on: [db]
    volumes: ["~/.aws:/root/.aws:ro", "cache:/cache"]
  db:
    image: postgres:latest
    networks: [backend]
""")

good_errs, bad_errs = lint_compose(GOOD), lint_compose(BAD)
for e in bad_errs:
    print("BAD :", e)
assert good_errs == [], good_errs
assert any("unpinned" in e for e in bad_errs)
assert any("list form" in e for e in bad_errs) and any("service_healthy" in e for e in bad_errs)
assert any("~/.aws" in e for e in bad_errs) and any("'cache' not declared" in e for e in bad_errs)
assert any("'backend' not declared" in e for e in bad_errs)
print("OK: compose lint caught", len(bad_errs), "problems; good file clean")
```

- `depends_on: [db]` (list form) -- sirf "db container start ho gaya", ready nahi. Isliye linter isse flag karta hai.
- `service_healthy` tabhi meaningful hai jab dependency ka `healthcheck` ho -- linter dono ko saath check karta hai.
- Named volume ka top-level declaration missing ho to Compose error deta hai -- CI mein pehle hi pakdo.
- `~/.aws` mount -- container ke andar aapke personal admin credentials; customer laptop pe ye kabhi nahi chahiye.
- Real verification: `docker compose config` YAML ko normalize karke print karta hai; is lint ko uske saath CI mein chalao.

```bash
# run later on your own machine -- needs Docker Desktop
docker compose config --quiet
docker compose up -d --wait
docker compose ps
docker compose logs -f api
docker compose down
```

### Mini-exercise (30-60 min)
OmniGuard repo:
- `compose.yaml` -- `api`, `db` (Postgres, healthcheck), `llm-fake` (ek chhota FastAPI jo fixed JSON answer de, taaki koi API key na lage).
- `.env.example` commit karo, `.env` gitignored; `api` sirf `env_file` se config le.
- `tools/lint_compose.py` + test: repo ki compose file clean pass ho.
- Acceptance (apni machine pe): `docker compose up -d --wait` ek baar mein green; `docker compose down` + `up` ke baad DB data still there (named volume).

### Common pitfalls
- `sleep 10` se ordering -- slow machine pe fail, fast machine pe time waste. Healthcheck + condition use karo.
- `docker compose down -v` -- `-v` named volumes bhi delete karta hai; demo DB gaya.
- App mein retry hi nahi -- production mein (ECS) Compose jaisa `depends_on` nahi hota; app ko khud DB connect retry karna chahiye.

### Checklist before moving on
- [ ] Har non-build image pinned version pe.
- [ ] DB dependency `condition: service_healthy` + DB healthcheck.
- [ ] Named volumes aur networks top-level declared.
- [ ] Koi host credential mount nahi; `.env` gitignored.

### Related
- M04-01 Writing optimized Dockerfiles
- M04-03 Volume mounting and networking
- M04-13 Health and readiness checks
- M03-03 Managed relational databases setup

### Self-quiz
1. `depends_on: [db]` aur `depends_on: {db: {condition: service_healthy}}` mein runtime pe kya farak hai?
2. ECS pe Compose ka `depends_on` nahi hai. Aapki app DB ke late ready hone ko kaise handle karegi?
3. `docker compose down` aur `down -v` -- demo ke din kaunsa chalaoge aur kyun?
4. Compose file mein `~/.aws` mount kyun dangerous hai, chahe `:ro` ho?
