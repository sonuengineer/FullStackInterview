# Identity & Access Management

## Authentication vs authorization

> Core | Fast CP5 / Slow CP7 | ~1.2 h | Builds on: M02-03, M02-05

### Kahani
Ek insurance company ke liye aapne claims assistant banaya. Login Azure AD se, sab theek. Pilot ke doosre hafte ek agent ne URL mein `/claims/1042` ko `/claims/1043` kar diya -- aur doosre region ka claim, customer ka naam aur medical note screen pe aa gaya.
Security review mein CISO: "User logged in tha, theek hai. Par usko ye claim dekhne ki permission kisne di?"
Aapka code sirf ye check kar raha tha ki token valid hai. Ye authentication tha. Authorization -- "kya ye user YE resource dekh sakta hai" -- kahin tha hi nahi.

### What it is
**Authentication (authn)** = "tum kaun ho?" -- identity prove karna (password, SSO, token signature check). Output: ek principal (user id, tenant, roles).
**Authorization (authz)** = "tum kya kar sakte ho?" -- us principal ko is action + is resource pe allow karna ya deny karna. Har request pe, har resource pe.

### Why it matters for an FDE
Enterprise customer ka IdP (Okta, Entra ID) authn de deta hai, authz hamesha aapke app ka kaam hai. AI app mein ye aur zaroori hai: LLM ko jo context mila, wo user ko dikh sakta hai -- isliye authz retrieval se pehle chahiye (M12-07).

### Key concepts
- **Principal** -- authn ka result: `sub`, `tenant`, `roles`, `groups`. Baaki sab decisions isi pe.
- **401 Unauthorized** -- authn fail (token missing/invalid/expired). Naam confusing hai, matlab "unauthenticated". `WWW-Authenticate` header bhejo.
- **403 Forbidden** -- authn pass, authz fail. User pata hai, permission nahi.
- **IDOR (Insecure Direct Object Reference)** -- sirf login check, object-level check nahi. OWASP API Top 10 ka #1 (BOLA).
- **Deny by default** -- koi rule match nahi hua = deny. Allow list, not block list.

### Code example
`pip install fastapi httpx`

```python
# runnable
from dataclasses import dataclass

from fastapi import Depends, FastAPI, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.testclient import TestClient

@dataclass(frozen=True)
class Principal:
    sub: str
    tenant: str
    region: str
    roles: frozenset

# Demo token store. Real app: verify a signed JWT from the IdP (M12-02).
TOKENS = {
    "tok-asha": Principal("asha", "acme-ins", "north", frozenset({"claims_agent"})),
    "tok-ravi": Principal("ravi", "acme-ins", "south", frozenset({"claims_agent"})),
    "tok-meera": Principal("meera", "acme-ins", "north", frozenset({"auditor"})),
}
CLAIMS = {
    1042: {"id": 1042, "tenant": "acme-ins", "region": "north", "status": "open"},
    1043: {"id": 1043, "tenant": "acme-ins", "region": "south", "status": "open"},
}

bearer = HTTPBearer(auto_error=False)

def authenticate(cred: HTTPAuthorizationCredentials | None = Depends(bearer)) -> Principal:
    """AuthN: who are you? Fails with 401."""
    principal = TOKENS.get(cred.credentials) if cred else None
    if principal is None:
        raise HTTPException(401, "not authenticated", headers={"WWW-Authenticate": "Bearer"})
    return principal

def can(principal: Principal, action: str, claim: dict) -> bool:
    """AuthZ: may this principal do this action on this resource? Deny by default."""
    if claim["tenant"] != principal.tenant:
        return False
    if action == "read" and "auditor" in principal.roles:
        return True
    if action in ("read", "update") and "claims_agent" in principal.roles:
        return claim["region"] == principal.region      # object-level check, not just "logged in"
    return False

app = FastAPI()

@app.get("/claims/{claim_id}")
def read_claim(claim_id: int, p: Principal = Depends(authenticate)):
    claim = CLAIMS.get(claim_id)
    if claim is None or not can(p, "read", claim):
        # Same 404 for "missing" and "other tenant" so ids cannot be probed across tenants.
        # Inside the same tenant you may prefer 403 -- pick one rule and document it.
        raise HTTPException(404 if claim is None or claim["tenant"] != p.tenant else 403, "denied")
    return claim

@app.post("/claims/{claim_id}/close")
def close_claim(claim_id: int, p: Principal = Depends(authenticate)):
    claim = CLAIMS.get(claim_id)
    if claim is None or not can(p, "update", claim):
        raise HTTPException(403, "forbidden")
    return {"id": claim_id, "status": "closed", "by": p.sub}

c = TestClient(app)
H = lambda t: {"Authorization": f"Bearer {t}"}

assert c.get("/claims/1042").status_code == 401                         # no token
r = c.get("/claims/1042", headers=H("forged"))
assert r.status_code == 401 and r.headers["www-authenticate"] == "Bearer"
assert c.get("/claims/1042", headers=H("tok-asha")).status_code == 200   # own region
assert c.get("/claims/1043", headers=H("tok-asha")).status_code == 403   # the IDOR from the story
assert c.get("/claims/1043", headers=H("tok-ravi")).status_code == 200
assert c.get("/claims/1043", headers=H("tok-meera")).status_code == 200  # auditor reads all
assert c.post("/claims/1042/close", headers=H("tok-meera")).status_code == 403  # auditor cannot write
assert c.post("/claims/1042/close", headers=H("tok-asha")).json()["by"] == "asha"
assert c.get("/claims/9999", headers=H("tok-asha")).status_code == 404
print("OK: 401 = who are you, 403 = not allowed, object-level checks stop IDOR")
```

- `authenticate` -- sirf identity banata hai. Kuch bhi galat = 401 + `WWW-Authenticate: Bearer`. Koi business logic nahi.
- `can(principal, action, resource)` -- authz ek jagah, ek function. Tenant check sabse pehle, phir role, phir object attribute (`region`).
- Last `return False` -- deny by default. Naya action add kiya aur rule bhoolna = deny, leak nahi.
- 1043 pe Asha ko 403 -- yahi kahani wala bug. Route sirf `Depends(authenticate)` pe ruk jaata to 200 milta.
- 404 vs 403 -- doosre tenant ke ids ka existence leak na ho, isliye 404. Ye ek policy decision hai, team ke saath likh ke rakho.

### Mini-exercise (30-60 min)
OmniGuard: `omniguard/auth/deps.py` banao.
- `Principal` dataclass (`sub`, `tenant`, `roles`, `groups`) aur `get_principal` dependency. Abhi fake token map; M12-02 mein JWT verify se replace hoga.
- `omniguard/auth/policy.py` mein `can(principal, action, resource) -> bool`, deny by default.
- `/documents/{id}` route jo dono use kare. Tests: no token 401, bad token 401, doosre tenant ka doc 404, same tenant bina role 403, sahi user 200.
- Acceptance: `pytest -q tests/test_authz.py` green, aur har route `Depends(get_principal)` use karta hai (ek test jo `app.routes` iterate karke check kare -- public routes allow-list mein).

### Common pitfalls
- "Login hai to sab dikhao" -- sirf authn, object-level authz nahi. AI app mein ye leak LLM ke through bhi hota hai.
- Authz checks frontend mein -- button hide kiya, API khuli. Har check server pe.
- Error message mein reason leak karna ("claim 1043 belongs to south region") -- log mein reason likho (M12-10), user ko generic message.

### Checklist before moving on
- [ ] Main 401 aur 403 ka farak ek line mein bata sakta hoon, aur `WWW-Authenticate` kab bhejte hain.
- [ ] Authz ek function/policy mein hai, routes mein bikhra hua nahi.
- [ ] Har resource fetch ke baad object-level check hota hai (tenant + attribute).
- [ ] Unknown action = deny.

### Related
- M02-03 Dependency injection
- M12-02 Understanding JWT tokens
- M12-06 Implementing Role-Based Access Control
- M12-07 Enforcing data-level permissions in retrieval layers
- M12-10 Audit logging

### Self-quiz
1. Customer ka IdP SSO de raha hai. Phir bhi authorization aapke app ki zimmedari kyun hai?
2. Expired token pe 401 ya 403? Valid token par galat tenant ka resource -- kya return karoge aur kyun?
3. IDOR kya hai, aur RAG chatbot mein ye kaise dikh sakta hai jahan koi URL id hi nahi hai?
4. "Deny by default" ko code mein kaise ensure karoge taaki naya endpoint galti se khula na rahe?
