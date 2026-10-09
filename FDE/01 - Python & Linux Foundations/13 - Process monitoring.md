# Python & Linux Foundations

## Process monitoring

> Core | Fast CP1 / Slow CP1 | ~1.2 h | Builds on: M01-09, M01-11

### Kahani
Ek bank ke on-prem Linux VM pe aapka document-ingestion worker chal raha hai. Customer ka message: "Har 2-3 din mein server slow ho jaata hai, phir worker gayab."
Aapke paas Kubernetes dashboard nahi hai, sirf SSH access aur ek ghanta.
`top` kholte hi dikha: worker ka memory 300 MB se 7 GB tak badh chuka hai, phir kernel ka OOM killer use maar deta hai, aur systemd restart karta hai.
FDE ka kaam yahan hai: process ko dekhna, numbers padhna, logs se story jodna -- aur ek chhota watchdog lagana jab tak asli leak fix ho.

### What it is
**Process monitoring** matlab ek running program ka CPU, memory (RSS), threads, open files, child processes aur state dekhna -- shell tools (`ps`, `top`, `htop`, `journalctl`) se ya code se (`psutil`).
Linux mein har process ka ek **PID** hai aur uski info `/proc/<pid>/` mein hoti hai; tools wahi padhte hain. `psutil` same cheez Linux, macOS aur Windows pe ek API se deta hai.

### Why it matters for an FDE
Customer ke servers pe aksar aapka observability stack nahi hota. Memory leak, zombie child processes, ya 100% CPU wala hung worker -- inhe 5 minute mein pakadna aur safe tareeke se restart karna aapki credibility hai.

### Key concepts
- **RSS vs VMS** -- RSS = actual RAM jo process use kar raha hai (leak yahin dikhta hai); VMS = reserved virtual address space (aksar bahut bada, misleading).
- **`cpu_percent(interval)`** -- do samples ke beech ka CPU use; pehli call 0.0 deti hai. 100% = ek core poora.
- **Process tree** -- worker ke children (subprocess, multiprocessing) bhi count karo; parent maara to orphans reh sakte hain.
- **Graceful stop** -- pehle `SIGTERM` (`terminate()`), wait with timeout, phir `SIGKILL` (`kill()`). Windows pe dono hard stop hain.
- **Logs** -- systemd services ke logs `journalctl -u <service>`; OOM kills kernel log (`journalctl -k`, `dmesg`) mein dikhte hain.

### Code example
`pip install psutil`

```python
# runnable
import subprocess
import sys
import time

import psutil

# A fake leaky worker: grows its memory by ~5 MB every 0.1 s.
LEAKY_WORKER = """
import time
leak = []
while True:
    leak.append(bytearray(5 * 1024 * 1024))
    time.sleep(0.1)
"""


def snapshot(proc: psutil.Process) -> dict:
    tree = [proc] + proc.children(recursive=True)  # worker + its children (a venv
    rss = 0                                        # launcher on Windows is a parent too)
    for p in tree:
        with p.oneshot():                          # read /proc once for all fields
            rss += p.memory_info().rss
    return {"pid": proc.pid, "status": proc.status(), "rss_mb": round(rss / 2**20, 1),
            "threads": proc.num_threads(), "children": len(tree) - 1}


def stop(proc: psutil.Process, timeout: float = 3.0) -> str:
    tree = proc.children(recursive=True) + [proc]
    for p in tree:
        p.terminate()                              # SIGTERM on Linux: let it clean up
    _, alive = psutil.wait_procs(tree, timeout=timeout)
    for p in alive:
        p.kill()                                   # SIGKILL: last resort
    psutil.wait_procs(alive, timeout=timeout)
    return "killed" if alive else "terminated"


def watchdog(limit_mb: float, max_seconds: float = 10.0) -> list:
    child = subprocess.Popen([sys.executable, "-c", LEAKY_WORKER])
    proc = psutil.Process(child.pid)
    proc.cpu_percent(None)                        # prime the CPU counter
    history, t0 = [], time.monotonic()
    while time.monotonic() - t0 < max_seconds:
        time.sleep(0.3)
        snap = snapshot(proc)
        snap["cpu"] = proc.cpu_percent(None)       # parent only; sum the tree in real tools
        history.append(snap)
        print(snap)
        if snap["rss_mb"] > limit_mb:
            print(f"RSS {snap['rss_mb']} MB > {limit_mb} MB -> stopping:", stop(proc))
            break
    else:
        stop(proc)
        raise AssertionError("watchdog never fired")
    return history


history = watchdog(limit_mb=80)
assert history[-1]["rss_mb"] > 80
assert history[-1]["rss_mb"] > history[0]["rss_mb"], "memory should grow over time"
assert not psutil.pid_exists(history[-1]["pid"]) or \
    psutil.Process(history[-1]["pid"]).status() == psutil.STATUS_ZOMBIE

me = psutil.Process()
print("this script:", snapshot(me), "| system RAM used %:", psutil.virtual_memory().percent)
print("OK: watched a leaking child, stopped it at the limit")
```

- `subprocess.Popen` + `psutil.Process(pid)` -- hum khud ek child start karte hain, phir usko PID se observe karte hain; real life mein PID `pgrep -f worker` se milta.
- `[proc] + proc.children(recursive=True)` -- RSS poore process tree ka jodo. Workers aksar children spawn karte hain (multiprocessing, `venv` launcher on Windows); sirf parent dekhoge to leak miss hoga. `oneshot()` har process ki fields ek saath padhta hai.
- `cpu_percent(None)` pehle prime karo, warna pehli reading hamesha 0.0 hogi.
- `stop()` -- poore tree ko pehle polite `terminate()`, `psutil.wait_procs` timeout ke baad bache hue ko `kill()`. Seedha `kill -9` se half-written batch / temp files / orphan children reh jaate hain.
- Asserts prove karte hain: RSS badha, limit cross hui, aur process ab zinda nahi hai.

Same investigation on a Linux box (shell):

```bash
pgrep -af worker                         # find the PID and full command line
ps -o pid,ppid,stat,%cpu,%mem,rss,etime,cmd -p "$(pgrep -f worker | head -1)"
ps aux --sort=-rss | head -5             # top 5 memory users
top -o %MEM                              # live view; press 1 for per-core CPU, q to quit
htop                                     # nicer top: F5 tree view, F6 sort, F9 send signal
journalctl -u ingest-worker --since "1 hour ago" --no-pager | tail -50
journalctl -k | grep -i "out of memory"  # did the kernel OOM killer fire?
systemctl status ingest-worker           # state, restarts, last log lines
kill -TERM 12345                         # graceful stop (replace with the real PID)
```

### Mini-exercise (30-60 min)
`fde-exercises/m01_procmon/` mein `procmon.py` CLI banao:
- `python procmon.py --pid <PID> --rss-limit-mb 500 --interval 2 --out metrics.csv` -- har interval pe pid, rss_mb, cpu, threads, children CSV mein likho.
- Limit cross ho to log warning + optional `--restart-cmd "..."` chalao (graceful stop, phir command).
- Test: is lesson ka leaky worker start karo, procmon attach karo, CSV mein RSS badhta dikhna chahiye aur watchdog fire hona chahiye. CSV ko ek line chart mein (koi bhi free tool) dekho.

### Common pitfalls
- VMS ya `top` ka VIRT column dekh ke panic karna -- leak ke liye RSS trend (time ke saath) dekho, ek reading nahi.
- Monitoring loop khud heavy bana dena (har 50 ms poora process tree scan) -- monitor hi CPU kha jaata hai.
- Customer ke server pe `kill -9` pehle chalana, ya logs/metrics mein command-line args print karna jinme passwords/tokens ho sakte hain (`ps aux` sab dikhata hai -- secrets args mein kabhi mat do).

### Checklist before moving on
- [ ] Main RSS aur VMS ka fark bata sakta hoon.
- [ ] Main `ps`, `top`/`htop` aur `journalctl` se ek process ki health 5 minute mein bata sakta hoon.
- [ ] Main psutil se kisi PID ka CPU/memory padh sakta hoon.
- [ ] Mujhe SIGTERM -> wait -> SIGKILL ka order aur reason pata hai.

### Related
- M01-09 Concurrency vs parallelism (process pools, children)
- M01-14 Shell scripting basics
- M04-13 Health and readiness checks
- M14-11 Monitoring granular token costs and endpoint latency

### Self-quiz
1. Worker ka RSS har ghante 200 MB badh raha hai lekin CPU normal hai. Aap kya hypotheses banaoge aur kaise check karoge?
2. `terminate()` aur `kill()` mein kya fark hai, aur worker code ko SIGTERM pe kya karna chahiye?
3. Worker gayab ho gaya aur app logs mein kuch nahi. Kahan dekhoge?
4. `ps aux` output customer ke saath share karne se pehle kya check karoge?
