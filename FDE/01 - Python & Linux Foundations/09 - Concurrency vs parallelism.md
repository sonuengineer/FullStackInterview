# Python & Linux Foundations

## Concurrency vs parallelism

> Core | Fast CP1 / Slow CP1 | ~1.2 h | Builds on: M01-06, M01-07

### Kahani
Ek insurance customer ke paas 2,000 scanned claim PDFs hain. Pipeline do kaam karti hai: har PDF ka text nikaalo (CPU heavy), phir LLM se fields extract karo (network wait).
Aapne sab kuch `asyncio` mein daal diya -- LLM calls fast ho gayi, lekin text extraction utni hi slow, aur extraction ke dauraan API health check bhi fail.
Phir kisi ne threads try kiye -- 8 threads, 8 cores, lekin speed wahi. "Python slow hai" bolne se pehle samjho kaunsa kaam kis type ka hai.

### What it is
**Concurrency** = kai kaam ek saath "progress" mein, ek worker unke beech switch karta hai (asyncio, threads) -- waiting chhupane ke liye.
**Parallelism** = kai kaam sach mein ek hi pal mein, alag CPU cores pe (processes). Standard CPython mein **GIL** ek waqt pe ek hi thread ko Python bytecode chalane deta hai, isliye CPU-bound kaam ke liye threads parallel nahi hote; I/O wait ke dauraan GIL release hota hai, isliye I/O ke liye threads/asyncio kaam karte hain.

### Why it matters for an FDE
Galat tool chunoge to ya to speedup zero (CPU kaam threads mein) ya complexity bina faayde (simple I/O ke liye multiprocessing). Customer ko "8x faster" promise karne se pehle workload classify karo: I/O-bound ya CPU-bound.

### Key concepts
- **I/O-bound** -- zyada time wait mein (LLM, DB, HTTP, disk). Tool: `asyncio` (best), ya threads agar library sync hai.
- **CPU-bound** -- zyada time calculation mein (PDF parse, image resize, pure-Python loops). Tool: `ProcessPoolExecutor` / multiprocessing, ya C-backed library (numpy) jo GIL chhodti hai.
- **GIL** -- CPython ka lock; threads I/O pe help karte hain, CPU pe nahi. Python 3.13+ ka optional free-threaded build ise hata sakta hai -- check the docs for your version, default build mein GIL hai.
- **Node se compare** -- Node bhi single-threaded hai; CPU kaam ke liye `worker_threads`. Python mein equivalent mostly process pool hai.
- **Process cost** -- har process alag memory, startup time, aur args/results pickle hote hain; chhote tasks ke liye overhead > faayda.

### Code example
stdlib only

```python
# runnable
import asyncio
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor


def cpu_task(n: int) -> int:
    """Pure-Python CPU work (stands in for PDF text extraction)."""
    total = 0
    for i in range(n):
        total += i * i % 7
    return total


def io_task(_: int) -> str:
    time.sleep(0.2)                     # stands in for a sync HTTP/DB call
    return "ok"


def timed(label, fn):
    t0 = time.perf_counter()
    fn()
    took = time.perf_counter() - t0
    print(f"{label:<24} {took:5.2f}s")
    return took


async def io_async_all(jobs):
    async def one(_):
        await asyncio.sleep(0.2)        # async client: concurrency on one thread
    async with asyncio.timeout(5):
        await asyncio.gather(*(one(j) for j in jobs))


def main():
    jobs, N = list(range(4)), 2_000_000

    io_serial = timed("io serial", lambda: [io_task(j) for j in jobs])
    with ThreadPoolExecutor(4) as tp:
        list(tp.map(time.sleep, [0.05] * 4))  # warm up: start all 4 threads before timing
        io_threads = timed("io threads", lambda: list(tp.map(io_task, jobs)))
    io_aio = timed("io asyncio", lambda: asyncio.run(io_async_all(jobs)))
    assert io_threads < io_serial * 0.6 and io_aio < io_serial * 0.6

    cpu_serial = timed("cpu serial", lambda: [cpu_task(N) for _ in jobs])
    with ThreadPoolExecutor(4) as tp:
        cpu_threads = timed("cpu threads (GIL)", lambda: list(tp.map(cpu_task, [N] * 4)))
    with ProcessPoolExecutor(4) as pp:
        list(pp.map(time.sleep, [0.3] * 4))  # warm up: spawn all 4 workers before timing
        cpu_procs = timed("cpu processes", lambda: list(pp.map(cpu_task, [N] * 4)))

    gil = getattr(sys, "_is_gil_enabled", lambda: True)()
    if gil:
        assert cpu_threads > cpu_serial * 0.6, "threads should not speed up CPU work"
    if (os.cpu_count() or 1) >= 4:
        assert cpu_procs < cpu_serial * 0.85, "processes should run CPU work in parallel"
    print("OK: I/O -> threads/asyncio, CPU -> processes")


if __name__ == "__main__":              # required for ProcessPoolExecutor on Windows/macOS
    main()
```

- `io_task` mein `time.sleep` GIL chhod deta hai, isliye 4 threads ~0.2 s mein khatam (serial 0.8 s). `asyncio.gather` ek hi thread pe wahi result deta hai.
- `cpu_task` pure Python hai -- 4 threads lagbhag serial jitna time lete hain kyunki GIL ek waqt pe ek thread chalata hai.
- `ProcessPoolExecutor` har task alag process (alag GIL) mein chalata hai -- multi-core machine pe real speedup. Warm-up (`time.sleep` x4) chaaron workers pehle spawn kar deta hai, taaki timing mein spawn cost na aaye.
- `if __name__ == "__main__":` -- Windows/macOS pe child process file ko re-import karta hai; guard ke bina infinite spawn / error.
- Asserts free-threaded build aur kam cores ke liye guarded hain -- numbers machine pe depend karte hain, pattern nahi.

### Mini-exercise (30-60 min)
`fde-exercises/m01_concurrency/` mein ek `classify.py` banao:
- Teen fake workloads: (a) 20 fake LLM calls (`asyncio.sleep` random 0.1-0.3 s), (b) 20 "PDF parse" (`cpu_task`), (c) mixed -- har item pe pehle parse phir LLM.
- Har ek ko serial, threads, asyncio, processes se chalao aur ek table print karo (seconds).
- Mixed case ke liye best design implement karo: asyncio pipeline jo CPU step `loop.run_in_executor(process_pool, ...)` pe bheje.
- Acceptance: README mein 3 lines -- kaunsa workload kis tool se fastest tha aur kyun (GIL ka zikr).

### Common pitfalls
- CPU-heavy kaam asyncio loop pe chalana -- poora service (health checks bhi) us dauraan freeze (M01-06).
- Process pool mein bade objects bhejna (poori DataFrame, model) -- pickling cost speedup kha jaata hai; file path ya chhota ID bhejo.
- Container mein `os.cpu_count()` host ke cores batata hai, container ki CPU limit nahi -- workers count config/env se set karo (check your runtime's docs).

### Checklist before moving on
- [ ] Main kisi bhi task ko I/O-bound ya CPU-bound classify kar sakta hoon.
- [ ] Main GIL ko ek line mein explain kar sakta hoon aur bata sakta hoon kab ye matter nahi karta.
- [ ] Maine threads vs processes ka CPU benchmark khud chalaya hai.
- [ ] Mujhe pata hai Windows pe `__main__` guard kyun chahiye.

### Related
- M01-06 Event loop architecture
- M01-07 Coroutines and tasks
- M01-10 ThreadPoolExecutor integration
- M04-08 Auto-scaling policy configuration

### Self-quiz
1. Ek job 95% time LLM response ka wait karti hai. Processes use karoge ya asyncio? Kyun?
2. 8 threads, 8 cores, pure-Python loop -- speedup kyun nahi mila? numpy use karne se kya badal sakta hai?
3. Node ke `worker_threads` aur Python ke `ProcessPoolExecutor` mein memory aur data passing ka kya fark hai?
4. Ek FastAPI service ko image resize (CPU) aur S3 upload (I/O) dono karna hai. Architecture sketch karo.
