# Cloud Fundamentals & Networking

## Outbound traffic via NAT

> Core | Fast CP4 / Slow CP6 | ~1.2 h | Builds on: M03-05, M03-06

### Kahani
OmniGuard app private subnet mein tha -- security team khush. Par app start hote hi crash: LLM provider ka API timeout, `pip install` timeout, container image pull timeout. Private subnet se bahar jaane ka koi raasta hi nahi tha.
FDE ne NAT gateway lagaya, sab chal gaya. Mahine ke end pe customer ka FinOps: "NAT gateway ka bill EC2 se zyada kyun hai?" Pata chala ki app roz S3 se GBs ke PDFs NAT ke through padh raha tha, aur dev, staging, prod -- teeno VPCs mein 2-2 NAT gateways 24x7 on the.
NAT zaroori hai, par yeh network ka sabse mehenga "chhota" component bhi hai.

### What it is
**NAT gateway** public subnet mein baitha managed service hai (Elastic IP ke saath) jo private subnets ko **outbound-only** internet access deta hai: private instance request bhej sakta hai, internet se koi naya connection andar nahi aa sakta.
Private route table ka `0.0.0.0/0 -> nat-...` route traffic ko NAT tak bhejta hai; NAT apne public IP se bahar jaata hai.

### Why it matters for an FDE
AI app ko bahar jaana hi padta hai (LLM API, package registry, webhooks). Customer ke security team ko batana padta hai ki **kaun sa traffic, kahan, kis IP se** jaata hai -- aur finance ko kitne ka.

### Key concepts
- **Outbound only** -- NAT inbound connections allow nahi karta; inbound ke liye ALB public subnet mein hota hai.
- **Charges** -- NAT gateway per hour **aur** per GB processed charge hota hai (plus normal data transfer); exact rate region pe depend -- hamesha pricing page check karo.
- **Per-AZ NAT** -- har AZ mein ek NAT = AZ failure pe bhi doosra AZ chalta hai, aur cross-AZ data charge nahi; single NAT sasta par single point of failure.
- **VPC endpoints** -- S3/DynamoDB gateway endpoints (free) aur interface endpoints (Secrets Manager, ECR, Bedrock; hourly + per-GB) se AWS services ka traffic NAT bypass karta hai.
- **Fixed egress IP** -- NAT ka Elastic IP stable hai; customer ke partners/LLM provider pe IP allowlist ke liye yahi IP doge.

### Code example
stdlib only

Prices hardcode **nahi** kiye -- `PRICES` placeholder units hain. Real numbers apne region ke pricing page se bharo. Block design compare karta hai aur AZ failure simulate karta hai.

```python
# runnable
HOURS = 730                                  # ~hours per month
PRICES = {"nat_hour": 1.0, "nat_gb": 1.0}   # PLACEHOLDER units -- fill from the AWS pricing page

def monthly_nat_cost(n_nat, gb_through_nat, prices=PRICES):
    return n_nat * HOURS * prices["nat_hour"] + gb_through_nat * prices["nat_gb"]

def egress_target(design, src_az, dst, nat_up):
    """Where does a private-subnet packet go? design: 'per-az' | 'single' (NAT in AZ a)."""
    if dst == "s3" and design.get("s3_endpoint"):
        return "vpce-s3"
    nat_az = src_az if design["nat"] == "per-az" else "a"
    if not nat_up.get(nat_az, False):
        return "DROPPED"
    return f"nat-{nat_az}" + ("" if nat_az == src_az else " (cross-AZ)")

single = {"nat": "single", "s3_endpoint": False}
per_az = {"nat": "per-az", "s3_endpoint": True}
healthy = {"a": True, "b": True}
az_a_down = {"a": False, "b": True}

assert egress_target(single, "b", "llm-api", healthy) == "nat-a (cross-AZ)"
assert egress_target(per_az, "b", "llm-api", healthy) == "nat-b"
assert egress_target(single, "b", "llm-api", az_a_down) == "DROPPED"    # SPOF
assert egress_target(per_az, "b", "llm-api", az_a_down) == "nat-b"       # survives
assert egress_target(per_az, "a", "s3", az_a_down) == "vpce-s3"          # S3 never needs NAT

traffic_gb = {"llm-api": 40, "s3": 900, "pypi+ecr": 60}
nat_gb_single = sum(traffic_gb.values())                                  # all via NAT
nat_gb_per_az = sum(v for k, v in traffic_gb.items() if k != "s3")        # S3 via endpoint

c_single = monthly_nat_cost(1, nat_gb_single)
c_per_az = monthly_nat_cost(2, nat_gb_per_az)
print(f"single NAT, no endpoint : {c_single:8.0f} units")
print(f"2 NATs + S3 endpoint    : {c_per_az:8.0f} units")
assert c_per_az < c_single, "with these volumes, the S3 endpoint pays for the second NAT"

dev_envs = 3
idle = monthly_nat_cost(2 * dev_envs, 0)
print(f"3 envs x 2 idle NATs     : {idle:8.0f} units (hourly charge even with zero traffic)")
assert idle == 6 * HOURS * PRICES["nat_hour"]
print("WARNING: replace PRICES with real numbers from the pricing page before quoting the customer")
```

- `PRICES` placeholder -- course mein real price likhna galat hoga (region aur time ke saath badalta hai). Customer ko quote se pehle pricing page / Pricing Calculator.
- `egress_target(single, "b", ...)` -- AZ b ka traffic AZ a ke NAT pe jaata hai: cross-AZ charge + AZ a down hua to `DROPPED`.
- `vpce-s3` -- 900 GB S3 traffic NAT se hata diya; yahi Kahani ka bill-killer tha.
- `idle` -- NAT ka hourly charge zero traffic pe bhi lagta hai; dev/staging mein single NAT ya raat ko band karna common compromise hai.
- Trade-off likho: prod = per-AZ NAT (availability), dev = single NAT (cost). Yeh decision design doc mein customer sign-off ke saath.

Asli setup:

```bash
EIP=$(aws ec2 allocate-address --domain vpc --query AllocationId --output text)
NAT_A=$(aws ec2 create-nat-gateway --subnet-id "$PUBLIC_A" --allocation-id "$EIP" \
  --query NatGateway.NatGatewayId --output text)
aws ec2 wait nat-gateway-available --nat-gateway-ids "$NAT_A"
aws ec2 create-route --route-table-id "$RT_PRIV_A" \
  --destination-cidr-block 0.0.0.0/0 --nat-gateway-id "$NAT_A"
aws ec2 describe-nat-gateways --nat-gateway-ids "$NAT_A" \
  --query 'NatGateways[].NatGatewayAddresses[].PublicIp'
```

### Mini-exercise (30-60 min)
`omniguard/infra/network/` mein:
1. `egress.py` -- `egress_target()` + `monthly_nat_cost()`; prices `prices.json` se aayen jismein ek `source_url` aur `checked_on` date field ho.
2. `test_egress.py` -- AZ failure, S3 endpoint, cross-AZ cases.
3. Design doc "Egress" section: kaunse external domains (LLM API, registries) chahiye, kis NAT IP se jaayenge, dev vs prod NAT design, monthly estimate with source.

Acceptance: `pytest -q` green; egress section mein ek table "destination | why | port | via" jo customer ka firewall team directly allowlist mein daal sake.

### Common pitfalls
- **NAT ko private subnet mein banana** -- NAT khud public subnet mein hona chahiye (IGW route ke saath); warna uska bhi bahar raasta nahi.
- **S3/ECR traffic NAT se** -- endpoints ke bina image pulls aur S3 reads per-GB NAT charge khaate hain.
- **Egress unrestricted chhodna** -- compromised container kahin bhi data bhej sakta hai; regulated customers proxy ya AWS Network Firewall se domain allowlist maangte hain -- pehle se puchho.

### Checklist before moving on
- [ ] NAT outbound-only kyun hai, aur inbound ke liye kya use hota hai, bata sakte ho.
- [ ] Per-AZ vs single NAT ka availability/cost trade-off likh sakte ho.
- [ ] S3 gateway endpoint lagaya hai.
- [ ] Egress destinations ki list customer ke security team ke paas hai.

### Related
- M03-06 Public vs private subnet routing
- M03-13 Setting automated budget thresholds
- M03-12 Navigating the AWS Billing console
- M03-04 Event-driven serverless function basics

### Self-quiz
1. AZ a ka NAT gateway down hai, single-NAT design. AZ b ke app ka kya hoga, aur ALB health checks pe kya dikhega?
2. Lambda ko VPC mein daala; ab woh Secrets Manager call pe timeout karta hai. Do alag fixes batao aur unki cost.
3. LLM provider aapse "static egress IP" maang raha hai. Kya doge, aur per-AZ NAT mein kitne IPs?
4. Billing mein `NatGateway-Bytes` sabse bada line item hai. Investigate kaise karoge? (Hint: VPC Flow Logs.)
