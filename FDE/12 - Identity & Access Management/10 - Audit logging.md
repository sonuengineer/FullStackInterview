# Identity & Access Management

## Audit logging

> Core | Fast CP5 / Slow CP7 | ~1.2 h | Builds on: M12-01, M12-06, M12-07

### Kahani
Hospital ka regulator audit. Sawaal simple tha: "Pichhle 90 din mein patient P-2291 ka record AI assistant ke through kisne dekha, aur kisko deny hua?"
Aapke paas sirf app logs the -- `INFO answered question` jaisi lines, kuch mein poora prompt (patient ka naam aur diagnosis ke saath!), user id kahin nahi, aur ek admin ke paas log file edit karne ka access tha. Auditor ne kaha: "Ye logs evidence nahi hain."
Audit log alag cheez hai: structured, har security decision ka, append-only, tamper-evident, aur khud PII-free.

### What it is
**Audit log** = security-relevant events ka record: **who** (actor), **what** (action), **when**, **which resource**, **decision** (allow/deny), **reason**, **request id**. Debug logs nahi -- ye compliance evidence hai (HIPAA, SOC 2, ISO 27001, RBI guidelines sab maangte hain).
**Tamper-evident** = har event pichhle event ka hash include karta hai (hash chain); beech ki koi line badli ya hatai to verification toot jaata hai.

### Why it matters for an FDE
Enterprise deal mein security questionnaire ka ek poora section audit logging pe hota hai. AI app mein extra sawaal: "LLM ne kaunse documents user ko dikhaye?" -- iska jawab chunk ids ke audit events se aata hai (M12-07), prompts se nahi.

### Key concepts
- **Event schema** -- `ts`, `request_id`, `actor` (sub + type user/key/service), `action`, `resource`, `decision`, `reason`, `source_ip`. Fixed schema, JSON, ek line per event.
- **Log denies too** -- allow aur deny dono. Denies ka spike = attack ya broken role mapping.
- **Append-only + hash chain** -- app sirf append kar sake; `hash = sha256(prev_hash + canonical_json(event))`. Production mein WORM storage (S3 Object Lock, immutable blob) ya SIEM pe ship karo.
- **No secrets, no PII, no raw prompts** -- tokens, API keys, prompt/answer text kabhi nahi. Prompt ka `sha256` + length + chunk ids chalega (M13-14).
- **Retention + access** -- kitne din (customer/regulation decide karta hai), aur audit log padhne ki permission bhi audited (`audit:read`).

### Code example
`stdlib only`

```python
# runnable
import hashlib, json, os, tempfile, uuid
from datetime import datetime, timezone
from pathlib import Path

GENESIS = "0" * 64
FORBIDDEN_KEYS = {"token", "authorization", "api_key", "password", "prompt", "answer", "cookie"}

def canonical(d: dict) -> bytes:
    return json.dumps(d, sort_keys=True, separators=(",", ":")).encode()

class AuditLog:
    def __init__(self, path: str):
        self.path, self.prev = path, GENESIS
        if os.path.exists(path):                       # resume the chain after a restart
            lines = Path(path).read_text(encoding="utf-8").splitlines()
            self.prev = json.loads(lines[-1])["hash"] if lines else GENESIS

    def record(self, *, request_id, actor, action, resource, decision, reason, **extra) -> dict:
        if bad := FORBIDDEN_KEYS & {k.lower() for k in extra}:
            raise ValueError(f"refusing to audit-log sensitive fields: {sorted(bad)}")
        event = {"ts": datetime.now(timezone.utc).isoformat(), "event_id": uuid.uuid4().hex,
                 "request_id": request_id, "actor": actor, "action": action, "resource": resource,
                 "decision": decision, "reason": reason, **extra, "prev_hash": self.prev}
        event["hash"] = hashlib.sha256(self.prev.encode() + canonical(event)).hexdigest()
        with open(self.path, "a", encoding="utf-8") as f:            # append only
            f.write(json.dumps(event, sort_keys=True) + "\n")
        self.prev = event["hash"]
        return event

def verify_chain(path: str) -> int | None:
    """Return the line number of the first broken event, or None if the chain is intact."""
    prev = GENESIS
    with open(path, encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            e = json.loads(line)
            body = {k: v for k, v in e.items() if k != "hash"}
            if e["prev_hash"] != prev or hashlib.sha256(prev.encode() + canonical(body)).hexdigest() != e["hash"]:
                return n
            prev = e["hash"]
    return None

def prompt_fingerprint(text: str) -> dict:          # what we keep instead of the prompt
    return {"prompt_sha256": hashlib.sha256(text.encode()).hexdigest()[:16], "prompt_chars": len(text)}

with tempfile.TemporaryDirectory() as d:
    path = os.path.join(d, "audit.jsonl")
    log = AuditLog(path)
    rid = uuid.uuid4().hex
    question = "Summarise discharge notes for patient P-2291 (Ramesh K, diabetic)"
    log.record(request_id=rid, actor={"sub": "dr-iyer", "type": "user"}, action="rag.retrieve",
               resource="patient:P-2291", decision="allow", reason="role=doctor,care_team",
               chunk_ids=["dn-88", "dn-91"], **prompt_fingerprint(question))
    log.record(request_id=uuid.uuid4().hex, actor={"sub": "nurse-4", "type": "user"}, action="rag.retrieve",
               resource="patient:P-2291", decision="deny", reason="not_in_care_team")
    log2 = AuditLog(path)                            # simulated restart: chain continues
    log2.record(request_id=uuid.uuid4().hex, actor={"sub": "key:3f9a12bc", "type": "api_key"},
                action="export.csv", resource="ward:7", decision="deny", reason="scope_missing:export")

    raw = Path(path).read_text(encoding="utf-8")
    assert verify_chain(path) is None
    assert "Ramesh" not in raw and "diabetic" not in raw          # no PII / prompt text
    try:
        log.record(request_id=rid, actor={"sub": "x"}, action="a", resource="r", decision="allow",
                   reason="r", token="eyJhbGciOi...")
        raise AssertionError("token must be refused")
    except ValueError as e:
        print("blocked:", e)

    events = [json.loads(line) for line in raw.splitlines()]
    print("who saw P-2291:", [e["actor"]["sub"] for e in events if e["resource"] == "patient:P-2291" and e["decision"] == "allow"])
    assert sum(e["decision"] == "deny" for e in events) == 2          # denies are evidence too

    lines = raw.splitlines()                        # an insider edits a deny into an allow
    lines[1] = lines[1].replace('"decision": "deny"', '"decision": "allow"')
    Path(path).write_text("\n".join(lines) + "\n", encoding="utf-8")
    assert verify_chain(path) == 2
    Path(path).write_text("\n".join([raw.splitlines()[0], raw.splitlines()[2]]) + "\n", encoding="utf-8")
    assert verify_chain(path) == 2                   # deleting a line is detected too
print("OK: structured events, allow + deny, no PII, hash chain detects edits and deletions")
```

- Schema `record(*, request_id, actor, action, resource, decision, reason, **extra)` -- keyword-only, taaki koi field bhool na sake; `actor.type` se user, API key (M12-09) aur service alag dikhte hain.
- `FORBIDDEN_KEYS` -- token/prompt/password field aaya to exception. Galti code review mein nahi, runtime pe pakdi jaati hai.
- `prompt_fingerprint` -- prompt ka chhota hash + length. Same prompt dobara aaya to correlate kar sakte ho, padh nahi sakte. Hash ko reversible maan ke chalo agar input chhota/guessable ho -- isliye identifiers (patient id) `resource` mein, free text kahin nahi.
- `hash = sha256(prev + canonical(event))` -- `sort_keys` + fixed separators se canonical JSON; warna same event ka hash alag aayega.
- `verify_chain` -- edit (line 2) aur deletion dono pakde. Limitation: koi poori chain dobara likh de to ye nahi pakdega -- isliye latest hash periodically bahar anchor karo (WORM bucket, SIEM, ya HMAC key jo app ke paas na ho).

### Mini-exercise (30-60 min)
OmniGuard: `omniguard/audit/log.py`.
- Middleware jo har request ko `request_id` de (incoming `X-Request-ID` ya naya uuid), response header mein wapas bheje.
- Audit events: login, token refresh/reuse (M12-08), har `require_permission` deny (M12-06), har `/ask` retrieval (chunk ids + allow/deny counts, M12-07), API key create/rotate/revoke (M12-09).
- `scripts/verify_audit.py` jo chain verify kare aur exit code 1 de agar toota; CI mein ek tamper test.
- Acceptance: two-user demo (CP5 gate) chalane ke baad audit file se ek command mein jawab: "HR doc `hr-7` kisko dikha, kisko deny hua?"

### Common pitfalls
- App logs aur audit logs ek hi stream -- debug noise mein evidence kho jaata hai, aur retention alag-alag chahiye. Alag sink.
- `logger.info(f"request {request.headers}")` -- Authorization header, cookies, sab audit/log mein. Allow-list fields, kabhi poora object dump nahi (M13-14).
- Audit write fail ho to request ka kya? High-risk actions (export, admin) ke liye fail closed; baaki ke liye buffered queue + alert. Ye decision customer ke saath likho.

### Checklist before moving on
- [ ] Mere audit events mein who/what/when/resource/decision/reason/request_id hai, JSON mein.
- [ ] Deny events bhi log hote hain.
- [ ] Hash chain verify script hai aur tamper test pass karta hai.
- [ ] Tokens, keys, prompts, answers audit log mein nahi jaate -- test se proven.

### Related
- M12-06 Implementing Role-Based Access Control
- M12-07 Enforcing data-level permissions in retrieval layers
- M12-08 Session and token lifecycle
- M13-14 Safe logging (never log PII or prompts)
- M14-10 Capturing deep span-level execution traces

### Self-quiz
1. App log aur audit log mein teen farak batao.
2. Regulator poochta hai "kisne patient X ka data dekha". Kaunse fields chahiye aur prompt text kyun nahi?
3. Hash chain kya pakadti hai aur kya nahi? Gap kaise band karoge?
4. Audit storage down hai. `/export` request allow karoge ya deny? Aur `/ask`?
