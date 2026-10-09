# Containerization & CI-CD

## Configuring task definitions

> Core | Fast CP4 / Slow CP6 | ~1.2 h | Builds on: M04-04, M04-05, M03-09, M03-10

### Kahani
Logistics customer ke AWS account mein OmniGuard ka pehla ECS deploy. Console pe service "PENDING" -> "STOPPED" loop mein. Reason: `cpu 512, memory 512 is not a valid combination`.
Fix kiya, ab task chala par CloudWatch mein ek bhi log line nahi -- `logConfiguration` hi nahi tha. Aur reviewer ne dekha ki `DATABASE_PASSWORD` plain `environment` mein hai, jo console pe kisi bhi read-only user ko dikhta hai.
Task definition ECS ka "docker run command as JSON" hai -- usme galti = deploy fail ya secret leak.

### What it is
**Task definition** = versioned JSON blueprint: kaunsi image, kitna CPU/memory, ports, env, secrets, logs, health check, aur kaunse IAM roles. Har change = nayi **revision** (`omniguard-api:7`); service ek revision chalati hai.
Fargate pe `networkMode` hamesha `awsvpc` aur CPU/memory sirf fixed combinations mein.

### Why it matters for an FDE
Customer ke account mein deploy aksar task definition pe hi atakta hai. Valid JSON, sahi roles aur secrets ka `valueFrom` pattern -- ye aapko pehli baar mein sahi chahiye, kyunki debug loop slow hai (har try = minutes).

### Key concepts
- **cpu/memory combos** -- 256 -> 512/1024/2048 MB; 512 -> 1-4 GB; 1024 -> 2-8 GB; 2048 -> 4-16 GB (Fargate docs mein full table).
- **executionRoleArn vs taskRoleArn** -- execution role: ECS agent image pull + logs + secrets fetch; task role: aapka app code AWS APIs call kare (M03-09 least privilege).
- **secrets[].valueFrom** -- SSM Parameter Store ya Secrets Manager ARN; value runtime pe inject, JSON mein kabhi nahi.
- **awslogs** -- `awslogs-group`, `awslogs-region`, `awslogs-stream-prefix`; bina iske container ke logs gayab.
- **healthCheck** -- container-level check (interval, timeout, retries, startPeriod); image mein jo binary ho wahi use karo.

### Code example
`pip install jsonschema`

```json
{
  "family": "omniguard-api",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "executionRoleArn": "arn:aws:iam::123456789012:role/omniguard-ecs-execution",
  "taskRoleArn": "arn:aws:iam::123456789012:role/omniguard-api-task",
  "containerDefinitions": [{
    "name": "api",
    "image": "123456789012.dkr.ecr.us-east-1.amazonaws.com/omniguard:replaced-by-ci",
    "essential": true,
    "portMappings": [{"containerPort": 8000, "protocol": "tcp"}],
    "environment": [{"name": "LOG_LEVEL", "value": "info"}],
    "secrets": [
      {"name": "DATABASE_URL", "valueFrom": "arn:aws:ssm:us-east-1:123456789012:parameter/omniguard/prod/database_url"},
      {"name": "LLM_API_KEY", "valueFrom": "arn:aws:secretsmanager:us-east-1:123456789012:secret:omniguard/llm-AbCdEf"}
    ],
    "logConfiguration": {"logDriver": "awslogs", "options": {
      "awslogs-group": "/ecs/omniguard-api", "awslogs-region": "us-east-1", "awslogs-stream-prefix": "api"}},
    "healthCheck": {
      "command": ["CMD-SHELL", "python -c \"import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=2)\" || exit 1"],
      "interval": 30, "timeout": 5, "retries": 3, "startPeriod": 30}
  }]
}
```

```python
# runnable
import copy
import re
import jsonschema

FARGATE = {256: [512, 1024, 2048], 512: range(1024, 4097, 1024), 1024: range(2048, 8193, 1024),
           2048: range(4096, 16385, 1024), 4096: range(8192, 30721, 1024),
           8192: range(16384, 61441, 4096), 16384: range(32768, 122881, 8192)}
ARN_SECRET = r"^arn:aws:(ssm|secretsmanager):[a-z0-9-]+:\d{12}:(parameter|secret)[:/].+"

SCHEMA = {
    "type": "object",
    "required": ["family", "networkMode", "requiresCompatibilities", "cpu", "memory",
                 "executionRoleArn", "taskRoleArn", "containerDefinitions"],
    "properties": {
        "networkMode": {"const": "awsvpc"},
        "requiresCompatibilities": {"contains": {"const": "FARGATE"}},
        "cpu": {"type": "string", "pattern": r"^\d+$"}, "memory": {"type": "string", "pattern": r"^\d+$"},
        "containerDefinitions": {"type": "array", "minItems": 1, "items": {
            "type": "object", "required": ["name", "image", "logConfiguration", "healthCheck"],
            "properties": {
                "secrets": {"type": "array", "items": {"type": "object", "required": ["name", "valueFrom"],
                            "properties": {"valueFrom": {"type": "string", "pattern": ARN_SECRET}}}},
                "logConfiguration": {"type": "object", "required": ["logDriver", "options"],
                    "properties": {"logDriver": {"const": "awslogs"}, "options": {"type": "object",
                        "required": ["awslogs-group", "awslogs-region", "awslogs-stream-prefix"]}}},
                "healthCheck": {"type": "object", "required": ["command"], "properties": {
                    "command": {"type": "array", "prefixItems": [{"enum": ["CMD", "CMD-SHELL"]}]},
                    "interval": {"minimum": 5, "maximum": 300}, "timeout": {"minimum": 2, "maximum": 120},
                    "retries": {"minimum": 1, "maximum": 10}, "startPeriod": {"minimum": 0, "maximum": 300}}}}}}}}

def validate(td: dict) -> list[str]:
    v = jsonschema.Draft202012Validator(SCHEMA)
    errs = [f"{'/'.join(map(str, e.absolute_path)) or 'root'}: {e.message[:70]}" for e in v.iter_errors(td)]
    if not errs and int(td["memory"]) not in FARGATE.get(int(td["cpu"]), []):
        errs.append(f"invalid Fargate cpu/memory combo {td['cpu']}/{td['memory']}")
    for c in td.get("containerDefinitions", []):
        if c.get("image", "").endswith(":latest") or ":" not in c.get("image", ""):
            errs.append(f"{c.get('name')}: image not pinned")
        for e in c.get("environment", []):
            if re.search(r"KEY|SECRET|TOKEN|PASSWORD", e["name"]):
                errs.append(f"{c.get('name')}: {e['name']} in plain environment (use secrets/valueFrom)")
    if td.get("executionRoleArn") == td.get("taskRoleArn"):
        errs.append("execution role and task role are the same (split them)")
    return errs

GOOD = {"family": "omniguard-api", "networkMode": "awsvpc", "requiresCompatibilities": ["FARGATE"],
        "cpu": "512", "memory": "1024",
        "executionRoleArn": "arn:aws:iam::123456789012:role/omniguard-ecs-execution",
        "taskRoleArn": "arn:aws:iam::123456789012:role/omniguard-api-task",
        "containerDefinitions": [{"name": "api", "image": "1234.dkr.ecr.us-east-1.amazonaws.com/omniguard:3f2a9c1",
            "environment": [{"name": "LOG_LEVEL", "value": "info"}],
            "secrets": [{"name": "DATABASE_URL",
                         "valueFrom": "arn:aws:ssm:us-east-1:123456789012:parameter/omniguard/prod/database_url"}],
            "logConfiguration": {"logDriver": "awslogs", "options": {"awslogs-group": "/ecs/omniguard-api",
                                 "awslogs-region": "us-east-1", "awslogs-stream-prefix": "api"}},
            "healthCheck": {"command": ["CMD-SHELL", "python -c 'print(1)' || exit 1"],
                            "interval": 30, "timeout": 5, "retries": 3, "startPeriod": 30}}]}

bad = copy.deepcopy(GOOD)
bad["memory"] = "512"
c = bad["containerDefinitions"][0]
c["image"] = "omniguard:latest"
c["environment"].append({"name": "DATABASE_PASSWORD", "value": "hunter2"})
c["secrets"][0]["valueFrom"] = "my-db-url"
c["healthCheck"]["interval"] = 1

assert validate(GOOD) == [], validate(GOOD)
schema_errs = validate(bad)
for e in schema_errs:
    print("BAD :", e)
assert any("valueFrom" in e for e in schema_errs) and any("interval" in e for e in schema_errs)
bad_c = copy.deepcopy(bad)
bad_c["containerDefinitions"][0]["secrets"][0]["valueFrom"] = GOOD["containerDefinitions"][0]["secrets"][0]["valueFrom"]
bad_c["containerDefinitions"][0]["healthCheck"]["interval"] = 30
rule_errs = validate(bad_c)
assert any("combo 512/512" in e for e in rule_errs) and any("DATABASE_PASSWORD" in e for e in rule_errs)
assert any("not pinned" in e for e in rule_errs)
assert 3072 in FARGATE[512] and 512 not in FARGATE[512] and 20480 in FARGATE[8192]
print("OK: schema + Fargate combo + secret rules")
```

- `SCHEMA` -- sirf woh fields jo deploy todte hain; AWS ka apna validation `register-task-definition` pe hota hai, par CI mein pehle pakadna sasta hai.
- `prefixItems` -- health check command ka pehla element `CMD` ya `CMD-SHELL` hona chahiye (Draft 2020-12).
- `FARGATE` table -- invalid combo schema se express karna mushkil, isliye Python rule.
- Schema errors pehle, rules baad mein -- isliye bad file do stages mein test kiya.
- Execution role ko Secrets Manager/SSM read + KMS decrypt chahiye, task role ko nahi (jab tak app khud secrets na padhe).

```bash
# run later on your own AWS account (free tier; budget alarm from M03-13 already set)
aws ecs register-task-definition --cli-input-json file://ecs/taskdef.json
aws ecs describe-task-definition --task-definition omniguard-api --query "taskDefinition.revision"
```

### Mini-exercise (30-60 min)
OmniGuard repo:
- `ecs/taskdef.json` -- upar wala template, apne account/region placeholders ke saath; image tag CI replace karega (M04-12).
- `tools/validate_taskdef.py` + `tests/test_taskdef.py` -- repo ki file clean pass kare; bad fixtures (invalid combo, plain secret, missing awslogs) fail karein.
- SSM parameter `/omniguard/prod/database_url` (SecureString) ka naam decide karo aur `docs/deploy.md` mein likho -- abhi create mat karo, M04-12 mein karoge.

### Common pitfalls
- `cpu`/`memory` number vs string -- task level pe API dono accept kar sakti hai, par apni files consistent rakho; validator ek format enforce kare.
- Health check mein `curl` jab image slim hai -- check hamesha fail, task loop mein restart.
- Execution role ko `secretsmanager:GetSecretValue` on `*` -- sirf `omniguard/*` ARNs do (M03-10).

### Checklist before moving on
- [ ] Execution role vs task role ka farak ek line mein.
- [ ] Fargate 512 CPU ke saath valid memory values bata sakte ho.
- [ ] Koi secret `environment` mein nahi, sab `secrets[].valueFrom`.
- [ ] awslogs + healthCheck har essential container pe.

### Related
- M04-04 Containerizing FastAPI backends
- M04-12 Continuous deployment to AWS
- M04-13 Health and readiness checks
- M03-09 Principle of least privilege
- M03-10 Creating identity policies

### Self-quiz
1. Task "STOPPED" hai aur CloudWatch mein kuch nahi. Pehle task definition mein kya check karoge?
2. App ko S3 bucket padhna hai. Permission kis role pe jaayegi aur kyun?
3. `environment` mein secret rakhne ka exact risk kya hai agar container to private hai?
4. Container `healthCheck` aur ALB target group health check -- dono kyun, aur farak kya?
