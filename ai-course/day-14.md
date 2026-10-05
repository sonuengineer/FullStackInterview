# Day 14 — Multi-Agent Systems and Orchestration

**Module:** 03 — Advanced Agent Systems
**Time:** about 1 hour
**Builds on:** Day 7 and 9 — agents; Day 10 — planning; Day 4 — tools

---

## 1. Today in one line

You run several agents together — and you measure whether it was actually worth it, because often it is not.

---

## 2. The problem

Your single agent is getting worse as you give it more.

It has four tools now. Add a web search tool, a code tool, an email tool, a database tool, and watch what happens: **tool selection degrades**. Twelve descriptions in the context, several plausibly relevant, and the model picks wrong more often. More capability, less reliability.

Three more pressures push the same way:

**Long tasks overflow.** A thirty-step research task fills the context with everything it read, and Day 11's compression is lossy.

**Different subtasks want different setups.** Researching wants a wide retrieval pool and read-only tools. Writing wants a careful prompt and no retrieval at all. Fact-checking wants a strict threshold and deliberate suspicion. One system prompt cannot be all three.

**Permissions are all-or-nothing.** Day 13 taught you to give write tools only when needed. With one agent, "when needed" means the whole run.

Several specialised agents solve all four. And this is where people over-engineer harder than anywhere else in the field.

So here is the frame for today, stated up front:

> Two agents are not twice as good. They are often about 1.2 times as good, at three times the cost.

Sometimes that trade is clearly right. Often it is not. By the end you will have measured it on your own tasks rather than believing either of us.

---

## 3. Mental model

**A team instead of one person.**

Specialists do better work in their area. Work can happen in parallel. Someone can review someone else's output.

**Where this comparison breaks — and all three breaks are today's real content:**

**Teams have overhead.** Every handoff is a meeting. In agent terms, every handoff is a model call, and the receiving agent starts with only what it was told — not what the first agent knew. Ask anyone who has explained a problem to a colleague: the explanation is always worse than the understanding.

**Handoffs lose things.** A researcher who read forty chunks passes a summary to the writer. The writer never sees the forty chunks. **Two agents almost always have less total context than one agent would have had.** This is the failure people do not anticipate, and it is the most common reason a multi-agent system produces worse output than the single agent it replaced.

**Coordination fails in ways one agent cannot.** Two agents disagree with no way to resolve it. A critic and a writer loop forever. Two workers do the same job. None of these exist with one agent.

The one place teams genuinely win, without argument: **independent work done at the same time.** Three researchers on three separate questions is a real three-times speedup, because there is nothing to coordinate.

---

## 4. How it really works

**The key trick: an agent is a tool.**

Day 4 taught you that a tool is a function the model can call. `run_agent(goal)` is a function. Therefore an agent can be a tool of another agent.

That one line gets you most of multi-agent for free. No new machinery.

**The patterns, and when each is right**

**Supervisor (orchestrator and workers).** One agent holds the goal and calls specialist agents as tools. Most useful pattern, and the default choice. The supervisor keeps the overview; workers keep clean, narrow contexts.

**Pipeline.** A fixed chain: research, then write, then check. Simple and predictable, but every step must succeed and nothing adapts.

**Parallel fan-out and fuse.** Split into independent subtasks, run at once, merge. **The only pattern with a genuine speed win.** Needs subtasks that truly do not depend on each other.

**Critic.** One generates, another reviews, the first revises. Cheap, and it improves quality more reliably than most things on this list. Cap it at one or two rounds.

**Swarm / handoff.** Agents pass control to each other freely. Flexible, hard to debug, easy to loop. Avoid until you have a reason.

**What has to be decided**

- **Shared or private memory?** Shared means agents see each other's findings, and also each other's mistakes. Private means clean contexts and repeated work.
- **Budget across agents.** Day 9's budgets were per run. Five agents at 25 steps each is 125 steps. Budgets have to be shared, not copied.
- **Termination across agents.** One agent finishing is not the task finishing.
- **Tracing.** With one agent you read the trajectory. With five you need a run id threaded through everything, or debugging is hopeless.

---

## 5. Setup

Nothing to install.

```bash
cd research-assistant/ai
source venv/bin/activate

touch multi_agent.py
```

**One practical warning before you start.** Groq free is about 30 requests per minute and 6,000 tokens per minute. Multi-agent multiplies calls, and the parallel stage fires several at once. You will hit limits today. That is part of the lesson — keep your backoff in place and keep `max_steps` low while experimenting.

---

## 6. Build it

---

### Stage 1 — An agent as a tool

`multi_agent.py`:

```python
import os, json, time, asyncio
from dotenv import load_dotenv
from openai import OpenAI, RateLimitError
from tools import TOOL_SCHEMAS, AVAILABLE_TOOLS

load_dotenv()
client = OpenAI(api_key=os.environ["GROQ_API_KEY"],
                base_url="https://api.groq.com/openai/v1")
MODEL = "llama-3.3-70b-versatile"


class SharedBudget:
    """One budget for every agent in the run, not one each."""
    def __init__(self, max_steps=40, max_tokens=80000, max_seconds=300):
        self.max_steps, self.max_tokens, self.max_seconds = max_steps, max_tokens, max_seconds
        self.steps = self.tokens = 0
        self.started = time.time()

    def spend(self, tokens):
        self.steps += 1
        self.tokens += tokens

    def exceeded(self):
        if self.steps >= self.max_steps:
            return "shared step limit"
        if self.tokens >= self.max_tokens:
            return "shared token limit"
        if time.time() - self.started > self.max_seconds:
            return "shared time limit"
        return None


def call(messages, tools=None, tries=4):
    for attempt in range(tries):
        try:
            return client.chat.completions.create(
                model=MODEL, messages=messages, tools=tools)
        except RateLimitError:
            time.sleep(2 ** attempt)
    raise RuntimeError("rate limited")


def agent(goal, system_prompt, tool_names, budget, max_steps=8, label="agent"):
    """One worker. Only gets the tools it is given."""
    schemas = [t for t in TOOL_SCHEMAS if t["function"]["name"] in tool_names]
    messages = [{"role": "system", "content": system_prompt},
                {"role": "user", "content": goal}]

    for step in range(max_steps):
        stop = budget.exceeded()
        if stop:
            return f"[{label} stopped: {stop}]"

        response = call(messages, schemas)
        budget.spend(response.usage.total_tokens)
        message = response.choices[0].message

        if not message.tool_calls:
            return message.content

        messages.append(message.model_dump(exclude_none=True))
        for tc in message.tool_calls:
            name = tc.function.name
            args = json.loads(tc.function.arguments)
            print(f"      [{label}] {name}({str(args)[:60]})")

            if name not in AVAILABLE_TOOLS:
                out = f"No tool called {name}."
            else:
                try:
                    out = str(AVAILABLE_TOOLS[name](**args))
                except Exception as e:
                    out = f"Tool failed: {e}"

            messages.append({"role": "tool", "tool_call_id": tc.id, "content": out})

    return f"[{label} ran out of its own steps]"
```

**Two design points that carry the whole day.**

**`SharedBudget`.** Day 9's budget belonged to one run. Here every agent spends from the same pot. Give each agent its own budget and five agents cost five times as much — quietly, because each one looks reasonable on its own.

**`tool_names` per agent.** This is Day 13's least privilege, made structural. The researcher will not get `save_note` — not because we asked it not to, but because it was never given it.

---

### Stage 2 — Specialists

```python
RESEARCHER = """You are a researcher. Find information and report what you found.
Search thoroughly, more than once if the first attempt is weak.
Report: what you found, where it came from, and what you could NOT find.
Never speculate. If something is missing, say it is missing.
You cannot write files. Only report."""

WRITER = """You are a writer. Turn findings into clear prose.
Use ONLY the findings you are given. Never add facts from your own knowledge.
If a finding is missing, write "not found" rather than filling the gap.
Keep the source filename next to each claim."""

CRITIC = """You review work against its brief. Be specific and be strict.
Reply with JSON only:
{"verdict": "good" | "needs_work",
 "problems": ["specific problem, with the sentence it applies to"],
 "missing": ["what the brief asked for that is absent"]}
Judge only against the brief. Do not invent new requirements."""


def researcher(goal, budget):
    return agent(goal, RESEARCHER,
                 ["search_documents", "get_current_time", "calculate"],
                 budget, max_steps=6, label="researcher")


def writer(brief, findings, budget):
    return agent(f"BRIEF: {brief}\n\nFINDINGS:\n{findings}",
                 WRITER, [], budget, max_steps=2, label="writer")
```

**The writer gets no tools at all.** It cannot search, so it cannot wander off-topic, and it cannot write files, so an injection reaching it can do nothing. Narrow by construction.

**`RESEARCHER` says "report what you could NOT find".** Without this, a researcher returns only successes, the writer assumes silence means nothing was needed, and gaps vanish silently. This one line prevents the most common quality failure in a pipeline.

---

### Stage 3 — The supervisor

Now make agents into tools:

```python
SUPERVISOR = """You coordinate a small team to complete a task.

Your team:
- delegate_research(question): a researcher who searches documents and reports
- delegate_writing(brief, findings): a writer who turns findings into prose

You cannot search or write files yourself. Work through your team.
Research first, then write. Delegate one clear question at a time.
When the task is complete, give the final result."""

TEAM_SCHEMAS = [
    {"type": "function", "function": {
        "name": "delegate_research",
        "description": "Ask the researcher one specific question. They will search the user's documents and report findings, including what they could not find.",
        "parameters": {"type": "object", "properties": {
            "question": {"type": "string", "description": "One clear, specific research question."}
        }, "required": ["question"]}}},
    {"type": "function", "function": {
        "name": "delegate_writing",
        "description": "Give the writer a brief and the findings. They produce the final prose. They only use the findings given.",
        "parameters": {"type": "object", "properties": {
            "brief": {"type": "string", "description": "What to write and in what shape."},
            "findings": {"type": "string", "description": "All relevant findings gathered so far. Include everything the writer needs."}
        }, "required": ["brief", "findings"]}}},
]


def supervise(goal, budget=None, max_steps=8):
    budget = budget or SharedBudget()
    messages = [{"role": "system", "content": SUPERVISOR},
                {"role": "user", "content": goal}]

    for step in range(max_steps):
        stop = budget.exceeded()
        if stop:
            return f"Stopped: {stop}"

        response = call(messages, TEAM_SCHEMAS)
        budget.spend(response.usage.total_tokens)
        message = response.choices[0].message

        if not message.tool_calls:
            print(f"\nbudget used: {budget.steps} steps, {budget.tokens} tokens")
            return message.content

        messages.append(message.model_dump(exclude_none=True))
        for tc in message.tool_calls:
            args = json.loads(tc.function.arguments)

            if tc.function.name == "delegate_research":
                print(f"  -> researcher: {args['question']}")
                out = researcher(args["question"], budget)
            else:
                print(f"  -> writer: {args['brief'][:60]}")
                out = writer(args["brief"], args["findings"], budget)

            print(f"  <- {out[:120]}\n")
            messages.append({"role": "tool", "tool_call_id": tc.id, "content": out})

    return "Supervisor ran out of steps."
```

Run it:

```python
print(supervise("Find out what my documents say about project deadlines and "
                "write a short summary with sources."))
```

**Watch the `findings` argument when the supervisor delegates writing.** That string is the entire handoff. Everything the researcher read that did not make it into that string is gone forever.

That is the lossy handoff, visible in your terminal. Make the supervisor careless about that argument and quality collapses — which is exactly what happens in real systems built by people who did not look at this.

---

### Stage 4 — Parallel fan-out

The one clear win.

```python
async def research_many(questions, budget):
    loop = asyncio.get_event_loop()
    tasks = [loop.run_in_executor(None, researcher, q, budget) for q in questions]
    return await asyncio.gather(*tasks)


def parallel_research(goal, questions):
    budget = SharedBudget(max_steps=40)

    start = time.time()
    findings = asyncio.run(research_many(questions, budget))
    print(f"\n{len(questions)} researchers finished in {time.time()-start:.1f}s")

    combined = "\n\n".join(f"Q: {q}\nA: {f}" for q, f in zip(questions, findings))
    return writer(goal, combined, budget)


if __name__ == "__main__":
    print(parallel_research(
        "Write a summary of my documents covering deadlines, budget and risks.",
        ["What deadlines are mentioned and where?",
         "What does it say about budget or cost?",
         "What risks or problems are described?"]
    ))
```

Time it, then run the same three questions one after another. **The parallel version should be roughly three times faster**, because the researchers do not depend on each other.

**Two honest warnings.**

You will hit Groq's rate limit. Three agents firing at once, each carrying its own context, can exceed 6,000 tokens per minute immediately. Your backoff handles it, but the speedup shrinks — on a free tier, parallelism is partly theoretical.

**The subtasks must be genuinely independent.** If question 2 needs question 1's answer, running them together produces two agents working with incomplete information. Splitting a task that does not split is worse than not splitting it.

---

### Stage 5 — The critic

Cheap, and it improves output more reliably than most of this page:

```python
def critique(brief, work, budget):
    response = call([{"role": "system", "content": CRITIC},
                     {"role": "user", "content": f"BRIEF:\n{brief}\n\nWORK:\n{work}"}])
    budget.spend(response.usage.total_tokens)
    try:
        return json.loads(response.choices[0].message.content)
    except json.JSONDecodeError:
        return {"verdict": "good", "problems": []}


def write_with_critic(brief, findings, budget, rounds=2):
    work = writer(brief, findings, budget)

    for round_number in range(rounds):
        review = critique(brief, work, budget)
        print(f"  critic round {round_number+1}: {review['verdict']}")

        if review["verdict"] == "good":
            break

        for problem in review.get("problems", [])[:3]:
            print(f"    - {problem}")

        work = writer(
            f"{brief}\n\nYour previous draft had these problems, fix them:\n"
            + "\n".join(review.get("problems", []) + review.get("missing", [])),
            findings, budget)

    return work
```

**`rounds=2` is a hard cap, and it is not negotiable.** Without it, a critic finds something to improve forever — each round produces a slightly different draft with slightly different flaws. Two rounds captures nearly all of the gain.

**Test whether it earns its cost.** Run the same brief with and without the critic, and read both outputs. Sometimes the improvement is obvious. Sometimes the critic invents requirements that were never in the brief and makes it worse. That is why `CRITIC` says "judge only against the brief".

---

### Stage 6 — Measure it, and be willing to conclude "not worth it"

The point of the day.

```python
from autonomous import run as single_agent, Budget

TASKS = [
    "What deadlines are in my documents?",
    "Summarise what my documents say about deadlines, with sources.",
    "Compare what my documents say about budget and timeline, find any "
    "contradictions, and write a summary with sources for each claim.",
]

for task in TASKS:
    print("=" * 70)
    print(task[:60])

    start = time.time()
    one = single_agent(task, budget=Budget(max_steps=15), policy="auto")
    print(f"  single: {one['budget']}, {time.time()-start:.0f}s")

    start = time.time()
    budget = SharedBudget()
    many = supervise(task, budget)
    print(f"  multi:  {budget.steps} steps, {budget.tokens} tokens, {time.time()-start:.0f}s")
```

Then **read both outputs** for each task and judge them yourself. Quality is the whole question and no counter measures it.

You will most likely find something like:

| Task | Better | Why |
|---|---|---|
| Simple lookup | **Single, clearly** | Coordination costs more than the task |
| Medium summary | About even, multi costs 2-3x | Specialisation helps a bit |
| Complex comparison | **Multi**, if handoffs were clean | Separate contexts prevent muddle |

**Write your real numbers down.** And be prepared for the outcome most people do not expect: that on your tasks, with your documents, the single agent wins. That is a legitimate and useful result. Multi-agent is a tool for specific shapes of problem, not a level you graduate to.

---

## 7. Words I heard today

| Word | Plain meaning |
|---|---|
| **Orchestrator / supervisor** | The agent that holds the goal and delegates. |
| **Worker** | A specialist agent doing one kind of job. |
| **Agent-as-tool** | Exposing an agent as a callable function. |
| **Handoff** | Passing work between agents. Where context is lost. |
| **Fan-out / fan-in** | Splitting into parallel work, then merging. |
| **Pipeline** | A fixed chain of agents. |
| **Critic** | An agent that reviews another's output. |
| **Swarm** | Agents passing control freely. Flexible, hard to debug. |
| **Blackboard** | Shared state all agents can read and write. |
| **Coordination overhead** | The extra calls, tokens and time that multi-agent costs. |
| **Context isolation** | Each agent seeing only what it needs. The main benefit. |
| **Trace id** | One id threaded through every agent, for debugging. |

---

## 8. Break it on purpose

**1. Measure the cost.**
Same task, single versus supervised. Compare tokens.
*You will see:* two to four times more for the multi version.
*It teaches:* coordination is not free, in a number you produced yourself.

**2. Cripple the handoff.**
Change the supervisor prompt to "pass a brief one-sentence summary of findings to the writer".
*You will see:* the final output gets noticeably thinner.
*It teaches:* the handoff string is the bottleneck. This is the failure people do not anticipate.

**3. Remove "say what you could not find".**
Take that line out of `RESEARCHER`. Ask about something half-covered in your documents.
*You will see:* the writer treats silence as completeness and the gap disappears.
*It teaches:* absent information must be reported explicitly or it vanishes at every handoff.

**4. Let the critic run free.**
Set `rounds=10`.
*You will see:* it keeps finding things, the draft keeps changing, quality plateaus early.
*It teaches:* review loops need a hard cap.

**5. Break a worker.**
Make the researcher always return `"[error]"`.
*You will see:* whether the supervisor notices, or writes a summary of nothing.
*It teaches:* failures must propagate. Same lesson as Day 10's `depends_on`.

**6. Split something unsplittable.**
Fan out three questions where question 3 depends on question 1's answer.
*You will see:* three researchers with incomplete information, and a muddled merge.
*It teaches:* parallelism needs genuine independence. It is not a general speedup.

---

## 9. Traps

**Trap 1 — multi-agent when one would do**
*Symptom:* three times the cost, no better output.
*Fix:* default to one agent. Reach for a team when you have a measured reason.

**Trap 2 — per-agent budgets**
*Symptom:* quota gone in one run.
*Cause:* five agents at 25 steps each. Each looks reasonable alone.
*Fix:* `SharedBudget`. One pot.

**Trap 3 — the lossy handoff**
*Symptom:* the multi version produces thinner work than the single one did.
*Cause:* the receiving agent only got a summary.
*Fix:* pass more, or restructure so the agent that needs the detail is the one that gathered it.

**Trap 4 — critic loops**
*Symptom:* it never finishes.
*Fix:* hard round cap. Always.

**Trap 5 — no trace id**
*Symptom:* something went wrong and you cannot tell which agent.
*Fix:* one run id, threaded through every agent, logged on every call, saved to `runs/`.

**Trap 6 — injection reaching the whole team**
*Symptom:* a document manipulates the researcher, whose report manipulates the supervisor.
*Cause:* Day 13, multiplied. Agent output is untrusted input to the next agent.
*Fix:* wrap inter-agent messages the same way you wrap document text, and keep least privilege per worker — which is exactly why the writer has no tools.

---

## 10. Check yourself

1. What single idea makes multi-agent possible with no new machinery?
2. Why do two agents usually have *less* total context than one agent would have had?
3. Which pattern gives a genuine speed win, and what must be true for it to work?
4. Why must budgets be shared rather than per agent?
5. Name one task where a single agent beats a team, and say why.

---

## 11. Where this goes

- **Day 15** makes this operable: tracing across agents, cost per task, and evaluation over many runs rather than one.
- **Day 16 (LangGraph)** gives you this as a graph. Supervisor, workers and handoffs become nodes and edges. You will recognise every piece.
- **Day 17 (CrewAI)** is this with roles and goals as the main concept. Crews, tasks, delegation — today's ideas with different names.
- **Day 18** builds the research agent properly, and you will choose single or multi with evidence from Stage 6.
- **Day 21** is where the choice matters commercially: three times the tokens for a marginal gain is a real cost.

---

## 12. PROJECT STATE

```
PROJECT STATE after Day 14:

Folders:
  research-assistant/
    ai/
      venv/, .env, .gitignore, requirements.txt
      multi_agent.py        (NEW)
      chat.py, agent.py, autonomous.py, planner.py, memory.py
      retrieval.py, golden_set.py, vector_store.py, embeddings.py
      documents.py, tools.py, security.py
      mcp_agent.py, mcp_client.py, mcp_servers/my_tools.py
      prompts.py, classify.py, test_prompt.py
      runs/, notes/, documents/, chroma_db/, conversation.json
    dashboard/              (still empty)

Libraries: no new installs (asyncio is standard library)

multi_agent.py contains:

  SharedBudget    - ONE budget for every agent in a run, not one each.
                    40 steps / 80000 tokens / 300 seconds.
                    Per-agent budgets were the trap: 5 agents x 25 steps
                    each looks reasonable and costs 125 steps.

  agent(goal, system_prompt, tool_names, budget, max_steps, label)
                  - a generic worker. tool_names filters TOOL_SCHEMAS, so
                    each worker STRUCTURALLY only has the tools it needs.
                    This is Day 13 least privilege built into the shape.

  Specialists:
    RESEARCHER  - tools: search_documents, get_current_time, calculate
                  MUST report what it could NOT find (without this line the
                  writer treats silence as completeness and gaps vanish)
    WRITER      - NO TOOLS AT ALL. Cannot search, cannot write files.
                  Uses only the findings handed to it.
    CRITIC      - JSON verdict good|needs_work, problems[], missing[]
                  judges only against the brief

  supervise(goal, budget, max_steps)
                  - supervisor with TEAM_SCHEMAS: delegate_research and
                    delegate_writing are TOOLS whose implementations are
                    other agents. Agent-as-tool is the whole trick; no new
                    machinery was needed.
                  - the "findings" argument IS the handoff, and everything
                    the researcher read that is not in that string is lost

  parallel_research(goal, questions) + research_many()
                  - asyncio.gather over run_in_executor, roughly 3x faster
                    for 3 independent questions
                  - only valid when the subtasks genuinely do not depend on
                    each other

  write_with_critic(brief, findings, budget, rounds=2)
                  - HARD cap at 2 rounds; without it the critic finds
                    something to improve forever

Measured, single agent vs supervised, on 3 tasks:
  simple lookup      -> single wins clearly, coordination costs more than
                        the task
  medium summary     -> roughly even, multi costs 2-3x the tokens
  complex comparison -> multi better IF the handoff carried enough detail
  (record your own numbers; concluding "not worth it" is a legitimate and
   useful result)

Practical note: Groq free (30 RPM / 6000 TPM) throttles the parallel stage
almost immediately. Backoff handles it but the speedup shrinks.

Key decisions made:
  - default to ONE agent; a team needs a measured reason
  - budgets are always shared
  - each worker gets the narrowest possible toolset; the writer gets none
  - researchers must report gaps explicitly
  - review loops always have a hard round cap

Known problems, left for later:
  - no trace id threaded through agents yet; debugging across workers is
    hard (Day 15)
  - handoffs are lossy by construction and there is no measurement of how
    much is lost
  - worker failures do not reliably propagate to the supervisor
  - inter-agent messages are not wrapped as untrusted content, so a Day 13
    injection can travel from a document through the researcher's report
    into the supervisor
  - no shared blackboard; workers cannot see each other's findings
```

---

## Answers

**1.** That an agent is a function, and a function can be a tool. `run_agent(goal)` exposed as a tool makes the supervisor pattern fall out of Day 4 with no new machinery.

**2.** Because the handoff is a summary. The researcher read forty chunks and passes a paragraph; the writer never sees the forty chunks. A single agent would have had all of it in one context.

**3.** Parallel fan-out. It requires the subtasks to be genuinely independent — if one needs another's answer, running them together just produces two agents working with incomplete information.

**4.** Because per-agent budgets multiply invisibly. Five agents with 25 steps each is 125 steps, and each individual budget looks perfectly reasonable when you set it.

**5.** A simple lookup like "what deadlines are in my documents". One search answers it, and the supervisor's delegation call costs more than the entire task. Coordination overhead only pays for itself when there is real work to coordinate.
