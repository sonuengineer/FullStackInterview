# Identity & Access Management

## OAuth grant types

> Core | Fast CP5 / Slow CP7 | ~1.2 h | Builds on: M12-01, M12-02

### Kahani
Hospital customer teen cheezein chahta hai: (1) doctors browser se AI notes app mein Entra ID se login karein, (2) raat ka batch job FHIR API se records khinche, (3) mobile app offline ke baad bhi chalti rahe.
Purane vendor ne teeno ke liye ek hi trick lagayi thi -- doctor ka username/password app mein lo aur token le aao (password grant). Ek doctor ne password badla, batch job toot gaya; MFA lagaya, mobile app toot gaya; aur audit mein ye "app ke paas doctors ke passwords hain" sunke CISO ne project rok diya.
Har situation ka alag OAuth grant hai. Galat grant = ya to security hole, ya roz ka outage.

### What it is
**OAuth 2.0** = delegation protocol: client ko user ka password diye bina, authorization server se ek scoped **access token** milta hai. **Grant type** = token lene ka tarika.
OAuth 2.1 (draft, practice mein follow hota hai): **authorization code + PKCE** sab clients ke liye, **client credentials** machines ke liye, **refresh token** rotation ke saath. **Implicit aur password grants deprecated hain -- naye kaam mein mat use karo.**

### Why it matters for an FDE
Customer ka IdP team poochegi "aapko kaunsa grant chahiye, kaunse scopes, redirect URI kya hai?" Galat jawab = weeks ki delay ya security review fail. Sahi grant chunna FDE ka roz ka kaam hai.

### Key concepts
- **Authorization code + PKCE** -- user browser mein IdP pe login, app ko short-lived `code` milta hai, app backend usse token ke liye exchange karta hai. PKCE: `code_verifier` (random secret) + `code_challenge = BASE64URL(SHA256(verifier))`; chura hua code bina verifier ke bekaar.
- **Client credentials** -- koi user nahi; service apne `client_id` + secret (ya better, certificate / workload identity -- M12-09) se token leti hai. Batch jobs, M2M.
- **Refresh token + rotation** -- har refresh pe naya refresh token, purana invalid. Purana dobara aaya = chori, poori family revoke (M12-08).
- **OIDC `id_token` vs `access_token`** -- `id_token` client ke liye "user kaun hai" (aud = client id); `access_token` API ke liye (aud = API). API pe hamesha access token.
- **`state` + exact `redirect_uri`** -- `state` CSRF rokta hai; redirect URI exact string match, wildcard nahi.

### Code example
`pip install fastapi httpx`

```python
# runnable
import base64, hashlib, secrets, time
from urllib.parse import parse_qs, urlencode
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient
def s256(verifier: str) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()

CLIENTS = {"notes-web": {"type": "public", "redirect": "https://notes.example/cb"},
           "fhir-batch": {"type": "confidential", "secret": "s3cr3t-demo", "scope": "fhir.read"}}
CODES, REFRESH, USED = {}, {}, {}          # USED: spent refresh token -> family id
auth = FastAPI()                           # tiny fake authorization server (real: Entra ID, Okta, Keycloak)
def fail(code, status=400): raise HTTPException(status, detail={"error": code})

def tokens(sub, scope, family=None):
    out = {"access_token": secrets.token_urlsafe(24), "token_type": "Bearer", "expires_in": 600, "scope": scope}
    if family:                                     # no family = no refresh token (client credentials)
        out["refresh_token"] = rt = secrets.token_urlsafe(32)
        REFRESH[rt] = {"sub": sub, "scope": scope, "family": family}
    return out

@auth.get("/authorize")                            # pretend the user already logged in + consented
def authorize(client_id: str, redirect_uri: str, code_challenge: str, code_challenge_method: str, state: str):
    if CLIENTS.get(client_id, {}).get("redirect") != redirect_uri or code_challenge_method != "S256":
        fail("invalid_request")                    # exact redirect match, S256 only
    code = secrets.token_urlsafe(16)
    CODES[code] = dict(client_id=client_id, redirect=redirect_uri, challenge=code_challenge, sub="dr-iyer", exp=time.time() + 60)
    return {"redirect_to": f"{redirect_uri}?{urlencode({'code': code, 'state': state})}"}

@auth.post("/token")
async def token(request: Request):
    f = {k: v[0] for k, v in parse_qs((await request.body()).decode()).items()}   # form-encoded body
    if (grant := f.get("grant_type")) == "authorization_code":
        d = CODES.pop(f.get("code", ""), None)                                      # single use
        ok = d and d["exp"] > time.time() and d["client_id"] == f.get("client_id") and d["redirect"] == f.get("redirect_uri")
        if not ok or s256(f.get("code_verifier", "")) != d["challenge"]:
            fail("invalid_grant")
        return tokens(d["sub"], "openid notes.write", family=secrets.token_hex(4))
    if grant == "client_credentials":
        c = CLIENTS.get(f.get("client_id", ""), {})
        if c.get("type") != "confidential" or not secrets.compare_digest(c["secret"], f.get("client_secret", "")):
            fail("invalid_client", 401)
        return tokens(f["client_id"], c["scope"])
    if grant == "refresh_token":
        if (rt := f.get("refresh_token", "")) in USED:                             # replay = probable theft: revoke the whole family
            for k in [k for k, v in REFRESH.items() if v["family"] == USED[rt]]:
                del REFRESH[k]
            fail("invalid_grant")
        d = REFRESH.pop(rt, None) or fail("invalid_grant")
        USED[rt] = d["family"]
        return tokens(d["sub"], d["scope"], family=d["family"])                     # rotation
    fail("unsupported_grant_type")                 # implicit / password: no code path at all

c = TestClient(auth)
post = lambda d: c.post("/token", content=urlencode(d), headers={"Content-Type": "application/x-www-form-urlencoded"})
def login(challenge, state="st-123"):
    r = c.get("/authorize", params={"client_id": "notes-web", "redirect_uri": "https://notes.example/cb",
              "code_challenge": challenge, "code_challenge_method": "S256", "state": state})
    cb = parse_qs(r.json()["redirect_to"].split("?", 1)[1])
    assert cb["state"][0] == state                 # client checks state (CSRF)
    return cb["code"][0]
# 1. Authorization code + PKCE (doctors in the browser)
verifier = secrets.token_urlsafe(48)               # 43-128 chars, never leaves the client
base = {"grant_type": "authorization_code", "client_id": "notes-web", "redirect_uri": "https://notes.example/cb"}
assert post(base | {"code": login(s256(verifier)), "code_verifier": "guess"}).status_code == 400   # stolen code, no verifier
code = login(s256(verifier))
t1 = post(base | {"code": code, "code_verifier": verifier}).json()
assert t1["token_type"] == "Bearer" and "refresh_token" in t1
assert post(base | {"code": code, "code_verifier": verifier}).status_code == 400    # code reused
# 2. Client credentials (nightly FHIR batch job: no user, no refresh token)
m2m = post({"grant_type": "client_credentials", "client_id": "fhir-batch", "client_secret": "s3cr3t-demo"}).json()
assert m2m["scope"] == "fhir.read" and "refresh_token" not in m2m
# 3. Refresh rotation + reuse detection
t2 = post({"grant_type": "refresh_token", "refresh_token": t1["refresh_token"]}).json()
assert t2["refresh_token"] != t1["refresh_token"]
assert post({"grant_type": "refresh_token", "refresh_token": t1["refresh_token"]}).status_code == 400  # replay
assert post({"grant_type": "refresh_token", "refresh_token": t2["refresh_token"]}).status_code == 400  # family dead
# 4. Deprecated grants are not offered
assert post({"grant_type": "password", "username": "dr-iyer", "password": "x"}).json()["detail"]["error"] == "unsupported_grant_type"
print("OK: code+PKCE, client credentials, refresh rotation with reuse detection, no password grant")
```

- `s256` -- PKCE ka S256 method: `BASE64URL(SHA256(verifier))` bina `=` padding. `plain` method mat allow karo.
- `CODES.pop(...)` -- code ek baar hi use hota hai, 60 s expiry. Galat verifier wala attempt bhi code jala deta hai.
- Client credentials mein refresh token nahi -- service jab chahe naya token le sakti hai.
- Refresh replay pe poori family revoke -- isliye asli user ka `t2` bhi fail hua. User ko dobara login, attacker bahar.
- `unsupported_grant_type` -- password/implicit ka koi code path hi nahi. Ye RFC 6749 ka standard error code hai.
- Real IdP ka token endpoint `application/x-www-form-urlencoded` leta hai, JSON nahi -- integration mein ye common galti hai.

```python
# real version -- not run here, needs: pip install httpx  (client credentials against the customer's IdP)
import os
import httpx

r = httpx.post(os.environ["OIDC_TOKEN_URL"], timeout=5, data={      # data= sends form-encoded
    "grant_type": "client_credentials", "client_id": os.environ["OIDC_CLIENT_ID"],
    "client_secret": os.environ["OIDC_CLIENT_SECRET"], "scope": os.environ["OIDC_SCOPE"]})
r.raise_for_status()
access_token = r.json()["access_token"]                              # cache until expires_in - 60 s
```

Entra ID mein client credentials ka scope aksar `api://<app-id>/.default` hota hai -- exact format apne IdP ke docs mein check karo.

### Mini-exercise (30-60 min)
OmniGuard: `omniguard/auth/oauth_client.py` banao.
- `TokenProvider` (client credentials) jo token cache kare aur `expires_in - 60` s pe refresh kare; httpx timeout 5 s; secret env se.
- `omniguard/auth/pkce.py`: `new_pkce() -> (verifier, challenge)` + test jo RFC 7636 Appendix B ka example vector match kare.
- Mock IdP (FastAPI, upar jaisa) tests ke liye `tests/fake_idp.py` mein; access tokens M12-02 ki tarah RS256 JWT banao taaki OmniGuard ka verify end-to-end test ho.
- Acceptance: tests mein code+PKCE flow, galat verifier 400, refresh replay 400, password grant 400.

### Common pitfalls
- SPA/mobile app mein client secret rakhna -- public client ka secret secret nahi hota. PKCE use karo, secret nahi.
- Redirect URI wildcard ya prefix match -- open redirect se code chori. Exact match.
- Har API call pe naya client-credentials token -- IdP rate limit hit. Cache karo.

### Checklist before moving on
- [ ] Browser user, batch job, mobile app -- teeno ke liye sahi grant bata sakta hoon.
- [ ] PKCE verifier/challenge khud generate aur verify kar sakta hoon.
- [ ] Refresh rotation + reuse detection ka flow samjha sakta hoon.
- [ ] `id_token` aur `access_token` ka farak aur kaunsa API pe jaata hai, pata hai.

### Related
- M12-02 Understanding JWT tokens
- M12-08 Session and token lifecycle
- M12-09 API keys vs service accounts
- M15-06 Executing mock OAuth 2.0 and RBAC flows

### Self-quiz
1. PKCE kis attack ko rokta hai, aur `code_challenge` server ko pehle aur `code_verifier` baad mein kyun bheja jaata hai?
2. Customer kehta hai "hamari mobile app password grant use karti hai, wahi chalao." Aap kya recommend karoge aur kyun?
3. Refresh token reuse detect hua. Asli user ka kya hota hai, aur ye trade-off sahi kyun hai?
4. Aapke API ko ek `id_token` mila. Usse reject kyun karna chahiye?
