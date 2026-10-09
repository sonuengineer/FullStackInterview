# Cloud Fundamentals & Networking

## Creating identity policies

> Core | Fast CP4 / Slow CP6 | ~1.2 h | Builds on: M03-09

### Kahani
M03-09 mein aapne OmniGuard ki permissions ki list customer ko bheji, aur unhone approve kar di. Ab asli kaam: woh list ek IAM **policy document** mein likhni hai.
Pehli koshish mein `s3:ListBucket` ko `arn:aws:s3:::acme-claims/omniguard/*` pe lagaya -- AccessDenied. Doosri koshish mein secret ka ARN bina random suffix ke likha -- AccessDenied. Teesri koshish mein frustrate hoke `"Resource": "*"` -- customer ka CI pipeline (Access Analyzer check) ne PR hi block kar diya.
Policy JSON chhota dikhta hai, par har line ke chhote rules hain. Yeh lesson unhi rules ka hai.

### What it is
**Identity policy** ek JSON document hai jo IAM role/user/group pe attach hota hai: `Version` + `Statement` list, har statement mein `Effect`, `Action`, `Resource`, optional `Condition`.
Role ke saath ek alag **trust policy** bhi hoti hai jo batati hai *kaun* is role ko assume kar sakta hai (EC2, ECS tasks, Lambda, ya doosra account).

### Why it matters for an FDE
Customer ke account mein policies aksar unke review/CI se guzarti hain. Shape galat, ARN galat, ya `*` hua to deploy din-bhar atka rehta hai. Sahi policy pehli baar mein = fast approval.

### Key concepts
- **Bucket vs object ARN** -- `s3:ListBucket` bucket ARN (`arn:aws:s3:::acme-claims`) pe lagta hai, `s3:GetObject` object ARN (`.../omniguard/*`) pe; prefix restrict karne ke liye `s3:prefix` condition.
- **Secret ARN suffix** -- Secrets Manager ARN ke end mein `-` + 6 random chars; policy mein `name-??????` likho.
- **KMS** -- secret customer-managed KMS key se encrypted ho to `kms:Decrypt` bhi chahiye; `kms:ViaService` condition se sirf Secrets Manager ke through.
- **Trust policy** -- `Principal: {"Service": "ecs-tasks.amazonaws.com"}` + `sts:AssumeRole`; yeh permissions nahi, "kaun pehen sakta hai" hai.
- **Validation** -- `Version` hamesha `"2012-10-17"`; size limits hain (check the docs); real lint ke liye `aws accessanalyzer validate-policy`.

### Code example
`pip install jsonschema`

Block policy banata hai, shape validate karta hai, house lint chalata hai, aur ek chhote evaluator se prove karta hai ki policy *kaam* bhi karti hai.

```python
# runnable
import json
from fnmatch import fnmatchcase
from jsonschema import Draft202012Validator

ACCT, REGION, BUCKET = "111122223333", "eu-west-1", "acme-claims"
SECRET = f"arn:aws:secretsmanager:{REGION}:{ACCT}:secret:omniguard/llm-key"
KMS_KEY = f"arn:aws:kms:{REGION}:{ACCT}:key/1111aaaa-22bb-33cc-44dd-555555eeeeee"

POLICY = {"Version": "2012-10-17", "Statement": [
    {"Sid": "ListOwnPrefix", "Effect": "Allow", "Action": "s3:ListBucket",
     "Resource": f"arn:aws:s3:::{BUCKET}",
     "Condition": {"StringLike": {"s3:prefix": ["omniguard/*"]}}},
    {"Sid": "ReadOwnPrefix", "Effect": "Allow", "Action": "s3:GetObject",
     "Resource": f"arn:aws:s3:::{BUCKET}/omniguard/*"},
    {"Sid": "ReadLlmKey", "Effect": "Allow", "Action": "secretsmanager:GetSecretValue",
     "Resource": f"{SECRET}-??????"},
    {"Sid": "DecryptViaSecretsManager", "Effect": "Allow", "Action": "kms:Decrypt",
     "Resource": KMS_KEY,
     "Condition": {"StringEquals": {"kms:ViaService": f"secretsmanager.{REGION}.amazonaws.com"}}}]}
TRUST = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "sts:AssumeRole",
         "Principal": {"Service": "ecs-tasks.amazonaws.com"}}]}

STR_OR_LIST = {"anyOf": [{"type": "string"}, {"type": "array", "items": {"type": "string"}, "minItems": 1}]}
SCHEMA = {"type": "object", "required": ["Version", "Statement"], "additionalProperties": False,
          "properties": {"Version": {"const": "2012-10-17"}, "Statement": {"type": "array", "minItems": 1,
          "items": {"type": "object", "required": ["Effect", "Action", "Resource"], "properties": {
              "Sid": {"type": "string", "pattern": "^[A-Za-z0-9]+$"}, "Effect": {"enum": ["Allow", "Deny"]},
              "Action": STR_OR_LIST, "Resource": STR_OR_LIST, "Condition": {"type": "object"}}}}}}

def lint(p):
    errs = []
    for st in p["Statement"]:
        acts = st["Action"] if isinstance(st["Action"], list) else [st["Action"]]
        ress = st["Resource"] if isinstance(st["Resource"], list) else [st["Resource"]]
        if st["Effect"] == "Allow" and any(a == "*" or a.endswith(":*") for a in acts):
            errs.append(f"{st.get('Sid')}: service-wide action")
        if st["Effect"] == "Allow" and "*" in ress:
            errs.append(f"{st.get('Sid')}: Resource '*'")
        if "s3:ListBucket" in acts and any("/" in r.split(":::")[-1] for r in ress):
            errs.append(f"{st.get('Sid')}: ListBucket needs the BUCKET arn, not an object arn")
    if len(json.dumps(p, separators=(",", ":"))) > 6144:
        errs.append("policy too large for a managed policy")
    return errs

def allows(p, action, resource, ctx):
    for st in p["Statement"]:
        if st["Effect"] != "Allow" or not fnmatchcase(action, st["Action"]):
            continue
        if not fnmatchcase(resource, st["Resource"]):
            continue
        conds = [(k, v) for kv in st.get("Condition", {}).values() for k, v in kv.items()]
        if all(any(fnmatchcase(ctx.get(k, "\0"), w) for w in (v if isinstance(v, list) else [v]))
               for k, v in conds):
            return True
    return False

Draft202012Validator(SCHEMA).validate(POLICY)
assert lint(POLICY) == [], lint(POLICY)
assert TRUST["Statement"][0]["Principal"]["Service"] == "ecs-tasks.amazonaws.com"

b = f"arn:aws:s3:::{BUCKET}"
assert allows(POLICY, "s3:ListBucket", b, {"s3:prefix": "omniguard/policies/"})
assert not allows(POLICY, "s3:ListBucket", b, {"s3:prefix": "patients/"})
assert allows(POLICY, "s3:GetObject", f"{b}/omniguard/policy.yaml", {})
assert allows(POLICY, "secretsmanager:GetSecretValue", f"{SECRET}-AbC123", {})
assert not allows(POLICY, "secretsmanager:GetSecretValue", f"{SECRET}-v2-AbC123", {})
assert allows(POLICY, "kms:Decrypt", KMS_KEY, {"kms:ViaService": f"secretsmanager.{REGION}.amazonaws.com"})
assert not allows(POLICY, "kms:Decrypt", KMS_KEY, {})              # direct decrypt blocked

first_try = {"Version": "2012-10-17", "Statement": [
    {"Sid": "Bad", "Effect": "Allow", "Action": ["s3:ListBucket", "s3:*"], "Resource": f"{b}/omniguard/*"},
    {"Sid": "Lazy", "Effect": "Allow", "Action": "secretsmanager:GetSecretValue", "Resource": "*"}]}
print("first_try lint:", lint(first_try))
assert len(lint(first_try)) == 3
print(json.dumps(POLICY, indent=2)[:200], "...")
```

- `ListOwnPrefix` -- `ListBucket` bucket ARN pe, aur `s3:prefix` condition se sirf `omniguard/*` list hota hai. Kahani ki pehli galti yahi thi.
- `{SECRET}-??????` -- secret recreate hua to suffix badlega; isliye `??????`, `*` nahi (`*` `llm-key-v2-...` bhi match karega).
- `kms:ViaService` -- app KMS key se seedha kuch bhi decrypt nahi kar sakta, sirf Secrets Manager ke through.
- `"\0"` default -- condition key request mein na ho to condition fail; real IAM bhi missing key pe (zyada operators ke liye) false deta hai.
- `lint()` -- house rules; `aws accessanalyzer validate-policy` iska real, kaafi zyada complete version hai -- dono CI mein chalao.

Asli create + AWS ka apna validator:

```bash
aws accessanalyzer validate-policy --policy-type IDENTITY_POLICY \
  --policy-document file://omniguard-app-policy.json \
  --query 'findings[].{type:findingType,issue:issueCode}'
aws iam create-role --role-name omniguard-app \
  --assume-role-policy-document file://trust-ecs-tasks.json
aws iam put-role-policy --role-name omniguard-app \
  --policy-name omniguard-runtime --policy-document file://omniguard-app-policy.json
```

### Mini-exercise (30-60 min)
`omniguard/infra/iam/` mein:
1. `omniguard-app-policy.json` + `trust-ecs-tasks.json` -- M03-09 ki approved list se generate (`make_policy.py`, account/region/bucket env se).
2. `test_policy.py` -- schema, lint, aur `allows()` cases: apna prefix haan, doosra prefix nahi, dusra secret nahi, direct KMS nahi.
3. Design doc "IAM" section: har `Sid` ka ek-line reason (customer reviewer ke liye), aur "hum kya **nahi** maang rahe" list.

Acceptance: `pytest -q` green; agar sandbox account hai to `validate-policy` zero ERROR/SECURITY_WARNING findings de.

### Common pitfalls
- **Trust aur permission policy mix karna** -- trust policy mein `s3:GetObject` likhne se kuch nahi hota; woh sirf "kaun assume kare" hai.
- **Hardcoded account/region** -- dev aur prod alag accounts hote hain; template/env se banao.
- **Inline policies ka jungle** -- 10 inline policies review karna mushkil; ek managed policy per role + version control.

### Checklist before moving on
- [ ] ListBucket bucket ARN pe kyun aur GetObject object ARN pe kyun, samjha sakte ho.
- [ ] Secret ARN `??????` suffix ka reason pata hai.
- [ ] Trust policy aur permission policy ka fark ek line mein.
- [ ] Policy JSON schema + lint + validate-policy CI mein hai.

### Related
- M03-09 Principle of least privilege
- M03-11 Assuming cross-account roles
- M03-03 Managed relational databases setup
- M03-02 Object storage lifecycle policies

### Self-quiz
1. Policy sahi dikhti hai par app ko phir bhi `AccessDenied` on `GetObject`. IAM ke alawa teen jagah batao jahan deny aa sakta hai.
2. `"Resource": "arn:aws:s3:::acme-claims*"` mein kya galat ho sakta hai?
3. Customer chahta hai ki OmniGuard role sirf unke VPC endpoint se S3 call kare. Kaunsi condition key soochoge?
4. Trust policy mein `Principal: {"AWS": "*"}` dekh ke aap kya bologe aur kyun?
