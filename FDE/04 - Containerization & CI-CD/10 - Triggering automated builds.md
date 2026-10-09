# Containerization & CI-CD

## Triggering automated builds

> Core | Fast CP4 / Slow CP6 | ~1.2 h | Builds on: M04-09, M04-01

### Kahani
Healthcare customer ke monorepo mein OmniGuard ke saath docs site aur ek data notebook folder bhi hai. README mein typo fix kiya -- 12-minute Docker build + full test suite chal gaya. Din mein 40 aise runs.
Ulta case bhi hua: release tag `v1.4.0` push kiya, par image build hi nahi hua -- workflow mein sirf `branches: [main]` tha, tags ka filter tha hi nahi.
Aur image ka tag `latest` tha, to rollback ke time koi nahi jaanta tha ki "pichhla latest" kaunsa commit tha.

### What it is
**Build triggers** = `on:` block ke events + filters jo decide karte hain ki workflow kab chale: `push` (branches, tags, paths), `pull_request`, `workflow_dispatch` (manual button), `schedule` (cron), `workflow_run` (doosre workflow ke baad).
Saath mein **image tagging strategy**: har build ko immutable tag (git SHA), release pe semver tag.

### Why it matters for an FDE
Sahi triggers = fast feedback aur kam runner cost; galat triggers = ya to bekaar builds ya release pe build hi nahi. Immutable tags ke bina customer ko "kaunsa version live hai" ka jawab nahi de paoge.

### Key concepts
- **branches / tags filters** -- sirf `branches` diya to tag push pe workflow nahi chalega; dono chahiye to dono likho.
- **paths / paths-ignore** -- `docs/**` change pe build skip; tag pushes pe paths filter evaluate nahi hota.
- **workflow_dispatch** -- manual run with `inputs` (e.g. environment), demo se pehle re-deploy ke kaam ka.
- **schedule** -- cron UTC mein, sirf default branch pe chalta hai; nightly eval/security scan ke liye.
- **Immutable image tags** -- `sha-3f2a9c1` hamesha; `v1.4.0` pe `1.4.0` + `1.4`; deploy kabhi `latest` se nahi.

### Code example
stdlib only

```yaml
name: build
on:
  push:
    branches: [main]
    tags: ["v*.*.*"]
    paths-ignore: ["docs/**", "**.md", "notebooks/**"]
  pull_request:
    paths-ignore: ["docs/**", "**.md"]
  workflow_dispatch:
    inputs:
      reason: {description: "Why are you running this by hand?", required: true}
  schedule:
    - cron: "30 2 * * 1"
permissions:
  contents: read
concurrency:
  group: build-${{ github.ref }}
  cancel-in-progress: true
jobs:
  image:
    runs-on: ubuntu-24.04
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: false
          tags: omniguard:sha-${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

```python
# runnable
import re

def glob_to_re(pattern: str) -> re.Pattern:
    """GitHub-style filter glob subset: ** = any chars incl '/', * = any chars except '/'."""
    out = re.escape(pattern).replace(r"\*\*", "\0").replace(r"\*", "[^/]*").replace("\0", ".*")
    return re.compile(f"^{out}$")

def any_match(patterns, value) -> bool:
    return any(glob_to_re(p).match(value) for p in patterns)

def should_run(on: dict, event: str, ref: str = "", changed: tuple = ()) -> bool:
    if event not in on:
        return False
    cfg = on[event] or {}
    if event in ("workflow_dispatch", "schedule"):
        return True
    if ref.startswith("refs/tags/"):
        tags = cfg.get("tags")
        return tags is not None and any_match(tags, ref.removeprefix("refs/tags/"))   # paths ignored for tags
    branch = ref.removeprefix("refs/heads/")
    if event == "push":
        if "branches" not in cfg and "tags" in cfg:
            return False                       # only tags defined -> branch pushes do not trigger
        if "branches" in cfg and not any_match(cfg["branches"], branch):
            return False
    if "paths-ignore" in cfg and changed and all(any_match(cfg["paths-ignore"], f) for f in changed):
        return False
    if "paths" in cfg and not any(any_match(cfg["paths"], f) for f in changed):
        return False
    return True

def image_tags(sha: str, ref: str) -> list[str]:
    tags = [f"sha-{sha[:7]}"]
    m = re.fullmatch(r"refs/tags/v(\d+)\.(\d+)\.(\d+)", ref)
    if m:
        tags += [f"{m[1]}.{m[2]}.{m[3]}", f"{m[1]}.{m[2]}"]
    elif ref == "refs/heads/main":
        tags.append("main")
    return tags

ON = {"push": {"branches": ["main"], "tags": ["v*.*.*"], "paths-ignore": ["docs/**", "**.md", "notebooks/**"]},
      "pull_request": {"paths-ignore": ["docs/**", "**.md"]}, "workflow_dispatch": {"inputs": {}}}

cases = [
    ("push", "refs/heads/main", ("app/main.py",), True),
    ("push", "refs/heads/main", ("README.md", "docs/setup.md"), False),          # docs only -> skip
    ("push", "refs/heads/main", ("README.md", "app/main.py"), True),             # mixed -> run
    ("push", "refs/heads/feature/x", ("app/main.py",), False),                  # branch filtered
    ("push", "refs/tags/v1.4.0", ("README.md",), True),                         # tags ignore paths
    ("push", "refs/tags/nightly", (), False),
    ("pull_request", "refs/heads/feature/x", ("notebooks/a.ipynb",), True),     # PR ignores only docs/md
    ("workflow_dispatch", "refs/heads/main", (), True),
    ("schedule", "refs/heads/main", (), False),                                 # not in this ON
]
for event, ref, changed, expected in cases:
    got = should_run(ON, event, ref, changed)
    print(f"{event:17} {ref:24} {str(changed):38} -> {got}")
    assert got is expected, (event, ref, changed)
assert should_run({"push": {"tags": ["v*"]}}, "push", "refs/heads/main", ("a.py",)) is False
assert glob_to_re("*.md").match("a/b.md") is None and glob_to_re("**.md").match("a/b.md")   # '*' stops at '/'
assert image_tags("3f2a9c1d0e", "refs/tags/v1.4.0") == ["sha-3f2a9c1", "1.4.0", "1.4"]
assert image_tags("3f2a9c1d0e", "refs/heads/main") == ["sha-3f2a9c1", "main"]
print("OK: trigger filters + immutable image tags")
```

- `glob_to_re` -- GitHub filter syntax ka subset: `*` slash pe rukta hai, `**` nahi. Isliye `"**.md"` har folder ki md file pakadta hai, `"*.md"` sirf root ki.
- `paths-ignore` -- workflow tabhi skip jab **saari** changed files ignore list mein hon; ek bhi code file = run.
- Tag push pe `paths` filters lagte hi nahi -- release tag hamesha build karega.
- Sirf `tags` defined = branch push pe nahi chalega (aur ulta bhi) -- Kahani wala bug yahi tha.
- `image_tags` -- SHA tag immutable aur unique; semver tags release ke liye. `latest` deploy ke liye kabhi nahi.

```bash
# run later on your own machine -- needs the GitHub CLI logged in to your account
gh workflow run build.yml -f reason="demo rebuild"
git tag v0.4.0 && git push origin v0.4.0
gh run list --workflow build.yml --limit 3
```

### Mini-exercise (30-60 min)
OmniGuard repo:
- `.github/workflows/build.yml` -- upar jaisa: main + `v*.*.*` tags, docs ignore, manual dispatch, buildx with GHA cache (push abhi `false`; ECR push M04-12 mein).
- `tools/trigger_sim.py` + test: apne workflow ka `on:` YAML se load karo (`True` key gotcha, M04-09) aur upar wale 9 cases assert karo.
- Acceptance: README-only commit pe build workflow nahi chala; `v0.4.0` tag push pe chala; doosre run mein Docker layers cache se aaye (logs mein `CACHED`).

### Common pitfalls
- `pull_request` pe image push karna -- fork PRs ke paas secrets nahi hote (M04-11) aur untrusted code registry tak pahunchta hai.
- Required status check + `paths-ignore` -- docs-only PR pe check kabhi report nahi hota, merge "pending" pe atak jata hai; branch protection settings check karo.
- Cron ko local time samajhna -- GitHub cron UTC hai, aur busy times pe delay ho sakta hai.

### Checklist before moving on
- [ ] Docs-only change pe heavy build nahi chalta.
- [ ] Release tag push pe build guaranteed.
- [ ] Har image ka immutable SHA tag hai.
- [ ] Manual `workflow_dispatch` button kaam karta hai.

### Related
- M04-09 Creating workflow YAML files
- M04-11 Managing GitHub secrets
- M04-12 Continuous deployment to AWS
- M04-01 Writing optimized Dockerfiles

### Self-quiz
1. Workflow mein sirf `branches: [main]` hai. `v2.0.0` tag push karne pe kya hoga aur kyun?
2. `paths-ignore: ["docs/**"]` hai aur PR mein `docs/a.md` + `app/x.py` badle. Workflow chalega?
3. `latest` tag se deploy karne ka rollback pe kya problem hai?
4. Nightly evaluation run ke liye kaunsa trigger lagaoge, aur kis branch pe chalega?
