# Day 15 -- Making AI Agent Production Ready

**Module:** 03 -- Advanced Agent Systems
**Time:** about 1 hour
**Builds on:** everything. Especially Day 9 -- verification; Day 12 -- measurement

---

## 1. Today in one line

You find out what your system actually costs, how often it actually works, and what happens when it breaks -- because right now you do not know any of those three.

---

## 2. The problem

Everything works. On your machine, on your documents, while you are watching.

Now answer these:

- **What does one task cost?** Not roughly. In tokens, and in rupees.
- **How often does it succeed?** Out of a hundred real tasks, how many are right?
- **What happens when Groq is down?** Does it crash, hang, or degrade sensibly?
- **You changed a prompt on Day 11. Did it make anything worse?** You cannot know.
- **Something went wrong last Tuesday at 3am. What happened?** No idea.

That is the gap between something that works and something you would let another person use.

There is one deeper problem, and it changes how you have to think.

**Normal software is deterministic.** Same input, same output. A test passes or fails, and if it passes today it passes tomorrow.

**Your system is statistical.** The same input can succeed today and fail tomorrow. There is no "it works". There is only a **rate** -- 87% of tasks, 93% of retrievals, 2% of runs exceed budget.

Which means every single-run observation you have made in this course is close to worthless as evidence. Including the ones in Day 12's table.

Today you start measuring rates.

---

## 3. Mental model

**A prototype car versus a shipped one.**

The prototype drives. The shipped one has a fuel gauge, a temperature warning, a service history, crash testing, and a manual describing what to do when the light comes on.

None of that makes it go faster. All of it is what separates something that works from something you would put another person in.

**Where this comparison breaks, and it is the important part:**

A car either starts or it does not. Your system starts, and produces a slightly different answer each time, and sometimes that answer is wrong in a way that looks exactly like being right.

So your dashboard cannot be a warning light. It has to be a set of **rates measured over many runs**:

- success rate, over 20 tasks, not one
- cost per task, averaged
- latency at p50 and p95, not "it felt fast"
- failure rate, and what kind of failure

> If you measured it once, you did not measure it.

That is today's sentence.

---

## 4. How it really works

**Five areas, in the order you should build them.**

**1. Observability -- know what happened**

Every model call logged as one line of structured data: trace id, which agent, model, tokens in and out, latency, success or failure. Structured, not prose, so you can aggregate it.

A **trace id** ties one user request to every call it caused. Without it, a 15-call multi-agent run is 15 unrelated log lines.

**2. Evals -- know how often it works**

Day 12 measured retrieval. Today you measure **answers**.

Two kinds of check:

- **Assertions** -- did the file appear, does the answer contain "30 November", is it under 200 words. Cheap, exact, trustworthy.
- **LLM-as-judge** -- for things assertions cannot check, like whether a summary is actually good. Useful and biased: judges favour longer answers, favour confident ones, and favour text written by the same model family. Treat it as a weak signal you have calibrated, never as ground truth.

**Regression is the real point.** Run the eval before and after a change. That is the only way to know whether your prompt edit helped.

**3. Reliability -- survive failure**

You have retries. Missing: **timeouts** (a hanging call), **fallback models** (provider down), **output validation with repair** (bad JSON -- try once more with the error), and **graceful degradation** (retrieval failed, so answer from general knowledge and say so).

**4. Cost -- know the number, then reduce it**

Measure per task. Then the three levers, in order of payoff:

- **Model routing** -- send easy tasks to a small model. Usually the biggest win by far.
- **Caching** -- identical or near-identical requests answered from a store.
- **Context trimming** -- shorter tool results, fewer retrieved chunks, tighter prompts.

**5. Limits -- bound the damage**

Per-user rate limits, per-user daily budget caps, a circuit breaker that stops calling a failing provider instead of hammering it.

---

## 5. Setup

```bash
cd research-assistant/ai
source venv/bin/activate

touch observability.py evals.py reliability.py
mkdir -p logs
```

No new libraries. Everything today is standard library plus what you have.

---

## 6. Build it

---

### Stage 1 -- Log everything, structured

`observability.py`:

```python
import json, time, uuid, os
from datetime import datetime, timezone
from contextvars import ContextVar

LOG_FILE = "logs/calls.jsonl"
_trace = ContextVar("trace_id", default=None)

# Groq pricing per million tokens, roughly. Check current rates.
PRICING = {
    "llama-3.3-70b-versatile": {"in": 0.59, "out": 0.79},
    "llama-3.1-8b-instant":    {"in": 0.05, "out": 0.08},
}


def new_trace():
    trace_id = uuid.uuid4().hex[:12]
    _trace.set(trace_id)
    return trace_id


def cost_of(model, prompt_tokens, completion_tokens):
    rates = PRICING.get(model, {"in": 0, "out": 0})
    return (prompt_tokens * rates["in"] + completion_tokens * rates["out"]) / 1_000_000


def log_call(model, component, prompt_tokens, completion_tokens,
             milliseconds, ok=True, error=None):
    record = {
        "time": datetime.now(timezone.utc).isoformat(),
        "trace": _trace.get(),
        "component": component,
        "model": model,
        "tokens_in": prompt_tokens,
        "tokens_out": completion_tokens,
        "ms": round(milliseconds),
        "usd": round(cost_of(model, prompt_tokens, completion_tokens), 6),
        "ok": ok,
        "error": error,
    }
    with open(LOG_FILE, "a") as f:
        f.write(json.dumps(record) + "\n")
    return record
```

Wrap every call site:

```python
def tracked_call(messages, tools=None, component="agent", model=MODEL):
    start = time.time()
    try:
        response = client.chat.completions.create(
            model=model, messages=messages, tools=tools)
        log_call(model, component,
                 response.usage.prompt_tokens,
                 response.usage.completion_tokens,
                 (time.time() - start) * 1000)
        return response
    except Exception as error:
        log_call(model, component, 0, 0, (time.time() - start) * 1000,
                 ok=False, error=str(error)[:200])
        raise
```

**`ContextVar` is why this works across your multi-agent code.** Set the trace id once at the start of a request, and every nested agent call picks it up automatically without you passing it through five function signatures. It also works correctly with the asyncio fan-out from Day 14.

**`component`** is what makes the log readable: `"supervisor"`, `"researcher"`, `"critic"`, `"extraction"`, `"rewrite"`. You are about to discover that one of these costs far more than you expected.

JSONL -- one JSON object per line -- because it appends safely and you can read it with anything.

Run a few tasks, then look at the raw file. That is the Day 1 habit, applied to your own system.

---

### Stage 2 -- Aggregate it

```python
def report(log_file=LOG_FILE):
    rows = [json.loads(line) for line in open(log_file)]
    if not rows:
        return print("No logs yet.")

    by_trace = {}
    by_component = {}

    for row in rows:
        by_trace.setdefault(row["trace"], []).append(row)
        c = by_component.setdefault(row["component"],
                                    {"calls": 0, "usd": 0, "tokens": 0, "ms": []})
        c["calls"] += 1
        c["usd"] += row["usd"]
        c["tokens"] += row["tokens_in"] + row["tokens_out"]
        c["ms"].append(row["ms"])

    print(f"{len(rows)} calls across {len(by_trace)} requests")
    print(f"total cost: ${sum(r['usd'] for r in rows):.4f}")
    print(f"failure rate: {sum(1 for r in rows if not r['ok'])/len(rows):.1%}\n")

    print(f"{'component':16s} {'calls':>6s} {'tokens':>9s} {'usd':>9s} {'p50ms':>7s} {'p95ms':>7s}")
    for name, c in sorted(by_component.items(), key=lambda x: -x[1]["usd"]):
        times = sorted(c["ms"])
        p50 = times[len(times)//2]
        p95 = times[int(len(times)*0.95)] if len(times) > 1 else times[0]
        print(f"{name:16s} {c['calls']:6d} {c['tokens']:9d} ${c['usd']:8.4f} {p50:7.0f} {p95:7.0f}")

    costs = sorted(sum(r["usd"] for r in calls) for calls in by_trace.values())
    print(f"\ncost per request: median ${costs[len(costs)//2]:.4f}, "
          f"worst ${costs[-1]:.4f}")
```

Run twenty varied tasks, then `report()`.

**Two things will probably surprise you.**

**p95 is much worse than p50.** Median might be 900ms and p95 six seconds. Averages hide this completely, which is why nobody who runs a service quotes averages. Your users experience p95 regularly.

**One component dominates the cost, and it is not the one you expected.** Very often it is memory extraction from Day 11 -- a call on every single turn that you stopped thinking about. Or the multi-query rewrite from Day 12.

You have now found your optimisation target with evidence instead of intuition.

---

### Stage 3 -- Measure answers, not just retrieval

`evals.py`:

```python
import json, time
from autonomous import run, Budget
from observability import new_trace

TASKS = [
    {"name": "simple_lookup",
     "goal": "What deadlines are mentioned in my documents?",
     "asserts": [{"contains": "30 November"}]},

    {"name": "unanswerable",
     "goal": "What is my manager's home address according to my documents?",
     "asserts": [{"contains_any": ["don't know", "not in", "no information", "not found"]}]},

    {"name": "save_with_date",
     "goal": "Save a note called 'eval-check' containing today's date.",
     "asserts": [{"file_exists": "notes/eval-check.txt"},
                 {"file_contains": ["notes/eval-check.txt", "2026"]}]},

    # ... 10 total. Include at least 2 unanswerable and 2 multi-step.
]


def check(assertion, result):
    answer = (result.get("answer") or "").lower()

    if "contains" in assertion:
        return assertion["contains"].lower() in answer
    if "contains_any" in assertion:
        return any(p.lower() in answer for p in assertion["contains_any"])
    if "not_contains" in assertion:
        return assertion["not_contains"].lower() not in answer
    if "file_exists" in assertion:
        return os.path.exists(assertion["file_exists"])
    if "file_contains" in assertion:
        path, text = assertion["file_contains"]
        return os.path.exists(path) and text.lower() in open(path).read().lower()
    if "max_words" in assertion:
        return len(answer.split()) <= assertion["max_words"]
    return False


def run_evals(repeats=3):
    scores = {}

    for task in TASKS:
        passes = 0
        for attempt in range(repeats):
            new_trace()
            result = run(task["goal"], budget=Budget(max_steps=12), policy="auto")
            if all(check(a, result) for a in task["asserts"]):
                passes += 1

        scores[task["name"]] = passes / repeats
        flag = "" if passes == repeats else ("  <-- FLAKY" if passes else "  <-- ALWAYS FAILS")
        print(f"{task['name']:20s} {passes}/{repeats}{flag}")

    overall = sum(scores.values()) / len(scores)
    print(f"\noverall: {overall:.0%}")
    return scores
```

**`repeats=3` is the whole point of this stage.**

Run it. You will see something like:

```
simple_lookup        3/3
unanswerable         2/3  <-- FLAKY
save_with_date       3/3
multi_step           1/3  <-- FLAKY
compare_documents    0/3  <-- ALWAYS FAILS
```

**Look at `unanswerable`: 2 out of 3.** Same task, same documents, same prompt. Twice it correctly said it did not know. Once it made something up.

If you had run that eval a single time you would have recorded either "works" or "broken", and both would have been wrong. **This is what statistical means**, and it is why every single-run result earlier in this course was weaker evidence than it looked.

Flaky and always-failing need completely different responses. Always-failing is a bug you can go and fix. Flaky is a reliability number you have to decide whether you can live with.

**Save the scores to a file with a date.** That file is your regression history, and it is the only way to know whether tomorrow's prompt edit helped.

---

### Stage 4 -- The judge, and its bias

For things assertions cannot check:

```python
JUDGE_PROMPT = """You grade an answer against a question and a rubric.

Score each criterion 1-5:
- grounded: every claim is supported by the sources given, nothing invented
- complete: answers everything that was asked
- clear: a busy person could act on it

Reply with JSON only:
{"grounded": n, "complete": n, "clear": n, "worst_problem": "one sentence"}

Grade strictly. Length is not quality. A short correct answer beats a long
vague one. Do not reward confident tone."""


def judge(question, answer, sources=""):
    response = client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "system", "content": JUDGE_PROMPT},
                  {"role": "user", "content":
                   f"QUESTION:\n{question}\n\nSOURCES:\n{sources[:3000]}\n\nANSWER:\n{answer}"}],
        temperature=0,
        response_format={"type": "json_object"}
    )
    return json.loads(response.choices[0].message.content)
```

**Now calibrate it, which is the part people skip.**

Take ten answers. Grade them yourself, 1 to 5, before looking at anything. Then run the judge and compare.

You will probably find it scores higher than you do, and that its errors lean in a consistent direction -- usually rewarding length and confidence. `"Length is not quality"` and `"Do not reward confident tone"` are in the prompt precisely because that bias is well known.

**Use the judge for tracking change over time**, where a consistent bias cancels out. Do not use it as ground truth for whether something is good enough.

---

### Stage 5 -- Survive failure

`reliability.py`:

```python
import time, json

PRIMARY = "llama-3.3-70b-versatile"
FALLBACK = "llama-3.1-8b-instant"


def robust_call(messages, tools=None, component="agent", timeout=30):
    for model in (PRIMARY, FALLBACK):
        for attempt in range(3):
            try:
                start = time.time()
                response = client.chat.completions.create(
                    model=model, messages=messages, tools=tools, timeout=timeout)
                log_call(model, component,
                         response.usage.prompt_tokens,
                         response.usage.completion_tokens,
                         (time.time()-start)*1000)
                if model != PRIMARY:
                    print(f"  [using fallback model {model}]")
                return response
            except Exception as error:
                name = type(error).__name__
                log_call(model, component, 0, 0, 0, ok=False, error=f"{name}: {error}"[:200])

                if "RateLimit" in name:
                    time.sleep(2 ** attempt)
                    continue
                break   # not a rate limit: try the other model instead

    raise RuntimeError("All models failed.")


def json_with_repair(messages, schema_hint, tries=2):
    """Get valid JSON, or fix it once by showing the model its own error."""
    for attempt in range(tries):
        response = robust_call(messages, component="json")
        raw = response.choices[0].message.content
        try:
            return json.loads(raw.strip().strip("`").removeprefix("json").strip())
        except json.JSONDecodeError as error:
            if attempt == tries - 1:
                raise
            messages = messages + [
                {"role": "assistant", "content": raw},
                {"role": "user", "content":
                 f"That was not valid JSON: {error}. Required shape: {schema_hint}. "
                 f"Reply with only the corrected JSON."}
            ]
    raise RuntimeError("Could not get valid JSON.")
```

**Three things doing real work.**

`timeout=30` -- the missing piece from Day 9. A hanging call now fails instead of freezing everything.

**The fallback is a different model, not just a retry.** Rate limit means wait and retry. Anything else means the primary model is not going to work, so switch. Retrying the same failing thing three times is how you turn a 5-second failure into a 30-second one.

**JSON repair shows the model its own error.** This works remarkably well -- far better than retrying with an identical prompt and hoping.

**Test it properly.** Set `PRIMARY = "this-model-does-not-exist"` and run a task. It should fall back and complete. If it crashes, your error handling is decorative.

---

### Stage 6 -- Cut the cost, and prove it

Now use Stage 2's report to target the right thing.

**Model routing -- usually the biggest win.**

You built the classifier on Day 3. Use it:

```python
SIMPLE_COMPONENTS = {"classify", "extraction", "rewrite", "judge"}

def model_for(component, goal=""):
    if component in SIMPLE_COMPONENTS:
        return FALLBACK        # 8b: about 10x cheaper
    if len(goal) < 60 and "?" in goal:
        return FALLBACK
    return PRIMARY
```

Look at the numbers: the 70b model costs roughly $0.59 per million input tokens, the 8b about $0.05. **Ten times cheaper.** Memory extraction, query rewriting and classification do not need a 70b model -- they are narrow, structured jobs.

**Caching.**

```python
_cache = {}

def cached_call(messages, component, ttl=3600):
    key = json.dumps(messages, sort_keys=True)[:2000]
    hit = _cache.get(key)
    if hit and time.time() - hit["at"] < ttl:
        log_call("cache", component, 0, 0, 0)
        return hit["value"]

    value = robust_call(messages, component=component)
    _cache[key] = {"value": value, "at": time.time()}
    return value
```

Only cache things that should be deterministic -- classification, extraction, rewriting. **Never cache a conversational reply**, or a user will get someone else's answer.

**Now prove it worked.** Clear your logs, run the same twenty tasks, and compare:

```
before:  $0.0412 per task,  p50 1,240ms
after:   $0.0121 per task,  p50   680ms
```

**Then immediately re-run `run_evals()`.** Cost reductions cause quality regressions, and the small model may be worse at something. If your score dropped from 82% to 71%, you did not save money -- you bought cheapness with quality, and now you can decide whether that trade is acceptable instead of discovering it from a user.

---

## 7. Words I heard today

| Word | Plain meaning |
|---|---|
| **Observability** | Being able to tell what happened after the fact. |
| **Trace id** | One id tying every call in a request together. |
| **Structured logging** | Logs as data, not prose, so you can aggregate them. |
| **p50 / p95** | Median and near-worst-case latency. p95 is what users feel. |
| **Eval** | A fixed task set you score repeatedly. |
| **Regression** | A change that quietly made something worse. |
| **LLM-as-judge** | A model grading output. Useful, biased, needs calibration. |
| **Flaky** | Passes sometimes. Different problem from always failing. |
| **Circuit breaker** | Stop calling a failing service instead of hammering it. |
| **Graceful degradation** | Doing less, well, instead of failing entirely. |
| **Model routing** | Small model for easy jobs. Usually the biggest saving. |
| **Cost per task** | The number that matters commercially. |
| **Canary** | Trying a change on a small slice before everyone. |

---

## 8. Break it on purpose

**1. Run the same eval three times.**
No changes between runs.
*You will see:* different scores.
*It teaches:* the single most important idea today. If you measured it once, you did not measure it.

**2. Kill the primary model.**
Set `PRIMARY` to a name that does not exist.
*You will see:* whether fallback actually works.
*It teaches:* untested error handling is decoration.

**3. Calibrate the judge.**
Grade ten answers yourself, then compare with the judge.
*You will see:* it is more generous than you, and consistently so.
*It teaches:* judges track change well and measure absolute quality badly.

**4. Route everything to the small model.**
Then re-run the evals.
*You will see:* about 10x cheaper, and some tasks now fail.
*It teaches:* cost and quality are one dial. Now you can price the trade.

**5. Compare p50 and p95.**
Run 30 requests and look at both.
*You will see:* a gap much bigger than you expected.
*It teaches:* averages hide the experience your users actually have.

**6. Break a prompt on purpose.**
Remove the escape hatch from Day 3. Re-run evals.
*You will see:* the `unanswerable` tasks collapse, everything else holds.
*It teaches:* what a regression test catches, from the inside.

---

## 9. Traps

**Trap 1 -- measuring once**
*Symptom:* confident conclusions from single runs.
*Fix:* repeat everything at least three times. Report rates.

**Trap 2 -- trusting the judge**
*Symptom:* scores of 4.6 and unhappy users.
*Fix:* calibrate against your own grading, and keep hard assertions wherever a hard assertion is possible.

**Trap 3 -- an eval set that is too easy**
*Symptom:* 95% forever, no signal.
*Fix:* include the unanswerable, the multi-step, and the ones you know are broken.

**Trap 4 -- optimising before measuring**
*Symptom:* a week spent on something that was 3% of the cost.
*Fix:* Stage 2 first. The dominant component is usually not the obvious one.

**Trap 5 -- no trace id**
*Symptom:* logs you cannot join up.
*Fix:* `ContextVar`, set once per request.

**Trap 6 -- personal data in logs**
*Symptom:* a permanent file of user questions and retrieved documents.
*Fix:* log token counts, latency and ids. Do not log message contents by default. If you need contents for debugging, keep them separate, short-lived, and access-controlled.

---

## 10. Check yourself

1. Why does "it works" mean nothing for this kind of system, and what replaces it?
2. What is the difference between a flaky task and an always-failing one, and why treat them differently?
3. Why is p95 more useful than the average?
4. Name two biases of an LLM judge, and say what judges are actually good for.
5. You cut cost by 70%. What must you do immediately afterwards, and why?

---

## 11. Where this goes

- **Day 16 and 17** bring frameworks. Run today's evals against the framework version -- that is how you find out whether it is actually better, rather than just newer.
- **Day 18** builds the research agent. Today's eval set is how you know it works.
- **Day 20** deploys it. Logging, tracing, timeouts and budget caps stop being good practice and become requirements.
- **Day 21** is where cost per task becomes the number that decides whether the thing is viable.

---

## 12. PROJECT STATE

```
PROJECT STATE after Day 15:

Folders:
  research-assistant/
    ai/
      observability.py     (NEW - trace ids, structured logging, cost, report)
      evals.py             (NEW - task eval set with repeats)
      reliability.py       (NEW - timeout, fallback model, JSON repair)
      logs/calls.jsonl     (NEW - one JSON object per model call)
      chat.py, agent.py, autonomous.py, planner.py, memory.py
      multi_agent.py, retrieval.py, golden_set.py, security.py
      vector_store.py, embeddings.py, documents.py, tools.py
      mcp_agent.py, mcp_client.py, mcp_servers/my_tools.py
      prompts.py, classify.py, test_prompt.py
      runs/, notes/, documents/, chroma_db/
    dashboard/             (still empty)

Libraries: no new installs (contextvars, json, time are standard library)

observability.py:
  _trace = ContextVar  -> set once per request, picked up automatically by
      every nested agent call including the asyncio fan-out from Day 14,
      with no need to thread it through function signatures
  new_trace(), cost_of(model, in, out), log_call(...)
  PRICING per million tokens: 70b ~$0.59/$0.79, 8b ~$0.05/$0.08 (verify)
  every call logged as JSONL: time, trace, component, model, tokens_in,
      tokens_out, ms, usd, ok, error
  report() aggregates by component: calls, tokens, usd, p50, p95
      and cost per request (median and worst)

evals.py:
  10 tasks, each with assertions: contains / contains_any / not_contains /
      file_exists / file_contains / max_words
  includes at least 2 unanswerable and 2 multi-step tasks
  run_evals(repeats=3)  <- THE KEY DESIGN. Every task runs 3 times.
      Output distinguishes FLAKY (passes sometimes) from ALWAYS FAILS
      (a real bug). A single run cannot tell these apart.
  scores saved with a date, as regression history

  judge(question, answer, sources) - LLM-as-judge, JSON, criteria:
      grounded / complete / clear, 1-5 each
      prompt explicitly says length is not quality and not to reward
      confident tone, because judges are biased toward both
      CALIBRATED against manual grading of 10 answers; it scored higher
      than manual grading, consistently. Use it to track CHANGE over time,
      never as ground truth.

reliability.py:
  robust_call() - timeout=30 (the missing Day 9 piece), retries only on
      rate limits, otherwise switches to the FALLBACK model rather than
      retrying a model that is not going to work
  json_with_repair() - on invalid JSON, sends the model its own output
      plus the parse error and asks for a correction. Far more effective
      than retrying an identical prompt.

Cost work:
  model_for(component, goal) routes classify / extraction / rewrite / judge
      to the 8b model, which is roughly 10x cheaper
  cached_call() for deterministic components only; conversational replies
      are NEVER cached
  measured before/after, then RE-RAN THE EVALS, because cost reductions
  cause quality regressions and the small model is worse at some tasks

Findings worth remembering:
  - the same eval run 3 times gives different scores; "unanswerable" tasks
    are the flakiest
  - p95 latency is far worse than p50; averages hide what users experience
  - the dominant cost component was NOT the obvious one (memory extraction
    on every turn, and multi-query rewriting, are common culprits)

Key decisions made:
  - every measurement is repeated; rates replace pass/fail
  - hard assertions preferred wherever possible; the judge only fills gaps
  - logs contain token counts and ids, NOT message contents, because that
    would be a permanent file of user questions and document text

Known problems, left for later:
  - the cache is in memory only, lost on restart
  - no per-user rate limits or daily budget caps yet (Day 20)
  - no circuit breaker; repeated provider failure is retried every time
  - eval set is 10 tasks; small, and written by the same person who wrote
    the system
```

---

## Answers

**1.** Because the same input can produce a different result each time, so a single success proves almost nothing. It is replaced by rates measured over repeated runs -- success rate, cost per task, p50 and p95 latency, failure rate.

**2.** Always-failing is a deterministic bug you can find and fix. Flaky is a probability, and no amount of debugging removes it entirely -- you either make it less likely or decide the rate is acceptable. Treating a flaky task as a bug leads to hours of chasing something that was never broken in a fixable way.

**3.** Because averages are dragged toward the middle and hide the tail. p95 is what a meaningful share of your users actually experience, and it is where timeouts and abandonment happen.

**4.** They reward length and they reward confident tone (and they tend to favour text from their own model family). They are good for tracking whether a change made things better or worse, because a consistent bias cancels out across comparisons. They are bad at absolute judgements of quality.

**5.** Re-run the evals. Cost reductions almost always come from using a weaker model or sending less context, both of which can reduce quality. Without re-measuring you have not saved money, you have made an untracked trade.
