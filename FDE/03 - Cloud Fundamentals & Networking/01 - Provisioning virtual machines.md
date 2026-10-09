# Cloud Fundamentals & Networking

## Provisioning virtual machines

> Core | Fast CP4 / Slow CP6 | ~1.2 h | Builds on: M03-13 (budget pehle lagao)

### Kahani
Ek hospital customer ne bola: "OmniGuard ko hamare AWS account mein ek VM pe chala do, demo Thursday ko hai." Aapko root nahi mila -- ek IAM role mila, aur security team ka rule hai: "Port 22 internet pe kabhi nahi khulega, SSH keys share nahi honge."
Pichhle vendor ne `t3.2xlarge` pe public IP, open SSH aur ek `.pem` key Slack pe share ki thi. Audit mein pakda gaya aur contract hold pe chala gaya.
Aapko ek VM chahiye jo boot pe khud OmniGuard install kare, bina SSH ke manage ho, aur security review pass kare.

### What it is
**EC2** AWS ki VM service hai: ek **AMI** (OS image) + **instance type** (CPU/RAM size) + network (subnet, security group) + **user data** (boot script) = ek running server.
Aaj ke production mein aap VM ko SSH se nahi, **SSM Session Manager** se access karte ho, aur metadata ko **IMDSv2** se lock karte ho.

### Why it matters for an FDE
Customer ka security team aapki launch config line-by-line padhega. Open port 22, IMDSv1 ya hardcoded secret dikha to deploy wahin ruk jaata hai -- aur trust bhi.

### Key concepts
- **AMI** -- OS + pre-installed software ka snapshot; region-specific ID (`ami-...`), isliye hardcode karne ke bajaye SSM public parameter se latest lo.
- **Instance type** -- `t3.small` jaise family+size; burstable `t` family demo ke liye theek, steady load pe CPU credits khatam ho sakte hain.
- **Key pair vs SSM Session Manager** -- key pair = SSH + port 22; SSM = IAM se authenticated shell, koi inbound port nahi, har session CloudTrail mein log.
- **User data** -- first boot pe root ke roop mein chalne wala script (cloud-init); size limit 16 KB (check the docs), aur yeh secret rakhne ki jagah nahi hai.
- **IMDSv2** -- instance metadata (`169.254.169.254`) pe session token zaroori; SSRF bug se role credentials churane wala classic attack rokta hai.

### Code example
`pip install jsonschema` (baaki stdlib only)

Yeh block AWS ko call nahi karta. Yeh launch config ko customer ke security rules ke against validate karta hai aur user data render karta hai.

```python
# runnable
import base64, re
from string import Template

ALLOWED_TYPES = {"t3.small", "t3.medium", "m6i.large"}     # agreed with customer
USER_DATA = Template("""#!/bin/bash
set -euo pipefail
dnf install -y docker
systemctl enable --now docker
docker run -d --restart=always -p 8080:8080 \\
  -e APP_ENV=$env -e SECRET_ARN=$secret_arn $image
""")

def render_user_data(env: str, image: str, secret_arn: str) -> str:
    script = USER_DATA.substitute(env=env, image=image, secret_arn=secret_arn)
    if len(script.encode()) > 16 * 1024:
        raise ValueError("user data over 16 KB")
    if re.search(r"(password|AKIA[0-9A-Z]{16})", script, re.I):
        raise ValueError("secret-looking value in user data")
    return script

def validate_launch(cfg: dict) -> list[str]:
    errs = []
    if not re.fullmatch(r"ami-[0-9a-f]{8,17}", cfg.get("ImageId", "")):
        errs.append("bad ImageId")
    if cfg.get("InstanceType") not in ALLOWED_TYPES:
        errs.append(f"instance type {cfg.get('InstanceType')} not approved")
    if cfg.get("MetadataOptions", {}).get("HttpTokens") != "required":
        errs.append("IMDSv2 not enforced (HttpTokens must be 'required')")
    if "KeyName" in cfg:
        errs.append("key pair present -- use SSM Session Manager instead")
    if "IamInstanceProfile" not in cfg:
        errs.append("no instance profile -- SSM agent cannot register")
    for ni in cfg.get("NetworkInterfaces", []):
        if ni.get("AssociatePublicIpAddress"):
            errs.append("public IP on app server")
    return errs

good = {
    "ImageId": "ami-0abc1234def567890",
    "InstanceType": "t3.small",
    "IamInstanceProfile": {"Name": "omniguard-ec2-ssm"},
    "MetadataOptions": {"HttpTokens": "required", "HttpPutResponseHopLimit": 2},
    "NetworkInterfaces": [{"DeviceIndex": 0, "SubnetId": "subnet-priv-a",
                           "AssociatePublicIpAddress": False}],
}
ud = render_user_data("demo", "omniguard:1.4.0",
                      "arn:aws:secretsmanager:eu-west-1:111122223333:secret:omniguard/db")
good["UserData"] = base64.b64encode(ud.encode()).decode()

assert validate_launch(good) == [], validate_launch(good)
bad = {**good, "InstanceType": "p4d.24xlarge", "KeyName": "vendor-key",
       "MetadataOptions": {"HttpTokens": "optional"},
       "NetworkInterfaces": [{"DeviceIndex": 0, "AssociatePublicIpAddress": True}]}
problems = validate_launch(bad)
assert len(problems) == 4, problems
try:
    render_user_data("demo", "x", "Password=hunter2")
    raise AssertionError("secret should be rejected")
except ValueError:
    pass
print("launch config OK; rejected bad config with:")
for p in problems:
    print(" -", p)
```

- `ALLOWED_TYPES` -- customer ke saath pehle se agree kiya hua list; galti se GPU instance (`p4d`) launch hona budget ka sabse bada dushman hai.
- `HttpTokens: required` -- yahi IMDSv2 hai. `HopLimit 2` isliye ki container ke andar se bhi metadata mil sake (docs check karo).
- `KeyName` ko error maana -- SSM agent + instance profile (`AmazonSSMManagedInstanceCore` policy) se shell milta hai, port 22 ki zarurat nahi.
- User data mein sirf secret ka **ARN** hai, value nahi; app boot pe Secrets Manager se value padhta hai (M03-10 ki policy se).
- `base64` -- `run-instances` API user data base64 mein leti hai; CLI `file://` se khud encode kar deti hai.

Asli launch (customer ke account mein, unke diye role se):

```bash
AMI=$(aws ssm get-parameter \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --query Parameter.Value --output text)
aws ec2 run-instances \
  --image-id "$AMI" --instance-type t3.small \
  --subnet-id subnet-priv-a --security-group-ids sg-omniguard-app \
  --iam-instance-profile Name=omniguard-ec2-ssm \
  --metadata-options HttpTokens=required,HttpPutResponseHopLimit=2 \
  --user-data file://user-data.sh \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Project,Value=omniguard},{Key=Owner,Value=fde}]'
aws ssm start-session --target i-0123456789abcdef0
```

### Mini-exercise (30-60 min)
Capstone `omniguard/infra/` mein:
1. `launch_config.py` -- upar ka `validate_launch()` + `render_user_data()`, plus ek `--env` CLI flag.
2. `test_launch_config.py` (pytest) -- 6 cases: IMDSv1, key pair, public IP, unapproved type, user data > 16 KB, secret in user data.
3. `docs/network-iam-design.md` ka pehla section "Compute": instance type kyun, SSM kyun (port 22 kyun nahi), user data mein kya hai.

Acceptance: `pytest -q` green; design doc ka "Compute" section ek non-engineer security reviewer padh ke samajh sake (5-8 lines).

### Common pitfalls
- **Port 22 "sirf mere IP ke liye" kholna** -- IP badalta hai, rule `0.0.0.0/0` ban jaata hai. SSM use karo.
- **AMI ID hardcode** -- region badla to ID invalid, aur purani AMI mein unpatched CVEs. SSM public parameter se lo.
- **Instance band karna bhool jaana** -- stopped instance ka EBS volume bhi charge hota hai; `Owner`/`Project` tags + budget (M03-13) lagao.

### Checklist before moving on
- [ ] AMI, instance type, user data, instance profile -- har ek ek line mein samjha sakte ho.
- [ ] IMDSv2 kyun zaroori hai, SSRF example ke saath bata sakte ho.
- [ ] Launch config mein `KeyName` aur public IP nahi hai.
- [ ] User data mein koi secret value nahi, sirf ARN.

### Related
- M03-06 Public vs private subnet routing
- M03-08 Configuring strict security groups
- M03-10 Creating identity policies
- M03-13 Setting automated budget thresholds

### Self-quiz
1. SSM Session Manager ke saath bhi aapka instance private subnet mein hai -- SSM agent AWS se baat kaise karta hai? (Hint: M03-07.)
2. IMDSv1 pe ek SSRF bug kya-kya leak kar sakta hai, aur IMDSv2 ka token step isse kaise rokta hai?
3. Security team kehti hai "user data mein DB password daal do, simple hai". Aap likhit mein kya jawab doge?
4. `t3.small` pe OmniGuard din mein theek, raat ko batch job pe slow ho jaata hai. Kya suspect karoge?
