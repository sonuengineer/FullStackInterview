# Containerization & CI-CD

## Volume mounting and networking

> Core | Fast CP4 / Slow CP6 | ~1.2 h | Builds on: M04-02, M03-05, M03-08

### Kahani
Bank customer ke staging VM pe OmniGuard Compose se chal raha hai. Do problems ek hi din:
1. API logs bolte hain `connection refused localhost:5432` -- par Postgres to chal raha hai!
2. Security scan: port 5432 `0.0.0.0` pe open, office network se koi bhi DB tak pahunch sakta hai.
Aur shaam ko kisi ne `docker compose down -v` chala diya -- 2 din ka seeded test data gaya, kyunki data ek anonymous volume mein tha.

### What it is
**Volumes** = container ke bahar data rakhne ka tareeka: **bind mount** (host folder), **named volume** (Docker managed), **tmpfs** (sirf RAM).
**Networking** = har container ka apna network namespace; user-defined bridge network pe service name DNS se resolve hota hai. `localhost` container ke andar = wahi container, host nahi.

### Why it matters for an FDE
Customer ke security group (M03-08) jaisa hi rule container level pe: DB sirf internal network pe, sirf API publicly reachable. Galat mount = data loss ya secret leak.

### Key concepts
- **Bind mount** `./app:/app/app` -- dev hot-reload ke liye; prod mein nahi (host pe depend).
- **Named volume** `pgdata:/var/lib/postgresql/data` -- persistent data; `down -v` pe hi delete.
- **Service DNS** -- `db:5432` resolve hota hai kyunki dono same network pe; `localhost` nahi.
- **ports vs expose** -- `ports: "8000:8000"` host pe publish; bina `ports` ke service sirf network ke andar reachable.
- **internal network** -- `internal: true` network se bahar internet route nahi (data tier ke liye, NAT jaisa sochna -- M03-07).

### Code example
`pip install pyyaml`

```yaml
services:
  api:
    build: .
    ports: ["8000:8000"]
    environment: {DATABASE_URL: "postgresql://omni:omni@db:5432/omniguard"}
    volumes: ["./app:/app/app:ro"]
    networks: [edge, data]
  db:
    image: postgres:16.4-bookworm
    ports: ["127.0.0.1:5432:5432"]
    volumes: ["pgdata:/var/lib/postgresql/data"]
    networks: [data]
volumes: {pgdata: {}}
networks:
  edge: {}
  data: {internal: true}
```

```python
# runnable
from urllib.parse import urlparse
import yaml

def mount_kind(spec: str) -> str:
    src = spec.split(":")[0]
    if not src or spec.count(":") == 0:
        return "anonymous"
    return "bind" if src.startswith((".", "/", "~")) else "named"

def published(svc: dict) -> list[tuple[str, str]]:
    out = []
    for p in svc.get("ports", []):
        parts = str(p).split(":")
        host_ip = parts[0] if len(parts) == 3 else "0.0.0.0"     # 2-part form binds all interfaces
        out.append((host_ip, parts[-1]))
    return out

def analyze(doc: dict, prod: bool) -> list[str]:
    svcs, nets = doc["services"], doc.get("networks", {})
    errs = []
    for name, svc in svcs.items():
        for v in svc.get("volumes", []):
            kind = mount_kind(v)
            if kind == "anonymous":
                errs.append(f"{name}: anonymous volume {v} (data lost on down -v / recreate)")
            if kind == "bind" and prod:
                errs.append(f"{name}: bind mount {v} in prod profile")
        for host_ip, cport in published(svc):
            if name != "api" and host_ip == "0.0.0.0":
                errs.append(f"{name}: port {cport} published on all interfaces")
        for key, val in svc.get("environment", {}).items():
            if "://" in str(val):
                host = urlparse(val).hostname
                if host in ("localhost", "127.0.0.1"):
                    errs.append(f"{name}: {key} points to {host} (that is the container itself)")
                elif host in svcs and not set(svc.get("networks", [])) & set(svcs[host].get("networks", [])):
                    errs.append(f"{name}: cannot reach {host}, no shared network")
        if name == "db" and not any((nets.get(n) or {}).get("internal") for n in svc.get("networks", [])):
            errs.append("db: not on an internal network")
    return errs

GOOD = yaml.safe_load("""
services:
  api:
    ports: ["8000:8000"]
    environment: {DATABASE_URL: "postgresql://omni:omni@db:5432/omniguard"}
    networks: [edge, data]
  db:
    ports: ["127.0.0.1:5432:5432"]
    volumes: ["pgdata:/var/lib/postgresql/data"]
    networks: [data]
volumes: {pgdata: {}}
networks: {edge: {}, data: {internal: true}}
""")
BAD = yaml.safe_load("""
services:
  api:
    ports: ["8000:8000"]
    environment: {DATABASE_URL: "postgresql://omni:omni@localhost:5432/omniguard",
                  CACHE_URL: "redis://redis:6379/0"}
    volumes: ["./app:/app/app"]
    networks: [edge]
  db:
    ports: ["5432:5432"]
    volumes: ["/var/lib/postgresql/data"]
    networks: [edge]
  redis:
    networks: [cache]
networks: {edge: {}, cache: {}}
""")

assert [mount_kind(v) for v in ("pgdata:/d", "./src:/s:ro", "/var/lib/d")] == ["named", "bind", "anonymous"]
assert analyze(GOOD, prod=True) == [], analyze(GOOD, prod=True)
bad = analyze(BAD, prod=True)
for e in bad:
    print("BAD :", e)
for needle in ["localhost", "no shared network", "bind mount", "anonymous", "all interfaces", "internal"]:
    assert any(needle in e for e in bad), needle
print("OK:", len(bad), "network/volume problems found")
```

- `mount_kind` -- single path (`/var/lib/...`) = anonymous volume; `./` ya `/host:` = bind; plain name = named volume.
- `"5432:5432"` 2-part form host ke saare interfaces pe bind karta hai; local debugging ke liye `127.0.0.1:5432:5432` likho.
- `localhost` check -- sabse common bug; container ke andar `localhost` = wahi container.
- Shared network check -- `api` aur `redis` alag networks pe = DNS name resolve hi nahi hoga.
- AWS pe yahi idea: ECS `awsvpc` mode mein har task ka apna ENI + security group (M03-08); "internal network" = private subnet (M03-06).

```bash
# run later on your own machine -- needs Docker Desktop
docker compose up -d
docker compose exec api python -c "import socket; print(socket.gethostbyname('db'))"
docker network ls
docker volume ls
```

### Mini-exercise (30-60 min)
OmniGuard:
- `compose.yaml` mein `edge` aur `data` (internal) networks; DB sirf `data` pe, host pe sirf `127.0.0.1` bind.
- `compose.override.yaml` (dev only) mein bind mount + `--reload`; base file prod-like rahe.
- `tools/check_compose_network.py` -- upar wala `analyze()`; test mein base file `prod=True` pe clean.
- Acceptance: `docker compose exec api` se `db` resolve ho; host se `curl localhost:8000/healthz` chale; doosri machine se 5432 reachable na ho.

### Common pitfalls
- Bind mount pe file permissions -- container non-root `uid 10001` hai, host folder kisi aur user ka; "permission denied". UID match karo ya named volume use karo.
- Windows/macOS pe bind mount slow hota hai (file sharing layer); heavy `node_modules`/`.venv` named volume mein rakho.
- DB port sirf "debugging ke liye" `0.0.0.0` pe khula chhod dena -- customer VM pe yahi scan finding banta hai.

### Checklist before moving on
- [ ] Bind vs named vs anonymous volume ek line mein samjha sakte ho.
- [ ] Container ke andar `localhost` ka matlab clear hai.
- [ ] DB kisi public interface pe published nahi.
- [ ] Dev overrides (bind mounts, reload) alag file mein.

### Related
- M04-02 Managing multi-container environments
- M03-06 Public vs private subnet routing
- M03-08 Configuring strict security groups
- M04-06 Configuring task definitions

### Self-quiz
1. `DATABASE_URL=...@localhost:5432` laptop pe (bina Docker) chalta tha, Compose mein kyun fail hua?
2. `"5432:5432"` aur `"127.0.0.1:5432:5432"` mein kaun DB ko office network pe expose karta hai?
3. Postgres data ke liye bind mount vs named volume -- kaunsa choose karoge aur kyun?
4. `internal: true` network ka AWS VPC mein closest equivalent kya hai?
