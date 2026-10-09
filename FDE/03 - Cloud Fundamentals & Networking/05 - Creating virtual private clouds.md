# Cloud Fundamentals & Networking

## Creating virtual private clouds

> Core | Fast CP4 / Slow CP6 | ~1.2 h | Builds on: M03-01

### Kahani
Ek bank customer ne OmniGuard ke liye naya AWS account diya aur bola: "Apna VPC bana lo, baad mein hum isse apne data center se VPN/Transit Gateway se jodenge."
FDE ne default wizard se `10.0.0.0/16` le liya. Do hafte baad network team ka email: "Hamara on-prem bhi `10.0.0.0/16` hai. Peering/VPN overlapping CIDR ke saath nahi chalega -- VPC dobara banao." Saare instances, DB, endpoints -- sab migrate.
CIDR ek baar chuna to badalna bahut mehnga hai. Isliye yeh 20 minute ka kaam pehle din ka sabse important design decision hai.

### What it is
**VPC (Virtual Private Cloud)** aapka private network hai AWS region ke andar: ek IP range (**CIDR block**, jaise `10.20.0.0/16`), jo **subnets** mein bata hota hai, aur har subnet ek **Availability Zone (AZ)** mein rehta hai.
VPC by default isolated hai -- internet, on-prem ya doosre VPC se connection aap explicitly banate ho (IGW, NAT, VPN, peering).

### Why it matters for an FDE
Customer ke network team ke paas IP plan (IPAM) hota hai. Overlapping ya bahut chhota CIDR baad mein connectivity tod deta hai aur poora re-deploy karwata hai.

### Key concepts
- **CIDR block** -- `/16` = 65,536 IPs, `/24` = 256; AWS VPC `/16` se `/28` tak allow karta hai.
- **Subnet = ek AZ** -- high availability ke liye har tier (public, app, db) ke kam se kam 2 subnets, 2 alag AZs mein.
- **5 reserved IPs** -- har subnet ke pehle 4 aur last 1 IP AWS ke (network, router, DNS, future, broadcast); `/24` mein 251 usable.
- **Non-overlap** -- VPC CIDR customer ke on-prem, doosre VPCs aur partner networks se overlap nahi karna chahiye; unke network team se range **maango**, khud mat chuno.
- **Room to grow** -- subnets ke beech gap chhodo (jaise app ko `10.20.10.0/24`, db ko `10.20.20.0/24`) taaki baad mein naye tiers/AZs aa sakein.

### Code example
stdlib only (`ipaddress`)

Yeh block AWS call nahi karta -- CIDR plan banata aur verify karta hai, wahi jo aap customer ke network team ko bhejoge.

```python
# runnable
import ipaddress as ip
from itertools import combinations

CUSTOMER_TAKEN = ["10.0.0.0/16", "10.10.0.0/16", "172.16.0.0/12"]   # from their IPAM / network team
CANDIDATES = ["10.0.0.0/16", "10.10.0.0/16", "10.20.0.0/16"]
AZS = ["eu-west-1a", "eu-west-1b"]
TIERS = {"public": 0, "app": 10, "db": 20}          # third-octet base per tier, leaves gaps

def pick_vpc_cidr(candidates, taken):
    taken_nets = [ip.ip_network(t) for t in taken]
    for c in candidates:
        net = ip.ip_network(c)
        if not any(net.overlaps(t) for t in taken_nets):
            return net
    raise RuntimeError("no free range -- ask the network team for an allocation")

def plan_subnets(vpc, tiers, azs):
    plan = {}
    all24 = list(vpc.subnets(new_prefix=24))
    for tier, base in tiers.items():
        for i, az in enumerate(azs):
            plan[f"{tier}-{az[-1]}"] = {"cidr": all24[base + i], "az": az, "tier": tier}
    return plan

def usable(net):
    return net.num_addresses - 5                     # AWS reserves 5 per subnet

vpc = pick_vpc_cidr(CANDIDATES, CUSTOMER_TAKEN)
assert str(vpc) == "10.20.0.0/16"
plan = plan_subnets(vpc, TIERS, AZS)

for (a, sa), (b, sb) in combinations(plan.items(), 2):
    assert not sa["cidr"].overlaps(sb["cidr"]), f"{a} overlaps {b}"
assert all(s["cidr"].subnet_of(vpc) for s in plan.values())
for tier in TIERS:                                   # every tier spans 2 AZs
    assert len({s["az"] for s in plan.values() if s["tier"] == tier}) == 2
assert usable(plan["app-a"]["cidr"]) == 251
assert ip.ip_address("10.20.11.40") in plan["app-b"]["cidr"]

print(f"VPC {vpc}  ({vpc.num_addresses} IPs)")
for name, s in plan.items():
    print(f"  {name:9} {str(s['cidr']):15} {s['az']}  usable={usable(s['cidr'])}")

try:
    pick_vpc_cidr(["10.0.0.0/16"], CUSTOMER_TAKEN)
    raise AssertionError("overlap should be refused")
except RuntimeError as e:
    print("refused:", e)
```

- `CUSTOMER_TAKEN` -- yeh list aap guess nahi karte; customer ke network team se email pe lete ho, aur design doc mein unka reply quote karte ho.
- `net.overlaps(t)` -- `172.16.0.0/12` jaise bade blocks bhi pakadta hai; manual octet comparison mein yeh galti hoti hai.
- `TIERS` base 0/10/20 -- `public-a = 10.20.0.0/24`, `app-a = 10.20.10.0/24`; beech ke /24 future AZ (c) ya naye tier ke liye khaali.
- `subnet_of(vpc)` -- typo se VPC ke bahar ka subnet AWS reject karega; hum pehle hi pakad lete hain.
- Kaunsa subnet "public" hai yeh CIDR se nahi, **route table** se tay hota hai -- next lesson (M03-06).

Asli create, CLI aur CloudFormation dono shape:

```bash
VPC_ID=$(aws ec2 create-vpc --cidr-block 10.20.0.0/16 \
  --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=omniguard}]' \
  --query Vpc.VpcId --output text)
aws ec2 modify-vpc-attribute --vpc-id "$VPC_ID" --enable-dns-hostnames
aws ec2 create-subnet --vpc-id "$VPC_ID" --cidr-block 10.20.10.0/24 \
  --availability-zone eu-west-1a \
  --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=app-a}]'
```

```yaml
Resources:
  OmniGuardVpc:
    Type: AWS::EC2::VPC
    Properties:
      CidrBlock: 10.20.0.0/16
      EnableDnsHostnames: true
      EnableDnsSupport: true
  AppSubnetA:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId:
        Ref: OmniGuardVpc
      CidrBlock: 10.20.10.0/24
      AvailabilityZone: eu-west-1a
```

### Mini-exercise (30-60 min)
`omniguard/infra/network/` mein:
1. `cidr_plan.py` -- `pick_vpc_cidr()` + `plan_subnets()`; input `taken.json` (customer ki list), output `subnet-plan.md` table.
2. `test_cidr_plan.py` -- overlap refuse, 3 AZs pe bhi plan valid, `/28` pe usable = 11.
3. Design doc "Network" section ka pehla part: VPC CIDR, kis se confirm kiya, subnet table, growth room.

Acceptance: `pytest -q` green; network team ko bhejne layak email draft (5-6 lines) jo range maangta hai aur kyun.

### Common pitfalls
- **Default VPC use karna** -- uske saare subnets public hain; customer workload ke liye kabhi nahi.
- **Ek hi AZ** -- AZ outage pe sab down; RDS Multi-AZ aur ALB ko 2 AZ ke subnets chahiye hi.
- **Bahut chhota VPC (`/24`)** -- EKS/Lambda-in-VPC har pod/ENI pe IP khaate hain; IPs jaldi khatam ho jaate hain.

### Checklist before moving on
- [ ] `/16`, `/24`, `/28` mein kitne IPs aur kitne usable, bina calculator ke.
- [ ] Customer ki taken ranges ke against overlap check automated hai.
- [ ] Har tier 2 AZs mein hai.
- [ ] Network team se range confirm karne ka email draft ready hai.

### Related
- M03-06 Public vs private subnet routing
- M03-07 Outbound traffic via NAT
- M03-08 Configuring strict security groups
- M03-11 Assuming cross-account roles

### Self-quiz
1. Customer bole "hamare paas `10.0.0.0/8` poora on-prem mein hai" -- aap VPC ke liye kya karoge?
2. Subnet `10.20.10.0/24` mein pehla usable IP kaunsa hai, aur `.1`-`.3` kiske hain?
3. CIDR se subnet public/private kyun nahi banta? Kya banata hai?
4. Do alag teams ke VPCs dono `10.20.0.0/16` -- peering ke alawa kaunsa option bachta hai aur uski cost kya hai?
