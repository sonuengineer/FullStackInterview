# AI Observability & Gateway Management

## Configuring rate limiting and fallback routing

> Core | Fast CP8 / Slow CP10 | ~1.2 h | Builds on: M14-02, M14-03

### Kahani
Ek SaaS company ka AI helpdesk 40 tenants serve karta hai. Ek tenant ne apne CRM ko loop mein integrate kiya -- 300 requests/second. Provider ka org-wide rate limit khatam, aur baaki 39 tenants ko bhi `429` milne laga.
Usi hafte primary provider ka ek region 20 minute down raha. Har request 30 s timeout tak latakti rahi, phir fail -- worker pool bhar gaya aur poora app slow ho gaya.
Customer ka VP bolta hai: "Ek noisy tenant sabko na giraye, aur ek provider down ho to hum gracefully degrade karein, crash nahi."

### What it is
**Rate limiting** (per tenant **token bucket**) = har tenant ko ek fixed refill rate aur burst capacity; khatam to turant 429, provider pe load hi nahi jaata.
**Fallback routing** = ek chain: primary model -> secondary model -> cached/canned answer. **Circuit breaker** primary ko tab tak skip karta hai jab tak wo baar-baar fail ho raha hai, phir thodi der baad ek "probe" request se check karta hai.

### Why it matters for an FDE
Multi-tenant customer pe fairness aur availability dono contract (SLA) ka hissa hote hain. Breaker ke bina har request dead provider pe timeout tak wait karti hai -- outage aapke app mein copy ho jaata hai.

### Key concepts
- **Token bucket** -- `tokens = min(capacity, tokens + elapsed * rate)`; request tabhi jab `tokens >= cost`. Burst allowed, sustained abuse nahi. Cost = request count ya estimated LLM tokens.
- **Closed / Open / Half-open** -- closed: normal; N consecutive failures -> open (skip turant); `reset_after` ke baad half-open: ek probe, success -> closed, fail -> wapas open.
- **Fallback chain** -- har step "kam acha lekin available"; last step kabhi fail nahi hona chahiye (cache ya honest canned message).
- **Fail fast** -- open breaker 0 ms mein next option pe jaata hai, 30 s timeout nahi.
- **Where it lives** -- gateway (M14-03) mein; LiteLLM/Portkey dono rate limits, fallbacks, cooldowns config se dete hain.

### Code example
stdlib only

```python
# runnable
import hashlib

class Clock:
    t = 0.0
    def now(self): return self.t

class TokenBucket:
    def __init__(self, rate, capacity, clock):
        self.rate, self.cap, self.clock = rate, capacity, clock
        self.tokens, self.last = capacity, clock.now()
    def allow(self, cost=1.0):
        now = self.clock.now()
        self.tokens = min(self.cap, self.tokens + (now - self.last) * self.rate)
        self.last = now
        ok = self.tokens >= cost
        self.tokens -= cost if ok else 0
        return ok

class Breaker:
    def __init__(self, clock, fail_threshold=3, reset_after=30.0):
        self.clock, self.n, self.reset = clock, fail_threshold, reset_after
        self.state, self.fails, self.opened_at = "closed", 0, 0.0
    def allow(self):
        if self.state == "open" and self.clock.now() - self.opened_at >= self.reset:
            self.state = "half_open"                 # let exactly one probe through
            return True
        return self.state == "closed"
    def record(self, ok):
        self.fails = 0 if ok else self.fails + 1
        if ok:
            self.state = "closed"
        elif self.state == "half_open" or self.fails >= self.n:
            self.state, self.opened_at = "open", self.clock.now()

class FakeProvider:                                  # same shape as an SDK call: prompt in, text out
    def __init__(self, name): self.name, self.up, self.calls = name, True, 0
    def complete(self, prompt):
        self.calls += 1
        if not self.up: raise TimeoutError(f"{self.name} timed out")
        return f"{self.name}: answer to '{prompt}'"

class Router:
    def __init__(self, chain, clock, rate=5, burst=5):
        self.chain = [(p, Breaker(clock)) for p in chain]
        self.buckets, self.cache, self.clock, self.rate, self.burst = {}, {}, clock, rate, burst
    def ask(self, tenant, prompt):
        b = self.buckets.setdefault(tenant, TokenBucket(self.rate, self.burst, self.clock))
        if not b.allow(): return 429, "rate limited, retry later"
        key = hashlib.sha256(prompt.encode()).hexdigest()
        for provider, breaker in self.chain:
            if not breaker.allow():
                continue                             # open breaker: skip instantly
            try:
                self.cache[key] = text = provider.complete(prompt)
                breaker.record(True)
                return 200, text
            except TimeoutError:
                breaker.record(False)
        return 200, self.cache.get(key, "Assistant is degraded right now; a human will follow up.")

clock = Clock()
primary, secondary = FakeProvider("primary"), FakeProvider("secondary")
r = Router([primary, secondary], clock)
codes = [r.ask("noisy-tenant", f"q{i}")[0] for i in range(10)]
assert codes.count(200) == 5 and codes.count(429) == 5        # burst 5, then limited
assert r.ask("quiet-tenant", "reset password?")[0] == 200     # other tenants unaffected
clock.t += 1.0
assert r.ask("noisy-tenant", "q-after-refill")[0] == 200      # refilled at 5/s
primary.up, before = False, primary.calls
for i in range(5):
    clock.t += 1.0
    assert r.ask("t1", f"invoice {i}")[1].startswith("secondary")
assert primary.calls == before + 3 and r.chain[0][1].state == "open"   # 3 fails, then skipped
clock.t, primary.up = clock.t + 31, True                                 # half-open probe succeeds
assert r.ask("t1", "invoice 9")[1].startswith("primary") and r.chain[0][1].state == "closed"
primary.up = secondary.up = False
assert r.ask("t1", "invoice 9")[1].startswith("primary: answer")       # last good answer from cache
assert "degraded" in r.ask("t2", "brand new question")[1]               # honest canned answer
print("primary calls:", primary.calls, "secondary:", secondary.calls, "| OK: per-tenant token bucket, breaker closed->open->half_open->closed, fallback chain")
```

- `TokenBucket` per tenant -- noisy tenant ke 10 mein se 5 hi chale; `quiet-tenant` ka apna bucket hai, isliye uspe asar nahi.
- `Breaker.allow()` -- open state mein provider call hi nahi hota; `primary.calls` 3 failures ke baad nahi badha (5 requests, sirf 3 attempts).
- Half-open -- 31 s baad ek probe gaya, primary up tha, breaker `closed`. Probe fail hota to seedha wapas `open`.
- Last step cache -> canned message -- user ko kabhi stack trace ya 30 s ka spinner nahi milta. Cached answer purana ho sakta hai: UI mein "may be outdated" dikhana better hai.
- Real system mein bucket state Redis mein (multiple gateway replicas), aur cost = estimated tokens, sirf request count nahi.

```python
# real version -- not run here, needs: pip install litellm
# LiteLLM Router: fallbacks + cooldown of failing deployments (field names: check the docs for your version)
import os
from litellm import Router
router = Router(
    model_list=[
        {"model_name": "primary", "litellm_params": {"model": os.environ["PRIMARY_MODEL"], "rpm": 600}},
        {"model_name": "secondary", "litellm_params": {"model": os.environ["SECONDARY_MODEL"], "rpm": 600}},
    ],
    fallbacks=[{"primary": ["secondary"]}], num_retries=1, allowed_fails=3, cooldown_time=30,
)
resp = router.completion(model="primary", messages=[{"role": "user", "content": "hi"}])
```

### Mini-exercise (30-60 min)
AuditMesh v1.0 ke gateway config mein: `supervisor-large` -> fallback `worker-small` -> canned "queued for human review" (ye approval UI mein ticket bana de).
- `auditmesh/obs/limits.py` -- per-tenant bucket jiska cost = estimated input tokens (M05-03), sirf request count nahi.
- Breaker state change (`closed -> open`) ek log event + metric (`breaker_state{provider}`) emit kare -- dashboard (M16-08) pe dikhe.
- Acceptance: pytest -- noisy tenant limited, doosra nahi; primary down pe p95 latency fake clock ke hisaab se timeout ke barabar nahi (breaker skip karta hai); dono down pe canned answer, 5xx nahi.

### Common pitfalls
- Fallback model ka prompt/format alag behave karta hai -- secondary pe bhi offline eval chalao (M14-05) warna fallback silently galat JSON dega.
- Rate limit sirf in-memory with 4 replicas -- har replica apna bucket, effective limit 4x. Shared store (Redis) ya gateway level pe limit.
- 429 pe client ko `Retry-After` header na dena -- clients apna guess karke aur zor se retry karte hain (M14-02).

### Checklist before moving on
- [ ] Token bucket ka refill formula likh sakta hoon aur burst vs rate samjha sakta hoon.
- [ ] Breaker ke teeno states aur transitions bina dekhe draw kar sakta hoon.
- [ ] Mere fallback chain ka last step kabhi exception nahi deta.
- [ ] Fallback model pe bhi eval chalaya hai.

### Related
- M14-02 Exponential backoff strategies
- M14-03 Centralizing provider API keys via LiteLLM/Portkey
- M14-16 Model selection and routing
- M16-03 Drafting latency and cost SLAs

### Self-quiz
1. Breaker ke bina primary 20 min down ho to aapke worker pool ka kya hota hai? Breaker kya badalta hai?
2. Half-open state mein sirf ek probe kyun, saari traffic kyun nahi?
3. Rate limit ka "cost" request count rakhein ya tokens -- LLM workloads ke liye kaunsa fair hai aur kyun?
4. Cached fallback answer kab dena khatarnak ho sakta hai (domain example do)?
