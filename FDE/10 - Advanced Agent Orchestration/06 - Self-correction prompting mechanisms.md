# Advanced Agent Orchestration

## Self-correction prompting mechanisms

> Core | Fast CP7 / Slow CP9 | ~1.2 h | Builds on: M05-09, M10-05

### Kahani
Ek pharma customer ka AuditMesh agent SOP documents se "control findings" nikaalta hai: control ID, status, aur supporting quote.
Pilot mein 12% findings mein quote document mein tha hi nahi -- model ne "plausible" sentence bana diya. Kisi ne prompt mein add kiya "Please double-check your answer." Accuracy waisi hi rahi, cost 2x.
Phir ek aur engineer ne "jab tak sahi na ho tab tak retry" laga diya -- ek document pe agent 9 baar ghooma aur aakhri answer pehle wale se bhi kharab tha.

### What it is
**Self-correction** = model ka output ek **objective validator** (schema, tests, grounding check) se jaancho, fail hone pe **specific error** wapas model ko do ("quote not found in source: '...'"), aur **bounded retries** ke baad best attempt ya human review pe ruk jao.
Asli taaqat validator mein hai, "reflect karo" prompt mein nahi. Bina external signal ke same model apni galti aksar nahi pakad paata.

### Why it matters for an FDE
Customer ke documents pe hallucinated evidence = audit finding galat = regulatory risk. Self-correction sasta quality lever hai, lekin unbounded retries cost aur latency ka bomb hain -- aur kabhi kabhi answer ko kharab bhi karte hain.

### Key concepts
- **Objective validator first** -- Pydantic schema, unit tests, SQL dry-run, "quote substring in source"; yahi feedback ka source hai.
- **Specific feedback** -- "field `status`: must be one of pass/fail" > "your answer was wrong". Error text exact aur chhota.
- **Bounded retries + best-so-far** -- max 2-3 attempts; har attempt ka score rakho, last nahi best return karo.
- **Critic vs same-model reflection** -- alag critic (doosra prompt/model ya rule engine) independent check deta hai; same-model "are you sure?" aksar sahi answer ko bhi badal deta hai.
- **Stop on no improvement** -- same error do baar = model atka hai; retry nahi, escalate (M10-05).

### Code example
`pip install pydantic`

> Needs API key for the real version: ANTHROPIC_API_KEY (or OPENAI_API_KEY)

```python
# runnable
import json
from typing import Literal

from pydantic import BaseModel, ValidationError

SOURCE = ("SOP-14 section 3: Access reviews for production databases are performed quarterly. "
          "The Q2 review was not completed by the deadline. Backups are tested monthly and passed.")

class Finding(BaseModel):
    control_id: str
    status: Literal["pass", "fail"]
    quote: str

def validate(raw):
    """Objective checks. Returns (score, errors). Score = number of checks passed (max 3)."""
    try:
        f = Finding.model_validate_json(raw)
    except ValidationError as e:
        return 0, [f"{'.'.join(map(str, x['loc']))}: {x['msg']}" for x in e.errors()[:2]]
    errors = []
    if f.quote not in SOURCE:
        errors.append(f"quote not found verbatim in source: {f.quote[:60]!r}")
    if f.status == "fail" and "not completed" not in f.quote:
        errors.append("status=fail but quote does not show a failure")
    return 3 - len(errors), errors

class FakeLLM:
    """Stand-in for client.messages.create(...): returns scripted attempts, records prompts."""
    def __init__(self, attempts):
        self.attempts, self.prompts = list(attempts), []
    def create(self, messages):
        self.prompts.append(messages[-1]["content"])
        return self.attempts.pop(0)

def extract_with_correction(llm, max_attempts=3):
    messages = [{"role": "user", "content": f"Extract the access-review finding as JSON.\n{SOURCE}"}]
    best, seen_errors = (-1, None, ["no attempt"]), set()
    for _ in range(max_attempts):
        raw = llm.create(messages)
        score, errors = validate(raw)
        if score > best[0]:
            best = (score, raw, errors)                        # keep BEST, not last
        if not errors:
            return {"status": "ok", "finding": json.loads(raw), "attempts": len(llm.prompts)}
        if tuple(errors) in seen_errors:                       # same mistake again -> stuck
            break
        seen_errors.add(tuple(errors))
        messages += [{"role": "assistant", "content": raw},
                     {"role": "user", "content": "Fix ONLY these problems and return JSON:\n- " + "\n- ".join(errors)}]
    return {"status": "needs_review", "best": best[1], "errors": best[2], "attempts": len(llm.prompts)}

good = '{"control_id": "SOP-14-3", "status": "fail", "quote": "The Q2 review was not completed by the deadline."}'
# 1) bad enum + invented quote -> specific feedback -> fixed on attempt 3
llm = FakeLLM(['{"control_id": "SOP-14-3", "status": "failed", "quote": "x"}',
               '{"control_id": "SOP-14-3", "status": "fail", "quote": "Q2 access review was skipped."}', good])
r = extract_with_correction(llm)
print(r["status"], "after", r["attempts"], "attempts | feedback 2:", llm.prompts[1].splitlines()[1])
assert r["status"] == "ok" and r["attempts"] == 3 and "status" in llm.prompts[1]
# 2) model gets WORSE after feedback -> we return the best attempt, flagged for review
half = '{"control_id": "SOP-14-3", "status": "fail", "quote": "Access reviews are skipped."}'
r = extract_with_correction(FakeLLM([half, '{"control_id": 1}', '{"oops"']))
assert r["status"] == "needs_review" and r["best"] == half
# 3) same error twice -> stop early, do not burn the third call
llm = FakeLLM([half, half, good])
r = extract_with_correction(llm)
assert r["status"] == "needs_review" and r["attempts"] == 2
print("OK: validator-driven feedback, bounded retries, best-so-far, early stop")
```

- `validate()` teen objective checks -- schema, verbatim quote (grounding), logical consistency. Feedback inhi errors se banta hai.
- Feedback message mein sirf errors list -- "Fix ONLY these problems" se model sahi parts ko nahi chhedta.
- Case 2 -- attempt 2 aur 3 pehle se kharab; `best` tuple pehla (score 2) wala return karta hai, last wala kachra nahi.
- Case 3 -- same error do baar -> `break`; teesri call ka paisa bacha, human review queue mein gaya.
- `needs_review` ko M10-04 ke approval/review flow mein bhejo -- self-correction ka end state "insaan dekhe" ho sakta hai.

```python
# real version -- not run here, needs: pip install anthropic pydantic
import os
import anthropic

client = anthropic.Anthropic()
MODEL = os.environ.get("LLM_MODEL", "<your-model-id>")

class AnthropicLLM:
    def create(self, messages):
        resp = client.messages.create(model=MODEL, max_tokens=500, messages=messages,
                                      system="Return only JSON with control_id, status, quote. Quote verbatim.")
        return "".join(b.text for b in resp.content if b.type == "text")

result = extract_with_correction(AnthropicLLM())
```

Structured outputs (M05-06) schema errors ko lagbhag khatam kar dete hain; grounding aur business-rule checks phir bhi tumhare validator ka kaam hain.

### Mini-exercise (30-60 min)
CP7 AuditMesh: `auditmesh/self_correct.py` -- evidence agent ke output pe correction loop.
- Validators: Pydantic `Finding`, quote verbatim in retrieved chunk, `control_id` exists in controls list.
- 10 scripted cases (FakeLLM): first-try pass, fix-on-retry, gets-worse, same-error-twice, never-valid.
- Acceptance: pytest -- har case ka expected status; total LLM calls <= 3 per case; `needs_review` cases ka best attempt returned; metric `self_correction_attempts` log hota hai (bina document text ke).

### Common pitfalls
- "Double-check your answer" bina kisi validator ke -- model confident hoke sahi answer ko galat mein badal deta hai.
- Unbounded `while not valid` loop -- ek tough document = 20 calls; hamesha max attempts + no-improvement stop.
- Poora validator error (stack trace, poora document) feedback mein -- tokens waste, aur prompt injection ka raasta; chhota, specific error do.

### Checklist before moving on
- [ ] Har self-correction loop ke peeche ek objective validator hai.
- [ ] Feedback specific error list hai, generic "try again" nahi.
- [ ] Best-so-far return hota hai aur same-error pe early stop hai.
- [ ] Critic vs same-model reflection ka trade-off bata sakta hoon.

### Related
- M05-09 Handling and retrying output parsing errors gracefully
- M05-06 Enforcing strict JSON output schemas via APIs
- M10-05 Detecting infinite ReAct loops
- M14-05 Automating LLM-as-a-judge scoring pipelines

### Self-quiz
1. Agar tumhare paas koi objective validator nahi hai (free-text summary), to self-correction kaise design karoge?
2. Same-model reflection kab output ko kharab kar deta hai? Ek concrete example do.
3. Best-so-far ke liye score kaise define karoge jab checks ka weight alag ho (schema vs grounding)?
4. Self-correction ka cost: average attempts 1.4 hai. Isse per-request cost aur p95 latency pe kya asar padega?
