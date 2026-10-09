# Cloud Fundamentals & Networking

## Principle of least privilege

> Core | Fast CP4 / Slow CP6 | ~1.2 h | Builds on: M03-01, M03-04

### Kahani
Ek healthcare customer pe pichhle vendor ne app role ko `AdministratorAccess` de diya tha -- "permissions ka jhanjhat baad mein dekhenge". Phir app mein ek SSRF bug mila. Attacker ne instance metadata se role credentials uthaye aur `s3:ListAllMyBuckets` se poore account ke patient-data buckets dekh liye.
Bug chhota tha. Blast radius `AdministratorAccess` ne bada banaya.
Ab aap OmniGuard le ke aaye ho, aur customer ka cloud security lead seedha poochhta hai: "Aapke app ko *exactly* kya chahiye? Ek list do, har line ka reason ke saath."

### What it is
**Least privilege** = har identity (user, role, app) ko sirf woh actions, sirf un resources pe, sirf un conditions mein do jo uske kaam ke liye zaroori hain -- aur kuch nahi.
AWS IAM mein iska matlab: specific `Action`s, specific resource **ARNs**, aur jahan ho sake `Condition` -- `"Action": "*"` / `"Resource": "*"` nahi.

### Why it matters for an FDE
Customer account mein aapko root nahi, ek **role** milta hai, aur aapke app ko bhi ek role chahiye. Dono ke liye permissions ka likhit justification aap doge -- broad request = security review reject, ya worse, incident pe aapka naam.

### Key concepts
- **Blast radius** -- credentials leak hone pe attacker kya kar sakta hai; least privilege isse chhota rakhta hai, bug ko rokta nahi.
- **Evaluation logic** -- explicit **Deny** sabse upar > koi **Allow** match kare to allow > warna **implicit deny** (default "na").
- **Wildcards** -- `s3:Get*` ya `arn:...:bucket/*` convenient hai par aage naye actions/resources bhi cover kar leta hai; scope sochke lagao.
- **Start narrow, widen with evidence** -- CloudTrail / **IAM Access Analyzer** policy generation se dekho app ne actually kya call kiya, phir wahi do.
- **Separate roles** -- deploy role (aapka, CI ka) aur runtime role (app ka) alag; app ko `iam:*` ya `ec2:RunInstances` ki zarurat nahi.

### Code example
stdlib only (`fnmatch`)

Yeh AWS ke real evaluator ka **chhota simplified model** hai (identity policies only; SCPs, boundaries, resource policies nahi). Real check ke liye IAM policy simulator / Access Analyzer use karo.

```python
# runnable
from fnmatch import fnmatchcase

def _list(x):
    return x if isinstance(x, list) else [x]

def _cond_ok(cond, ctx):
    for op, kv in cond.items():
        for key, want in kv.items():
            have = ctx.get(key)
            if have is None:
                return False
            if op == "StringEquals" and have not in _list(want):
                return False
            if op == "StringLike" and not any(fnmatchcase(have, w) for w in _list(want)):
                return False
            if op == "Bool" and str(have).lower() != str(want).lower():
                return False
    return True

def evaluate(policies, action, resource, ctx=None):
    ctx, allowed = ctx or {}, False
    for pol in policies:
        for st in pol["Statement"]:
            a_ok = any(fnmatchcase(action.lower(), a.lower()) for a in _list(st["Action"]))
            r_ok = any(fnmatchcase(resource, r) for r in _list(st["Resource"]))
            if a_ok and r_ok and _cond_ok(st.get("Condition", {}), ctx):
                if st["Effect"] == "Deny":
                    return "explicit-deny"          # deny always wins
                allowed = True
    return "allow" if allowed else "implicit-deny"

BUCKET = "arn:aws:s3:::acme-claims"
SECRET = "arn:aws:secretsmanager:eu-west-1:111122223333:secret:omniguard/llm-key-AbCdEf"
broad = {"Statement": [{"Effect": "Allow", "Action": ["s3:*", "secretsmanager:*"], "Resource": "*"}]}
narrow = {"Statement": [
    {"Effect": "Allow", "Action": "s3:GetObject", "Resource": f"{BUCKET}/omniguard/*"},
    {"Effect": "Allow", "Action": "secretsmanager:GetSecretValue",
     "Resource": "arn:aws:secretsmanager:eu-west-1:111122223333:secret:omniguard/llm-key-??????"},
    {"Effect": "Deny", "Action": "s3:*", "Resource": "*",
     "Condition": {"Bool": {"aws:SecureTransport": "false"}}}]}

needed = [("s3:GetObject", f"{BUCKET}/omniguard/policy.yaml"), ("secretsmanager:GetSecretValue", SECRET)]
attacker = [("s3:ListAllMyBuckets", "*"), ("s3:GetObject", f"{BUCKET}/patients/123.pdf"),
            ("s3:DeleteObject", f"{BUCKET}/omniguard/policy.yaml"),
            ("secretsmanager:GetSecretValue", SECRET.replace("llm-key", "db-root"))]
tls = {"aws:SecureTransport": "true"}

for act, res in needed:
    assert evaluate([narrow], act, res, tls) == "allow", (act, res)
    assert evaluate([broad], act, res, tls) == "allow"
blast_broad = [a for a, r in attacker if evaluate([broad], a, r, tls) == "allow"]
blast_narrow = [a for a, r in attacker if evaluate([narrow], a, r, tls) == "allow"]
assert len(blast_broad) == 4 and blast_narrow == []
assert evaluate([narrow], "s3:GetObject", f"{BUCKET}/omniguard/policy.yaml",
                {"aws:SecureTransport": "false"}) == "explicit-deny"   # deny beats allow
assert evaluate([narrow], "S3:getobject", f"{BUCKET}/omniguard/x", tls) == "allow"  # actions: case-insensitive

observed = {"s3:GetObject", "secretsmanager:GetSecretValue"}            # e.g. from CloudTrail
granted_broad = {"s3:*", "secretsmanager:*"}
print("leaked-creds blast radius  broad:", blast_broad)
print("leaked-creds blast radius narrow:", blast_narrow)
print("observed actions:", sorted(observed), "| broad grants:", sorted(granted_broad))
```

- `evaluate()` order -- Deny turant return; Allow sirf flag set karta hai; kuch match nahi to `implicit-deny`. Yahi AWS ka core rule hai.
- `fnmatchcase(action.lower(), ...)` -- IAM actions case-insensitive hain, ARNs case-sensitive; isliye resource pe `.lower()` nahi.
- `llm-key-??????` -- Secrets Manager ARN ke end mein 6 random characters lagte hain; `??????` sirf woh suffix allow karta hai, `omniguard/llm-key-v2-...` jaisa doosra secret nahi.
- `Deny ... SecureTransport false` -- guardrail statement: TLS ke bina S3 call hamesha deny, chahe koi Allow ho.
- `blast_broad` vs `blast_narrow` -- yahi number customer ko dikhao: same leaked credentials, 4 vs 0 dangerous actions.

Real check (sandbox), simulator se:

```bash
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::111122223333:role/omniguard-app \
  --action-names s3:GetObject s3:DeleteObject secretsmanager:GetSecretValue \
  --resource-arns arn:aws:s3:::acme-claims/omniguard/policy.yaml \
  --query 'EvaluationResults[].{action:EvalActionName,decision:EvalDecision}'
```

### Mini-exercise (30-60 min)
`omniguard/infra/iam/` mein:
1. `permissions-request.md` -- OmniGuard runtime role ki table: action | resource | why | what breaks without it. Max 6 rows.
2. `evaluator.py` -- upar ka model; `test_evaluator.py` mein "needed" sab allow, "attacker" list sab deny.
3. Ek alag table deploy role ke liye (aap/CI kya karoge: ECS deploy, logs read) -- runtime role se mix nahi.

Acceptance: `pytest -q` green; permissions-request.md mein koi `*` action nahi, aur har resource ARN specific hai.

### Common pitfalls
- **"Pehle sab de do, baad mein kam karenge"** -- baad kabhi nahi aata. Narrow se shuru karo, AccessDenied logs se widen karo.
- **Sirf Action narrow, Resource `*`** -- `s3:GetObject` on `*` = account ke saare buckets padh sakta hai.
- **Human aur app ka ek role** -- aapke debug permissions app ke credentials ke saath leak hote hain. Alag roles, alag sessions.

### Checklist before moving on
- [ ] Explicit deny > allow > implicit deny bina dekhe samjha sakte ho.
- [ ] OmniGuard runtime role ki permissions list har line ke reason ke saath likhi hai.
- [ ] Policy simulator / Access Analyzer kab use karna hai pata hai.
- [ ] Deploy role aur runtime role alag hain.

### Related
- M03-10 Creating identity policies
- M03-11 Assuming cross-account roles
- M03-01 Provisioning virtual machines
- M03-08 Configuring strict security groups

### Self-quiz
1. Ek policy `Allow s3:*` aur doosri `Deny s3:DeleteObject` -- `DeleteObject` ka result kya aur kyun?
2. Least privilege ne SSRF bug fix kiya ya nahi? Toh exactly kya badla?
3. App ko kabhi-kabhi naye prefix ki zarurat padti hai aur har baar ticket raise karna padta hai. Speed aur safety ka balance kaise karoge?
4. Customer ka security lead puchhta hai "`s3:Get*` kyun nahi, `s3:GetObject` kyun?" -- `Get*` mein aur kya-kya aata hai jo risky ho sakta hai?
