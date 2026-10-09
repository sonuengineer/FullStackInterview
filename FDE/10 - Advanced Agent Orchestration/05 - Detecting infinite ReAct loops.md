# Advanced Agent Orchestration

## Detecting infinite ReAct loops

> Core | Fast CP7 / Slow CP9 | ~1.2 h | Builds on: M09-02, M05-15

### Kahani
Ek hospital ka scheduling agent: "Dr. Rao ka next free slot dhundo". Calendar API ne `503` diya. Agent ne socha "retry karta hoon" -- phir `search_slots("Dr Rao")`, phir `search_slots("dr. rao")`, phir `search_slots("Rao, Dr")`...
Weekend pe kisi ne nahi dekha. Monday ko bill aaya: ek hi conversation ne 2,100 LLM calls aur Rs 38,000 ke tokens jala diye. Logs mein har step "reasonable" lag raha tha -- bas kuch aage nahi badh raha tha.
M05-15 mein humne exact duplicate calls pakde the. Yahan model har baar thoda alag query bana raha tha, isliye wo guard bach nikla.

### What it is
**ReAct loop detection** = agent loop ke around guards jo pakadte hain ki agent progress nahi kar raha: hard **step/recursion limit**, normalized **(tool, args) fingerprint** repeat, **no-progress** (naya information nahi aa raha), aur **token/cost budget**. Trip hone pe agent ko rok ke **escalate** karo -- human, fallback answer, ya ticket.
Ek guard kaafi nahi; har guard ek alag failure shape pakadta hai.

### Why it matters for an FDE
Infinite loop = cost spike + hung request + customer ka "agent atak gaya". Customer ko budget guarantee chahiye ("ek conversation max Rs 20"), aur on-call ko clear reason ("no progress after 4 steps") -- "timeout" nahi.

### Key concepts
- **Recursion / step limit** -- last line of defence; LangGraph mein `recursion_limit` config, trip pe `GraphRecursionError`.
- **Normalized fingerprint** -- args ko lowercase, punctuation-strip, sort karke hash; "Dr Rao" aur "dr. rao" same fingerprint.
- **No-progress detection** -- observation hash pichhle N steps mein badla hi nahi (same error, same empty result) -> stuck.
- **Budget** -- per-run tokens aur cost cap; model price env/config se, hardcode nahi.
- **Escalation** -- reason code (`max_steps`, `repeat_call`, `no_progress`, `budget`) ke saath stop; metric + alert (M14-12).

### Code example
`stdlib only`

> Needs API key for the real version: ANTHROPIC_API_KEY (or OPENAI_API_KEY)

```python
# runnable
import hashlib
import json
import re
from collections import Counter, deque

def fingerprint(tool, args):
    norm = {k: re.sub(r"[^a-z0-9]+", " ", str(v).lower()).split() for k, v in args.items()}
    norm = {k: " ".join(sorted(v)) for k, v in norm.items()}          # "Rao, Dr" == "dr rao"
    return hashlib.sha256(f"{tool}:{json.dumps(norm, sort_keys=True)}".encode()).hexdigest()[:12]

class LoopGuard:
    def __init__(self, max_steps=8, max_repeats=2, no_progress_window=3, max_tokens=20_000):
        self.max_steps, self.max_repeats, self.window, self.max_tokens = max_steps, max_repeats, no_progress_window, max_tokens
        self.steps, self.tokens, self.calls, self.obs = 0, 0, Counter(), deque(maxlen=no_progress_window)
    def check(self, tool, args, observation, tokens_used):
        """Call after every tool step. Returns a stop reason or None."""
        self.steps += 1
        self.tokens += tokens_used
        fp = fingerprint(tool, args)
        self.calls[fp] += 1
        self.obs.append(hashlib.sha256(observation.encode()).hexdigest())
        if self.tokens > self.max_tokens:
            return "budget"
        if self.calls[fp] > self.max_repeats:
            return "repeat_call"
        if len(self.obs) == self.window and len(set(self.obs)) == 1:
            return "no_progress"
        if self.steps >= self.max_steps:
            return "max_steps"
        return None

def run_agent(script, tools, guard):
    """script = scripted model decisions (FakeLLM stand-in): list of (tool, args, tokens)."""
    for tool, args, tokens in script:
        if tool == "final":
            return {"status": "ok", "answer": args["text"], "steps": guard.steps}
        observation = tools[tool](**args)
        reason = guard.check(tool, args, observation, tokens)
        if reason:
            return {"status": "escalated", "reason": reason, "steps": guard.steps}
    return {"status": "escalated", "reason": "script_exhausted", "steps": guard.steps}

TOOLS = {"search_slots": lambda doctor: "error: calendar 503",
         "list_doctors": lambda dept: f"doctors in {dept}: rao, iyer",
         "get_slot": lambda doctor, day: f"{doctor} free on {day} 10:30"}
variants = ["Dr Rao", "dr. rao", "Rao, Dr", "DR RAO", "dr rao"]
r1 = run_agent([("search_slots", {"doctor": v}, 900) for v in variants], TOOLS, LoopGuard())
r2 = run_agent([("list_doctors", {"dept": d}, 900) for d in ["cardio", "ortho", "neuro", "ent"] * 3]
               + [("final", {"text": "x"}, 0)], TOOLS, LoopGuard(max_repeats=5, no_progress_window=4))
r3 = run_agent([("get_slot", {"doctor": "rao", "day": d}, 9_000) for d in ["mon", "tue", "wed"]], TOOLS, LoopGuard())
r4 = run_agent([("list_doctors", {"dept": "cardio"}, 800), ("get_slot", {"doctor": "rao", "day": "mon"}, 800),
                ("final", {"text": "Dr Rao is free Monday 10:30"}, 0)], TOOLS, LoopGuard())
for r in (r1, r2, r3, r4):
    print(r)
assert r1["reason"] in {"repeat_call", "no_progress"} and r1["steps"] == 3   # caught at step 3, not 2,100
assert r2["reason"] == "max_steps" and r2["steps"] == 8                      # varied calls, still capped
assert r3["reason"] == "budget"
assert r4["status"] == "ok" and r4["steps"] == 2                             # healthy run untouched
print("OK: four loop shapes caught, healthy run passes")
```

- `fingerprint` -- punctuation/case hata ke words sort; model ke "creative" re-phrasings ek hi bucket mein.
- `obs` deque -- last 3 observations same (`calendar 503`) = no progress, chahe call args alag hon.
- `r2` har call alag aur observation bhi alag -- sirf `max_steps` pakadta hai. Isliye hard cap hamesha chahiye.
- `r3` sirf 3 steps, lekin 27k tokens -- budget guard; real mein `usage.input_tokens + output_tokens` (M14-11) se gino.
- `r4` -- guards healthy run ko nahi chhedte; thresholds ko apne eval traces se tune karo, guess se nahi.

```python
# real version -- not run here, needs: pip install langgraph
# Check the LangGraph docs for your version.
from langgraph.errors import GraphRecursionError

try:
    result = graph.invoke(inputs, config={"recursion_limit": 12, "configurable": {"thread_id": tid}})
except GraphRecursionError:
    escalate(tid, reason="max_steps")   # state is checkpointed: a human can inspect and resume
```

Custom guards (fingerprint, no-progress, budget) ko ek conditional edge ke andar rakho: `route_after_tool(state)` guard check kare aur stop reason pe `"escalate"` node pe bheje.

### Mini-exercise (30-60 min)
CP7 AuditMesh: `auditmesh/guards.py` banao aur supervisor graph ke har tool step ke baad chalao.
- `LoopGuard` with config from env (`AUDITMESH_MAX_STEPS`, `AUDITMESH_MAX_TOKENS`); stop pe `escalate` node jo ek approval-style record (M10-04) banaye with reason.
- `evals/loop_cases.jsonl`: 8 scripted runs (exact repeat, rephrased repeat, same error 3x, varied-but-endless, token blowup, 3 healthy).
- Acceptance: pytest -- har case ka expected reason; healthy runs ka `status == "ok"`; koi run 12 steps se zyada nahi.

### Common pitfalls
- Sirf `recursion_limit` pe bharosa -- 25 steps tak paisa jalta rehta hai, aur reason "limit hit" se debugging nahi hoti.
- Limit trip pe silently last partial answer user ko dena -- galat/adhoora jawab; explicit fallback + escalation do.
- Thresholds itne tight ki legit multi-step research (10 alag docs padhna) bhi trip ho -- per-agent tune karo, traces dekh ke.

### Checklist before moving on
- [ ] Chaar loop shapes (repeat, rephrase, no-progress, budget) aur unke guards bata sakta hoon.
- [ ] Fingerprint normalization rephrased calls pakadta hai.
- [ ] Har stop ke saath reason code aur escalation hai, sirf exception nahi.
- [ ] Healthy runs guard se affect nahi hote (test hai).

### Related
- M09-02 ReAct framework loops
- M05-15 Managing hallucinated tool calls
- M10-06 Self-correction prompting mechanisms
- M14-11 Monitoring granular token costs and endpoint latency
- M14-12 Debugging multi-step agent reasoning and tool inputs

### Self-quiz
1. Model har baar alag doctor ka naam search kar raha hai (legit). Kaunsa guard galat trip kar sakta hai aur kaise bachoge?
2. No-progress window 3 hai. Upstream API flaky hai (har 2nd call 503). Kya guard trip karega? Kya karna chahiye?
3. Loop guard tool layer pe ho ya graph routing pe -- dono ke fayde batao.
4. Budget trip hone pe user ko kya message jaana chahiye, aur on-call ko kya data?
