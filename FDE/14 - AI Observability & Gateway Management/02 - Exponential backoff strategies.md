# AI Observability & Gateway Management

## Exponential backoff strategies

> Core | Fast CP8 / Slow CP10 | ~1.2 h | Builds on: M14-01, M02-12

### Kahani
Ek bank ka document-summary batch job raat 2 baje 4,000 loan files process karta hai. 2:10 pe provider ne `429 Too Many Requests` dena shuru kiya.
Code mein `while True: try ... except: sleep(1)` tha -- 40 worker ek saath har second retry karte rahe, rate limit kabhi khula hi nahi.
Upar se ek file ka prompt galat format mein tha (`400`) -- wo bhi infinite retry mein ghoomta raha aur subah tak bill badhta raha.
Customer ka platform lead bolta hai: "Retry karo, lekin samajhdaari se -- aur kab rukna hai wo bhi pata ho."

### What it is
**Exponential backoff** = har failed attempt ke baad wait time double karna (`base * 2^attempt`), ek **cap** tak. **Full jitter** = us window mein random wait (`uniform(0, window)`) taaki saare clients ek saath wapas na aayein.
Saath mein: sirf retryable errors pe retry, `Retry-After` header ka respect, max attempts aur ek total deadline.

### Why it matters for an FDE
Galat retry logic outage ko lamba karta hai (thundering herd), non-retryable errors pe paisa jalata hai, aur user request ko minutes tak latka deta hai. LLM APIs pe 429/overloaded normal hai -- isko design mein maan ke chalo.

### Key concepts
- **Retryable** -- 408, 429, 500, 502, 503, 504 (aur provider-specific "overloaded" codes), timeouts, connection errors. **Not retryable** -- 400, 401, 403, 404, 422: retry se jawab nahi badlega.
- **Full jitter (AWS style)** -- `sleep = random.uniform(0, min(cap, base * 2**n))`; plain exponential ke saath sab clients sync mein retry karte hain.
- **Retry-After** -- server bata raha hai kab aana hai; usse kam wait mat karo.
- **Deadline > attempts** -- "5 attempts" ka matlab 1 s bhi ho sakta hai aur 5 min bhi; user-facing call ke liye total time budget (jaise 30 s) rakho.
- **Retry + idempotency** -- side-effecting call retry karne se pehle M14-01 ka key lagao.

### Code example
`pip install httpx`

```python
# runnable
import random
import httpx

RETRYABLE = {408, 429, 500, 502, 503, 504, 529}

class FakeClock:                          # no real sleeping: sleep() just moves time forward
    def __init__(self): self.t, self.sleeps = 0.0, []
    def now(self): return self.t
    def sleep(self, s): self.sleeps.append(round(s, 3)); self.t += s

def backoff(attempt, base=0.5, cap=8.0, rng=random):
    return rng.uniform(0, min(cap, base * 2 ** attempt))      # full jitter

def call_with_retry(client, req_json, clock, max_attempts=6, deadline_s=30.0, rng=random):
    start = clock.now()
    for attempt in range(max_attempts):
        try:
            r = client.post("https://llm.fake/v1/messages", json=req_json)
            if r.status_code < 400:
                return r.json(), attempt + 1
            if r.status_code not in RETRYABLE:
                r.raise_for_status()                               # 400/401: fail fast
            wait = backoff(attempt, rng=rng)
            if "retry-after" in r.headers:
                wait = max(wait, float(r.headers["retry-after"]))   # never earlier than told
        except httpx.TimeoutException:
            wait = backoff(attempt, rng=rng)
        if attempt == max_attempts - 1 or clock.now() - start + wait > deadline_s:
            raise TimeoutError(f"gave up after {attempt + 1} attempts")
        clock.sleep(wait)

def flaky(script):                        # MockTransport replays a scripted list of outcomes
    calls = []
    def handler(request):
        calls.append(request)
        step = script[min(len(calls) - 1, len(script) - 1)]
        if step == "timeout":
            raise httpx.ReadTimeout("slow", request=request)
        code, headers = step
        return httpx.Response(code, headers=headers, json={"ok": code < 400, "n": len(calls)})
    return httpx.Client(transport=httpx.MockTransport(handler)), calls

rng = random.Random(7)
# 1) 503, timeout, 429 with Retry-After, then success
client, calls = flaky([(503, {}), "timeout", (429, {"retry-after": "5"}), (200, {})])
clock = FakeClock()
body, attempts = call_with_retry(client, {"q": "summarise"}, clock, rng=rng)
assert body["ok"] and attempts == 4 and len(calls) == 4
assert clock.sleeps[2] >= 5.0                     # Retry-After honoured
assert all(s <= 8.0 for s in clock.sleeps[:2])    # jitter stays under cap
print("sleeps:", clock.sleeps)

# 2) 400 is not retryable: exactly one call
client, calls = flaky([(400, {})])
try:
    call_with_retry(client, {}, FakeClock(), rng=rng); raise AssertionError("should fail")
except httpx.HTTPStatusError as e:
    assert e.response.status_code == 400 and len(calls) == 1

# 3) always 429 with a long Retry-After: the deadline stops us early
client, calls = flaky([(429, {"retry-after": "12"})])
clock = FakeClock()
try:
    call_with_retry(client, {}, clock, deadline_s=30, rng=rng); raise AssertionError("should fail")
except TimeoutError as e:
    print("deadline:", e, "| waited", round(clock.now(), 1), "s")
    assert len(calls) == 3 and clock.now() <= 30

# 4) jitter spreads 1000 clients instead of syncing them
waits = [backoff(3, rng=rng) for _ in range(1000)]
assert 0 <= min(waits) < 0.5 and 3.5 < max(waits) <= 4.0
print("OK: full jitter, cap, retryable-only, Retry-After, total deadline")
```

- `FakeClock` -- retry logic ko clock aur sleep inject karo; tests milliseconds mein chalte hain aur exact waits assert hote hain.
- `RETRYABLE` set -- 400 pe `raise_for_status()` turant; ek hi call hoti hai (case 2). 529 Anthropic ka "overloaded" hai -- apne provider ke codes docs mein check karo.
- `max(wait, retry-after)` -- jitter Retry-After se chhota nikle to server ki baat maano.
- Deadline check sleep se *pehle* -- agar agla wait budget tod dega to abhi fail karo, user ko 30 s ke baad bhi latkaate mat raho.
- Case 4 -- attempt 3 pe window 4 s hai; 1000 clients 0-4 s mein phail jaate hain, ek saath server pe nahi girte.

```python
# real version -- not run here, needs: pip install anthropic tenacity
# The official SDKs already retry 408/409/429/5xx with backoff; tune, don't stack a second loop blindly.
import anthropic
client = anthropic.Anthropic(max_retries=4, timeout=30.0)   # check the docs for your version
# For your own HTTP tools, tenacity gives the same policy declaratively:
from tenacity import retry, stop_after_attempt, stop_after_delay, wait_random_exponential
@retry(wait=wait_random_exponential(multiplier=0.5, max=8),
       stop=(stop_after_attempt(6) | stop_after_delay(30)))
def call_tool(): ...
```

### Mini-exercise (30-60 min)
AuditMesh v1.0 mein `auditmesh/obs/retry.py` banao -- ek `retry_policy(max_attempts, base, cap, deadline_s)` jo LLM client aur Jira tool dono use karein.
- Har retry attempt ek span event ke roop mein log ho (attempt, status, wait) -- M14-10 ke tracer mein jayega.
- Jira POST pe retry tabhi jab M14-01 ka Idempotency-Key header laga ho; warna 5xx pe fail-fast.
- Acceptance: pytest with MockTransport -- 401 pe 1 call; 503 x2 then 200 pe 3 calls; Retry-After 20 aur deadline 10 pe turant TimeoutError.

### Common pitfalls
- SDK ke built-in retries ke upar apna retry loop -- 4 x 4 = 16 attempts aur 4x lamba latency. Ek layer choose karo.
- Retry ke andar total deadline nahi -- API gateway 60 s pe kaat deta hai, lekin worker background mein retry karta rehta hai aur paise lagte rehte hain.
- Har retry pe full prompt aur error body log karna -- PII bhi log mein; sirf status, attempt, request id log karo.

### Checklist before moving on
- [ ] Retryable vs non-retryable status codes ki list bina dekhe bata sakta hoon.
- [ ] Full jitter formula likh sakta hoon aur bata sakta hoon kyun plain exponential kaafi nahi.
- [ ] Retry-After aur total deadline dono handle karta hoon.
- [ ] Retry logic fake clock ke saath test karta hoon, real sleep ke bina.

### Related
- M14-01 Idempotency keys for safe tool execution
- M14-04 Configuring rate limiting and fallback routing
- M14-10 Capturing deep span-level execution traces
- M02-12 Fixtures and mocking

### Self-quiz
1. 50 workers, sab plain `2^n` backoff use karte hain -- 429 storm ke baad kya hota hai, aur full jitter isse kaise todta hai?
2. `401 Unauthorized` pe retry karna kyun galat hai? Kya kabhi exception hai?
3. Max attempts 6 hai lekin user request ka SLA 10 s -- aapka policy kya hoga?
4. POST `/refund` pe 504 aaya. Retry karna safe hai? Kis cheez pe depend karta hai?
