# Day 10 — Advanced Agent Planning

**Module:** 03 — Advanced Agent Systems
**Time:** about 1 hour
**Builds on:** Day 7 — the loop; Day 9 — budgets and verification; Day 3 — JSON output

---

## 1. Today in one line

Your agent writes down what it intends to do *before* doing it — and you find out that the plan matters less than the ability to change it.

---

## 2. The problem

Your Day 9 agent is **greedy**. Each step it looks at where it is and picks the next action. No overview, no idea how far along it is, no idea what is coming.

Give it something genuinely multi-part:

> Research the three main approaches to caching, compare them on speed and complexity, and write me a recommendation.

Watch it. You will see some of these:

- It researches approach one, writes half a recommendation, then remembers approach two.
- It searches for the same thing twice, ten steps apart, having forgotten it already did.
- It writes the comparison before gathering the third approach.
- At step 12 it announces it is finished, having covered two of the three.

Nothing there is a bug. It is what one-step-at-a-time thinking looks like on a task with structure.

There is a second problem, which matters more in practice. **You cannot approve a plan you were never shown.** On Day 9 you could approve twenty individual actions, which is not approval — it is twenty interruptions. Being able to read "here are the six things I intend to do" and say yes once is a completely different experience.

So: make it plan first. Which introduces its own failure, and that failure is really what today is about.

---

## 3. Mental model

**Walking with a map versus following your nose.**

Following your nose works well when the terrain is simple and you can see the destination. You react to what is in front of you. No wasted effort on planning.

A map lets you see the whole route, notice that two errands are near each other, and know how far along you are.

**Where the comparison breaks, and this is the actual lesson:**

**The map is drawn before you have seen the terrain.** An agent writes its plan at step zero, when it knows the least it will ever know. Step 2 will teach it something that makes steps 4, 5 and 6 wrong.

A person adjusts automatically — you find the road closed and reroute without thinking. An agent will march through a plan that stopped making sense four steps ago, because the plan is in its context and the plan is what it is following.

So here is the sentence for today:

> Planning is easy. Replanning is the skill.

An agent that plans and then follows the plan blindly is often *worse* than one that never planned at all — it has traded flexibility for a structure that may be wrong. The value comes from plan, act, check the plan still holds, adjust.

---

## 4. How it really works

**Three patterns. You should be able to choose between them.**

**ReAct** (Days 7 and 9): think, act, observe, repeat. Flexible, adapts instantly, no wasted planning. Wanders on complex tasks, loses track of overall progress.

**Plan-and-execute**: make the full plan, then work through it. Structured, visible, approvable, less repeated work. Brittle when the plan turns out wrong, and costs a planning call up front.

**Plan with replanning** (today's target): plan, execute a step, check whether the remaining plan still makes sense, adjust if not. Best results, most calls.

None is universally correct. A two-step task does not deserve a plan. A fifteen-step research task falls apart without one.

**What a plan actually is**

A plan is structured data, not prose. You already know how to get that — Day 3, JSON mode.

```
[
  {"id": 1, "task": "Search documents for caching approaches",
   "tool": "search_documents", "depends_on": [], "done": false},
  {"id": 2, "task": "For each approach found, search for performance details",
   "tool": "search_documents", "depends_on": [1], "done": false},
  {"id": 3, "task": "Write the comparison and save it",
   "tool": "save_note", "depends_on": [1, 2], "done": false}
]
```

Two fields carry most of the weight.

**`depends_on`** is what stops it writing the comparison before the research. Step 3 cannot start until 1 and 2 are done. This is the structure that greedy stepping never has.

**`done`** is progress. The agent can look at the plan and know it is four of seven through. On Day 9 it had no way to know that.

**The dependency problem**

Step 2 needs what step 1 found. So when you run step 2, you must pass along step 1's results. Get this wrong and each step starts blind, which is worse than no plan at all.

**Reflection**

One more idea, cheap and effective: when the plan is finished, hand the goal and the results to a fresh call and ask "was this actually achieved, and what is weak about it?" Then optionally redo one step.

This is Day 9's verification, used as an input rather than a report. Same trick, different purpose.

---

## 5. Setup

Nothing to install.

```bash
cd research-assistant/ai
source venv/bin/activate

touch planner.py
```

---

## 6. Build it

---

### Stage 1 — Make a plan and look at it

Do not execute anything yet. Just get a plan and read it.

`planner.py`:

```python
import os, json
from dotenv import load_dotenv
from openai import OpenAI
from tools import TOOL_SCHEMAS, AVAILABLE_TOOLS

load_dotenv()
client = OpenAI(api_key=os.environ["GROQ_API_KEY"],
                base_url="https://api.groq.com/openai/v1")
MODEL = "llama-3.3-70b-versatile"

TOOL_LIST = "\n".join(
    f"- {t['function']['name']}: {t['function']['description'][:120]}"
    for t in TOOL_SCHEMAS
)

PLANNER_PROMPT = f"""You break a goal into a short, ordered plan.

Available tools:
{TOOL_LIST}

Reply with JSON only, in this shape:
{{"steps": [
   {{"id": 1, "task": "what to do, in one clear sentence",
     "tool": "the tool name, or null if this step is thinking only",
     "depends_on": []}}
]}}

RULES
- Between 2 and 6 steps. Fewer is better.
- Each step must be doable with ONE of the listed tools, or be pure reasoning.
- Use depends_on when a step needs an earlier step's result.
- If the goal cannot be done with these tools, return {{"steps": [], "impossible": "why"}}.
- Do not plan steps for things you already know."""


def make_plan(goal):
    response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": PLANNER_PROMPT},
            {"role": "user", "content": goal}
        ],
        temperature=0,
        response_format={"type": "json_object"}
    )
    return json.loads(response.choices[0].message.content)


if __name__ == "__main__":
    plan = make_plan(
        "Find everything my documents say about deadlines, check which ones "
        "have already passed, and save a summary note."
    )
    print(json.dumps(plan, indent=2))
```

Run it. You get something like:

```json
{"steps": [
  {"id": 1, "task": "Search documents for deadlines and due dates",
   "tool": "search_documents", "depends_on": []},
  {"id": 2, "task": "Get today's date to compare against",
   "tool": "get_current_time", "depends_on": []},
  {"id": 3, "task": "Determine which deadlines have passed",
   "tool": null, "depends_on": [1, 2]},
  {"id": 4, "task": "Save a summary note",
   "tool": "save_note", "depends_on": [3]}
]}
```

**Read that plan properly.** It is a reasonable plan — better than what Day 9's agent would have wandered into. Steps 1 and 2 have no dependencies, so they could run in either order. Step 3 needs both. Step 4 needs step 3.

**Now try to break the planner.** Ask for something impossible with your tools:

```python
    print(json.dumps(make_plan("Email my manager a summary of my documents."), indent=2))
```

If you get `"impossible"`, good. If you get a confident four-step plan including a `send_email` tool that does not exist — which happens often — note it. **Planners hallucinate capability.** The plan is generated text like any other, and a plausible-looking plan is easy to produce whether or not it can be carried out. Your executor has to catch it, because the planner will not.

---

### Stage 2 — Execute the plan

Each step becomes a small agent run, with the step as its goal:

```python
EXECUTOR_PROMPT = """You are completing ONE step of a larger plan.

Do only this step. Do not try to complete the whole goal.
Use a tool if the step needs one. When the step is done, reply with a short
statement of what you found or did, with no tool calls.
If you cannot do this step, say exactly why."""


def run_step(step, context, max_calls=4):
    messages = [
        {"role": "system", "content": EXECUTOR_PROMPT},
        {"role": "user", "content":
            f"OVERALL GOAL: {context['goal']}\n\n"
            f"RESULTS SO FAR:\n{context['results_text']()}\n\n"
            f"YOUR STEP: {step['task']}"}
    ]

    for _ in range(max_calls):
        response = client.chat.completions.create(
            model=MODEL, messages=messages, tools=TOOL_SCHEMAS)
        message = response.choices[0].message

        if not message.tool_calls:
            return message.content

        messages.append(message.model_dump(exclude_none=True))
        for call in message.tool_calls:
            name = call.function.name
            args = json.loads(call.function.arguments)
            print(f"    {name}({args})")

            if name not in AVAILABLE_TOOLS:
                output = f"There is no tool called {name}."
            else:
                try:
                    output = str(AVAILABLE_TOOLS[name](**args))
                except Exception as error:
                    output = f"Tool failed: {error}"

            messages.append({"role": "tool", "tool_call_id": call.id, "content": output})

    return "This step did not finish within its call limit."
```

**Two design points.**

`max_calls=4` per step. Each step gets its own small budget. One bad step cannot eat the whole run — a real advantage over Day 9, where one confused stretch could consume everything.

`RESULTS SO FAR` is the dependency fix. Each step sees what earlier steps produced. Remove that line and step 3 has no idea what step 1 found, and the plan becomes worse than useless.

---

### Stage 3 — The runner, with results carried forward

```python
def run_plan(goal):
    plan = make_plan(goal)

    if plan.get("impossible") or not plan.get("steps"):
        return {"status": "impossible", "reason": plan.get("impossible", "no plan produced")}

    steps = plan["steps"]
    results = {}

    print("PLAN:")
    for step in steps:
        needs = f" (needs {step['depends_on']})" if step.get("depends_on") else ""
        print(f"  {step['id']}. {step['task']}{needs}")
    print()

    context = {
        "goal": goal,
        "results_text": lambda: "\n".join(
            f"Step {i} ({steps[i-1]['task']}): {r}" for i, r in results.items()
        ) or "Nothing yet."
    }

    for step in steps:
        missing = [d for d in step.get("depends_on", []) if d not in results]
        if missing:
            print(f"  ! step {step['id']} skipped, missing {missing}")
            continue

        print(f"  > step {step['id']}: {step['task']}")
        outcome = run_step(step, context)
        results[step["id"]] = outcome
        print(f"    = {outcome[:140]}\n")

    return {"status": "finished", "plan": steps, "results": results}
```

Run it on the deadlines goal. You get a visible plan, then each step running in order, each seeing what came before.

**Compare this against Day 9 on the same task.** Look at the trajectory of each. The plan version does less repeated work, and — more usefully — you can read what it intends to do before it does any of it.

---

### Stage 4 — Replanning (the part that matters)

Now the real content. After each step, check whether the rest of the plan still holds.

```python
REPLAN_PROMPT = """You are checking whether a plan is still valid.

You get the goal, the plan, which steps are done, and what they found.

Reply with JSON only:
{"action": "continue" | "revise" | "stop",
 "reason": "one short sentence",
 "steps": [ ...the new remaining steps, only if action is revise... ]}

Choose "continue" unless something has genuinely changed.
Choose "revise" if what was learned makes remaining steps wrong, redundant or
insufficient.
Choose "stop" if the goal is already achieved, or is now clearly impossible."""


def replan(goal, steps, results, current_id):
    remaining = [s for s in steps if s["id"] > current_id]
    if not remaining:
        return {"action": "continue"}

    payload = {
        "goal": goal,
        "completed": [{"id": i, "result": str(r)[:400]} for i, r in results.items()],
        "remaining_steps": remaining
    }

    response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": REPLAN_PROMPT},
            {"role": "user", "content": json.dumps(payload, indent=2)}
        ],
        temperature=0,
        response_format={"type": "json_object"}
    )
    return json.loads(response.choices[0].message.content)
```

Wire it into the runner, after each step completes:

```python
        decision = replan(goal, steps, results, step["id"])

        if decision["action"] == "stop":
            print(f"  [stopping: {decision['reason']}]")
            break

        if decision["action"] == "revise":
            print(f"  [revising plan: {decision['reason']}]")
            steps = [s for s in steps if s["id"] <= step["id"]] + decision.get("steps", [])
```

**Test it by breaking reality.** Move your documents folder somewhere else so step 1 finds nothing, and run again.

Without replanning: step 1 finds nothing, steps 2, 3 and 4 run anyway, and you get a note about deadlines that do not exist.

With replanning: after step 1 returns nothing, it should `stop` or `revise` — "no deadlines found, there is nothing to summarise".

**That difference is the whole day.** A plan alone makes the agent tidier. Replanning makes it able to be wrong and recover, which is what actually matters in real use.

**The cost is honest and worth stating:** one extra model call after every step. On a six-step plan that is six extra calls, plus the planning call. Plan-execute-replan can easily cost more than plain ReAct. What you buy is structure, visibility, and less wasted work on complex tasks. On simple tasks you are paying for nothing.

---

### Stage 5 — Reflect at the end

One last call, and it is cheap:

```python
REFLECT_PROMPT = """You review finished work against its original goal.

Reply with JSON only:
{"achieved": "fully" | "partly" | "no",
 "gaps": ["what is missing or weak"],
 "redo_step": <step id to redo, or null>,
 "suggestion": "how to do that step better"}

Be strict. Judge against the goal as written, not against what was attempted."""
```

Run it after the plan finishes, print the result, and — if `redo_step` is set — re-run that one step with the suggestion appended to its task.

**Two warnings, both real.**

**Do not let it redo more than once.** Reflection loops can go around forever, each pass finding something new to improve. One redo, then stop.

**Do not trust reflection as verification.** It is the same model judging the same work, so it is optimistic. Keep Day 9's `verify_in_code` for anything with a checkable outcome. Reflection is for *improving* the work; verification is for *believing* it. Different jobs.

---

### Stage 6 — Work out when planning is worth it

Run the same three tasks through both `autonomous.run` (Day 9) and `run_plan` (today). Record steps, total tokens and whether the result was actually good.

Try:

- **Simple:** "What time is it in Tokyo?"
- **Medium:** "Find deadlines in my documents and save a note."
- **Complex:** "Compare what my documents say about budget and timeline, check for contradictions, and write a summary with sources."

You will most likely find:

| Task | Better approach | Why |
|---|---|---|
| Simple | ReAct, easily | The planning call costs more than the whole task |
| Medium | About even | Planning helps a little, costs a little |
| Complex | Plan and replan | Structure prevents the wandering |

**Write your actual numbers down.** This is a judgement you will make constantly for the rest of the course, and having measured it once on your own machine is worth more than any rule of thumb.

---

## 7. Words I heard today

| Word | Plain meaning |
|---|---|
| **Decomposition** | Breaking a goal into smaller steps. |
| **Plan-and-execute** | Plan everything first, then carry it out. |
| **ReAct** | Decide one step at a time. Days 7 and 9. |
| **Replanning** | Checking after each step whether the rest still makes sense. |
| **Reflection** | Critiquing finished work and possibly redoing part of it. |
| **Subtask / step** | One item in the plan. |
| **depends_on** | Which steps must finish first. |
| **DAG** | A dependency graph with no loops. What a plan really is. |
| **Plan drift** | Following a plan that stopped being right. |
| **Over-planning** | Planning a task too simple to need it. |
| **Hallucinated capability** | Planning a step using a tool that does not exist. |
| **Executor** | The part that carries out one step. |

---

## 8. Break it on purpose

**1. Plan something impossible.**
Ask for a plan involving email, or the web, or anything you have no tool for.
*You will see:* often, a confident plan using invented tools.
*It teaches:* a plan is generated text. Plausibility is free; feasibility is not. The executor must check.

**2. Remove the dependency context.**
Delete `RESULTS SO FAR` from the executor prompt.
*You will see:* every step starts blind. Step 3 asks for information step 1 already found.
*It teaches:* passing results forward is not a detail, it is the point.

**3. Break reality mid-plan.**
Rename your documents folder after the plan is made but before it runs.
*You will see:* without replanning, it produces a summary of nothing. With replanning, it stops.
*It teaches:* the difference between a plan and an adaptive plan, felt directly.

**4. Force over-planning.**
Change the rule to "between 8 and 12 steps" and give it a simple task.
*You will see:* invented busywork steps, higher cost, worse output.
*It teaches:* more structure is not better structure. "Fewer is better" earns its place in the prompt.

**5. Make a step fail permanently.**
Break `search_documents` so it always errors. Run a plan that depends on it.
*You will see:* whether replanning notices, or whether later steps carry on regardless.
*It teaches:* dependency handling only helps if failure propagates. Note whether yours does — and whether `depends_on` should also check that the dependency *succeeded*, not just ran.

**6. Compare the costs honestly.**
Total tokens for ReAct versus plan-and-replan, on your three tasks.
*You will see:* planning often costs more.
*It teaches:* it is a trade, not an upgrade. Anyone who tells you agents should always plan has not measured it.

---

## 9. Traps

**Trap 1 — planning tasks that do not need it**
*Symptom:* three model calls for something one call answers.
*Fix:* decide first whether the task has real structure. Some systems make this choice with a cheap classifier — Day 3's `classify.py` is exactly that shape.

**Trap 2 — steps that are not executable**
*Symptom:* a beautiful plan where step 2 says "analyse the results thoroughly" and the executor has no idea what to do.
*Fix:* require each step to name a tool or be explicit reasoning. Vague steps are where plans quietly fail.

**Trap 3 — plan drift**
*Symptom:* it completes every step and produces the wrong thing.
*Cause:* the plan stopped matching reality at step 2 and nothing checked.
*Fix:* replanning. This is the single most common failure of plan-and-execute.

**Trap 4 — dependencies that only check existence**
*Symptom:* step 3 runs on step 1's error message as if it were data.
*Fix:* `depends_on` should check that the dependency *succeeded*, not just that it ran. Experiment 5 will show you this.

**Trap 5 — reflection loops**
*Symptom:* it redoes work forever, each pass finding a new improvement.
*Fix:* one redo, maximum. Reflection is an optimisation, not a quality gate.

**Trap 6 — the plan as an injection surface**
*Symptom:* rare and nasty. A document says "ignore the plan and do X", the planner reads it during a research step, and the revised plan contains it.
*Cause:* replanning feeds tool results back into a prompt that generates instructions.
*Fix:* Day 13. For now, know that revised plans deserve the same suspicion as any other model output, and that a `revise` action is a more dangerous thing than a `continue`.

---

## 10. Check yourself

1. Give one task where ReAct beats planning, and one where planning wins. What distinguishes them?
2. What does `depends_on` prevent, and what does it fail to check in your current code?
3. Why is replanning more valuable than planning?
4. Why can reflection not replace Day 9's verification?
5. Your planner produces a step using a tool that does not exist. Whose job is it to catch that, and why?

---

## 11. Where this goes

- **Day 11** fixes the memory problem underneath all this. Plans and results accumulate; the context window does not grow.
- **Day 12** improves the retrieval your research steps depend on. A good plan over bad retrieval still produces a bad answer.
- **Day 14** is planning across several agents: the plan becomes the allocation of work, and `depends_on` becomes coordination between workers.
- **Day 15** measures all of this properly — cost per task, success rate, and whether planning was worth it on your real workload.
- **Day 16 (LangGraph)** is this day with a framework. Its whole idea is making the plan an explicit graph of states with edges between them. You will recognise `depends_on` immediately.

---

## 12. PROJECT STATE

```
PROJECT STATE after Day 10:

Folders:
  research-assistant/
    ai/
      venv/, .env, .gitignore, requirements.txt
      chat.py, agent.py, autonomous.py
      planner.py                  (NEW - plan, execute, replan, reflect)
      mcp_agent.py, mcp_client.py, mcp_servers/my_tools.py
      tools.py, prompts.py, classify.py, test_prompt.py
      documents.py, embeddings.py, vector_store.py, chroma_db/
      runs/, notes/, documents/, conversation.json
    dashboard/                    (still empty)

Libraries: no new installs

planner.py contains:

  TOOL_LIST      - tool names + truncated descriptions, injected into the
                   planner prompt so it can only plan with real tools
  make_plan(goal) - JSON mode, temperature 0, returns
                   {"steps":[{id, task, tool, depends_on}]}
                   or {"steps":[], "impossible": "..."}
                   rules: 2-6 steps, fewer is better, each step must map to
                   one tool or be pure reasoning, no planning things it
                   already knows

  run_step(step, context, max_calls=4)
                 - a small agent run scoped to ONE step
                 - per-step call budget, so one bad step cannot eat the run
                 - prompt includes OVERALL GOAL and RESULTS SO FAR, which is
                   how dependencies actually get satisfied

  run_plan(goal) - prints the plan before executing anything
                 - skips steps whose depends_on are not in results
                 - carries results forward via context["results_text"]()

  replan(goal, steps, results, current_id)
                 - runs AFTER every step
                 - returns {"action": "continue"|"revise"|"stop", "reason",
                   "steps": [...new remaining steps...]}
                 - "revise" replaces everything after the current step

  reflection pass at the end
                 - {"achieved", "gaps", "redo_step", "suggestion"}
                 - at most ONE redo, then stop

Key decisions made:
  - a plan is structured JSON, never prose
  - the planner is only ever shown real tool names, and the executor still
    checks, because planners hallucinate capability anyway
  - each step gets its own small budget rather than sharing one big one
  - replanning is the point; planning alone was measured as barely better
    than ReAct
  - reflection improves work; it does NOT verify it. Day 9's
    verify_in_code is still the thing that decides whether to believe a run.

Measured on three tasks (simple / medium / complex):
  simple  -> ReAct wins, the planning call costs more than the task
  medium  -> roughly even
  complex -> plan + replan clearly better, less repeated work
  planning generally costs MORE tokens; it is a trade, not an upgrade

Known problems, left for later:
  - depends_on only checks that a step RAN, not that it SUCCEEDED, so a
    failed step's error message can be used as input by a later step
  - no automatic choice between ReAct and planning; it is manual
  - replanning feeds tool results into a prompt that generates instructions,
    which is a prompt-injection surface (Day 13)
  - results accumulate with no trimming; long plans will overflow (Day 11)
  - steps run strictly in order, never in parallel even when independent
    (Day 14)
```

---

## Answers

**1.** ReAct wins on "what time is it in Tokyo" — a single tool call, where the planning call costs more than the task itself. Planning wins on "compare three approaches and write a recommendation", which has several parts with real dependencies. The distinguishing feature is structure: multiple parts that depend on each other, where order matters and work can be repeated by accident.

**2.** It prevents a step running before the steps it needs have run. It does not check whether those steps *succeeded* — a failed step still counts as present in `results`, so a later step can happily treat an error message as data.

**3.** Because the plan is written when the agent knows the least it will ever know. Step 2 routinely makes steps 4 and 5 wrong. Without replanning, the agent marches through a plan that stopped being correct, which can be worse than never having planned.

**4.** Because it is the same model judging its own work, and it is optimistic about it. Verification checks evidence — the file exists, it contains what it should — and cannot be talked round. Reflection improves work; verification decides whether to believe it.

**5.** The executor's. The planner produces text, and a plausible-looking plan is exactly as easy to generate as a feasible one. Only the code that actually tries to run the step can find out that the tool does not exist — which is why unknown tool names return a message rather than crashing.
