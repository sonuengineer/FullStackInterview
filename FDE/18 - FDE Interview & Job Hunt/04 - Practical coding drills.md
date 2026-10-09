# FDE Interview & Job Hunt

## Practical coding drills

> Core | Fast CP6 / Slow CP10 | ~3 h | Builds on: M01-*, M02-*, M11-*

### Kahani
Interviewer screen share karta hai: "Ye ek customer ka export hai, 400 lines ka JSON log. Kuch lines broken hain, kuch duplicate hain. 40 minute mein mujhe har endpoint ka error rate nikaal ke do."
Koi binary tree nahi, koi dynamic programming nahi. Bas messy data, ek flaky API, aur ek clock.
Bahut strong LeetCode wale log yahan atak jaate hain -- kyunki woh pehle 10 minute "perfect" solution sochte hain aur ek bhi line nahi chalate.
FDE interview ka coding round asli customer site ka chhota version hai: data gandaa hai, docs adhure hain, aur aapko bolte hue code karna hai.

### What it is
**Practical coding round** = 30-60 minute ka problem jahan aap real-world type ka kaam karte ho: parse, clean, call an API, fix a bug, write a small endpoint ya SQL query.
Judge hota hai: kya chalta hai, kya edge cases handle hue, aur aapne apni soch kitni clearly boli.

### Why it matters for an FDE
Customer site pe pehla hafta hamesha "ye CSV ajeeb hai" aur "ye API 3rd page pe 429 deta hai" hota hai. Jo yahan fast aur calm hai, wahi customer ka trust jeetta hai.

### Key concepts
- **Talk-first, then type** -- 2 minute mein input/output, assumptions aur edge cases bolo; phir code.
- **Smallest runnable slice** -- pehle happy path chalao (print karke), phir edge cases add karo.
- **Defensive parsing** -- bad rows skip + count karo, crash mat karo; end mein "skipped N rows" report karo.
- **Retries with backoff** -- sirf retryable errors (429, 5xx, timeout) retry karo, max attempts ke saath; 4xx validation errors retry nahi.
- **Self-check with asserts** -- interviewer ke saamne 2-3 `assert` likhna "maine test kiya" ka sabse sasta saboot hai.

### How to do it
Har drill ke liye ye 6-step loop use karo (timer lagao, 40 min):
1. **Restate** (1 min): "So the input is X, I need to return Y, and bad rows should be skipped and counted. Correct?"
2. **Examples** (2 min): ek normal, ek broken, ek duplicate input khud likho.
3. **Plan out loud** (2 min): functions ke naam bolo -- `parse_line`, `dedupe`, `summarise`.
4. **Happy path** (15 min): chalao, output dekho.
5. **Edge cases** (10 min): empty input, missing field, wrong type, duplicate, timeout.
6. **Wrap-up** (5 min): "In production I would add logging, a timeout config and a test file." -- ek line, lecture nahi.

Worked example -- drill #3 (paginated API with retries + dedupe). stdlib only.

```python
# runnable
# Drill: fetch all pages from a flaky paginated API, retry transient errors, dedupe by id.
# FakeAPI mimics a real REST client: get(page) -> {"items": [...], "next": int|None}.

class TransientError(Exception):
    """Stands in for HTTP 429 / 503 / timeout."""

class FakeAPI:
    def __init__(self, pages, fail_plan):
        self.pages, self.fail_plan, self.calls = pages, dict(fail_plan), 0

    def get(self, page):
        self.calls += 1
        if self.fail_plan.get(page, 0) > 0:          # fail this page N times first
            self.fail_plan[page] -= 1
            raise TransientError(f"503 on page {page}")
        nxt = page + 1 if page + 1 < len(self.pages) else None
        return {"items": self.pages[page], "next": nxt}

def get_with_retry(api, page, max_attempts=3, sleep=lambda s: None):
    for attempt in range(1, max_attempts + 1):
        try:
            return api.get(page)
        except TransientError:
            if attempt == max_attempts:
                raise
            sleep(0.5 * 2 ** (attempt - 1))         # exponential backoff: 0.5, 1.0 ...

def fetch_all(api, **kw):
    page, items = 0, []
    while page is not None:
        body = get_with_retry(api, page, **kw)
        items.extend(body["items"])
        page = body["next"]
    return items

def dedupe_latest(records):
    latest = {}
    for r in records:
        if "id" not in r:                            # defensive: skip broken rows
            continue
        cur = latest.get(r["id"])
        if cur is None or r["updated_at"] > cur["updated_at"]:
            latest[r["id"]] = r
    return sorted(latest.values(), key=lambda r: r["id"])

pages = [
    [{"id": 1, "updated_at": "2026-01-01", "status": "open"}, {"id": 2, "updated_at": "2026-01-02", "status": "open"}],
    [{"id": 1, "updated_at": "2026-01-05", "status": "closed"}, {"bad": True}],
    [{"id": 3, "updated_at": "2026-01-03", "status": "open"}],
]
waits = []
api = FakeAPI(pages, fail_plan={1: 2})              # page 1 fails twice, then works
out = dedupe_latest(fetch_all(api, sleep=waits.append))

assert [r["id"] for r in out] == [1, 2, 3]
assert out[0]["status"] == "closed"                 # newest version of id 1 wins
assert api.calls == 5 and waits == [0.5, 1.0]       # 3 pages + 2 retries

try:                                                # permanent failure must surface
    fetch_all(FakeAPI(pages, fail_plan={0: 9}))
    raise AssertionError("should have raised")
except TransientError:
    pass
print("ok:", len(out), "records,", api.calls, "calls, waits", waits)
```

- `sleep` injectable hai -- test mein real wait nahi hota, aur backoff values assert ho jaati hain. Interview mein ye trick bolke dikhao.
- `get_with_retry` last attempt pe error **re-raise** karta hai -- silently `None` return karna sabse common bug hai.
- `dedupe_latest` broken row (`{"bad": True}`) skip karta hai, crash nahi; production mein yahan skipped count log karte.
- ISO date strings (`YYYY-MM-DD`) string compare se bhi sahi order dete hain -- par mixed formats ho to pehle parse karo.

### Practice set
20 drills. Har ek 30-45 min, timer ke saath, bolte hue (record karo ya Claude ko narrate karo). Text only -- code khud likho.
1. Parse a CSV of customer orders where some rows have extra commas inside quotes, some have blank amounts, and dates come in 3 formats. Return total revenue per month and the count of rejected rows.
2. Given JSON-lines access logs (some lines truncated), compute request count, error rate (status >= 500) and p95 latency per endpoint.
3. Fetch all pages from a paginated API that returns 429/503 sometimes; retry with backoff; dedupe by id keeping the latest (worked example above).
4. Fix a buggy `async def fetch_all(urls)` that awaits each call in a loop (slow) and swallows exceptions. Make it concurrent with a limit of 5 and return per-URL errors.
5. Deduplicate customer records where the same person appears with different email casing, extra spaces and phone formats (+91, 0, spaces). Explain your matching key.
6. Write a FastAPI `POST /tickets` endpoint with pydantic validation (title 5-200 chars, priority enum, optional due date not in the past). Return 422 with a clear message on bad input. Add one TestClient test.
7. SQL: given `orders(id, customer_id, amount, created_at)` and `customers(id, name, city)`, return the top 3 customers by revenue per city for the last 90 days.
8. Flatten a nested JSON from a legacy system (`customer.address.lines[0]`) into a flat dict with dotted keys; handle lists and nulls.
9. Write a chunker that splits a long text into ~500-token chunks with 50-token overlap without cutting sentences in half (use word count as a token proxy).
10. Parse a fixed-width mainframe export (column positions given) into dicts; trim padding; convert amounts stored as cents with a trailing sign (`000012345-`).
11. Given two CSV exports (CRM and billing), find customers present in one but not the other, and those with mismatched plan names. Output a reconciliation report.
12. Implement a simple rate limiter (token bucket) class with `allow() -> bool`, testable with an injected clock.
13. Redact emails, Indian phone numbers and PAN-like IDs from support tickets with regex; show 5 test strings including tricky ones.
14. A function reads a 2 GB log file with `f.read()` and runs out of memory. Rewrite it to stream line by line and keep only the counters you need.
15. Write a webhook receiver that verifies an HMAC-SHA256 signature header, rejects stale timestamps (> 5 min) and is idempotent on `event_id`.
16. Given an LLM response that should be JSON but sometimes has markdown fences or trailing text, write a robust parser + jsonschema validation + one retry prompt.
17. SQL: find support tickets where the first agent reply took more than 4 business hours (ignore weekends). Explain the edge cases even if your query simplifies them.
18. Fix a function that mutates a default list argument and leaks state across calls; write a test that proves the bug and the fix.
19. Build a tiny CLI (`argparse`) that takes a folder of PDFs/TXT files and outputs a CSV of filename, page count/characters and detected language-ish hint (stub detection is fine).
20. Given a list of tool-call traces (`{run_id, step, tool, ms, tokens}`), compute per-run total cost with a price table and flag runs above a budget.

### Rubric
Har drill ko 10 mein score karo:
| Area | Points | What "full marks" looks like |
|---|---|---|
| Clarify | 2 | Restated the task, asked 1-2 sharp questions, wrote examples |
| Works | 3 | Happy path runs and output shown |
| Edge cases | 2 | Bad/empty/duplicate input handled, not crashed |
| Readability | 1 | Small named functions, no 80-line blob |
| Verification | 1 | Asserts or a test, not "trust me" |
| Communication | 1 | Narrated decisions; ended with a 1-line production note |
Target: 3 drills in a row at 7+/10 before moving on.

### Common pitfalls
- Silence for 10 minutes while "thinking". Interviewer ko aapka process sunna hai -- bolo, even if galat ho.
- Retry everything forever. Production mein ye customer ki API ko DDoS karta hai; max attempts + backoff + only retryable codes.
- Network calls without a timeout. Real version mein `httpx.Client(timeout=10)` jaisa explicit timeout hamesha bolo.
- Logging raw rows with PII while debugging -- interview mein bhi bolo "I would not log the full record".

### Checklist before moving on
- [ ] 20 drills attempted, each with a score in your notes
- [ ] Last 3 drills scored 7+/10
- [ ] Worked example re-written from memory in under 25 minutes
- [ ] You can explain retry vs. not-retry status codes without looking
- [ ] At least 2 drills done live with Claude acting as interviewer (log it in Job hunt -> Mock interviews as "coding")

### Self-quiz
1. Why should the retry helper re-raise on the last attempt instead of returning `None`, and what would break downstream if it did not?
2. In drill 5, what matching key would you choose for dedupe, and what false-merge risk does it create?
3. How do you prove to an interviewer that your code works in under 2 minutes, without a full test suite?
