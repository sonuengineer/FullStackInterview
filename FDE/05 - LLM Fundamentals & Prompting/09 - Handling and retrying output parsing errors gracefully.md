# LLM Fundamentals & Prompting

## Handling and retrying output parsing errors gracefully

> Core | Fast CP2 / Slow CP3 | ~1.2 h | Builds on: M01-04, M05-06, M05-07

### Kahani
Ek hospital ka appointment-triage bot structured JSON deta hai. Schema enforcement ke baad bhi weekly ~0.5% calls fail: kabhi `max_tokens` pe JSON kat gaya, kabhi `urgency: "very high"` (enum mein nahi), kabhi date galat format mein.
Purana code exception pe seedha 500 return karta tha -- nurse ko "Something went wrong" dikhta tha. Kisi ne `while True: retry` laga diya -- ek bad prompt pe ek request ne 40 calls kar daale aur bill uda diya.
Aapko chahiye: bounded retry, model ko exact error batao taaki wo khud fix kare, aur limit ke baad graceful fallback -- kabhi invalid JSON downstream nahi.

### What it is
**Repair-retry loop** = output validate karo; fail ho to `ValidationError` ka chhota, readable text model ko next turn mein bhejo ("field `urgency`: must be one of low/medium/high") aur dobara maango. Max attempts ke baad ek typed failure return karo (human review queue, safe default).
Parse errors aur API errors alag cheez hain: 429/5xx/timeout pe backoff retry (same request), parse error pe **repair** retry (error feedback ke saath).

### Why it matters for an FDE
CP2 gate: "50 LLM calls with zero invalid JSON". Zero ka matlab ye nahi ki model kabhi galti nahi karega -- matlab aapka system galti ko pakad ke fix karega ya clearly fail karega, kabhi garbage aage nahi bhejega.

### Key concepts
- **Bounded attempts** -- `max_attempts` (2-3) config se; har attempt log karo; infinite loop kabhi nahi.
- **Error feedback** -- `e.errors()` se `loc` + `msg` ka compact list; poora traceback ya input data nahi (tokens + PII).
- **Conversation shape** -- bad output `assistant` turn mein, error `user` turn mein; model apni galti "dekh" ke sudharta hai.
- **Classify failures** -- `max_tokens` (badha ke retry), `refusal` (retry mat karo), validation error (repair), transport error (backoff, M14-02).
- **Graceful fallback** -- typed `Failure` result + metric/alert; caller decide kare (human queue, default answer). Exception leak nahi, garbage nahi.

### Code example
`pip install pydantic`

> Needs API key for the real version: ANTHROPIC_API_KEY (or OPENAI_API_KEY)

```python
# runnable
import random
from dataclasses import dataclass, field
from typing import Literal

from pydantic import BaseModel, ConfigDict, ValidationError

class Triage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    urgency: Literal["low", "medium", "high"]
    department: str

@dataclass
class Failure:
    reason: str
    attempts: int
    errors: list = field(default_factory=list)

class FakeLLM:
    """Mimics client.messages.create(...). No network. Plays scripted replies, or random ones."""
    def __init__(self, script=None, seed=0):
        self.script, self.rng, self.calls = list(script or []), random.Random(seed), 0

    def create(self, model, max_tokens, system, messages):
        self.calls += 1
        if self.script:
            stop, text = self.script.pop(0)
        else:
            fixing = "Validation failed" in str(messages[-1]["content"])
            bad = self.rng.random() < (0.05 if fixing else 0.3)    # 30% bad first try
            text = '{"urgency": "very high", "department": "ER"}' if bad else '{"urgency": "high", "department": "ER"}'
            stop = "end_turn"
        return {"stop_reason": stop, "content": [{"type": "text", "text": text}]}

def short_errors(e: ValidationError):
    return [f"{'.'.join(map(str, x['loc'])) or '(root)'}: {x['msg']}" for x in e.errors()][:5]

def call_with_repair(llm, user_text, max_attempts=3, max_tokens=300):
    messages = [{"role": "user", "content": user_text}]
    errors = []
    for attempt in range(1, max_attempts + 1):
        resp = llm.create(model="fake", max_tokens=max_tokens, system="Return Triage JSON only.",
                          messages=messages)
        text = "".join(b["text"] for b in resp["content"] if b["type"] == "text")
        if resp["stop_reason"] == "refusal":
            return Failure("refusal", attempt)                     # do not retry refusals
        if resp["stop_reason"] == "max_tokens":
            max_tokens *= 2                                         # truncated: give more room
            errors = ["output truncated"]
            continue
        try:
            return Triage.model_validate_json(text)
        except ValidationError as e:
            errors = short_errors(e)
            messages += [{"role": "assistant", "content": text},
                         {"role": "user", "content": "Validation failed:\n- " + "\n- ".join(errors)
                          + "\nReturn the corrected JSON only."}]
    return Failure("max_attempts", max_attempts, errors)

# 1) scripted: truncated -> invalid enum -> valid
llm = FakeLLM(script=[("max_tokens", '{"urgency": "hi'),
                      ("end_turn", '{"urgency": "very high", "department": "ER"}'),
                      ("end_turn", '{"urgency": "high", "department": "ER"}')])
r = call_with_repair(llm, "Chest pain since 1 hour, age 64")
print("scripted:", r, "calls =", llm.calls)
assert isinstance(r, Triage) and llm.calls == 3

# 2) always bad -> bounded, typed failure, never garbage
r = call_with_repair(FakeLLM(script=[("end_turn", "not json")] * 3), "x")
print("hopeless:", r)
assert isinstance(r, Failure) and r.attempts == 3

# 3) mini gate: 50 calls, zero invalid JSON reaches the caller
llm = FakeLLM(seed=7)
results = [call_with_repair(llm, f"ticket {i}") for i in range(50)]
valid = sum(isinstance(x, Triage) for x in results)
failed = sum(isinstance(x, Failure) for x in results)
print(f"gate: valid={valid} explicit_failures={failed} llm_calls={llm.calls}")
assert valid + failed == 50 and valid >= 48 and llm.calls <= 150
print("OK: repair-retry with bounded attempts and typed fallback")
```

- `short_errors` -- sirf `loc: msg`, max 5 lines; model ko pata chalta hai kya theek karna hai, bina extra tokens ya input data repeat kiye.
- Bad output `assistant` turn mein aur error `user` turn mein -- conversation end hamesha `user` pe, aur model ko context milta hai kya galat tha.
- `max_tokens` stop pe repair message nahi -- budget double karke same request; truncation model ki galti nahi thi.
- `refusal` pe turant `Failure` -- dobara poochne se usually wahi jawab aur extra cost.
- Gate test: 50 calls -- har result ya valid `Triage` ya explicit `Failure`; invalid JSON kabhi caller tak nahi gaya, aur total calls bounded (<= 3x).

```python
# real version -- not run here, needs: pip install anthropic pydantic
import os
import anthropic

MODEL = os.environ.get("LLM_MODEL", "<your-model-id>")
client = anthropic.Anthropic(max_retries=2, timeout=30)   # SDK retries 429/5xx itself


class AnthropicAdapter:
    def create(self, model, max_tokens, system, messages):
        resp = client.messages.create(
            model=MODEL, max_tokens=max_tokens, system=system, messages=messages,
            output_config={"format": {"type": "json_schema", "schema": Triage.model_json_schema()}},
        )
        return {"stop_reason": resp.stop_reason,
                "content": [{"type": b.type, "text": getattr(b, "text", "")} for b in resp.content]}


result = call_with_repair(AnthropicAdapter(), "Chest pain since 1 hour, age 64")
```

Transport errors (429, 5xx, timeouts) are a different retry layer: the SDK's `max_retries` plus your own backoff (M14-02) -- do not mix them into the repair loop.

### Mini-exercise (30-60 min)
CP2 gate ka core: `omniguard/llm.py` mein `call_with_repair(...)` integrate karo.
- `MAX_ATTEMPTS` env var se (default 3); har attempt ka structured log: `request_id`, attempt, stop_reason, error count (raw text nahi).
- `/triage` endpoint: `Failure` pe 422/503 with `{"status": "needs_review"}` -- kabhi model ka raw text nahi.
- `scripts/gate.py`: FakeLLM (30% bad first tries, seeded) se 50 calls; phir agar key hai to real model se 50. Output: valid, explicit failures, invalid_json_leaked (must be 0), total LLM calls, total tokens.
- Acceptance: pytest -- leaked == 0, calls <= 3 x 50, refusal pe exactly 1 call.

### Common pitfalls
- Retry pe exactly same prompt bhejna (bina error feedback) -- temperature 0 pe aksar same galti dobara; repair message zaroori.
- Error message mein poora input/user data echo karna -- tokens badhte hain aur PII logs mein jaati hai.
- Parse retries aur HTTP retries ko nest karna (3 x 3 x 3) -- ek request 27 calls. Har layer ka budget alag aur chhota rakho.

### Checklist before moving on
- [ ] Repair-retry loop likh sakta hoon jo error ko model ko feedback karta hai.
- [ ] `max_tokens`, `refusal`, validation error aur transport error ko alag handle karta hoon.
- [ ] Max attempts ke baad typed failure return hota hai, garbage nahi.
- [ ] Mere gate script mein invalid JSON leaked = 0 aur calls bounded hain.

### Related
- M01-04 Exception handling
- M05-06 Enforcing strict JSON output schemas via APIs
- M05-15 Managing hallucinated tool calls
- M14-02 Exponential backoff strategies

### Self-quiz
1. Validation error aur 429 error -- dono pe retry, lekin kaise alag? Kyun mix nahi karna?
2. Repair message mein poora `ValidationError` string bhejne ke kya nuksaan hain?
3. 3 attempts ke baad bhi fail. Hospital use case mein aap user ko kya dikhaoge aur system kya karega?
4. "Zero invalid JSON" gate ko aap kaise prove karoge ki pass hua -- kaunse numbers report karoge?
