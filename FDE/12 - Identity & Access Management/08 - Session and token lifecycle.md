# Identity & Access Management

## Session and token lifecycle

> Core | Fast CP5 / Slow CP7 | ~1.2 h | Builds on: M12-02, M12-03

### Kahani
Fintech customer ka support copilot. Ek agent ko fraud ke shak mein raat 11 baje terminate kiya gaya. HR ne Entra ID mein account disable kiya. Agle din pata chala ki usne raat 2 baje tak copilot se 300 customer records nikale.
Kyun? Access token ki life 24 ghante thi, refresh token kabhi rotate nahi hota tha, aur "logout" sirf browser ka localStorage clear karta tha. Server ko pata hi nahi tha ki session khatam hona chahiye.
Token lifecycle -- kitni der valid, kaise renew, kaise revoke -- ye design decision hai, library ka default nahi.

### What it is
**Access token** = short-lived (5-15 min) proof jo har API call pe jaata hai, aksar JWT, server stateless verify karta hai. **Refresh token** = long-lived, sirf naya access token lene ke liye, server pe tracked, har use pe **rotate**.
**Revocation** = logout, password reset, account disable pe sessions ko server side khatam karna -- short TTL + refresh family revoke + (zaroorat ho to) access token `jti` denylist.

### Why it matters for an FDE
Customer ka security team poochega: "User disable hua to kitne minute mein access band?" Aapka jawab ek number hona chahiye (= access token TTL), aur test se proven. Browser app ke cookies galat flags ke saath = XSS/CSRF finding.

### Key concepts
- **Short access TTL** -- revocation ka worst-case delay = access token TTL. 10 min common hai; JWT ko bina state ke revoke karna mushkil hai, isliye chhota rakho.
- **Refresh rotation + reuse detection** -- har refresh pe naya token, purana "used". Used token dobara aaya = chori, poori family revoke (M12-03).
- **Denylist by `jti`** -- high-risk logout pe access token ka `jti` denylist mein `exp` tak (Redis TTL). Sirf jab 10 min wait acceptable nahi.
- **Cookie flags** -- `HttpOnly` (JS nahi padh sakta, XSS se bachav), `Secure` (sirf HTTPS), `SameSite=Strict/Lax` (cross-site requests pe cookie nahi, CSRF se bachav), narrow `Path`.
- **Idle vs absolute timeout** -- 30 min inactivity pe logout, aur 12 h baad hard re-login, chahe active ho. Banks/hospitals dono maangte hain.

### Code example
`pip install fastapi httpx pyjwt`

```python
# runnable
import hashlib, secrets, time, uuid
import jwt
from fastapi import Cookie, Depends, FastAPI, HTTPException, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.testclient import TestClient

KEY = secrets.token_bytes(32)          # HS256 only because issuer == verifier here; IdP tokens use RS256 (M12-02)
ACCESS_TTL, REFRESH_TTL = 600, 8 * 3600
REFRESH, DENY_JTI = {}, {}             # sha256(rt) -> {sub, family, exp, used} / jti -> exp; real: DB + Redis TTL
h = lambda t: hashlib.sha256(t.encode()).hexdigest()   # store refresh tokens hashed, like passwords

def issue(resp: Response, sub: str, family: str) -> dict:
    now = int(time.time())
    access = jwt.encode({"sub": sub, "jti": uuid.uuid4().hex, "iat": now, "exp": now + ACCESS_TTL}, KEY, algorithm="HS256")
    rt = secrets.token_urlsafe(32)
    REFRESH[h(rt)] = {"sub": sub, "family": family, "exp": now + REFRESH_TTL, "used": False}
    resp.set_cookie("rt", rt, max_age=REFRESH_TTL, httponly=True, secure=True, samesite="strict", path="/auth")
    return {"access_token": access, "expires_in": ACCESS_TTL}

def revoke_family(family: str):
    for k in [k for k, v in REFRESH.items() if v["family"] == family]: del REFRESH[k]

app = FastAPI()
bearer = HTTPBearer(auto_error=False)
def current(cred: HTTPAuthorizationCredentials | None = Depends(bearer)) -> dict:
    try:
        claims = jwt.decode(cred.credentials if cred else "", KEY, algorithms=["HS256"])
    except jwt.InvalidTokenError:
        raise HTTPException(401, "invalid or expired token")
    if claims["jti"] in DENY_JTI:
        raise HTTPException(401, "token revoked")
    return claims

@app.post("/login")                    # stand-in for the OIDC callback (M12-03)
def login(resp: Response, user: str):
    return issue(resp, user, family=uuid.uuid4().hex)

@app.post("/auth/refresh")
def refresh(resp: Response, rt: str | None = Cookie(default=None)):
    rec = REFRESH.get(h(rt or ""))
    if rec is None or rec["exp"] < time.time():
        raise HTTPException(401, "login again")
    if rec["used"]:                    # reuse detected: someone else has this token
        revoke_family(rec["family"])
        raise HTTPException(401, "refresh token reuse")
    rec["used"] = True                 # keep it (marked) so a replay is recognised
    return issue(resp, rec["sub"], rec["family"])

@app.post("/auth/logout")
def logout(resp: Response, claims: dict = Depends(current), rt: str | None = Cookie(default=None)):
    if rec := REFRESH.get(h(rt or "")):
        revoke_family(rec["family"])
    DENY_JTI[claims["jti"]] = claims["exp"]          # access token dies now, not in 10 min
    resp.delete_cookie("rt", path="/auth", secure=True, httponly=True, samesite="strict")
    return {"ok": True}

@app.get("/me")
def me(claims: dict = Depends(current)):
    return {"sub": claims["sub"]}

c = TestClient(app, base_url="https://testserver")  # https so the Secure cookie is sent back
bearer_h = lambda t: {"Authorization": f"Bearer {t}"}
r = c.post("/login", params={"user": "agent-9"})
cookie = r.headers["set-cookie"].lower()
assert all(f in cookie for f in ["httponly", "secure", "samesite=strict", "path=/auth"]), cookie
a1, rt1 = r.json()["access_token"], c.cookies["rt"]
assert c.get("/me", headers=bearer_h(a1)).json()["sub"] == "agent-9"

assert c.post("/auth/refresh").status_code == 200 and (rt2 := c.cookies["rt"]) != rt1   # cookie sent, rotated
c.cookies.clear()                                     # attacker replays the OLD refresh token
replay = c.post("/auth/refresh", headers={"Cookie": f"rt={rt1}"})
assert replay.status_code == 401 and replay.json()["detail"] == "refresh token reuse"
assert c.post("/auth/refresh", headers={"Cookie": f"rt={rt2}"}).json()["detail"] == "login again"  # family revoked
a3 = c.post("/login", params={"user": "agent-9"}).json()["access_token"]
assert c.post("/auth/logout", headers=bearer_h(a3)).status_code == 200
assert c.get("/me", headers=bearer_h(a3)).status_code == 401          # denylisted before exp
old = jwt.encode({"sub": "agent-9", "jti": "x", "iat": 0, "exp": int(time.time()) - 5}, KEY, algorithm="HS256")
assert c.get("/me", headers=bearer_h(old)).status_code == 401         # expired
print("OK: short access TTL, HttpOnly/Secure/SameSite cookie, rotation, reuse detection, logout revokes")
```

- `issue` -- access token body mein (SPA memory mein rakhe), refresh token sirf `HttpOnly; Secure; SameSite=Strict; Path=/auth` cookie mein. JS refresh token kabhi nahi dekhta.
- `REFRESH[h(rt)]` -- DB leak ho to bhi raw refresh tokens nahi milte. Password jaisa treat karo.
- `rec["used"] = True` -- delete nahi kiya, mark kiya; tabhi replay pehchana gaya aur poori family (`rt2` bhi) revoke hui.
- `DENY_JTI` -- logout ke baad wahi access token turant 401. Denylist entries sirf `exp` tak rakhni hain, isliye Redis TTL perfect fit.
- `base_url="https://testserver"` -- `Secure` cookie http pe client wapas nahi bhejta; test bhi production jaisa.

### Mini-exercise (30-60 min)
OmniGuard: `omniguard/auth/session.py`.
- Config: `ACCESS_TTL_S=600`, `REFRESH_TTL_S`, `IDLE_TIMEOUT_S=1800`, `ABSOLUTE_TIMEOUT_S=43200`; idle aur absolute dono enforce karo (refresh record mein `created_at` + `last_used_at`).
- Refresh store SQLite mein (`refresh_tokens` table: hash, family, sub, used, exp); denylist abhi in-memory dict, interface aisa ki Redis se swap ho.
- `POST /admin/users/{sub}/revoke` (permission `user:manage`, M12-06) -- us user ki saari families revoke + audit event (M12-10).
- Tests: rotation, reuse -> family revoked, idle timeout (fake clock inject karo), absolute timeout, logout ke baad 401, cookie flags.

### Common pitfalls
- Access token ko `localStorage` mein rakhna -- koi bhi XSS use padh leta hai. Memory mein rakho ya BFF pattern (server-side session, sirf cookie browser mein).
- `SameSite=None` bina `Secure` ke -- browsers cookie reject karte hain; aur cross-site iframe embed (Teams/Salesforce tab) mein `None; Secure` + CSRF token chahiye. Customer ka embed context pehle poochho.
- Refresh token lifetime "never expires" -- ek chura hua token saal bhar chalega. Absolute timeout rakho.

### Checklist before moving on
- [ ] Main bata sakta hoon user disable hone ke kitne minute baad access band hota hai, aur kyun.
- [ ] Refresh rotation + reuse detection ka test mere paas hai.
- [ ] Logout server-side kuch revoke karta hai, sirf client state clear nahi.
- [ ] Mere session cookie pe `HttpOnly`, `Secure`, `SameSite`, narrow `Path` hai.

### Related
- M12-02 Understanding JWT tokens
- M12-03 OAuth grant types
- M12-06 Implementing Role-Based Access Control
- M12-10 Audit logging

### Self-quiz
1. Access token 24 h, refresh token nahi -- vs -- access 10 min, refresh 8 h rotating. Security aur UX dono angle se compare karo.
2. Refresh token reuse detect hone pe asli user ka bhi logout kyun hona theek hai?
3. `HttpOnly`, `Secure`, `SameSite` -- har ek kis attack ko rokta hai?
4. JWT stateless hai. Phir bhi "logout turant effective" kaise karoge, aur iski cost kya hai?
