# Cloud Fundamentals & Networking

## Public vs private subnet routing

> Core | Fast CP4 / Slow CP6 | ~1.2 h | Builds on: M03-05

### Kahani
Hospital customer ke account mein OmniGuard deploy hua. Load balancer chal raha tha par health check fail. FDE ne app EC2 ko "public subnet" naam wale subnet mein daal diya tha -- par uske route table mein internet gateway ka route tha hi nahi. Naam public, behaviour private.
Ulta case bhi hua: DB subnet galti se IGW wale route table se associate tha. Security group ne bachaya, par audit report mein "database subnet has internet route" red flag ban gaya.
Subnet ka naam kuch nahi batata. **Route table** sach batata hai.

### What it is
Har subnet ek **route table** se juda hota hai: "destination CIDR -> target" rules ki list. **Public subnet** = jiske route table mein `0.0.0.0/0 -> igw-...` hai. **Private subnet** = jiska default route IGW pe nahi (NAT pe, ya bilkul nahi).
AWS route chunte waqt **longest prefix match** use karta hai: sabse specific matching route jeetta hai, aur `local` route (VPC CIDR) hamesha hota hai.

### Why it matters for an FDE
Customer ka security review pehla sawal yahi puchhta hai: "Kaunse resources internet se reachable hain?" Aapko route tables dikha ke, ek line mein, sahi jawab dena aana chahiye.

### Key concepts
- **Internet Gateway (IGW)** -- VPC ko internet se jodta hai; instance tabhi reachable jab subnet route IGW pe ho **aur** instance ke paas public IP ho.
- **Local route** -- VPC CIDR -> `local`, delete nahi hota; VPC ke andar sab subnets ek doosre ko route kar sakte hain (rokna SG/NACL ka kaam).
- **Longest prefix match** -- `10.20.0.0/16` aur `0.0.0.0/0` dono `10.20.10.5` match karte hain; `/16` zyada specific hai, woh jeetta hai.
- **Typical 3-tier layout** -- public subnets mein sirf ALB + NAT gateway; app aur DB private subnets mein.
- **Gateway endpoints** -- S3/DynamoDB ke liye route table entry (prefix list -> `vpce-...`), taaki private subnet ka S3 traffic NAT/internet se na jaaye.

### Code example
stdlib only (`ipaddress`)

Block AWS ka route lookup simulate karta hai aur asserts se prove karta hai ki har packet kahan jaata hai.

```python
# runnable
import ipaddress as ip

VPC = "10.20.0.0/16"
S3_PL = "203.0.113.0/24"   # stand-in for the S3 managed prefix list (pl-...) -- real list has many CIDRs

ROUTE_TABLES = {
    "rt-public":  [(VPC, "local"), ("0.0.0.0/0", "igw-og")],
    "rt-private-a": [(VPC, "local"), ("10.0.0.0/16", "tgw-onprem"),
                     (S3_PL, "vpce-s3"), ("0.0.0.0/0", "nat-a")],
    "rt-db":      [(VPC, "local")],                     # no default route at all
}
SUBNET_RT = {"public-a": "rt-public", "app-a": "rt-private-a", "db-a": "rt-db"}

def resolve(subnet: str, dst: str) -> str:
    """Longest-prefix match, like the VPC router. Returns target or 'blackhole'."""
    addr = ip.ip_address(dst)
    matches = [(ip.ip_network(c), t) for c, t in ROUTE_TABLES[SUBNET_RT[subnet]]
               if addr in ip.ip_network(c)]
    if not matches:
        return "blackhole"
    return max(matches, key=lambda m: m[0].prefixlen)[1]

def reachable_from_internet(subnet: str, has_public_ip: bool) -> bool:
    has_igw_default = resolve(subnet, "8.8.8.8").startswith("igw-")
    return has_igw_default and has_public_ip

LLM_API = "198.51.100.7"     # pretend public IP of an LLM provider endpoint

# public subnet: ALB lives here
assert resolve("public-a", LLM_API) == "igw-og"
assert resolve("public-a", "10.20.10.5") == "local"
# app subnet: outbound via NAT, S3 via endpoint, on-prem via TGW, VPC local wins over default
assert resolve("app-a", LLM_API) == "nat-a"
assert resolve("app-a", "203.0.113.50") == "vpce-s3"
assert resolve("app-a", "10.0.4.20") == "tgw-onprem"
assert resolve("app-a", "10.20.20.8") == "local"
# db subnet: nothing leaves the VPC
assert resolve("db-a", LLM_API) == "blackhole"
assert resolve("db-a", "10.20.10.5") == "local"

assert reachable_from_internet("public-a", has_public_ip=True)
assert not reachable_from_internet("public-a", has_public_ip=False)
assert not reachable_from_internet("app-a", has_public_ip=True)   # public IP alone is useless

for sn in SUBNET_RT:
    print(f"{sn:9} -> LLM API via {resolve(sn, LLM_API):10} | internet-reachable "
          f"(with public IP): {reachable_from_internet(sn, True)}")
```

- `max(..., key=prefixlen)` -- yahi longest prefix match hai; `10.20.20.8` ke liye `/16 local` `/0 nat` ko harata hai.
- `rt-db` mein default route hi nahi -- DB ko internet ki zarurat nahi, to route bhi nahi. Defense in depth: SG ke saath route bhi band.
- `vpce-s3` -- gateway endpoint free hai aur S3 traffic ko NAT ke per-GB charge se bachata hai (M03-07).
- `reachable_from_internet` -- do conditions: IGW route **aur** public IP. Private subnet mein public IP lagana kuch nahi karta (return path IGW pe nahi).
- `198.51.100.x` / `203.0.113.x` -- documentation IP ranges, real services nahi.

Asli wiring:

```bash
IGW=$(aws ec2 create-internet-gateway --query InternetGateway.InternetGatewayId --output text)
aws ec2 attach-internet-gateway --internet-gateway-id "$IGW" --vpc-id "$VPC_ID"
RT_PUB=$(aws ec2 create-route-table --vpc-id "$VPC_ID" --query RouteTable.RouteTableId --output text)
aws ec2 create-route --route-table-id "$RT_PUB" --destination-cidr-block 0.0.0.0/0 --gateway-id "$IGW"
aws ec2 associate-route-table --route-table-id "$RT_PUB" --subnet-id "$PUBLIC_A"
aws ec2 create-vpc-endpoint --vpc-id "$VPC_ID" --service-name com.amazonaws.eu-west-1.s3 \
  --route-table-ids "$RT_PRIV_A"
aws ec2 describe-route-tables --filters "Name=vpc-id,Values=$VPC_ID" \
  --query 'RouteTables[].{id:RouteTableId,routes:Routes[].[DestinationCidrBlock,GatewayId,NatGatewayId]}'
```

### Mini-exercise (30-60 min)
`omniguard/infra/network/` mein:
1. `routes.py` -- `resolve()` + `reachable_from_internet()`; route tables `routes.json` se load hon.
2. `test_routes.py` -- har subnet ke liye 4 destinations (LLM API, S3, on-prem, VPC) ka expected target.
3. Design doc "Network" section mein table: subnet | route table | default route | internet-reachable? | kya chalta hai (ALB/app/DB).
4. Bonus: `aws ec2 describe-route-tables` ka JSON output (sandbox se) `routes.json` mein convert karne wala chhota parser.

Acceptance: `pytest -q` green; table se security reviewer ko 30 second mein dikh jaaye ki DB internet se nahi judta.

### Common pitfalls
- **Main route table pe IGW route** -- naye subnets automatically main RT pe jaate hain, to har naya subnet public ban jaata hai. Main RT private rakho.
- **Naam pe bharosa** -- "private-subnet" naam ka subnet IGW route ke saath public hi hai; hamesha route table check karo.
- **ALB private subnets mein** -- internet-facing ALB ko public subnets chahiye, warna health check / traffic nahi aayega.

### Checklist before moving on
- [ ] Public subnet ki definition route table se bata sakte ho, naam se nahi.
- [ ] Longest prefix match ek example se samjha sakte ho.
- [ ] DB subnets pe koi default route nahi.
- [ ] S3 gateway endpoint private route tables pe hai.

### Related
- M03-05 Creating virtual private clouds
- M03-07 Outbound traffic via NAT
- M03-08 Configuring strict security groups
- M03-03 Managed relational databases setup

### Self-quiz
1. Instance private subnet mein hai aur uspe Elastic IP laga diya. Internet se reach hoga? Packet ka return path trace karo.
2. Route table mein `10.20.0.0/16 local`, `10.20.10.0/24 -> eni-firewall`, `0.0.0.0/0 -> nat`. `10.20.10.9` ka traffic kahan jaayega?
3. Security team kehti hai "DB subnet ka koi outbound route nahi chahiye" -- patching kaise hoga RDS pe? (Hint: managed service.)
4. Aapka app S3 se 5 TB/mahina padhta hai. Gateway endpoint na ho to kya kharcha badhega?
