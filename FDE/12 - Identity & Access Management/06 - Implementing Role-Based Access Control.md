# Identity & Access Management

## Implementing Role-Based Access Control

> Core | Fast CP5 / Slow CP7 | ~1.2 h | Builds on: M12-01, M12-02, M02-03

### Kahani
Bank ke liye aapka "credit memo assistant" pilot se production ja raha hai. 40 endpoints, aur har endpoint mein alag `if user.email in ADMINS or user.dept == "risk":` likha hai -- teen developers ne teen tarah se.
Audit team ka sawaal: "Kaun kya kar sakta hai, ek page pe dikhao." Koi jawab nahi. Phir pata chala `/memos/export` pe check hi nahi tha -- kisi ne copy-paste mein bhool gaya.
Fix: roles -> permissions ek jagah, har route ek dependency se gate, aur jo route gate nahi hai wo test mein fail ho.

### What it is
**RBAC** = users ko **roles** milte hain (analyst, approver, admin), roles ko **permissions** (`memo:read`, `memo:approve`). Code permissions check karta hai, roles nahi.
FastAPI mein ek dependency factory `require_permission("memo:approve")` -- route pe lagao, baaki logic route se bahar.

### Why it matters for an FDE
Enterprise customer ka security review ek **permission matrix** maangta hai. Ek mapping file + tests = review ek meeting mein khatam. Bikhre hue `if` = weeks ki back-and-forth aur production leak ka risk.

### Key concepts
- **Role -> permission mapping** -- ek dict/YAML; code mein `"memo:approve"` check karo, `"risk_head"` nahi. Naya role = config change, code change nahi.
- **Deny by default** -- unknown role, unknown permission, missing claim = deny. Route bina dependency ke = test fail.
- **401 vs 403** -- token nahi/galat = 401 (M12-01); token sahi par permission nahi = 403.
- **Roles source** -- IdP claims (`roles`, groups -> M12-05) se aate hain; app unhe apne internal roles pe map karta hai, IdP ke naam code mein hardcode nahi.
- **ABAC / ReBAC** -- ABAC = attributes pe rule (region, classification, time); ReBAC = relationships ("owner of this folder", Google Zanzibar style, OpenFGA/SpiceDB). RBAC coarse gate, ABAC/ReBAC fine-grained -- aksar dono saath.

### Code example
`pip install fastapi httpx`

```python
# runnable
from fastapi import Depends, FastAPI, HTTPException
from fastapi.routing import APIRoute
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.testclient import TestClient

ROLE_PERMISSIONS = {         # the one place that answers "who can do what" (review reads this)
    "analyst":  {"memo:read", "memo:draft", "ask:use"},
    "approver": {"memo:read", "memo:approve", "ask:use"},
    "admin":    {"memo:read", "audit:read", "user:manage"},     # admin is NOT a superuser by default
}
# Demo identities; real app: roles from the verified JWT (M12-02), IdP names mapped (M12-05).
TOKENS = {"t-anil": {"sub": "anil", "roles": ["analyst"]},
          "t-bina": {"sub": "bina", "roles": ["approver"]},
          "t-chen": {"sub": "chen", "roles": ["admin", "ghost_role"]}}

def permissions_for(roles: list[str]) -> set[str]:
    return set().union(*(ROLE_PERMISSIONS.get(r, set()) for r in roles))   # unknown role -> nothing

bearer = HTTPBearer(auto_error=False)

def current_user(cred: HTTPAuthorizationCredentials | None = Depends(bearer)) -> dict:
    user = TOKENS.get(cred.credentials) if cred else None
    if not user:
        raise HTTPException(401, "not authenticated", headers={"WWW-Authenticate": "Bearer"})
    return user | {"perms": permissions_for(user["roles"])}

def _gate(label: str, allowed):
    def checker(user: dict = Depends(current_user)) -> dict:
        if not allowed(user):
            raise HTTPException(403, f"missing {label}")    # log user + label, never the token
        return user
    checker.required_permission = label          # lets the guard test find ungated routes
    return checker

def require_permission(perm: str):
    return _gate(perm, lambda u: perm in u["perms"])

def require_role(role: str):                     # customers sometimes ask for this; prefer permissions
    return _gate(f"role:{role}", lambda u: role in u["roles"])

app = FastAPI()
PUBLIC = {"/health"}

@app.get("/health")
def health():
    return {"ok": True}

@app.get("/memos/{memo_id}")
def read_memo(memo_id: int, user=Depends(require_permission("memo:read"))):
    return {"id": memo_id, "reader": user["sub"]}

@app.post("/memos/{memo_id}/approve")
def approve(memo_id: int, user=Depends(require_permission("memo:approve"))):
    return {"id": memo_id, "approved_by": user["sub"]}

@app.post("/ask")
def ask(user=Depends(require_role("analyst"))):
    return {"answer": "stub", "for": user["sub"]}

c = TestClient(app)
H = lambda t: {"Authorization": f"Bearer {t}"}
assert c.get("/memos/1").status_code == 401
assert c.get("/memos/1", headers=H("t-anil")).status_code == 200
assert c.post("/memos/1/approve", headers=H("t-anil")).status_code == 403     # analyst cannot approve
assert c.post("/memos/1/approve", headers=H("t-bina")).json()["approved_by"] == "bina"
assert c.post("/memos/1/approve", headers=H("t-chen")).status_code == 403     # admin != superuser
assert permissions_for(["ghost_role"]) == set()                               # deny by default
assert c.post("/ask", headers=H("t-anil")).status_code == 200
assert c.post("/ask", headers=H("t-bina")).status_code == 403

# Guard test: every non-public route must carry a permission dependency.
def gated(route: APIRoute) -> bool:
    return any(hasattr(d.call, "required_permission") for d in route.dependant.dependencies)
ungated = [r.path for r in app.routes if isinstance(r, APIRoute) and r.path not in PUBLIC and not gated(r)]
assert ungated == [], ungated
matrix = {p: sorted(r for r, ps in ROLE_PERMISSIONS.items() if p in ps)
          for p in sorted(set().union(*ROLE_PERMISSIONS.values()))}
print("permission matrix:", matrix)
print("OK: roles -> permissions, deny by default, 401 vs 403, no ungated routes")
```

- `ROLE_PERMISSIONS` -- poora access model ek dict mein. Security review ke liye `matrix` print -- ye hi aapka permission matrix doc hai.
- `permissions_for` -- unknown role (`ghost_role`) ko khaali set; koi exception, koi default allow nahi.
- `_gate` -> `require_permission(perm)` -- dependency factory; route ka signature hi batata hai kya chahiye. 401 `current_user` se, 403 `_gate` se.
- `require_role("analyst")` -- kabhi customer role-based check maangta hai; chalega, par permission check zyada flexible hai (naya role = sirf mapping).
- Guard test -- `route.dependant.dependencies` scan karke ungated routes pakadta hai. Kahani wala `/memos/export` bug yahin CI mein ruk jaata.
- Admin approve nahi kar sakta -- **separation of duties**. Bank mein "jo memo likhe wahi approve na kare" common requirement hai.

### Mini-exercise (30-60 min)
OmniGuard: `omniguard/auth/rbac.py` banao.
- `config/rbac.yaml` mein roles -> permissions (`ask:use`, `docs:read`, `sql:query`, `audit:read`); startup pe load + validate (unknown permission names pe startup fail).
- `require_permission(...)` dependency `omniguard/auth/deps.py` ke `Principal` (M12-02 JWT se) pe chale.
- `tests/test_rbac.py`: 401 bina token, 403 galat role, 200 sahi role, aur guard test jo ungated routes pe fail ho.
- `docs/permission-matrix.md` ek script se generate karo (YAML -> markdown table). CP5 gate demo mein ye dikhana hai.

### Common pitfalls
- Roles string compare code mein bikhra hua (`if "Risk-Head-APAC" in groups`) -- IdP group rename hua, prod toot gaya. Mapping ek jagah.
- `admin` ko wildcard `*` dena -- ek compromised admin = sab kuch. Admin ko bhi explicit permissions.
- Role explosion -- `analyst_north_retail_readonly`. Jab roles mein attributes ghusne lagein, ABAC rule (region, classification) pe shift karo.

### Checklist before moving on
- [ ] Mere app mein roles -> permissions mapping ek file mein hai aur matrix generate hota hai.
- [ ] Har route ek permission dependency use karta hai; guard test CI mein hai.
- [ ] Unknown role/permission = deny, test ke saath.
- [ ] RBAC, ABAC aur ReBAC ka farak ek-ek example se bata sakta hoon.

### Related
- M12-01 Authentication vs authorization
- M12-05 Mapping Azure AD groups
- M12-07 Enforcing data-level permissions in retrieval layers
- M02-03 Dependency injection
- M15-06 Executing mock OAuth 2.0 and RBAC flows

### Self-quiz
1. Code mein role check karne ki jagah permission check karna kyun better hai? Ek scenario do.
2. Token valid hai par role nahi hai -- status code kya, aur client ko kya message dikhana chahiye?
3. "Doctor sirf apne patients ke notes dekhe" -- ye RBAC se hoga ya ABAC/ReBAC chahiye? Kyun?
4. Naya developer ek route bina dependency ke add karta hai. Aapka system ise kaise pakdega?
