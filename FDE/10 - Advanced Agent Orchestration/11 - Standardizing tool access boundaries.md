# Advanced Agent Orchestration

## Standardizing tool access boundaries

> Core | Fast CP7 / Slow CP9 | ~1.2 h | Builds on: M10-09, M10-10, M12-06

### Kahani
Ek bank mein ab 6 teams agents bana rahi hain aur 40 MCP tools hain. Har team ne apna "safe tool" pattern likha: kisi ne scopes `read/write` rakhe, kisi ne `viewer/editor`, kisi ne kuch nahi. Ek tool ka naam `update_customer` tha jo asal mein account *close* karta tha.
Security review mein CISO ka sawaal: "Mujhe ek table do -- kaunsa agent kaunsa tool chala sakta hai, kis tenant ke data pe, aur kaunse tools destructive hain." Kisi ke paas jawab nahi tha; har team ke code mein alag logic tha.
M10-09 mein humne ek agent ke liye safe executor banaya. Yahan problem scale ki hai: ek **standard** chahiye jo sab teams follow karein aur jo machine check kare.

### What it is
**Tool access boundary standard** = har tool ka ek declarative **manifest** (naam convention, version, scope, risk level, annotations, data classification, approval rule) + har agent ke liye short-lived **capability token** (allowed scopes, tenant, expiry) + ek central **deny-by-default policy check** jo har call pe chalta hai. Boundary ab har team ke code mein nahi, ek reviewable config + ek shared library mein hai.

### Why it matters for an FDE
Enterprise mein pehla agent hamesha pass ho jaata hai; dasvaan agent tab pass hota hai jab boundaries standard aur auditable hon. FDE aksar yahi standard customer ke platform team ke saath likhta hai.

### Key concepts
- **Manifest per tool** -- `namespace.verb_noun` naam, `scope`, `risk: read|write|destructive`, `data_class`, `requires_approval`; CI lint isse enforce kare.
- **MCP tool annotations** -- `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` hints hain, guarantees nahi; inhe manifest se generate karo, policy inpe blindly trust na kare.
- **Capability token** -- agent ko JWT jisme `scopes`, `tenant`, `exp` (minutes); token leak ho to bhi limited aur jaldi expire.
- **Deny by default** -- token scope + manifest + context (tenant match, approval) sab pass hon tabhi allow; teen outcomes: allow, deny, needs_approval.
- **Boundary matrix test** -- agents x tools expected-outcome table; koi bhi change jo matrix badle, PR mein dikhe.

### Code example
`pip install pyjwt pyyaml`

```python
# runnable
import re
import time
import jwt
import yaml

MANIFEST = yaml.safe_load("""
tools:
  - {name: jira.get_issue,    version: 1, scope: jira:read,  risk: read,        data_class: internal, requires_approval: false}
  - {name: jira.create_issue, version: 1, scope: jira:write, risk: write,       data_class: internal, requires_approval: false}
  - {name: jira.close_issue,  version: 1, scope: jira:write, risk: destructive, data_class: internal, requires_approval: true}
  - {name: kb.search_docs,    version: 2, scope: kb:read,    risk: read,        data_class: confidential, requires_approval: false}
""")["tools"]

def lint(tools):
    problems = []
    for t in tools:
        if not re.fullmatch(r"[a-z]+\.[a-z]+_[a-z_]+", t["name"]):
            problems.append(f"{t['name']}: name must be namespace.verb_noun")
        if t["risk"] == "destructive" and not t["requires_approval"]:
            problems.append(f"{t['name']}: destructive tools require approval")
        if t["scope"].split(":")[1] == "read" and t["risk"] != "read":
            problems.append(f"{t['name']}: read scope cannot do {t['risk']}")
    return problems

def mcp_annotations(t):   # generate MCP hints FROM the manifest, never hand-written per team
    return {"readOnlyHint": t["risk"] == "read", "destructiveHint": t["risk"] == "destructive"}

SIGNING_KEY = "test-only-signing-key-at-least-32-bytes!"         # prod: KMS / vault, rotated
def issue_token(agent, scopes, tenant, ttl_s=900):
    now = int(time.time())
    return jwt.encode({"sub": agent, "scopes": scopes, "tenant": tenant, "iat": now, "exp": now + ttl_s},
                      SIGNING_KEY, algorithm="HS256")

TOOLS = {t["name"]: t for t in MANIFEST}
def decide(token, tool_name, resource_tenant, approved=False):
    try:
        claims = jwt.decode(token, SIGNING_KEY, algorithms=["HS256"])
    except jwt.InvalidTokenError as e:
        return "deny", f"bad token: {type(e).__name__}"
    tool = TOOLS.get(tool_name)
    if tool is None:
        return "deny", "tool not in manifest"
    if tool["scope"] not in claims["scopes"]:
        return "deny", f"missing scope {tool['scope']}"
    if claims["tenant"] != resource_tenant:
        return "deny", "cross-tenant access"
    if tool["requires_approval"] and not approved:
        return "needs_approval", "human approval required (M10-04)"
    return "allow", "ok"

assert lint(MANIFEST) == []
assert lint([{"name": "updateCustomer", "scope": "crm:read", "risk": "destructive", "requires_approval": False}]) == [
    "updateCustomer: name must be namespace.verb_noun", "updateCustomer: destructive tools require approval",
    "updateCustomer: read scope cannot do destructive"]
assert mcp_annotations(TOOLS["jira.close_issue"]) == {"readOnlyHint": False, "destructiveHint": True}

agents = {"evidence": issue_token("evidence", ["jira:read", "kb:read"], "acme"),
          "ticketing": issue_token("ticketing", ["jira:read", "jira:write"], "acme")}
EXPECTED = {  # boundary matrix: (agent, tool) -> outcome, reviewed in every PR
    ("evidence", "jira.get_issue"): "allow", ("evidence", "jira.create_issue"): "deny",
    ("evidence", "kb.search_docs"): "allow", ("ticketing", "kb.search_docs"): "deny",
    ("ticketing", "jira.create_issue"): "allow", ("ticketing", "jira.close_issue"): "needs_approval",
    ("ticketing", "jira.delete_project"): "deny"}
for (agent, tool), want in EXPECTED.items():
    got = decide(agents[agent], tool, "acme")
    assert got[0] == want, (agent, tool, got)
assert decide(agents["evidence"], "kb.search_docs", "globex") == ("deny", "cross-tenant access")
assert decide(agents["ticketing"], "jira.close_issue", "acme", approved=True)[0] == "allow"
expired = issue_token("evidence", ["jira:read"], "acme", ttl_s=-10)
assert decide(expired, "jira.get_issue", "acme") == ("deny", "bad token: ExpiredSignatureError")
print("OK: manifest lint, generated annotations, scoped tokens, deny-by-default matrix")
```

- `lint()` standard ko code banata hai -- `updateCustomer` jaisa misleading naam ya bina approval ka destructive tool CI mein hi fail.
- `mcp_annotations()` manifest se generate -- MCP server (M10-10) ye hints `tools/list` mein bhejega; hints client ke UX ke liye hain, enforcement `decide()` mein hai.
- `issue_token()` -- agent ka token 15 minute ka, sirf uske scopes aur tenant; signing key test-only hai, prod mein KMS se.
- `decide()` har check fail-closed: unknown tool, missing scope, tenant mismatch, expired token -- sab deny; destructive -> `needs_approval`.
- `EXPECTED` matrix -- CISO wala table yahi hai, aur test bhi yahi hai. Naya tool ya scope change = matrix diff PR mein.

### Mini-exercise (30-60 min)
CP7 AuditMesh: `auditmesh/policy/` -- `tools.yaml` manifest, `lint.py`, `tokens.py`, `decide.py`.
- Supervisor har sub-agent ko spawn karte waqt `issue_token()` se scoped token de; M10-09 ka executor har call pe `decide()` chalaye.
- `mcp_jira/server.py` (M10-10) tool annotations manifest se generate kare.
- Acceptance: `tests/test_boundaries.py` mein poora agents x tools matrix; `python lint.py tools.yaml` CI step; cross-tenant aur expired token deny; `jira.close_issue` bina approval `needs_approval`.

### Common pitfalls
- MCP annotations ya tool description ko security control maan lena -- ye untrusted server se aa sakte hain; enforcement apne policy layer mein.
- Long-lived, broad agent tokens ("*" scope, 1 saal expiry) -- ek leak = poora system; short TTL + narrow scopes.
- Policy logic har team ke code mein copy-paste -- drift guaranteed; ek shared library/service, ek manifest repo.

### Checklist before moving on
- [ ] Har tool ka manifest hai aur lint CI mein chalta hai.
- [ ] Agent tokens scoped, tenant-bound aur short-lived hain.
- [ ] Policy deny-by-default hai, teen outcomes ke saath.
- [ ] Boundary matrix test PR mein review hota hai.

### Related
- M10-09 Connecting agents to external tools safely
- M10-10 Host/Client/Server architectures
- M12-02 Understanding JWT tokens
- M12-06 Implementing Role-Based Access Control
- M12-10 Audit logging

### Self-quiz
1. Tool annotations `readOnlyHint: true` keh raha hai par tool actually delete karta hai. Tumhare design mein ye kahan pakda jaayega?
2. Agent token mein scopes hain, end-user ke permissions alag hain. Dono ka intersection kyon lena chahiye? Example do.
3. Matrix mein naya agent add karna -- review process kya hona chahiye aur kaun approve kare?
4. Token TTL 15 minute hai, par ek audit run 2 ghante chalta hai. Kya karoge?
