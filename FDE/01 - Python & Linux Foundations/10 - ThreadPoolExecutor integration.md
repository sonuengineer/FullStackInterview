# Python & Linux Foundations

## ThreadPoolExecutor integration

> Core | Fast CP1 / Slow CP1 | ~1.2 h | Builds on: M01-06, M01-07, M01-09

### Kahani
Ek logistics customer ka async worker LLM se delivery notes classify karta hai -- woh hissa aapne M01-07 mein bana liya.
Ab result unke purane Oracle/SOAP system mein likhna hai, aur unka official SDK sirf sync hai. Async version exist hi nahi karta.
Pehli try: `async def` ke andar seedha `sdk.save(...)` -- har save 300 ms, loop freeze, LLM calls bhi serial ho gayi.
Doosri try: har save ke liye naya `threading.Thread` -- 2,000 threads, customer ke DB pe 2,000 connections, DBA ka phone aaya.
Chahiye: sync code ko loop se bahar, lekin ek bounded pool mein.

### What it is
**`ThreadPoolExecutor`** ek fixed size thread pool hai (`concurrent.futures`). Asyncio ke saath `await loop.run_in_executor(pool, fn, *args)` sync function ko pool ke kisi thread pe chalata hai aur ek awaitable deta hai -- loop free rehta hai.
`asyncio.to_thread(fn, ...)` iska shortcut hai jo loop ka default pool use karta hai. JS mein closest cheez `worker_threads` pool ya libuv ka threadpool hai jo `fs`/`crypto` ke liye Node khud chalata hai.

### Why it matters for an FDE
Enterprise customers ke paas sync-only SDKs bahut hote hain (SOAP, ODBC, legacy DB drivers, SFTP libs). Bounded pool se aap async service mein unhe use kar sakte ho bina loop block kiye aur bina customer ke system ko connections se flood kiye.

### Key concepts
- **`run_in_executor(pool, fn, *args)`** -- sync -> awaitable; kwargs ke liye `functools.partial`.
- **Bounded pool = backpressure** -- `max_workers` hi max concurrent DB connections hai; ise DBA ke limit se match karo, env var se.
- **Timeout ka sach** -- `asyncio.timeout` sirf aapka `await` cancel karta hai; thread mein chal raha sync call rukta NAHI. Real timeout SDK/driver level pe bhi set karo.
- **Thread safety** -- sync clients aksar thread-safe nahi hote (jaise `sqlite3` connection); har thread ka apna connection (`threading.local`) ya har call pe naya.
- **Wapas loop pe** -- thread se coroutine chalani ho to `asyncio.run_coroutine_threadsafe(coro, loop)`.

### Code example
stdlib only

```python
# runnable
import asyncio
import functools
import sqlite3
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

DB = Path(tempfile.mkdtemp()) / "notes.db"
_local = threading.local()
active, peak, lock = 0, 0, threading.Lock()


def get_conn():
    """One sqlite connection per worker thread -- sqlite3 objects must not cross threads."""
    if not hasattr(_local, "conn"):
        _local.conn = sqlite3.connect(DB, timeout=5)
    return _local.conn


def save_label(note_id: str, label: str, *, slow: float = 0.05) -> str:
    """The customer's sync-only SDK call (blocking)."""
    global active, peak
    with lock:
        active += 1
        peak = max(peak, active)
    try:
        time.sleep(slow)                              # legacy system latency
        conn = get_conn()
        with conn:                                    # commit or rollback
            conn.execute("INSERT INTO labels VALUES (?, ?)", (note_id, label))
        return threading.current_thread().name
    finally:
        with lock:
            active -= 1


async def fake_llm_classify(note_id: str) -> str:    # stands in for an async LLM call
    await asyncio.sleep(0.02)
    return "urgent" if note_id.endswith("7") else "normal"


async def handle(note_id, pool):
    loop = asyncio.get_running_loop()
    label = await fake_llm_classify(note_id)
    return await loop.run_in_executor(pool, functools.partial(save_label, note_id, label))


async def main():
    with sqlite3.connect(DB) as c:
        c.execute("CREATE TABLE labels (id TEXT PRIMARY KEY, label TEXT)")
    with ThreadPoolExecutor(max_workers=4, thread_name_prefix="db") as pool:
        t0 = time.perf_counter()
        async with asyncio.TaskGroup() as tg:
            tasks = [tg.create_task(handle(f"n{i}", pool)) for i in range(40)]
        took = time.perf_counter() - t0
        threads = {t.result() for t in tasks}
        print(f"40 notes in {took:.2f}s on threads {sorted(threads)}, peak={peak}")
        assert peak <= 4 and len(threads) <= 4 and took < 40 * 0.05

        loop = asyncio.get_running_loop()
        fut = loop.run_in_executor(pool, functools.partial(save_label, "late", "x", slow=0.5))
        try:
            async with asyncio.timeout(0.1):
                await fut
        except TimeoutError:
            print("await timed out, but the thread is still running...")
        await asyncio.sleep(0.6)                      # the sync call finished anyway

    rows = sqlite3.connect(DB).execute("SELECT COUNT(*) FROM labels").fetchone()[0]
    assert rows == 41, "the 'timed out' write still happened"
    print("OK: bounded pool, loop stayed free, timeout does not stop threads")


asyncio.run(main())
```

- `run_in_executor(pool, partial(...))` -- loop kabhi block nahi hota; LLM calls aur DB writes overlap karte hain. Total time 40 x 50 ms serial (2 s) se kaafi kam.
- `max_workers=4` -- `peak <= 4` prove karta hai ki customer DB pe kabhi 4 se zyada connections nahi gaye. Yahi bounded pool ka faayda hai.
- `threading.local()` -- har thread apna sqlite connection rakhta hai; ek connection ko kai threads mein share karna error ya corruption deta hai.
- Timeout demo -- `asyncio.timeout` ne `await` chhod diya, lekin row phir bhi likhi gayi (41 rows). Production mein: SDK/driver ka apna timeout + idempotent writes.
- `thread_name_prefix="db"` -- logs aur `py-spy`/stack dumps mein turant dikhta hai kaunsa pool kya kar raha hai.

### Mini-exercise (30-60 min)
CP1 capstone ka doosra hissa -- M01-07 wale `fde-exercises/m01_async_worker/worker.py` mein:
- Har successful summary ko ek sync "legacy" store mein likho (`sqlite3`, ya ek fake `LegacySDK.save()` jo `time.sleep(0.2)` kare) -- `run_in_executor` + `ThreadPoolExecutor(max_workers=DB_WORKERS)` (env var).
- Pool ko `main()` mein ek baar banao aur worker ko pass karo (har call pe naya pool mat banao).
- Writes ko idempotent banao (`INSERT OR REPLACE` / primary key), kyunki timeout ke baad bhi write ho sakta hai.
- Acceptance: pytest -- 50 jobs, DB mein 50 unique rows (dead letters ko chhod ke), peak concurrent DB calls <= DB_WORKERS, aur ek "heartbeat" task (M01-06) ka worst gap < 100 ms poore run mein. Repo README mein "how to run" + ek architecture diagram (ASCII) add karo -- yahi CP1 build deliverable hai.

### Common pitfalls
- `max_workers` bina soche bada rakhna -- customer DB/SOAP endpoint overload. Unke documented limit se chhota rakho.
- Thread mein bina timeout ka sync network call -- hang hua thread pool ka slot hamesha ke liye kha jaata hai; 4 hangs = poora pool dead.
- CPU-heavy kaam thread pool mein daalna -- GIL ki wajah se parallel nahi chalega (M01-09); uske liye `ProcessPoolExecutor`.

### Checklist before moving on
- [ ] Main sync SDK ko async service mein `run_in_executor` / `to_thread` se use kar sakta hoon.
- [ ] Mujhe pata hai pool size customer ke connection limit se kaise judta hai.
- [ ] Mujhe pata hai ki asyncio timeout thread ke andar ka kaam nahi rokta.
- [ ] Mera capstone worker async LLM calls + bounded sync DB writes dono karta hai.

### Related
- M01-07 Coroutines and tasks
- M01-09 Concurrency vs parallelism
- M01-15 Environment variable configurations (pool sizes from env)
- M11-10 Establishing secure connections using Python-native drivers (pyodbc, oracledb) and SQLAlchemy

### Self-quiz
1. `asyncio.to_thread` aur `loop.run_in_executor(my_pool, ...)` mein kab kaunsa use karoge?
2. `asyncio.timeout(1)` expire hua jab executor mein ek sync DB insert chal raha tha. Insert ka kya hua? Ye kyun dangerous hai?
3. Customer DB 10 connections allow karta hai aur aapke 3 pods hain. `max_workers` kya rakhoge?
4. Ek `sqlite3` connection ko sab threads mein share kyun nahi karna chahiye?
