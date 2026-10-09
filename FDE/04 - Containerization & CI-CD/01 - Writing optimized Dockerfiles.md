# Containerization & CI-CD

## Writing optimized Dockerfiles

> Core | Fast CP4 / Slow CP6 | ~1.2 h | Builds on: M01-12, M01-15, M03-09

### Kahani
Logistics customer ka security team aapki OmniGuard image scan karta hai. Report: image 2.3 GB, `python:latest` base, container `root` user se chal raha hai, aur `docker history` mein ek layer ke andar `ENV OPENAI_API_KEY=sk-...` saaf dikh raha hai.
Upar se har chhote code change pe CI 9 minute leta hai, kyunki `COPY . .` dependencies install se pehle hai -- cache har baar toot jata hai.
CISO ka email: "Fix this before we allow it in our VPC." Aaj ka lesson usi email ka jawab hai.

### What it is
**Optimized Dockerfile** = chhoti, reproducible, secure image banane ki recipe: pinned base, multi-stage build, sahi layer order (deps pehle, code baad mein), non-root user, `.dockerignore`, aur koi secret image ke andar nahi.
Har instruction ek layer hai; layer cache upar se neeche chalta hai -- jo cheez kam badalti hai woh upar.

### Why it matters for an FDE
Customer ka platform team image ko scanner + policy se guzarta hai. Root user, unpinned base ya baked secret = deployment blocked, aur leaked key rotate karni padegi.

### Key concepts
- **Layer cache order** -- `COPY requirements.txt` + `pip install` pehle, `COPY . .` baad mein; code change pe deps layer reuse hoti hai.
- **Multi-stage build** -- `builder` stage mein compilers/wheels, final stage mein sirf runtime; build tools final image mein nahi jaate.
- **Pinned base** -- `python:3.12-slim-bookworm` (ya digest `@sha256:...`), kabhi `latest` nahi; reproducible builds.
- **Non-root USER** -- container escape hua to blast radius kam (M01-12 wala permission model yahin lagta hai).
- **No secrets in layers** -- `ENV`/`ARG` mein key = `docker history` mein hamesha ke liye; secrets runtime pe env/secret store se aate hain.

### Code example
stdlib only (Dockerfile ko Python se lint karte hain, Docker nahi chalate)

Target Dockerfile for OmniGuard:

```dockerfile
# syntax=docker/dockerfile:1
FROM python:3.12-slim-bookworm AS builder
WORKDIR /build
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

FROM python:3.12-slim-bookworm AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN useradd --create-home --uid 10001 app
WORKDIR /app
COPY --from=builder /install /usr/local
COPY --chown=app:app app/ ./app/
USER app
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=2)"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

```text
# .dockerignore
.git
.env
.venv
__pycache__
*.pyc
tests/
.github/
```

```python
# runnable
import re

SECRET_WORDS = re.compile(r"(KEY|SECRET|TOKEN|PASSWORD)", re.I)
MUST_IGNORE = {".git", ".env", ".venv", "__pycache__"}

def instructions(dockerfile: str):
    text = re.sub(r"\\\n", " ", dockerfile)                    # join line continuations
    for line in text.splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            op, _, rest = line.partition(" ")
            yield op.upper(), rest.strip()

def lint(dockerfile: str, dockerignore: str) -> list[str]:
    ins = list(instructions(dockerfile))
    froms = [r for op, r in ins if op == "FROM"]
    errs = []
    for f in froms:
        image = f.split()[0]
        if "@sha256:" not in image and (":" not in image or image.endswith(":latest")):
            errs.append(f"unpinned base image: {image}")
    if len(froms) < 2:
        errs.append("single-stage build (use a builder stage)")
    users = [r for op, r in ins if op == "USER"]
    if not users or users[-1] in ("root", "0"):
        errs.append("runs as root (add a non-root USER)")
    if not any(op == "HEALTHCHECK" for op, _ in ins):
        errs.append("no HEALTHCHECK")
    for op, r in ins:
        if op in ("ENV", "ARG") and SECRET_WORDS.search(r.split("=")[0]):
            errs.append(f"secret-looking name in {op}: {r.split('=')[0]}")
        if op == "RUN" and "pip install" in r and "--no-cache-dir" not in r:
            errs.append("pip install without --no-cache-dir")
    last_stage = ins[max(i for i, (op, _) in enumerate(ins) if op == "FROM"):]
    ops = [(op, r) for op, r in last_stage]
    copy_all = next((i for i, (op, r) in enumerate(ops) if op == "COPY" and r.startswith(". ")), None)
    pip_at = next((i for i, (op, r) in enumerate(ops) if op == "RUN" and "pip install" in r), None)
    if copy_all is not None and pip_at is not None and copy_all < pip_at:
        errs.append("COPY . . before pip install (breaks layer cache)")
    cmd = [r for op, r in ins if op == "CMD"]
    if cmd and not cmd[-1].startswith("["):
        errs.append("CMD in shell form (use exec form so PID 1 gets SIGTERM)")
    missing = MUST_IGNORE - {l.strip() for l in dockerignore.splitlines()}
    if missing:
        errs.append(f".dockerignore missing: {sorted(missing)}")
    return errs

BAD = """FROM python:latest
ENV OPENAI_API_KEY=sk-test-not-real
WORKDIR /app
COPY . .
RUN pip install -r requirements.txt
CMD uvicorn app.main:app --host 0.0.0.0
"""
GOOD = """FROM python:3.12-slim-bookworm AS builder
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt
FROM python:3.12-slim-bookworm AS runtime
RUN useradd --create-home --uid 10001 app
WORKDIR /app
COPY --from=builder /install /usr/local
COPY --chown=app:app app/ ./app/
USER app
HEALTHCHECK --interval=30s --timeout=3s \\
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz')"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
"""
IGNORE_GOOD = ".git\n.env\n.venv\n__pycache__\n*.pyc\ntests/\n"

bad = lint(BAD, ".git\n")
for e in bad:
    print("BAD :", e)
assert any("unpinned" in e for e in bad) and any("root" in e for e in bad)
assert any("OPENAI_API_KEY" in e for e in bad) and any("shell form" in e for e in bad)
assert any(".dockerignore" in e for e in bad) and len(bad) >= 7
assert lint(GOOD, IGNORE_GOOD) == [], lint(GOOD, IGNORE_GOOD)
print("OK: good Dockerfile passes, bad one has", len(bad), "findings")
```

- `instructions()` -- `\` continuation join karke har instruction `(OP, rest)` banata hai; real tool `hadolint` isse bahut zyada rules check karta hai.
- Unpinned check -- tag missing ya `:latest` = fail; digest (`@sha256:`) sabse strict pinning hai.
- Secret check -- `ENV`/`ARG` ka naam dekhta hai; `ARG` bhi `docker history` mein dikhta hai, isliye build-time secret ke liye `RUN --mount=type=secret` use karo.
- Layer order -- final stage mein `COPY . .` agar `pip install` se pehle aaya to har code edit pe poori dependency install dobara.
- Exec form `CMD [...]` -- uvicorn PID 1 banta hai aur `SIGTERM` seedha use milta hai (M04-04 mein detail).

Learner apni machine pe baad mein chalayega (is lesson mein Docker run nahi hota):

```bash
# run later on your own machine -- needs Docker Desktop
docker build -t omniguard:dev .
docker image ls omniguard:dev
docker history omniguard:dev
docker run --rm omniguard:dev whoami
```

### Mini-exercise (30-60 min)
OmniGuard repo mein:
- `Dockerfile` + `.dockerignore` upar wale pattern se likho; `requirements.txt` mein versions pinned.
- `tools/lint_dockerfile.py` -- upar wala `lint()` copy karo, CLI banao (`python tools/lint_dockerfile.py Dockerfile .dockerignore`), findings pe exit 1.
- `tests/test_dockerfile_lint.py` -- repo ka real Dockerfile lint pass kare.
- Acceptance (apni machine pe): image size note karo (`docker image ls`), `whoami` = `app`, code-only change ke baad rebuild mein `pip install` layer `CACHED` dikhe.

### Common pitfalls
- `python:3.12-alpine` lena "chhota hai" soch ke -- musl ki wajah se many wheels source se build hote hain, build slow aur image badi; slim usually better default hai.
- `.env` file `.dockerignore` mein nahi -- `COPY . .` usse image mein daal deta hai, chahe app use na kare.
- `HEALTHCHECK` mein `curl` -- slim image mein curl hai hi nahi; python ya app ka apna check use karo.

### Checklist before moving on
- [ ] Base image pinned (tag ya digest), `latest` kahin nahi.
- [ ] Multi-stage build, final image mein compilers nahi.
- [ ] Non-root `USER`, exec-form `CMD`, `HEALTHCHECK` present.
- [ ] `.dockerignore` mein `.git`, `.env`, `.venv`, `__pycache__`.
- [ ] Lint script CI mein chalti hai.

### Related
- M04-04 Containerizing FastAPI backends
- M04-11 Managing GitHub secrets
- M04-13 Health and readiness checks
- M01-12 Permission and user management
- M15-09 Finalizing Dockerized FastAPI cloud deployments

### Self-quiz
1. `COPY . .` ko `pip install` se pehle rakhne se exactly kya slow hota hai, aur kyun?
2. `ARG HF_TOKEN` se build-time pe token pass kiya. Final image mein woh dikhega ya nahi? Safer option kya hai?
3. Multi-stage build image size kaise kam karta hai -- final stage mein kya copy hota hai, kya nahi?
4. Customer ka scanner bolta hai "container runs as root". Do lines mein fix kya hai?
