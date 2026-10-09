# AI Observability & Gateway Management

## Automating LLM-as-a-judge scoring pipelines

> Core | Fast CP3 / Slow CP4 | ~1.2 h | Builds on: M05-06, M05-09, M06-10

### Kahani
Ek insurance company ka claims-support RAG bot live hai. Har week prompt ya retriever mein chhota change hota hai, aur team "vibe check" karti hai -- 5 sawaal poocho, "theek lag raha hai", ship.
Teesre release ke baad complaints aaye: bot policy ki galat waiting period bata raha tha. Kisi ne 300 answers manually padhne ki koshish ki -- 2 din lage, aur do reviewers ki rai bhi alag thi.
Customer ka CTO poochta hai: "Har release pe quality ka ek number do, automatically, aur prove karo ki wo number trust karne layak hai."
Aapka jawab: ek LLM-as-a-judge pipeline -- rubric, strict JSON verdict, cache, sampling, aur human labels se calibrated.

### What it is
**LLM-as-a-judge** = ek doosra LLM call jo aapke system ke output ko ek fixed rubric pe grade karta hai aur structured verdict (score + reason) deta hai.
Pipeline = dataset ya sampled traffic -> judge prompt -> validated verdict -> aggregate score -> report. Isse M14-06/07 ke RAG metrics bhi bante hain (wo bhi andar se judge calls hi hain).

### Why it matters for an FDE
Customer site pe "accuracy kitni hai?" ka jawab bina eval pipeline ke sirf guess hai. Uncalibrated judge aur bhi khatarnak hai -- confident galat number, jispe release decisions ho jaate hain.

### Key concepts
- **Rubric prompt** -- score levels ki explicit definition (5 = ..., 3 = ..., 1 = ...); vague "rate quality 1-10" se noise aata hai.
- **Strict verdict** -- judge ka output Pydantic model se validate (M05-06); invalid verdict = retry ya "unscored", kabhi silently 0 nahi.
- **Pointwise vs pairwise** -- pointwise: ek answer ko absolute score; pairwise: A vs B mein kaun better (prompt v1 vs v2 compare karne ke liye zyada stable).
- **Position bias** -- judges aksar pehle wale answer ko prefer karte hain; fix: dono order mein poocho, consistent ho to hi winner, warna tie.
- **Calibration** -- ~20 human-labelled items pe judge vs human: agreement % aur **Cohen's kappa** (chance agreement hata ke). Kappa low = judge pe bharosa mat karo.

### Code example
`pip install pydantic`

> Needs API key for the real version: ANTHROPIC_API_KEY (or OPENAI_API_KEY)

```python
# runnable
import hashlib, json, re
from typing import Literal

from pydantic import BaseModel, Field

RUBRIC_V = "claims-rubric-v2"
RUBRIC = ("Grade the ANSWER against the CONTEXT. 5 = fully grounded and correct, 3 = partly, "
          "1 = wrong or not in context. Return JSON only: {\"score\": int, \"reason\": str}")

class Verdict(BaseModel):
    score: int = Field(ge=1, le=5)
    reason: str = Field(max_length=300)

class PairVerdict(BaseModel):
    winner: Literal["A", "B", "tie"]
    reason: str

toks = lambda s: set(re.findall(r"[a-z0-9]+", s.lower()))
overlap = lambda ans, ctx: len(toks(ans) & toks(ctx)) / max(len(toks(ans)), 1)

class FakeJudge:
    """Deterministic stand-in for an LLM judge -- ONLY for wiring/tests, not a real grader.
    Scores by token overlap; pairwise mode has a deliberate position bias toward 'A'."""
    calls = 0
    def complete(self, system, user):
        self.calls += 1
        d = json.loads(user)
        if "answer_a" in d:
            sa, sb = overlap(d["answer_a"], d["context"]), overlap(d["answer_b"], d["context"])
            return json.dumps({"winner": "A" if sa + 0.2 >= sb else "B", "reason": f"{sa:.2f}/{sb:.2f}"})
        s = overlap(d["answer"], d["context"])
        return json.dumps({"score": 1 + round(4 * s), "reason": f"overlap={s:.2f}"})

CACHE = {}
def judge_point(judge, answer, context):
    payload = json.dumps({"answer": answer, "context": context}, sort_keys=True)
    key = hashlib.sha256((RUBRIC_V + payload).encode()).hexdigest()   # rubric version is in the key
    if key not in CACHE:
        CACHE[key] = Verdict.model_validate_json(judge.complete(RUBRIC, payload))
    return CACHE[key]

def judge_pair(judge, a, b, context):
    ask = lambda x, y: PairVerdict.model_validate_json(judge.complete(
        "Which answer is better grounded?", json.dumps({"answer_a": x, "answer_b": y, "context": context}))).winner
    first, second = ask(a, b), ask(b, a)                                 # swap order
    swapped_back = {"A": "B", "B": "A", "tie": "tie"}[second]
    return first if first == swapped_back else "tie"                     # inconsistent -> tie

def should_judge(trace_id, rate=0.1):                                    # deterministic sampling
    return int(hashlib.sha256(trace_id.encode()).hexdigest(), 16) % 1000 < rate * 1000

def cohens_kappa(h, j):
    n = len(h); po = sum(x == y for x, y in zip(h, j)) / n
    ph, pj = sum(h) / n, sum(j) / n
    pe = ph * pj + (1 - ph) * (1 - pj)
    return po, (po - pe) / (1 - pe)

CTX = "Accident claims are covered after a 30 day waiting period. Illness claims need 90 days."
GOOD = ["accident claims are covered after a 30 day waiting period", "illness claims need 90 days"]
BAD = ["claims are paid instantly with no waiting", "you get a free phone with every policy"]
items = [(GOOD[i % 2], 1) if i % 3 else (BAD[i % 2], 0) for i in range(20)]
human = [lab for _, lab in items]
human[4], human[7] = 0, 0                    # two items where the human disagreed with "truth"

judge = FakeJudge()
judged = [int(judge_point(judge, ans, CTX).score >= 4) for ans, _ in items]
po, kappa = cohens_kappa(human, judged)
print(f"calibration: agreement={po:.0%} kappa={kappa:.2f} judge_calls={judge.calls}")
assert judge.calls == 4                      # 20 items, only 4 unique -> cache works
assert po == 0.9 and kappa > 0.6

near_tie = judge_pair(judge, "covered after 30 days", "accident claims covered after 30 day waiting", CTX)
clear = judge_pair(judge, "free phone", "illness claims need 90 days", CTX)
print("pairwise near-tie:", near_tie, "| clear:", clear)
assert near_tie == "tie" and clear == "B"    # bias cancelled by swapping
sampled = sum(should_judge(f"trace-{i}") for i in range(5000))
assert 350 < sampled < 650, sampled         # ~10% of traffic gets judged
print("OK: rubric judge with strict verdicts, cache, swap-order pairwise, kappa calibration")
```

- `Verdict` / `PairVerdict` -- judge ka output bhi untrusted hai; Pydantic validate karta hai ki score 1-5 hi ho. Real pipeline mein yahan M05-09 ka repair-retry lagao.
- Cache key mein `RUBRIC_V` -- rubric badla to purane scores reuse nahi honge; same input pe dobara pay nahi karte (20 items, 4 calls).
- `judge_pair` -- A,B aur B,A dono order; FakeJudge ka "A" bias near-tie pe dono baar pehle wale ko jitata hai, isliye inconsistent -> `tie`. Clear case pe winner stable rehta hai.
- `cohens_kappa` -- 90% agreement accha lagta hai, lekin agar 70% items "pass" hi hain to random judge bhi kaafi agree karega; kappa wo chance hata deta hai (~0.6+ reasonable, < 0.4 judge rubric fix karo).
- `should_judge` -- trace id ka hash se 10% sampling: deterministic, har replica same decision, production traffic pe cost control.

```python
# real version -- not run here, needs: pip install anthropic pydantic
import os
import anthropic

client = anthropic.Anthropic(max_retries=2, timeout=60)
JUDGE_MODEL = os.environ.get("JUDGE_MODEL", "<a-different-model-id-than-the-app>")

class AnthropicJudge:
    def complete(self, system, user):
        msg = client.messages.parse(model=JUDGE_MODEL, max_tokens=300, system=system,
                                    messages=[{"role": "user", "content": user}],
                                    output_format=Verdict)
        return msg.parsed_output.model_dump_json()
```

### Mini-exercise (30-60 min)
OmniGuard Hybrid RAG v1 ke liye `omniguard/evals/judge.py` banao.
- `RUBRIC` file mein (`evals/rubrics/grounded_v1.txt`), version string cache key mein. Judge prompt app ke system prompt se bilkul alag.
- `evals/human_labels.jsonl` -- 20 OmniGuard answers khud padh ke pass/fail label karo. `run_eval.py --calibrate` agreement % aur kappa print kare.
- Pairwise mode: `run_eval.py --compare prompt_v1 prompt_v2` -> win/loss/tie counts (swap order ke saath).
- Acceptance: pytest -- invalid judge JSON pe "unscored" count badhta hai (crash nahi); cache hit pe judge call count same rehta hai; kappa `report.md` mein likha ho.

### Common pitfalls
- Same model + same prompt se judge karna jo app use karta hai -- wo apni hi galti ko "sahi" bolega. Judge prompt alag, ideally model bhi alag.
- Har production request judge karna -- cost double. Sample karo, cache karo, nightly batch mein chalao.
- Judge ke reason mein poora user data log karna -- PII eval logs mein pahunch jaati hai; IDs log karo, text nahi.

### Checklist before moving on
- [ ] Rubric prompt likh sakta hoon jisme har score level defined ho.
- [ ] Judge verdict Pydantic se validate hota hai aur invalid verdict alag count hota hai.
- [ ] Pairwise compare swap order ke saath karta hoon aur samajhta hoon kyun.
- [ ] 20 human labels pe agreement aur kappa calculate kar sakta hoon.

### Related
- M05-06 Enforcing strict JSON output schemas via APIs
- M05-09 Handling and retrying output parsing errors gracefully
- M14-06 Calculating RAGAS faithfulness and answer relevance metrics
- M14-09 Tracking evaluation scores across deployment runs

### Self-quiz
1. 90% agreement aur kappa 0.2 -- dono ek saath kaise possible hai? Aap kya conclude karoge?
2. Pairwise judging pointwise se zyada stable kyun hota hai, aur position bias ko kaise neutralize karte ho?
3. Cache key mein rubric version na ho to kya galat ho sakta hai?
4. Customer kehta hai "judge ka cost kam karo" -- teen concrete levers batao.
