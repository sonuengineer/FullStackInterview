# Containerization & CI-CD

## Creating workflow YAML files

> Core | Fast CP4 / Slow CP6 | ~1.2 h | Builds on: M02-11, M02-13, M04-01

### Kahani
Fintech customer ka repo. CI 40 minute chal ke timeout hota hai kyunki ek test hang hai aur job pe koi `timeout-minutes` nahi -- poore org ke runner minutes khatam.
Security review mein do aur findings: workflow ko default `write` token mil raha hai (koi `permissions:` block nahi), aur ek step `uses: some-org/setup-tool@main` hai -- kal koi us repo mein malicious commit kare to woh aapke CI mein chalega.
Ek PR pe teen pushes = teen parallel runs, sab paise khaate hue. Workflow YAML chhota dikhta hai, par production-grade banana skill hai.

### What it is
**GitHub Actions workflow** = `.github/workflows/*.yml` file: `on:` (kab chale), `permissions:` (GITHUB_TOKEN ko kitni power), `concurrency:` (duplicate runs), aur `jobs:` -> `steps:` (`uses:` action ya `run:` shell).
Har job ek fresh runner VM pe chalta hai; jobs default parallel, `needs:` se order.

### Why it matters for an FDE
CP4 gate mein CI badge chahiye, aur customer ka security team workflow files bhi review karta hai. Least-privilege token aur pinned actions supply-chain attack se bachate hain.

### Key concepts
- **on:** -- triggers (`push`, `pull_request`, `workflow_dispatch`); M04-10 mein detail.
- **permissions:** -- top level pe `contents: read`; jis job ko zyada chahiye sirf usko do.
- **concurrency** -- `group: ${{ github.workflow }}-${{ github.ref }}` + `cancel-in-progress: true` PR pe purane runs cancel karta hai.
- **Pinned actions** -- `@main` kabhi nahi; major tag (`@v4`) minimum, hardened repos mein full 40-char commit SHA.
- **PyYAML gotcha** -- YAML 1.1 mein `on` boolean hai; `yaml.safe_load` key ko `True` bana deta hai, string `"on"` nahi.

### Code example
`pip install pyyaml`

```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
jobs:
  test:
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
        with: {persist-credentials: false}
      - uses: actions/setup-python@v5
        with: {python-version: "3.12", cache: pip}
      - run: pip install -r requirements-dev.txt
      - run: ruff check .
      - run: pytest -q --cov=app
      - run: python tools/lint_dockerfile.py Dockerfile .dockerignore
```

```python
# runnable
import re
import yaml

def get_on(wf: dict):
    # PyYAML follows YAML 1.1: bare `on` is parsed as boolean True. Accept both keys.
    return wf.get("on", wf.get(True))

PINNED_SHA = re.compile(r"@[0-9a-f]{40}$")
PINNED_TAG = re.compile(r"@v\d+(\.\d+){0,2}$")

def lint_workflow(text: str) -> tuple[list[str], list[str]]:
    wf = yaml.safe_load(text)
    errs, warns = [], []
    if not get_on(wf):
        errs.append("no triggers (on:)")
    perms = wf.get("permissions")
    if perms is None:
        errs.append("no top-level permissions (token gets repo default, often write)")
    elif perms == "write-all" or (isinstance(perms, dict) and "write" in perms.values()):
        errs.append(f"top-level permissions too broad: {perms}")
    if "concurrency" not in wf:
        errs.append("no concurrency group (duplicate runs)")
    for job_name, job in wf.get("jobs", {}).items():
        if "timeout-minutes" not in job:
            errs.append(f"{job_name}: no timeout-minutes (default is 360)")
        for step in job.get("steps", []):
            uses = step.get("uses")
            if uses and not uses.startswith("./"):
                if PINNED_SHA.search(uses):
                    continue
                if PINNED_TAG.search(uses):
                    warns.append(f"{job_name}: {uses} pinned to tag, SHA is stricter")
                else:
                    errs.append(f"{job_name}: unpinned action {uses}")
    return errs, warns

GOOD = """
name: ci
on: {push: {branches: [main]}, pull_request: {}}
permissions: {contents: read}
concurrency: {group: "${{ github.workflow }}-${{ github.ref }}", cancel-in-progress: true}
jobs:
  test:
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - run: pytest -q
"""
BAD = """
name: ci
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: some-org/setup-tool@main
      - uses: actions/checkout
      - run: pytest -q
"""

assert yaml.safe_load("on: push") == {True: "push"}          # the gotcha, proven
assert get_on(yaml.safe_load(BAD)) == "push"
errs, warns = lint_workflow(GOOD)
assert errs == [] and len(warns) == 1, (errs, warns)
bad_errs, _ = lint_workflow(BAD)
for e in bad_errs:
    print("BAD :", e)
for needle in ["permissions", "concurrency", "timeout-minutes", "@main", "actions/checkout"]:
    assert any(needle in e for e in bad_errs), needle
print("OK:", len(bad_errs), "errors in bad workflow; good one only warns:", warns[0])
```

- `get_on()` -- bina iske linter bolega "no triggers" har workflow pe. GitHub khud YAML ko sahi padhta hai; gotcha sirf aapke Python tooling mein hai.
- `permissions` check -- top level pe koi bhi `write` = error; zarurat ho to job-level pe do (M04-12 mein `id-token: write`).
- Pinning -- 40-hex SHA = pass, `@v4` = warning, `@main` ya bina ref = error. SHA release page se lo, khud mat banao.
- `timeout-minutes` -- GitHub default 360 minutes hai; hung test = 6 ghante ka bill.
- `persist-credentials: false` (YAML block mein) -- checkout token `.git/config` mein nahi chhodta.

```bash
# run later on your own machine -- needs the GitHub CLI logged in to your account
gh workflow list
gh run list --workflow ci.yml --limit 5
gh run watch
```

### Mini-exercise (30-60 min)
OmniGuard repo:
- `.github/workflows/ci.yml` -- upar wala workflow (ruff, pytest with coverage, Dockerfile lint, compose lint).
- `tools/lint_workflow.py` + `tests/test_workflows.py` -- `.github/workflows/*.yml` sab files pe chale; errors pe fail.
- README ke top pe CI badge: `![CI](https://github.com/<you>/omniguard/actions/workflows/ci.yml/badge.svg)` -- CP4 gate ka hissa.
- Acceptance: ek PR pe 2 pushes karo -- pehla run "cancelled", doosra green.

### Common pitfalls
- YAML ko Python mein padh ke `wf["on"]` -- KeyError; `True` key ka gotcha yaad rakho (ya `yaml` ki jagah `ruamel.yaml` YAML 1.2 mode).
- `cancel-in-progress: true` deploy workflow pe bhi -- aadha deploy cancel ho sakta hai; deploy ke liye `false` (M04-12).
- Tests ke liye real LLM API key CI mein -- fake client use karo; key wale tests sirf manual/nightly.

### Checklist before moving on
- [ ] Har workflow mein `permissions`, `concurrency`, job `timeout-minutes`.
- [ ] Koi action `@main`/`@master`/unpinned nahi.
- [ ] PyYAML `on` -> `True` gotcha explain kar sakte ho.
- [ ] CI badge README mein green.

### Related
- M04-10 Triggering automated builds
- M04-11 Managing GitHub secrets
- M04-12 Continuous deployment to AWS
- M02-11 Unit testing fundamentals
- M02-13 Test coverage analysis

### Self-quiz
1. `permissions:` block na ho to GITHUB_TOKEN ko kitni power milti hai, aur woh kis cheez pe depend karta hai?
2. Action ko `@v4` vs commit SHA pe pin karne mein security farak kya hai?
3. `yaml.safe_load` ke baad `wf["on"]` KeyError kyun deta hai?
4. Concurrency group mein `github.ref` kyun daala? Sirf `github.workflow` rakhte to kya hota?
