# Modern API Development

## Dependency injection

> Core | Fast CP2 / Slow CP2 | ~1.2 h | Builds on: M02-01, M02-02, M01-15

### Kahani
Ek logistics SaaS customer ke liye aapki API mein 14 routes hain. Har route ke top pe wahi 6 lines copy-paste hain: header se API key padho, tenant nikalo, DB session kholo, settings load karo.
Ek route pe kisi ne `session.close()` bhool gaya -- 2 din baad connection pool khaali, poora API timeout.
Tests ke liye developer ne asli staging DB aur asli auth server hit kiye, CI har dusre din flaky.
Aapko chahiye: shared cheezein ek jagah define ho, har route bas "mujhe current user aur DB chahiye" bole, aur tests mein inhe fake se badalna ek line ka kaam ho.

### What it is
**Dependency injection** = function apni zaroorat (DB session, current user, settings) khud nahi banata; framework bana ke deta hai.
FastAPI mein ye `Depends(fn)` hai: route ke parameter mein likho, FastAPI har request pe `fn` chalata hai (aur uski apni dependencies bhi), result inject karta hai. NestJS ke providers + constructor injection jaisa, lekin class/module decorators ke bina -- sirf functions.

### Why it matters for an FDE
Customer ke paas har environment alag hota hai (SSO, DB, vault). DI se auth/DB/settings swap karna config ka kaam rehta hai, aur `dependency_overrides` se tests bina customer ke systems ke chal jaate hain -- CI green, aur demo laptop pe bhi.

### Key concepts
- **`Depends(get_x)`** -- route ya doosri dependency ke parameter mein; FastAPI call graph khud resolve karta hai (sub-dependencies).
- **`yield` dependency** -- `yield` se pehle setup (session kholo), baad mein teardown (close) -- `finally` mein rakho to error pe bhi chalega. Nest mein ye request-scoped provider + lifecycle hook jaisa.
- **Per-request caching** -- ek request mein `get_db` do jagah maanga to ek hi baar chalta hai (`use_cache=True` default).
- **Router/app level dependencies** -- `APIRouter(dependencies=[Depends(require_api_key)])` -- Express ka `router.use(authMiddleware)`, lekin typed aur docs mein dikhta hai.
- **`app.dependency_overrides[real] = fake`** -- tests mein real dependency ko fake se badlo; Nest ka `overrideProvider()`. M02-12 isi pe build karta hai.

### Code example
`pip install fastapi httpx pydantic`

```python
# runnable
from functools import lru_cache
from typing import Annotated

from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException
from fastapi.testclient import TestClient
from pydantic import BaseModel

EVENTS: list[str] = []


class Settings(BaseModel):
    api_keys: dict[str, str] = {"key-acme": "acme", "key-globex": "globex"}  # key -> tenant


@lru_cache                               # build once per process, like a singleton provider
def get_settings() -> Settings:
    return Settings()


class FakeSession:
    def __init__(self):
        self.closed = False


def get_db():
    db = FakeSession()
    EVENTS.append("open")
    try:
        yield db                         # route runs here
    finally:
        db.closed = True                 # teardown runs even if the route raised
        EVENTS.append("close")


def get_tenant(x_api_key: Annotated[str | None, Header()] = None,
               settings: Settings = Depends(get_settings)) -> str:
    tenant = settings.api_keys.get(x_api_key or "")
    if tenant is None:
        raise HTTPException(status_code=401, detail="invalid api key")
    return tenant


Tenant = Annotated[str, Depends(get_tenant)]     # reusable alias
DB = Annotated[FakeSession, Depends(get_db)]

router = APIRouter(prefix="/documents", dependencies=[Depends(get_tenant)])


@router.get("")
def list_docs(tenant: Tenant, db: DB, db_again: DB):
    assert db is db_again                # same request -> dependency cached
    return {"tenant": tenant, "db_open": not db.closed}


app = FastAPI()
app.include_router(router)

c = TestClient(app)
assert c.get("/documents").status_code == 401
r = c.get("/documents", headers={"X-API-Key": "key-acme"})
assert r.json() == {"tenant": "acme", "db_open": True}
assert EVENTS == ["open", "close"], EVENTS       # one session per request, then closed

app.dependency_overrides[get_tenant] = lambda: "test-tenant"   # what tests do (M02-12)
assert c.get("/documents").json()["tenant"] == "test-tenant"   # no header needed
app.dependency_overrides.clear()                               # always clean up
assert c.get("/documents").status_code == 401
print("OK: Depends graph, yield teardown, per-request cache, dependency_overrides")
```

- `get_settings` + `@lru_cache` -- settings ek baar bante hain; tests mein `get_settings` ko override karke alag config de sakte ho bina env vars chhede.
- `get_db` ka `try/yield/finally` -- `EVENTS == ["open", "close"]` proof hai ki har request ke baad session close hua. Kahani wala pool leak yahi rokta hai.
- `get_tenant` khud `Depends(get_settings)` maangta hai -- sub-dependency. Header `X-API-Key` FastAPI `x_api_key` naam se map karta hai (underscore -> hyphen).
- `Tenant = Annotated[str, Depends(get_tenant)]` -- ek alias, har route mein `tenant: Tenant`; copy-paste khatam.
- `db is db_again` -- per-request cache; agar har baar naya chahiye to `Depends(get_db, use_cache=False)`.
- `dependency_overrides` -- key = original function object, value = fake. `clear()` bhoole to agla test bhi fake use karega.

### Mini-exercise (30-60 min)
`omniguard` mein `app/deps.py` banao.
- `get_settings()` (`@lru_cache`, `pydantic-settings` ya env vars se `OMNIGUARD_API_KEYS`), `get_db()` (abhi in-memory store, M02-05 mein SQLAlchemy session), `get_current_user()` -- auth stub: `Authorization: Bearer <token>` header, fake token table se `User(id, tenant, roles)` return, warna 401 + `WWW-Authenticate: Bearer`.
- `/documents` router pe `dependencies=[Depends(get_current_user)]`; `/health` public rahe.
- `tests/test_auth.py`: override `get_current_user` se `User(roles=["admin"])` inject karke ek test, aur bina override ke 401 wala test.
- Acceptance: `pytest -q` green, koi test network ya env var pe depend nahi karta. M12 mein yahi stub real JWT validation (M12-02) ban jaayega.

### Common pitfalls
- `Depends(get_db())` likhna (call kar diya) -- `Depends` ko function chahiye, result nahi. Galti pe ajeeb errors ya ek hi object sab requests mein share.
- `yield` dependency mein `finally` na lagana -- route exception pe teardown skip, connections leak. Aur teardown mein slow kaam (emails, uploads) mat karo -- wo background task hai.
- Module-level global client (`db = connect()` import time pe) -- tests override nahi kar sakte aur import pe hi real DB hit. Lifespan (M02-05) mein banao, dependency se do.

### Checklist before moving on
- [ ] `Depends`, sub-dependency aur `yield` dependency ka flow bata sakta hoon.
- [ ] NestJS provider ko FastAPI dependency mein map kar sakta hoon.
- [ ] Router-level auth dependency laga sakta hoon.
- [ ] `dependency_overrides` se test mein fake inject karke `clear()` karna yaad hai.

### Related
- M01-15 Environment variable configurations
- M02-05 Building scalable CRUD endpoints
- M02-12 Fixtures and mocking
- M12-02 Understanding JWT tokens
- M12-09 API keys vs service accounts

### Self-quiz
1. Ek request mein `get_db` ko route aur `get_current_user` dono maangte hain. Kitne sessions khulenge, aur kyun?
2. `yield` dependency mein `finally` hata do aur route `HTTPException` raise kare -- kya hoga?
3. Express middleware (`app.use(auth)`) aur FastAPI router dependency mein kya fark hai -- route ko auth ka result kaise milta hai?
4. Test mein `dependency_overrides` set karke `clear()` bhool gaye. Kaunsa doosra test aur kaise galat pass/fail hoga?
