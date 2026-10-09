# Python & Linux Foundations

## Exception handling

> Core | Fast CP1 / Slow CP1 | ~1.2 h | Builds on: M01-01, M01-03

### Kahani
Ek logistics customer ka nightly job hai: 40,000 shipments ka status unke partner API se pull karo aur DB mein likho.
Teesri raat job 2 baje crash ho gaya -- ek shipment ka JSON mein `eta` field missing tha, `KeyError` aaya, aur poora batch mar gaya.
Subah ops team ke paas 0 updates the aur log mein sirf ek traceback.
Fix "sab kuch `try/except Exception: pass` mein wrap kar do" nahi hai -- usse to bugs chhup jaate hain.
Asli fix: kaunsi error retry karni hai, kaunsi skip + log karni hai, aur kaunsi pe job ko rokna hai -- ye decide karna.

### What it is
Python mein errors **exceptions** hain: objects jo `raise` hote hain aur call stack upar travel karte hain jab tak koi `except` unhe pakad na le.
JS ke `try/catch/finally` jaisa hi hai, bas Python mein `else` block bhi hai, exceptions ki class hierarchy pe match hota hai, aur `except*` se ek saath kai errors (ExceptionGroup) handle ho sakte hain.

### Why it matters for an FDE
Customer ke APIs flaky hote hain aur data dirty hota hai. Agar aap retryable (timeout, 503) aur permanent (400, bad data) errors ko alag nahi karte, to ya to job crash hoti hai ya galat data chupchaap DB mein chala jaata hai.

### Key concepts
- **Exception hierarchy** -- apni base class (`IntegrationError`) banao, uske neeche `RetryableError` / `PermanentError`; caller sirf category pe decide kare.
- **`raise ... from err`** -- low-level error ko high-level error mein wrap karo bina original traceback khoye (`__cause__`).
- **`try / except / else / finally`** -- `else` sirf success pe chalta hai, `finally` hamesha (cleanup: file, connection, lock).
- **Narrow except** -- sirf wahi pakdo jo aap handle kar sakte ho; `except Exception` sirf top-level boundary pe, aur wahan bhi log karo.
- **`ExceptionGroup` + `except*`** -- concurrent tasks (TaskGroup) se multiple errors ek saath aate hain; JS ke `AggregateError` jaisa.

### Code example
stdlib only

```python
# runnable
import json
import logging

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("sync")


class IntegrationError(Exception):  # base for everything the customer system can throw at us
    pass


class RetryableError(IntegrationError):
    pass


class PermanentError(IntegrationError):
    pass


class FakePartnerAPI:
    """Stands in for the customer's HTTP API: fails twice with 503, then succeeds."""
    def __init__(self):
        self.calls = 0

    def get_shipment(self, sid):
        self.calls += 1
        if sid == "bad":
            return '{"id": "bad"}'                      # missing "eta" -> dirty data
        if self.calls <= 2:
            raise ConnectionError("503 Service Unavailable")
        return json.dumps({"id": sid, "eta": "2026-10-10"})


def fetch(api, sid):
    try:
        raw = api.get_shipment(sid)
    except ConnectionError as err:
        raise RetryableError(f"network problem for {sid}") from err
    try:
        data = json.loads(raw)
        return {"id": data["id"], "eta": data["eta"]}
    except (KeyError, json.JSONDecodeError) as err:
        raise PermanentError(f"bad payload for {sid}: {err!r}") from err


def fetch_with_retry(api, sid, attempts=3):
    for attempt in range(1, attempts + 1):
        try:
            result = fetch(api, sid)
        except RetryableError as err:
            log.warning("attempt %d failed: %s (cause: %s)", attempt, err, err.__cause__)
            if attempt == attempts:
                raise
        else:
            return result                                # only runs when no exception
        finally:
            log.info("attempt %d for %s done", attempt, sid)


api = FakePartnerAPI()
ok, skipped = [], []
for sid in ["S1", "bad"]:
    try:
        ok.append(fetch_with_retry(api, sid))
    except PermanentError as err:
        skipped.append(sid)                              # skip + log, do not kill the batch
        log.error("skipping: %s", err)

assert ok == [{"id": "S1", "eta": "2026-10-10"}]
assert skipped == ["bad"] and api.calls == 4

# ExceptionGroup: what you get back from asyncio.TaskGroup when several tasks fail
try:
    raise ExceptionGroup("batch", [RetryableError("timeout"), PermanentError("400")])
except* RetryableError as eg:
    retry_later = [str(e) for e in eg.exceptions]
except* PermanentError as eg:
    dead_letter = [str(e) for e in eg.exceptions]
assert retry_later == ["timeout"] and dead_letter == ["400"]
print("OK: retried network errors, skipped bad data, split an ExceptionGroup")
```

- `raise RetryableError(...) from err` -- caller ko clean category milti hai, aur `err.__cause__` mein original `ConnectionError` bacha rehta hai (debugging ke liye).
- `except RetryableError` sirf retryable errors pakadta hai -- `PermanentError` seedha upar jaata hai, retry waste nahi hota.
- `else: return result` -- sirf success pe; `finally` har attempt ke baad log karta hai (real code mein: connection close, lock release).
- Bare `raise` last attempt pe original exception ko traceback ke saath dobara phenkta hai.
- `except*` ek `ExceptionGroup` ko type ke hisaab se split karta hai -- M01-07 mein TaskGroup yahi deta hai.

### Mini-exercise (30-60 min)
`fde-exercises/m01_errors/` mein ek `sync_orders.py` banao:
- Ek `FakeOrdersAPI` jo random se `TimeoutError`, `ValueError` (bad data) ya success deta hai (`random.seed(7)` se deterministic).
- Apni hierarchy (`IntegrationError` -> `RetryableError`, `PermanentError`) aur `fetch_with_retry` with exponential backoff (`0.1 * 2**attempt`, tests mein sleep ko inject/mock karo).
- 100 orders process karo; end mein summary print: `ok=.. retried=.. dead_letter=..`.
- Acceptance: pytest test jo check kare ki permanent error kabhi retry nahi hoti, aur ek bhi bad order poore batch ko nahi rokta.

### Common pitfalls
- `except Exception: pass` -- bug ko chhupa deta hai; kam se kam `log.exception(...)` karo aur decide karo ki re-raise karna hai.
- Non-idempotent call (payment, "create ticket") ko blindly retry karna -- duplicate charges. Retry sirf idempotent operations ya idempotency key ke saath.
- Error message mein poora request body/PII log karna (customer ka naam, account no.) -- sirf IDs log karo.

### Checklist before moving on
- [ ] Main `raise X from err` aur bare `raise` ka fark bata sakta hoon.
- [ ] Mujhe pata hai `else` aur `finally` kab chalte hain.
- [ ] Maine retryable vs permanent errors ki apni hierarchy banayi hai.
- [ ] Main `except*` se ExceptionGroup split kar sakta hoon.

### Related
- M01-07 Coroutines and tasks (TaskGroup raises ExceptionGroup)
- M01-08 Async context managers (cleanup on error)
- M05-09 Handling and retrying output parsing errors gracefully
- M14-01 Idempotency keys for safe tool execution
- M14-02 Exponential backoff strategies

### Self-quiz
1. Aapke batch job mein ek record ka data kharab hai. Aap job crash karoge, skip karoge, ya retry karoge? Kyun?
2. `raise PermanentError("x") from err` aur `raise PermanentError("x")` (except block ke andar) mein traceback mein kya fark dikhega?
3. Kis case mein retry karna dangerous hai, aur use safe kaise banaoge?
4. JS ke `Promise.allSettled` / `AggregateError` ka Python equivalent kya hai?
