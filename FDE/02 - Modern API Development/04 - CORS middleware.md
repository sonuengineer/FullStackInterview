# Modern API Development

## CORS middleware

> Core | Fast CP2 / Slow CP2 | ~1.2 h | Builds on: M02-01, M02-03

### Kahani
Ek insurance customer ka React dashboard `https://claims.acme-insure.example` pe hai, aur aapki FastAPI `https://api.acme-insure.example` pe.
Postman aur curl se sab chal raha hai, lekin browser console mein laal error: "blocked by CORS policy". Frontend dev bolta hai "backend tootha hai".
Jaldi mein kisi ne `allow_origins=["*"]` aur `allow_credentials=True` laga diya -- dashboard chal gaya. Do hafte baad pen-test report: "koi bhi website logged-in user ke cookies ke saath aapki API call karke claims data padh sakti hai."
Aapko samajhna hai ki CORS kaun enforce karta hai, kya protect karta hai, aur sahi config kya hai.

### What it is
**CORS (Cross-Origin Resource Sharing)** = browser ka rule: page ek origin (scheme + host + port) se doosre origin ko JS se call kare to browser response tabhi JS ko dega jab server `Access-Control-Allow-Origin` header se us origin ko allow kare.
**Server enforce nahi karta** -- server request process karke response bhej deta hai; browser header dekh ke JS se chupa leta hai. Isliye curl/Postman pe CORS kabhi nahi dikhta. FastAPI mein `CORSMiddleware` ye headers lagata hai (Express ke `cors()` package jaisa).

### Why it matters for an FDE
Har customer demo browser mein hota hai. Galat CORS = "aapki API kaam nahi karti" ka pehla impression; bahut dheela CORS = security finding jo go-live rok deta hai.

### Key concepts
- **Simple vs preflighted request** -- custom header (`Authorization`), JSON `Content-Type`, ya PUT/DELETE ho to browser pehle `OPTIONS` preflight bhejta hai (`Origin`, `Access-Control-Request-Method`, `Access-Control-Request-Headers`).
- **Preflight response** -- server allowed origin, methods, headers aur `Access-Control-Max-Age` batata hai; fail hua to asli request jaati hi nahi.
- **Credentials** -- cookies/auth ke saath request ke liye server ko `Access-Control-Allow-Credentials: true` aur EXACT origin (not `*`) dena hota hai.
- **`*` + credentials trap** -- browser spec `*` ko credentials ke saath reject karta hai, isliye Starlette aise case mein request ka origin echo kar deta hai = har website trusted. Explicit allow-list hi sahi hai.
- **CORS is not auth** -- server-to-server ya curl attacker pe CORS kuch nahi rokta; auth (M02-03) phir bhi chahiye.

### Code example
`pip install fastapi httpx`

```python
# runnable
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient

DASHBOARD = "https://claims.acme-insure.example"
EVIL = "https://evil.example"


def make_app(origins: list[str]) -> FastAPI:
    app = FastAPI()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
        max_age=600,                         # browser caches the preflight for 10 min
    )

    @app.get("/claims")
    def claims():
        return [{"id": 1, "amount": 1200}]

    return app


def preflight(c: TestClient, origin: str):
    return c.options("/claims", headers={
        "Origin": origin,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
    })


good = TestClient(make_app([DASHBOARD]))     # explicit allow-list

r = preflight(good, DASHBOARD)
assert r.status_code == 200
assert r.headers["access-control-allow-origin"] == DASHBOARD
assert r.headers["access-control-allow-credentials"] == "true"
assert "authorization" in r.headers["access-control-allow-headers"].lower()
assert r.headers["access-control-max-age"] == "600"

r = preflight(good, EVIL)
assert r.status_code == 400 and "access-control-allow-origin" not in r.headers

# Simple GET from an evil origin: the SERVER still answers 200 with data.
# Only the missing header makes the BROWSER hide it from evil.example's JS.
r = good.get("/claims", headers={"Origin": EVIL})
assert r.status_code == 200 and r.json()[0]["amount"] == 1200
assert "access-control-allow-origin" not in r.headers

# Anti-pattern: "*" + credentials. With a cookie, Starlette echoes ANY origin back.
bad = TestClient(make_app(["*"]))
r = bad.get("/claims", headers={"Origin": EVIL, "Cookie": "session=abc"})
assert r.headers["access-control-allow-origin"] == EVIL
assert r.headers["access-control-allow-credentials"] == "true"
print("OK: preflight allowed for dashboard, rejected for evil; '*' + credentials trusts evil")
```

- `preflight()` -- wahi headers bhejta hai jo browser `fetch(url, {headers: {Authorization}})` se pehle bhejta. Asli bug debug karte waqt DevTools Network tab mein `OPTIONS` row dekho.
- Evil preflight pe `400` aur koi `access-control-allow-origin` nahi -- browser asli GET bhejega hi nahi.
- Evil simple GET pe `200` + data -- ye proof hai ki CORS server-side firewall NAHI hai. Sensitive data ko auth chahiye, CORS sirf browser JS ko padhne se rokta hai.
- `bad` app -- `["*"]` + `allow_credentials=True` + cookie: response mein `evil.example` aur `credentials: true` -- yani logged-in user ki session ke saath koi bhi site data padh sakti hai.
- `max_age=600` -- har API call se pehle extra OPTIONS round-trip bachata hai; latency-sensitive dashboards ke liye important.

### Mini-exercise (30-60 min)
`omniguard` mein CORS config-driven banao.
- `Settings.cors_origins: list[str]` env var `OMNIGUARD_CORS_ORIGINS` (comma-separated) se; default khaali list. `"*"` aaye aur credentials on hon to startup pe `ValueError` raise karo (fail fast).
- `app/main.py` mein `CORSMiddleware` isi setting se add karo, methods/headers explicit.
- `tests/test_cors.py`: allowed origin ka preflight 200 + sahi headers; unknown origin ka preflight 400; `"*"` config pe settings validation fail.
- Acceptance: ek chhota `index.html` (`python -m http.server 5500` se serve) se `fetch("http://localhost:8000/health")` -- origin allow-list mein ho to chale, hata do to console mein CORS error.

### Common pitfalls
- Origin mein trailing slash ya galat port (`http://localhost:3000/` vs `http://localhost:3000`) -- exact string match hota hai, ek character se fail.
- CORS error ko "server down" samajhna -- aksar asli error 500 hota hai jiske response pe CORS headers nahi lage (exception middleware ke bahar). Pehle server logs dekho.
- Production mein `allow_origin_regex=".*"` ya `["*"]` dev config se copy -- environment-wise allow-list config mein rakho, code mein nahi.

### Checklist before moving on
- [ ] Bata sakta hoon CORS browser enforce karta hai, server nahi, aur curl pe kyun nahi dikhta.
- [ ] Preflight kab hota hai aur uske headers kya hain, pata hai.
- [ ] `*` + credentials kyun galat hai, example se samjha sakta hoon.
- [ ] Mera CORS allow-list env-driven hai.

### Related
- M02-03 Dependency injection
- M02-17 End-to-end testing fundamentals
- M04-04 Containerizing FastAPI backends
- M12-08 Session and token lifecycle

### Self-quiz
1. Postman se API chal rahi hai, browser se nahi. Kaunse 2 cheezein DevTools mein sabse pehle check karoge?
2. Kya CORS ek attacker ko curl se aapka `/claims` endpoint call karne se rokta hai? Agar nahi, to kya rokta hai?
3. `fetch` mein `Authorization` header add karte hi CORS error aane laga, bina header ke nahi. Kyun?
4. Bearer token (header) wale API mein bhi `allow_credentials=True` ki zaroorat kab padti hai aur kab nahi?
