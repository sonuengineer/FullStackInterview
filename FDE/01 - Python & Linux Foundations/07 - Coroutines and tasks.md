# Python & Linux Foundations

## Coroutines and tasks

> Core | Fast CP1 / Slow CP1 | ~1.2 h | Builds on: M01-04, M01-06

### Kahani
Ek SaaS customer chahta hai ki unke 500 support tickets ka LLM se summary + priority banaye, har subah 9 baje se pehle.
Pehla version `for t in tickets: await summarize(t)` -- har call 3 s, total 25 minute. Manager khush nahi.
Doosra version: sab 500 ek saath fire -- LLM provider ne 429 (rate limit) phenk diya, aur ek ticket ka hang hua call poore job ko 10 minute rok ke baitha raha.
Aapko chahiye: concurrent calls, lekin limit ke andar, har call pe timeout, aur ek fail ho to baaki ka kya hoga ye clearly decide.

### What it is
**Coroutine** = `async def` function call karne se jo object milta hai; wo tab tak chalta hi nahi jab tak use `await` na karo ya Task na banao (JS Promise se fark: Promise banate hi chal padta hai).
**Task** = loop pe schedule kiya hua coroutine (`asyncio.create_task`) -- ye "started Promise" jaisa hai. `gather` ~ `Promise.all`, `TaskGroup` ~ structured `Promise.all` jo ek failure pe baaki tasks ko cancel bhi kar deta hai.

### Why it matters for an FDE
Customer ke LLM/CRM calls slow aur rate-limited hote hain. Sahi concurrency (Semaphore + timeout + retry) se job 25 min se 1 min ho jaati hai bina provider ko DDoS kiye; galat concurrency se 429s, hung jobs aur leaked tasks.

### Key concepts
- **Coroutine vs Task** -- `summarize(t)` sirf coroutine object hai (lazy); `create_task(summarize(t))` use turant schedule karta hai (eager, Promise jaisa).
- **`asyncio.gather(*aws)`** -- `Promise.all`; `return_exceptions=True` se `Promise.allSettled` jaisa. Ek fail ho to baaki by default cancel NAHI hote.
- **`asyncio.TaskGroup`** -- structured concurrency: block se bahar tab niklo jab sab tasks khatam; ek fail -> baaki cancel -> `ExceptionGroup` (M01-04 ka `except*`).
- **`asyncio.timeout(s)`** -- har await pe deadline; expire hone pe andar `CancelledError`, bahar `TimeoutError`.
- **`asyncio.Semaphore(n)`** -- max n calls ek saath; rate limit / connection pool ke andar rehne ka simple tareeka.

### Code example
stdlib only

```python
# runnable
import asyncio
import time


class FakeLLM:
    """Same shape as an async SDK call: await client.complete(prompt). No network."""
    def __init__(self):
        self.in_flight = 0
        self.max_in_flight = 0
        self.calls = {}

    async def complete(self, prompt: str) -> str:
        self.calls[prompt] = self.calls.get(prompt, 0) + 1
        self.in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self.in_flight)
        try:
            if prompt == "ticket-7" and self.calls[prompt] == 1:
                await asyncio.sleep(5)            # first call hangs (provider stall)
            await asyncio.sleep(0.1)
            return f"summary of {prompt}"
        finally:
            self.in_flight -= 1


async def summarize(llm, sem, ticket, attempts=3):
    for attempt in range(1, attempts + 1):
        async with sem:                           # at most N calls in flight
            try:
                async with asyncio.timeout(0.5):  # per-call deadline
                    return await llm.complete(ticket)
            except TimeoutError:
                if attempt == attempts:
                    raise
        await asyncio.sleep(0.05 * 2 ** attempt)  # backoff outside the semaphore


async def main():
    llm, sem = FakeLLM(), asyncio.Semaphore(5)
    tickets = [f"ticket-{i}" for i in range(20)]

    coro = summarize(llm, sem, "lazy")            # coroutine: nothing has run yet
    assert llm.calls == {}
    coro.close()                                  # avoid "never awaited" warning

    t0 = time.perf_counter()
    async with asyncio.TaskGroup() as tg:         # structured Promise.all
        tasks = [tg.create_task(summarize(llm, sem, t)) for t in tickets]
    took = time.perf_counter() - t0
    results = [t.result() for t in tasks]
    print(f"20 tickets in {took:.2f}s, max in flight = {llm.max_in_flight}")
    assert results[7] == "summary of ticket-7" and llm.calls["ticket-7"] == 2
    assert llm.max_in_flight <= 5 and took < 2.0   # serial would be 2s + 5s hang

    async def boom():
        await asyncio.sleep(0.05)
        raise ValueError("bad ticket")

    slow = None
    try:
        async with asyncio.TaskGroup() as tg:
            slow = tg.create_task(asyncio.sleep(10))
            tg.create_task(boom())
    except* ValueError as eg:
        print("TaskGroup failed:", eg.exceptions)
    assert slow.cancelled(), "sibling task must be cancelled"

    out = await asyncio.gather(boom(), asyncio.sleep(0, "fine"), return_exceptions=True)
    assert isinstance(out[0], ValueError) and out[1] == "fine"   # like Promise.allSettled
    print("OK: semaphore + timeout + retry + structured cancellation")


asyncio.run(main())
```

- `summarize(llm, sem, "lazy")` ke baad `llm.calls` khaali hai -- coroutine lazy hai. JS mein `fetch()` likhte hi request chali jaati; yahan `await`/`create_task` chahiye.
- `async with sem` -- 20 tickets, lekin ek waqt pe max 5 provider ke paas. Backoff semaphore ke bahar hai taaki sota hua retry slot na roke.
- `asyncio.timeout(0.5)` -- ticket-7 ka hung call 0.5 s pe kat jaata hai aur retry pe pass hota hai. Bina timeout ke poora job 5 s ruk jaata.
- `TaskGroup` -- ek task fail hua to `slow` (10 s sleep) turant cancel; error `ExceptionGroup` mein aata hai, isliye `except*`.
- `gather(..., return_exceptions=True)` -- har result ya exception list mein; "best effort" batch ke liye useful.

### Mini-exercise (30-60 min)
CP1 capstone ka pehla hissa: `fde-exercises/m01_async_worker/worker.py`.
- `jobs.jsonl` (50 fake tickets) padho, `FakeLLM` (random latency 0.05-0.5 s, 10% `TimeoutError`, 5% hang) se summarize karo.
- `asyncio.Semaphore(CONCURRENCY)` (env var se, default 5), har call pe `asyncio.timeout`, 3 retries with exponential backoff + jitter.
- `TaskGroup` use karo, lekin ek ticket ke permanent fail hone pe poora batch cancel nahi hona chahiye -- failed tickets `dead_letter.jsonl` mein jaayein (hint: worker function andar hi exception pakde).
- Acceptance: pytest test -- 50 jobs, max in-flight <= CONCURRENCY, total time < serial time / 3, dead letter file mein sirf permanently failed IDs. M01-10 mein isi worker mein ek sync DB write add karoge.

### Common pitfalls
- `create_task(...)` ka reference na rakhna -- loop sirf weak reference rakhta hai, task beech mein garbage collect ho sakta hai. TaskGroup use karo ya tasks ko list/set mein rakho.
- Bare `except:` ya `except BaseException:` se `CancelledError` nigal jaana (Python 3.8+ mein ye `BaseException` subclass hai, isliye `except Exception` use nahi pakadta) -- cancellation aur timeouts toot jaate hain. Pakdo to re-raise karo.
- Sab kuch ek saath fire karna bina semaphore -- provider 429, cost spike, aur customer ka API down. Concurrency limit hamesha config se lo.

### Checklist before moving on
- [ ] Main coroutine aur Task ka fark JS Promise se compare karke bata sakta hoon.
- [ ] Mujhe pata hai `gather` aur `TaskGroup` failure pe alag kaise behave karte hain.
- [ ] Har external call pe maine `asyncio.timeout` lagaya hai.
- [ ] Semaphore se concurrency limit kar sakta hoon aur retry backoff semaphore ke bahar rakhta hoon.

### Related
- M01-04 Exception handling (ExceptionGroup, except*)
- M01-08 Async context managers
- M01-10 ThreadPoolExecutor integration
- M05-13 Handling multi-tool parallel execution

### Self-quiz
1. `results = [await f(x) for x in items]` aur `await asyncio.gather(*(f(x) for x in items))` mein timing ka kya fark hai, aur kyun?
2. TaskGroup ke andar ek task fail hua -- baaki tasks, aur `async with` block ke baad wala code, inke saath kya hota hai?
3. Aapka semaphore 5 hai lekin provider ka limit "60 requests per minute" hai. Kya semaphore kaafi hai? Aur kya chahiye?
4. `asyncio.timeout` expire hone pe coroutine ke andar kaunsi exception aati hai aur bahar kaunsi?
