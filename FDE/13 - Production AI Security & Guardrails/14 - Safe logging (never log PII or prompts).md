# Production AI Security & Guardrails

## Safe logging (never log PII or prompts)

> Core | Fast CP6 / Slow CP8 | ~1.2 h | Builds on: M13-05, M13-10, M12-10, M14-10

### Kahani
Ek health-insurance customer ne bola: "Hamare guardrails perfect hain, PII provider tak nahi jaati." Phir audit team ne Datadog/CloudWatch khola.
Wahan har request ka `logger.info(f"prompt={prompt}")` tha -- patient names, phone numbers, diagnosis, sab plain text mein, 400 logo ki access ke saath, 13 mahine ki retention.
Ek exception trace mein `Authorization: Bearer eyJ...` bhi pada tha. Redaction LLM ke liye kiya tha, logs ke liye kisi ne socha hi nahi.
Lesson: logs aapka sabse bada **shadow database** hai. PII aur prompts wahan by default nahi jaane chahiye.

### What it is
**Safe logging** = logs mein sirf metadata: request id, prompt ka **hash**, token counts, latency, guardrail decisions, model id. Raw prompt/response kabhi nahi.
Teen layers: (1) code mein raw text log hi mat karo, (2) ek `logging.Filter` jo galti se aaya PII/secret scrub kare (safety net), (3) agar legal ko transcripts chahiye to **alag secured store** with access control + retention.

### Why it matters for an FDE
DPDP Act / HIPAA / GDPR jaisi regulations mein logs bhi "personal data processing" hain. Ek leaked log bucket = breach notification. CISO review mein "show me your logs" common sawaal hai.

### Key concepts
- **Log metadata, not content** -- `prompt_hash`, `input_tokens`, `output_tokens`, `latency_ms`, `guardrail_trail` (reason codes). Debugging ke liye ye kaafi hai zyada-tar.
- **Keyed hash (HMAC)** -- plain SHA-256 of a short prompt guess karke reverse ho sakta hai; secret key ke saath HMAC karo. Same prompt = same hash, to duplicates dikh jaate hain.
- **Redaction filter as safety net** -- `logging.Filter` message, args aur exception text sab scrub kare; primary control nahi, last line.
- **Separate transcript store** -- raw transcripts sirf jab legally required: encrypted, restricted IAM role, access audited (M12-10), fixed retention + auto purge.
- **Third-party traces** -- Langfuse/LangSmith jaise tools mein bhi same rule; masking config on karo (M14-10).

### Code example
`stdlib only`

```python
# runnable
import hashlib, hmac, json, logging, re, tempfile, time
from pathlib import Path

SCRUB = [(re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.]+\b"), "[EMAIL]"),
         (re.compile(r"\b[6-9]\d{4} ?\d{5}\b"), "[PHONE]"),
         (re.compile(r"\b(?:\d[ -]?){12,18}\d\b"), "[NUMBER]"),
         (re.compile(r"(?i)bearer\s+[\w.-]+"), "Bearer [SECRET]"),
         (re.compile(r"\bsk-[A-Za-z0-9]{16,}\b"), "[API_KEY]")]
def scrub(text: str) -> str:
    for rx, repl in SCRUB:
        text = rx.sub(repl, text)
    return text

class RedactingFilter(logging.Filter):          # safety net: scrubs message, args and tracebacks
    def filter(self, record: logging.LogRecord) -> bool:
        record.msg, record.args = scrub(record.getMessage()), None
        if record.exc_info:
            record.exc_text = scrub(logging.Formatter().formatException(record.exc_info))
        return True

LOG_KEY = b"from-secrets-manager-not-code"     # HMAC key: rotate, store in a vault
def prompt_hash(p: str) -> str:
    return hmac.new(LOG_KEY, p.encode(), hashlib.sha256).hexdigest()[:16]

def log_llm_call(log, req_id, prompt, answer, ms):   # metadata only, never raw text
    log.info(json.dumps({"event": "llm_call", "req": req_id, "prompt_hash": prompt_hash(prompt),
                         "input_tokens": len(prompt.split()), "output_tokens": len(answer.split()),
                         "latency_ms": ms, "guardrails": ["pii_redacted", "on_topic"]}))

class TranscriptStore:                          # separate, access-controlled store with retention
    def __init__(self, root: Path, retention_days: int):
        self.root, self.retention = root, retention_days
    def save(self, req_id: str, text: str, ts: float):
        (self.root / f"{req_id}.json").write_text(json.dumps({"ts": ts, "text": text}))
    def purge(self, now: float) -> int:
        old = [f for f in self.root.glob("*.json") if now - json.loads(f.read_text())["ts"] > self.retention * 86400]
        for f in old: f.unlink()
        return len(old)

with tempfile.TemporaryDirectory() as d:
    app_log, tx_dir = Path(d) / "app.log", Path(d) / "secure_transcripts"
    tx_dir.mkdir()
    handler = logging.FileHandler(app_log)
    handler.addFilter(RedactingFilter())
    handler.setFormatter(logging.Formatter("%(levelname)s %(name)s %(message)s"))
    log = logging.getLogger("omniguard"); log.addHandler(handler); log.setLevel(logging.INFO)

    prompt = "Patient Ravi, phone 98200 12345, email ravi@example.com, card 4111 1111 1111 1111 -- summarize."
    log_llm_call(log, "r-1", prompt, "Summary: follow-up in 2 weeks.", 412)
    log.warning("debug dump by a careless dev: %s", prompt)              # mistake: filter must catch it
    try:
        raise ValueError(f"provider rejected request, headers=Bearer eyJhbGciOi.secret sk-{'a' * 20}")
    except ValueError:
        log.exception("llm call failed for ravi@example.com")
    store = TranscriptStore(tx_dir, retention_days=30)
    store.save("r-1", prompt, ts=time.time())
    store.save("r-0", "old transcript", ts=time.time() - 40 * 86400)
    handler.close(); log.removeHandler(handler)

    content = app_log.read_text()
    print(content)
    for secret in ("98200 12345", "ravi@example.com", "4111 1111", "eyJhbGciOi", "sk-aaaa"):
        assert secret not in content, f"leaked: {secret}"
    assert prompt_hash(prompt) in content and '"input_tokens"' in content   # still debuggable
    assert store.purge(now=time.time()) == 1 and [f.stem for f in tx_dir.glob("*.json")] == ["r-1"]
    print("OK: log file has metadata + hashes, zero PII/secrets; transcripts separate with retention")
```

- `log_llm_call` -- primary control: raw prompt kabhi field mein nahi. Hash se same prompt ke repeats correlate ho jaate hain.
- `RedactingFilter` -- `getMessage()` se args merge karke scrub, phir `args=None`. Exception ka text bhi scrub (`exc_text`), kyunki tracebacks mein headers/PII aa jaate hain. Output mein "Patient Ravi" bacha hai -- naam regex se nahi pakde jaate, real filter mein Presidio NER (M13-04).
- Filter **handler** pe laga hai -- logger pe lagaoge to child loggers (`omniguard.rag`) ke records bypass ho sakte hain; handler pe sab pakde jaate hain.
- `prompt_hash` HMAC hai -- bina key ke koi "Patient Ravi..." guess karke hash match nahi kar sakta.
- `TranscriptStore` -- alag directory (real: encrypted bucket + restricted IAM role), 30-day retention, purge test se proven.

### Mini-exercise (30-60 min)
OmniGuard CP6: `omniguard/guardrails/logging_filter.py`.
- `RedactingFilter` jo M13-05 ka `redact()` reuse kare (ek hi source of truth), plus secrets patterns (Bearer, `sk-`, AWS `AKIA...`).
- `configure_logging()` JSON formatter ke saath; root handler pe filter. FastAPI request middleware har request ka ek `llm_call` event likhe (M14-11 ke fields).
- `tests/test_safe_logging.py`: 10 PII-heavy requests chalao (including ek forced exception), phir log file mein har PII value ke liye `assert value not in log_text`.
- `docs/data-retention.md`: kya log hota hai, kahan, kitne din, kaun padh sakta hai -- customer ke DPO ke liye.

### Common pitfalls
- f-string logging (`log.info(f"...{prompt}")`) -- filter usse scrub karega par primary control fail ho chuka; code review mein `prompt` / `messages` logging block karo.
- Exception tracebacks aur HTTP client debug logs (`httpx`, `urllib3` DEBUG) -- headers aur bodies log kar dete hain; production mein unka level WARNING.
- Retention policy sirf doc mein -- purge job aur bucket lifecycle rule actually configured hai, ye test/verify karo.

### Checklist before moving on
- [ ] Mere logs mein raw prompt/response field nahi hai, sirf hash + token counts.
- [ ] Redaction filter handler pe hai aur exceptions bhi scrub karta hai.
- [ ] Test jo log file padh ke PII absence assert karta hai.
- [ ] Transcripts (agar zaroori) alag store, restricted access, retention purge ke saath.

### Related
- M13-05 Redacting sensitive entities (SSN, credit cards, emails)
- M13-10 Configuring strict input and output filtering pipelines natively in Python
- M12-10 Audit logging
- M14-10 Capturing deep span-level execution traces
- M14-11 Monitoring granular token costs and endpoint latency

### Self-quiz
1. Plain SHA-256 prompt hash aur HMAC mein security fark kya hai?
2. Redaction filter ko "primary control" kyun nahi maanna chahiye?
3. Filter logger pe vs handler pe lagane ka fark kya hai?
4. Legal team bolti hai "7 saal ke transcripts rakho." Aap kaunse 3 controls maangoge?
