# OmniGuard - Secure AI Integration

## Executing mock OAuth 2.0 / RBAC flows

> Core | Fast CP6 / Slow CP8 | ~1.2 h | Builds on: M12-02, M12-03, M12-06, M12-07

### Kahani
Kavach ka Azure AD tenant UAT ke 3 din pehle tak nahi milega -- Anil ki team change ticket approve kar rahi hai.
Par UAT-07 (M15-05) kehta hai: "underwriter ko claim medical notes kabhi nahi dikhne chahiye." Ye test real IdP ke bina bhi aaj pass hona chahiye, warna week 5 mein surprise.
Solution: ek **mock IdP** jo bilkul real jaise RS256 JWT banaye (sahi `iss`, `aud`, `exp`, roles), aur ek acceptance-test harness jo OmniGuard ko baahar se attack kare -- bina token, expired token, doosre app ka token, forged token, aur do alag users se same sawaal.
Jis din real Azure AD aaye, sirf issuer/JWKS config badle; harness wahi rahe.

### What it is
**Mock OAuth 2.0 / RBAC flow** = tests mein ek fake authorization server jo real format ke tokens issue kare, taaki aapka API ka poora auth chain (verify -> principal -> permission -> data filter) end-to-end chal sake.
Yahan aap OmniGuard ka **auth acceptance harness** banate ho -- woh tests jo CP5/CP6 gate ka "two-user demo" prove karte hain.

### Why it matters for an FDE
Customer ka IdP access hamesha late aata hai. Mock flow ke bina aap ya to auth ko "baad mein" chhod dete ho (sabse risky part untested) ya UAT mein pehli baar test karte ho.

### Key concepts
- **Factory + injected key** -- `create_app(jwt_public_key_pem)` taaki tests apni key de sakein; prod mein JWKS URL (M12-02).
- **Negative tests first** -- no token, expired, wrong `aud`, wrong signer, `alg=none` -- sab 401. Ek bhi 200 = Sev1.
- **401 vs 403** -- 401 = "tum kaun ho, pata nahi"; 403 = "pata hai, par permission nahi" (M12-06).
- **Two-user test** -- same question, do roles, alag allowed answers; aur har user ke answer mein doosre ka data *absent* (M12-07).
- **Harness, not solution** -- harness sirf HTTP contract test karta hai; andar kya hai (aapka code) uski parwah nahi.

Architecture (auth slice of OmniGuard):
```text
 [mock IdP / Azure AD] --RS256 JWT {iss, aud, exp, sub, roles}--> [client / harness]
                                                                       |
                                                    Authorization: Bearer <jwt>
                                                                       v
 OmniGuard: verify_access_token (M12-02) -> Principal -> require_permission("ask:use") (M12-06)
            -> retrieve(principal, q) with ACL filter (M12-07) -> LLM -> answer + sources
```

Threat / failure list the harness covers: missing token, expired token, token for another app (`aud`), forged signature, `alg=none` downgrade, role without permission, cross-role data leak in answer. Not covered here (add later): token replay after logout (M12-08), audit events (M12-10).

### Code example
`pip install fastapi httpx pyjwt cryptography`

```python
# runnable
import importlib, os, time
import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.testclient import TestClient

ISS, AUD = "https://mock-idp.local", "omniguard"
def keypair():
    k = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = k.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    return k, pem.decode()
IDP_KEY, IDP_PUB = keypair()        # the harness IS the mock IdP
EVIL_KEY, _ = keypair()

def token(roles, key=IDP_KEY, alg="RS256", **over):
    now = int(time.time())
    claims = {"iss": ISS, "aud": AUD, "sub": f"u-{roles[0]}", "roles": roles, "iat": now, "exp": now + 300, **over}
    return jwt.encode(claims, key if alg != "none" else None, algorithm=alg)

def standin_create_app(public_pem: str, check_aud: bool = True) -> FastAPI:
    """STAND-IN, not OmniGuard: hard-coded data so the harness executes here."""
    app, data = FastAPI(), {"claims_analyst": "Claim C-1001 status: approved.", "underwriter": "Q2 loss ratio: 61%."}
    def principal(authorization: str = Header(default="")) -> dict:
        try:
            return jwt.decode(authorization.removeprefix("Bearer "), public_pem, algorithms=["RS256"],
                              audience=AUD if check_aud else None, issuer=ISS,
                              options={"verify_aud": check_aud, "require": ["exp", "iss", "sub"]})
        except jwt.PyJWTError:
            raise HTTPException(401, "invalid token")
    @app.post("/v1/ask")
    def ask(body: dict, p: dict = Depends(principal)):
        allowed = [data[r] for r in p.get("roles", []) if r in data]
        if not allowed:
            raise HTTPException(403, "missing permission ask:use")
        return {"answer": " ".join(allowed), "sources": []}
    return app

# Point at your real app later: OMNIGUARD_APP_FACTORY="omniguard.main:create_app"
def make_client(factory=None) -> TestClient:
    if factory is None and (target := os.environ.get("OMNIGUARD_APP_FACTORY")):
        mod, attr = target.split(":")
        factory = getattr(importlib.import_module(mod), attr)
    return TestClient((factory or standin_create_app)(IDP_PUB))

Q = {"question": "Status of claim C-1001 and the Q2 loss ratio?"}
MARKERS = {"claims_analyst": ("C-1001", "loss ratio"), "underwriter": ("loss ratio", "C-1001")}  # (must, must_not)

def run_harness(c: TestClient) -> list[str]:
    ask = lambda tok=None: c.post("/v1/ask", json=Q, headers={"Authorization": f"Bearer {tok}"} if tok else {})
    expect = {"no token": (ask(), 401), "expired": (ask(token(["underwriter"], exp=int(time.time()) - 600)), 401),
              "wrong aud": (ask(token(["underwriter"], aud="other-app")), 401),
              "forged signer": (ask(token(["underwriter"], key=EVIL_KEY)), 401),
              "alg none": (ask(token(["underwriter"], alg="none")), 401), "no permission": (ask(token(["intern"])), 403)}
    fails = [f"{n}: got {r.status_code}, want {want}" for n, (r, want) in expect.items() if r.status_code != want]
    for role, (must, must_not) in MARKERS.items():
        r = ask(token([role]))
        ans = r.json().get("answer", "") if r.status_code == 200 else ""
        if must not in ans or must_not in ans:
            fails.append(f"two-user: {role} answer wrong or leaks data: {ans!r}")
    return fails

fails = run_harness(make_client())
print("target app:", fails or "all auth checks passed")
assert fails == []
broken = run_harness(make_client(lambda pem: standin_create_app(pem, check_aud=False)))
print("broken app:", broken)
assert broken == ["wrong aud: got 200, want 401"]       # the harness has teeth
print("OK: mock OAuth + RBAC acceptance harness")
```

- `IDP_KEY, IDP_PUB` -- harness khud mock IdP hai: private key se sign, app ko sirf public key milti hai. Bilkul real IdP jaisa trust model.
- `token(..., **over)` -- ek helper se saare bad tokens (expired, wrong aud, forged, `alg=none`) bante hain; har negative case ek line.
- `standin_create_app` jaan-boojh ke chhota aur hard-coded hai -- ye OmniGuard nahi, sirf harness chalane ke liye. Aapka real app `OMNIGUARD_APP_FACTORY` se plug hota hai.
- `MARKERS` -- two-user test "must" aur "must_not" dono check karta hai. Sirf "sahi answer aaya" check karna leak nahi pakadta.
- `broken` run -- `aud` check band karne wala app pakda gaya. Harness ko hamesha ek broken target pe bhi chala ke dekho.

### Mini-exercise (30-60 min)
OmniGuard deliverable #3 (OAuth 2.0 + RBAC): `omniguard/tests/acceptance/test_auth.py`.
- Is harness ko pytest mein convert karo (har check ek test, `MARKERS` aapke seed data se). Apne `omniguard.main:create_app(jwt_public_key_pem)` pe chalao.
- Mock IdP ko M12-03 ke `tests/fake_idp.py` se jodo (code + PKCE flow se token), harness wale direct-mint tokens ke saath.
- Acceptance: saare 8 checks green; ek PR jisme `verify_aud` band karo -> CI red (screenshot README mein); UAT-07 isi test ko reference kare.

### Common pitfalls
- Tests mein auth bypass flag (`DISABLE_AUTH=1`) -- ek din prod env mein lag jaata hai. Mock IdP use karo, bypass nahi.
- Sirf happy path test -- auth bugs hamesha negative cases mein hote hain.
- Test private key repo mein commit karna aur prod mein bhi wahi trust karna -- test keys runtime pe generate karo.

### Checklist before moving on
- [ ] Mock IdP aur real IdP mein sirf issuer/key source ka fark hai -- samjha sakta hoon.
- [ ] 6 negative auth cases aur unke expected status codes bata sakta hoon.
- [ ] Two-user test "must" + "must_not" dono check karta hai.
- [ ] Harness mere real OmniGuard pe green hai aur broken config pe red.

### Related
- M12-02 Understanding JWT tokens
- M12-03 OAuth grant types
- M12-06 Implementing Role-Based Access Control
- M12-07 Enforcing data-level permissions in retrieval layers
- M15-05 Delivering User Acceptance Testing (UAT) runbooks

### Self-quiz
1. Harness app ko public key kyun deta hai, private key kyun nahi? Real Azure AD mein ye kaise hota hai?
2. "wrong aud" token ka attack scenario Kavach ke context mein batao.
3. Two-user test mein sirf "must" check karte to kaunsa bug miss ho jaata?
4. Real IdP aane ke baad kaunse 2 config values badlenge aur harness mein kya nahi badlega?
