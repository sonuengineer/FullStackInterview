# Containerization & CI-CD

## Continuous deployment to AWS

> Core | Fast CP4 / Slow CP6 | ~1.2 h | Builds on: M04-06, M04-09, M04-11, M03-11, M03-13

### Kahani
Bank customer ka deploy process: ek engineer laptop pe `docker build`, `docker push`, phir console mein task definition ka image haath se edit. Friday shaam ko galat tag (`latest`, jo kisi ki feature branch ka tha) prod pe chala gaya.
Rollback? Kisi ko pichhli revision yaad nahi thi. Aur laptop pe 3 saal purani AWS admin keys. CISO ki demand: "Har prod change git commit se traceable ho, koi long-lived key na ho, aur fail ho to automatic rollback."

### What it is
**Continuous deployment** = `main` pe merge -> GitHub Actions: OIDC se AWS role assume -> image build + ECR push (SHA tag) -> task definition render (naya image) -> ECS service update -> **service stable hone tak wait** -> smoke test.
Fail ho to ECS **deployment circuit breaker** pichhli working revision pe rollback karta hai.

### Why it matters for an FDE
CP4 gate = live URL + health check + CI badge. Customer ke liye traceability (commit -> image -> task revision) aur bina static keys ke deploy -- ye dono security review ke standard sawaal hain.

### Key concepts
- **OIDC federation** -- GitHub short-lived token deta hai, AWS role (trust policy mein `aud` + `sub` condition) assume hota hai; koi key store nahi (M03-11 cross-account roles jaisa idea).
- **Immutable image** -- `omniguard:<git sha>`; task definition revision exact image point karti hai.
- **Render + deploy** -- `amazon-ecs-render-task-definition` image badalta hai, `amazon-ecs-deploy-task-definition` register + service update karta hai.
- **wait-for-service-stability** -- job tab tak green nahi jab tak naye tasks healthy na hon.
- **Rollback** -- circuit breaker `rollback: true` automatic; manual = pichhli revision pe `update-service`. **Blue/green** (CodeDeploy, ya newer ECS native support -- check docs) traffic shift ke saath.

### Code example
`pip install pyyaml`

```yaml
name: deploy
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions: {contents: read}
concurrency: {group: deploy-production, cancel-in-progress: false}
jobs:
  deploy:
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    environment: production
    permissions: {contents: read, id-token: write}
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.AWS_DEPLOY_ROLE_ARN }}
          aws-region: us-east-1
      - id: ecr
        uses: aws-actions/amazon-ecr-login@v2
      - id: build
        env:
          IMAGE: ${{ steps.ecr.outputs.registry }}/omniguard:${{ github.sha }}
        run: |
          docker build -t "$IMAGE" .
          docker push "$IMAGE"
          echo "image=$IMAGE" >> "$GITHUB_OUTPUT"
      - id: render
        uses: aws-actions/amazon-ecs-render-task-definition@v1
        with:
          task-definition: ecs/taskdef.json
          container-name: api
          image: ${{ steps.build.outputs.image }}
      - uses: aws-actions/amazon-ecs-deploy-task-definition@v2
        with:
          task-definition: ${{ steps.render.outputs.task-definition }}
          cluster: omniguard
          service: omniguard-api
          wait-for-service-stability: true
      - name: Smoke test
        env: {BASE_URL: "${{ vars.OMNIGUARD_BASE_URL }}"}
        run: curl -fsS --retry 5 --retry-delay 5 "$BASE_URL/readyz"
```

```python
# runnable
import json
import yaml

ORDER = ["aws-actions/configure-aws-credentials", "aws-actions/amazon-ecr-login", "docker push",
         "aws-actions/amazon-ecs-render-task-definition", "aws-actions/amazon-ecs-deploy-task-definition", "/readyz"]

def lint_deploy(text: str) -> list[str]:
    wf = yaml.safe_load(text)
    errs = []
    if "pull_request" in wf.get("on", wf.get(True)):          # PyYAML `on` gotcha (M04-09)
        errs.append("deploy must not run on pull_request")
    if wf.get("concurrency", {}).get("cancel-in-progress") is not False:
        errs.append("deploy concurrency must not cancel in-progress deploys")
    job = wf["jobs"]["deploy"]
    if job.get("environment") != "production":
        errs.append("deploy job has no production environment (no approval gate)")
    if job.get("permissions", {}).get("id-token") != "write":
        errs.append("missing id-token: write (needed for OIDC)")
    if "AWS_ACCESS_KEY_ID" in text or "aws-access-key-id" in text:
        errs.append("long-lived AWS keys used; use role-to-assume")
    seen = []
    for s in job["steps"]:
        step_text = (s.get("uses") or "") + " " + (s.get("run") or "")
        seen += [o for o in ORDER if o in step_text and o not in seen]
        if "ecs-deploy-task-definition" in step_text and s.get("with", {}).get("wait-for-service-stability") is not True:
            errs.append("deploy does not wait for service stability")
        if "IMAGE" in s.get("env", {}) and "github.sha" not in s["env"]["IMAGE"]:
            errs.append("image tag is not the commit SHA")
    if seen != ORDER:
        errs.append(f"steps out of order or missing: {seen}")
    return errs

def lint_trust_policy(policy: dict, repo: str) -> list[str]:
    errs = []
    for st in policy["Statement"]:
        cond = st.get("Condition", {})
        c = {**cond.get("StringEquals", {}), **cond.get("StringLike", {})}
        if c.get("token.actions.githubusercontent.com:aud") != "sts.amazonaws.com":
            errs.append("aud must be sts.amazonaws.com")
        sub = c.get("token.actions.githubusercontent.com:sub", "")
        if not sub.startswith(f"repo:{repo}:") or sub.endswith(":*"):
            errs.append(f"sub too broad or wrong repo: {sub!r}")
    return errs

GOOD_WF = """
on: {push: {branches: [main]}, workflow_dispatch: {}}
concurrency: {group: deploy-production, cancel-in-progress: false}
jobs:
  deploy:
    environment: production
    permissions: {contents: read, id-token: write}
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with: {role-to-assume: "${{ vars.AWS_DEPLOY_ROLE_ARN }}", aws-region: us-east-1}
      - uses: aws-actions/amazon-ecr-login@v2
      - env: {IMAGE: "${{ steps.ecr.outputs.registry }}/omniguard:${{ github.sha }}"}
        run: docker build -t "$IMAGE" . && docker push "$IMAGE"
      - uses: aws-actions/amazon-ecs-render-task-definition@v1
      - uses: aws-actions/amazon-ecs-deploy-task-definition@v2
        with: {wait-for-service-stability: true}
      - run: curl -fsS "$BASE_URL/readyz"
"""
BAD_WF = (GOOD_WF.replace("cancel-in-progress: false", "cancel-in-progress: true")
          .replace("    environment: production\n", "").replace(", id-token: write", "")
          .replace('role-to-assume: "${{ vars.AWS_DEPLOY_ROLE_ARN }}"', 'aws-access-key-id: "${{ secrets.AWS_ACCESS_KEY_ID }}"')
          .replace("${{ github.sha }}", "latest").replace("{wait-for-service-stability: true}", "{}"))
TRUST = json.loads("""{"Version": "2012-10-17", "Statement": [{"Effect": "Allow",
  "Principal": {"Federated": "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"},
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {"StringEquals": {"token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
    "token.actions.githubusercontent.com:sub": "repo:you/omniguard:environment:production"}}}]}""")

bad = lint_deploy(BAD_WF)
print("BAD :", *bad, sep="\n  ")
assert len(bad) == 6, bad          # cancel, environment, id-token, static keys, latest tag, no stability wait
assert lint_deploy(GOOD_WF) == [] and lint_trust_policy(TRUST, "you/omniguard") == []
TRUST["Statement"][0]["Condition"]["StringEquals"]["token.actions.githubusercontent.com:sub"] = "repo:you/*"
assert lint_trust_policy(TRUST, "you/omniguard")       # any repo of yours could deploy -> rejected
print("OK: deploy workflow + OIDC trust policy validated")
```

- `ORDER` -- credentials -> ECR login -> push -> render -> deploy -> smoke test. Kisi bhi step ka order galat = broken deploy.
- `cancel-in-progress: false` -- deploy beech mein cancel hua to service aadhe state mein reh sakti hai; deploys queue mein chalne do. `id-token: write` sirf deploy job pe (M04-09 least privilege).
- Trust policy `sub` -- `repo:you/omniguard:environment:production` matlab sirf is repo ka production-environment job; `repo:you/*` = aapka koi bhi repo prod mein deploy kar sakta hai.

**Rollback**: ECS service pe `deploymentConfiguration.deploymentCircuitBreaker = {enable: true, rollback: true}` -- naye tasks health check fail karein to ECS pichhli revision pe wapas. Manual rollback neeche.

```bash
# run later on your own AWS account (free tier; budget alarm from M03-13 already set)
aws ecr create-repository --repository-name omniguard --image-scanning-configuration scanOnPush=true
aws ecs update-service --cluster omniguard --service omniguard-api \
  --deployment-configuration "deploymentCircuitBreaker={enable=true,rollback=true},maximumPercent=200,minimumHealthyPercent=100"
# manual rollback to a known-good revision
aws ecs update-service --cluster omniguard --service omniguard-api --task-definition omniguard-api:6
aws ecs wait services-stable --cluster omniguard --services omniguard-api
```

### Mini-exercise (30-60 min)
OmniGuard CP4 build (ye gate hai):
- AWS: OIDC provider, `omniguard-github-deploy` role (trust policy upar wali, permissions: ECR push to one repo, `ecs:RegisterTaskDefinition`, `ecs:UpdateService`/`DescribeServices` on one service, `iam:PassRole` sirf do task roles pe).
- `.github/workflows/deploy.yml` upar jaisa; `tools/lint_deploy.py` + test CI mein. ECS service: Fargate, ALB (M04-07), circuit breaker on, 1 task. Kaam ke baad desired count 0 (cost, M03-13).
- **Gate**: README mein LIVE URL, `curl <url>/readyz` = 200, CI badge green. Ek jaan-boojh ke broken commit (`/readyz` 503) push karo -- circuit breaker rollback dekho, phir fix.

### Common pitfalls
- `iam:PassRole` `*` pe -- deploy role koi bhi role ECS ko pass kar sakta hai; sirf execution + task role ARNs do.
- `wait-for-service-stability` ke bina workflow green, prod red -- CI pe bharosa khatam.
- ALB health check `/` pe aur app `/` pe 404 -- har deploy circuit breaker rollback; path `/readyz` rakho (M04-13).

### Checklist before moving on
- [ ] GitHub mein koi AWS key nahi; OIDC role trust policy repo + environment tak locked.
- [ ] Har prod task revision ek git SHA image pe.
- [ ] Deploy job stability ka wait karta hai aur smoke test chalata hai.
- [ ] Rollback (automatic + manual) ek baar practice kiya; LIVE URL + health check + CI badge README mein.

### Related
- M04-06 Configuring task definitions
- M04-11 Managing GitHub secrets
- M04-13 Health and readiness checks
- M03-11 Assuming cross-account roles

### Self-quiz
1. OIDC deploy mein AWS ko kaise pata chalta hai ki request aapke repo ke production job se aa rahi hai?
2. Circuit breaker rollback kab trigger hota hai, aur kab nahi bachayega (hint: health check kya check karta hai)?
3. Deploy concurrency mein `cancel-in-progress: true` kyun galat hai?
4. Prod pe bug mila. Commit SHA se running task revision tak ka trace kaise karoge?
