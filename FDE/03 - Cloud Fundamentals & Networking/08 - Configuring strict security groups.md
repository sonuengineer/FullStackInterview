# Cloud Fundamentals & Networking

## Configuring strict security groups

> Core | Fast CP4 / Slow CP6 | ~1.2 h | Builds on: M03-05, M03-06

### Kahani
Fintech customer ka security team har hafte AWS Config/Security Hub report chalata hai. OmniGuard deploy ke agle din report mein 3 HIGH findings: `sg-omniguard` pe `0.0.0.0/0 -> 22`, `0.0.0.0/0 -> 5432`, aur ek "all traffic" rule jo kisi ne "debug ke liye" daala tha.
DB private subnet mein tha to sach mein exposed nahi tha -- par report mein yeh fark nahi dikhta. Customer ne poochha: "Aapki team ko network samajh aata hai ya nahi?"
Security groups wahi jagah hai jahan FDE ki seriousness ek nazar mein dikh jaati hai.

### What it is
**Security group (SG)** ek virtual firewall hai jo ENI (instance, RDS, Lambda-in-VPC, ALB) pe lagta hai. Sirf **allow** rules hote hain, aur yeh **stateful** hai: andar aayi request ka response apne-aap bahar jaata hai.
Source ek CIDR ho sakta hai ya **doosra SG** -- "jo bhi `sg-app` mein hai, woh 5432 pe aa sakta hai". Yahi strict design ki chaabi hai.

### Why it matters for an FDE
Customer ki compliance tooling `0.0.0.0/0` rules turant flag karti hai. Tight SGs = security review fast pass; loose SGs = hafton ka back-and-forth aur trust loss.

### Key concepts
- **Stateful allow-only** -- inbound rule allow kiya to response traffic automatic; deny rule SG mein hota hi nahi (default = deny).
- **SG-to-SG references** -- `sg-db` inbound 5432 source `sg-app`; IPs badlein, autoscale ho, rule sahi rehta hai.
- **Chain** -- internet -> `sg-alb` (443) -> `sg-app` (8080 from `sg-alb`) -> `sg-db` (5432 from `sg-app`); har hop sirf pichhle hop se.
- **Outbound bhi tight** -- default SG outbound "all" allow karta hai; strict customers outbound ko bhi limit karwaate hain (443 to NAT/endpoints, 5432 to `sg-db`).
- **NACL contrast** -- Network ACL subnet level pe, **stateless**, numbered allow+deny rules; response ke liye ephemeral ports (1024-65535) alag se allow karne padte hain.

### Code example
stdlib only (`ipaddress`)

Block SG chain evaluate karta hai (stateful, SG references) aur lint karta hai; end mein stateless NACL ka contrast.

```python
# runnable
import ipaddress as ip

SGS = {
    "sg-alb": {"in": [{"port": 443, "src": "0.0.0.0/0"}], "out": [{"port": 8080, "dst": "sg-app"}]},
    "sg-app": {"in": [{"port": 8080, "src": "sg-alb"}],
               "out": [{"port": 5432, "dst": "sg-db"}, {"port": 443, "dst": "0.0.0.0/0"}]},
    "sg-db":  {"in": [{"port": 5432, "src": "sg-app"}], "out": []},
}
MEMBERS = {"alb-1": ("10.20.0.10", ["sg-alb"]), "app-1": ("10.20.10.5", ["sg-app"]),
           "db-1": ("10.20.20.7", ["sg-db"])}
SENSITIVE = {22, 3389, 5432, 3306, 6379}

def _match(ref, ip_addr, sgs):
    if ref.startswith("sg-"):
        return ref in sgs
    return ip.ip_address(ip_addr) in ip.ip_network(ref)

def allowed(src, dst_name, port):
    """src: instance name or a raw IP from the internet. Stateful: replies are not checked."""
    s_ip, s_sgs = MEMBERS.get(src, (src, []))
    d_ip, d_sgs = MEMBERS[dst_name]
    out_ok = not s_sgs or any(r["port"] == port and _match(r["dst"], d_ip, d_sgs)
                              for sg in s_sgs for r in SGS[sg]["out"])
    in_ok = any(r["port"] == port and _match(r["src"], s_ip, s_sgs)
                for sg in d_sgs for r in SGS[sg]["in"])
    return out_ok and in_ok

def lint(sgs):
    bad = []
    for name, sg in sgs.items():
        for r in sg["in"]:
            open_world = r["src"] in ("0.0.0.0/0", "::/0")
            if open_world and (r["port"] in SENSITIVE or r["port"] == "all"):
                bad.append(f"{name}: {r['port']} open to the world")
    return bad

INTERNET = "198.51.100.23"
assert allowed(INTERNET, "alb-1", 443)
assert not allowed(INTERNET, "app-1", 8080)        # must come through the ALB
assert allowed("alb-1", "app-1", 8080)
assert allowed("app-1", "db-1", 5432)
assert not allowed("alb-1", "db-1", 5432)          # ALB cannot skip a hop
assert not allowed(INTERNET, "db-1", 5432)
assert lint(SGS) == []

sloppy = {**SGS, "sg-db": {"in": [{"port": 5432, "src": "0.0.0.0/0"}, {"port": 22, "src": "0.0.0.0/0"}],
                           "out": []}}
assert len(lint(sloppy)) == 2

# NACL contrast: stateless, so the reply direction needs its own rule.
def nacl_roundtrip(inbound_ports, outbound_ports, service_port, client_ephemeral=51544):
    return service_port in inbound_ports and client_ephemeral in outbound_ports

assert not nacl_roundtrip({5432}, {5432}, 5432)                    # reply to :51544 dropped
assert nacl_roundtrip({5432}, set(range(1024, 65536)), 5432)
print("SG chain OK, lint clean; sloppy findings:", lint(sloppy))
```

- `_match(ref, ...)` -- source `sg-...` ho to IP nahi, **membership** check hoti hai; yahi SG references ki taakat hai.
- `allowed()` sirf request direction check karta hai -- response ka check nahi, kyunki SG stateful hai.
- `not allowed("alb-1", "db-1", 5432)` -- har tier sirf agle tier tak; ALB compromise hua to bhi DB tak seedha raasta nahi.
- `lint()` -- wahi check jo customer ka Security Hub karega; CI mein chalao, report se pehle.
- `nacl_roundtrip` -- NACL pe response port (ephemeral) bhi allow karna padta hai; isliye zyada teams NACL default rakhti hain aur SG strict karti hain.

Asli rules:

```bash
aws ec2 authorize-security-group-ingress --group-id "$SG_APP" \
  --ip-permissions "IpProtocol=tcp,FromPort=8080,ToPort=8080,UserIdGroupPairs=[{GroupId=$SG_ALB}]"
aws ec2 authorize-security-group-ingress --group-id "$SG_DB" \
  --ip-permissions "IpProtocol=tcp,FromPort=5432,ToPort=5432,UserIdGroupPairs=[{GroupId=$SG_APP}]"
aws ec2 revoke-security-group-egress --group-id "$SG_DB" \
  --ip-permissions 'IpProtocol=-1,IpRanges=[{CidrIp=0.0.0.0/0}]'
aws ec2 describe-security-groups --group-ids "$SG_DB" --query 'SecurityGroups[].IpPermissions'
```

### Mini-exercise (30-60 min)
`omniguard/infra/network/` mein:
1. `sg_rules.json` -- OmniGuard ke 3 SGs (alb, app, db) + outbound rules.
2. `sg_check.py` -- `allowed()` + `lint()`; `sg_rules.json` padhe, findings pe non-zero exit (CI gate).
3. `test_sg_check.py` -- happy path chain, hop-skip blocked, world-open 22/5432 flagged, "all ports" flagged.
4. Design doc "Firewall" section: SG chain diagram (text), har rule ka "why" ek line mein.

Acceptance: `pytest -q` green; `python sg_check.py sloppy.json` exit code 1 aur findings print kare.

### Common pitfalls
- **"Temporarily" 0.0.0.0/0** -- temporary rules kabhi hatte nahi. SSM port forwarding se debug karo (M03-01).
- **CIDR source jab SG reference ho sakta tha** -- `10.20.0.0/16` se 5432 allow = VPC ka har resource DB tak; `sg-app` use karo.
- **Ek SG sab pe** -- app aur DB same SG mein = tiers ka koi isolation nahi. Har tier ka apna SG.

### Checklist before moving on
- [ ] Stateful vs stateless ek example (ephemeral port) se samjha sakte ho.
- [ ] SG chain ALB -> app -> DB SG references se bani hai, koi CIDR nahi.
- [ ] Koi sensitive port 0.0.0.0/0 ya ::/0 pe open nahi.
- [ ] Lint CI mein chalta hai.

### Related
- M03-06 Public vs private subnet routing
- M03-03 Managed relational databases setup
- M03-01 Provisioning virtual machines
- M03-09 Principle of least privilege

### Self-quiz
1. DB private subnet mein hai par SG `0.0.0.0/0 -> 5432`. Kya yeh exposed hai? Customer ke report mein phir bhi kyun flag hona theek hai?
2. NACL pe inbound 443 allow kiya, outbound sirf 443. Clients ko timeout kyun aa raha hai?
3. Customer chahta hai ki OmniGuard sirf ek LLM domain pe bahar jaaye. SG kyun kaafi nahi hai, aur kya use karoge?
4. Ek SG mein deny rule kyun nahi daal sakte? Specific IP block karna ho to kahan karoge?
