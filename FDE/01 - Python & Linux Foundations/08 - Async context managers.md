# Python & Linux Foundations

## Async context managers

> Core | Fast CP1 / Slow CP1 | ~1.2 h | Builds on: M01-04, M01-07

### Kahani
Ek bank customer ke paas aapka async service unke core-banking gateway se baat karta hai. Gateway sirf 20 concurrent connections allow karta hai.
Load test ke 15 minute baad sab requests "pool exhausted" pe fail hone lagi. Restart karo, phir 15 minute baad wahi.
Root cause: timeout ya exception aane pe code `await conn.close()` tak pahunchta hi nahi tha -- connections leak ho rahe the.
JS mein aap `try { ... } finally { await conn.release() }` likhte. Python ka cleaner jawab hai `async with`.

### What it is
**Async context manager** ek object hai jiske paas `async def __aenter__` aur `async def __aexit__` hote hain; `async with x as y:` setup await karta hai aur block khatam hone pe -- success, exception ya cancellation -- cleanup bhi await karta hai.
Shortcut: `contextlib.asynccontextmanager` se ek `async def` generator likho -- `yield` se pehle setup, `finally` mein cleanup. `AsyncExitStack` se runtime pe kai resources manage hote hain.

### Why it matters for an FDE
Customer systems mein connections, locks, temp files, DB transactions limited aur expensive hote hain. Leak hone pe outage hota hai jo sirf load pe dikhta hai -- yaani production mein, demo mein nahi.

### Key concepts
- **`__aenter__` / `__aexit__`** -- `__aexit__(exc_type, exc, tb)` ko error ki info milti hai; `True` return karoge to exception dab jaayegi (aam taur pe mat karo).
- **`@asynccontextmanager`** -- generator style; `try: yield conn` / `finally: await conn.close()` -- sabse common pattern.
- **Cancellation safe** -- `asyncio.timeout` ya TaskGroup cancel kare tab bhi `finally` chalta hai, isliye pool slot wapas aata hai.
- **`AsyncExitStack`** -- jab resources ki sankhya runtime pe pata chale (N tenants ke N clients); sab reverse order mein close.
- **FastAPI `lifespan`** -- app startup pe shared client/pool banana aur shutdown pe band karna -- yahi pattern, app level pe.

### Code example
`pip install fastapi httpx` (only for the lifespan part; `TestClient` needs httpx)

```python
# runnable
import asyncio
from contextlib import AsyncExitStack, asynccontextmanager, suppress

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient


class FakeGatewayPool:
    """Stands in for an async connection pool to the customer's core-banking gateway."""
    def __init__(self, size):
        self.free = size
        self.closed = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        self.closed = True
        return False                     # never swallow the error

    @asynccontextmanager
    async def connection(self):
        if self.free == 0:
            raise RuntimeError("pool exhausted")
        self.free -= 1
        try:
            yield f"conn-{self.free}"
        finally:
            self.free += 1               # runs on success, error AND cancellation


async def slow_query(pool):
    async with pool.connection():
        await asyncio.sleep(5)           # gateway hangs


async def main():
    async with FakeGatewayPool(size=2) as pool:
        for _ in range(5):               # 5 timeouts would leak 5 conns without finally
            with suppress(TimeoutError):
                async with asyncio.timeout(0.05):
                    await slow_query(pool)
        assert pool.free == 2, "connections must come back after timeouts"

        with suppress(ValueError):
            async with pool.connection():
                raise ValueError("bad account id")
        assert pool.free == 2

    assert pool.closed
    async with AsyncExitStack() as stack:  # N tenants, decided at runtime
        pools = [await stack.enter_async_context(FakeGatewayPool(1)) for _ in range(3)]
    assert all(p.closed for p in pools)
    print("OK: no leaks after timeout, error, and stack exit")


asyncio.run(main())


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with FakeGatewayPool(size=20) as pool:   # startup
        app.state.pool = pool
        yield                                      # app serves requests here


app = FastAPI(lifespan=lifespan)


@app.get("/balance")
async def balance(request: Request):
    async with request.app.state.pool.connection() as conn:
        return {"conn": conn, "free_during_call": request.app.state.pool.free}


with TestClient(app) as client:                    # runs lifespan startup/shutdown
    assert client.get("/balance").json()["free_during_call"] == 19
assert app.state.pool.closed
print("OK: FastAPI lifespan opened and closed the pool")
```

- `connection()` ka `finally` hi pura fix hai -- 5 timeouts ke baad bhi `free == 2`. `finally` ke bina pehle 2 timeouts ke baad hi "pool exhausted".
- `asyncio.timeout` andar `CancelledError` daalta hai; `async with` ka cleanup phir bhi chalta hai -- yahi "cancellation safe" ka matlab hai.
- `__aexit__` `False` return karta hai -- error caller tak jaati hai. `True` return karna = silent bug.
- `AsyncExitStack` loop mein bane 3 pools ko bhi ek saath band karta hai, reverse order mein.
- `lifespan` -- FastAPI ka current tareeka (purana `@app.on_event` deprecated hai). `TestClient` ko `with` mein use karoge tabhi lifespan chalta hai.

### Mini-exercise (30-60 min)
`fde-exercises/m01_async_cm/` mein:
- `RateLimitedClient` likho jo async context manager ho: enter pe fake "login" (token lo), exit pe "logout", aur ek `request()` method jo andar `asyncio.Semaphore` use kare.
- Ek `@asynccontextmanager` `transaction(db)` likho jo success pe `commit`, exception pe `rollback` call kare (fake db object jo calls record kare).
- Acceptance (pytest + `asyncio.run` ya `pytest-asyncio` agar installed ho): exception, timeout aur normal exit -- teeno cases mein logout hota hai; exception pe sirf rollback, commit nahi.

### Common pitfalls
- Async resource ko sync `with` mein use karna ya `async with` ke bahar connection object ko kahin store kar lena -- block ke baad wo closed/returned hai.
- Har request pe naya HTTP client / pool banana (`async with httpx.AsyncClient()` inside endpoint) -- TCP + TLS handshake har baar, slow aur sockets khatam. Lifespan mein ek shared client banao.
- Cleanup ke andar lamba await (network logout) bina timeout -- shutdown hang ho jaata hai. Cleanup pe bhi chhota timeout lagao.

### Checklist before moving on
- [ ] Main `__aenter__`/`__aexit__` aur `@asynccontextmanager` dono style mein likh sakta hoon.
- [ ] Mujhe pata hai timeout/cancel hone pe bhi `finally` chalta hai.
- [ ] Maine FastAPI `lifespan` mein shared resource banaya aur band kiya.
- [ ] `AsyncExitStack` kab use karna hai ye pata hai.

### Related
- M01-07 Coroutines and tasks
- M01-04 Exception handling
- M02-03 Dependency injection
- M04-13 Health and readiness checks

### Self-quiz
1. `__aexit__` `True` return kare to kya hota hai, aur ye kab sahi ho sakta hai?
2. Ek endpoint har request pe `async with httpx.AsyncClient()` banata hai. Load pe kya problem aayegi aur fix kya hai?
3. Timeout ne coroutine cancel kiya -- connection pool ka slot wapas kaise aaya? Step by step batao.
4. JS mein ye same guarantee kaise milti hai, aur Python ka tareeka kis cheez mein better hai?
