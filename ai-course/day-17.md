# Day 17 -- CrewAI

**Module:** 04 -- Frameworks
**Time:** about 1 hour
**Builds on:** Day 14 -- multi-agent; Day 16 -- LangGraph, for comparison

---

## 1. Today in one line

You rebuild your Day 14 team in CrewAI, and learn to tell an opinionated framework from a flexible one -- because that choice matters more than either framework's feature list.

---

## 2. The problem

Yesterday's LangGraph version required you to define state, nodes, edges and reducers. Full control, and a lot of scaffolding for something as common as "a researcher hands findings to a writer".

That pattern is so standard it should not need a graph. CrewAI takes that view: describe a **team** -- who they are, what they do, in what order -- and it assembles the machinery.

Your Day 14 supervisor was about 120 lines. The CrewAI version is about 30.

**The cost of that is control.** Yesterday you could see every edge. Today a great deal happens inside the framework, including prompts you did not write and cannot easily read. That is the trade, and today is about learning to feel it rather than being told about it.

One practical note: **CrewAI is Python-only.** Which is fine -- your AI side has been Python since Day 1, and Node is only doing the dashboard.

---

## 3. Mental model

**LangGraph is a flowchart. CrewAI is an org chart.**

LangGraph: boxes and arrows. You decide what happens after what.

CrewAI: roles and responsibilities. You decide who does what, and hand over the goal.

**Where this comparison breaks, and it is worth watching for:**

**The org-chart metaphor invites you to anthropomorphise.** CrewAI has a field called `backstory`, and writing "You are a veteran analyst with 15 years in fintech" *feels* like creating a person. It is a string prepended to a prompt. Nothing more. Day 3 told you that role-setting shifts output style -- that is real, and it is also all that is happening.

**Real teams get better because people learn.** Your crew does not. Every run starts from the same prompts. There is no accumulated judgement, no "she's good at that one", no growth. The org chart is a way of organising prompts, not an organisation.

Hold on to that and the framework is useful. Forget it and you will start attributing behaviour to personalities instead of debugging prompts.

---

## 4. How it really works

**Four concepts, and all four are things you already built.**

**Agent** -- a role, a goal, a backstory, tools, an LLM, and whether it may delegate. This is Day 14's specialist: `RESEARCHER` with its own system prompt and its own tool list.

**Task** -- a description, an `expected_output`, the agent responsible, and `context` (which earlier tasks feed it). This is one delegation call.

**Crew** -- the agents, the tasks, and a process: `sequential` (in order) or `hierarchical` (a manager delegates). This is your supervisor.

**Process** -- `sequential` is Day 14's pipeline. `hierarchical` is Day 14's supervisor, with a manager LLM deciding who does what.

**The field that matters most**

`expected_output` is not documentation. It goes into the prompt, and it is the single biggest lever on output quality in the whole framework.

```python
expected_output="A bullet list. Each bullet: the deadline date, what it refers to, and the source filename in brackets. Say 'none found' if there are none."
```

That is Day 3's format specification wearing a CrewAI name. Leave it vague and you get vague output, exactly as on Day 3.

**The field that matters second**

`context=[previous_task]` is Day 14's handoff, made explicit. It controls what the next agent sees. You learned on Day 14 that the handoff is where context gets lost -- this is the field where that loss happens, so it is the field to watch.

**What it does underneath**

CrewAI wraps each task in its own prompt template, adds delegation instructions when delegation is on, and manages the passing of outputs. Those wrappers are real tokens on every call, and they are not shown to you by default. Stage 6 is about seeing them.

---

## 5. Setup

```bash
cd research-assistant/ai
source venv/bin/activate

pip install crewai crewai-tools
pip freeze > requirements.txt

touch crew_agent.py
```

**Two warnings.**

**This install is heavy** and pulls a large dependency tree. It also has stricter Python version requirements than the rest of your project. If it conflicts with what you have, make a separate virtual environment for today rather than breaking the one that works:

```bash
python3 -m venv venv-crew && source venv-crew/bin/activate && pip install crewai crewai-tools
```

**CrewAI defaults to OpenAI.** Configure Groq explicitly or you will get an authentication error that has nothing to do with your code:

```python
from crewai import LLM

llm = LLM(model="groq/llama-3.3-70b-versatile",
          api_key=os.environ["GROQ_API_KEY"])
```

The `groq/` prefix matters -- that is how the underlying router picks the provider.

---

## 6. Build it

---

### Stage 1 -- Your Day 14 crew, in 30 lines

`crew_agent.py`:

```python
import os
from dotenv import load_dotenv
from crewai import Agent, Task, Crew, Process, LLM

load_dotenv()

llm = LLM(model="groq/llama-3.3-70b-versatile",
          api_key=os.environ["GROQ_API_KEY"])

researcher = Agent(
    role="Document Researcher",
    goal="Find accurate information in the user's documents and report exactly what is there",
    backstory="You are careful and literal. You report what the documents say and "
              "nothing more. When something is not there, you say so plainly instead "
              "of guessing.",
    llm=llm,
    allow_delegation=False,
    verbose=True,
)

writer = Agent(
    role="Technical Writer",
    goal="Turn findings into clear, honest prose a busy person can act on",
    backstory="You write plainly and never add facts that were not given to you. "
              "Where information is missing you write 'not found' rather than "
              "filling the gap.",
    llm=llm,
    allow_delegation=False,
    verbose=True,
)

research_task = Task(
    description="Search the user's documents for anything about deadlines or due dates. "
                "Report each one you find, and state clearly what you could NOT find.",
    expected_output="A list. Each item: the date, what it refers to, and the source "
                    "filename. Then a short line listing anything you looked for and "
                    "could not find.",
    agent=researcher,
)

writing_task = Task(
    description="Using only the research findings, write a short summary of the "
                "user's deadlines.",
    expected_output="Under 200 words. A one-sentence opening, then bullets, each with "
                    "its source filename in brackets. Include a 'Gaps' line if anything "
                    "was not found.",
    agent=writer,
    context=[research_task],
)

crew = Crew(agents=[researcher, writer],
            tasks=[research_task, writing_task],
            process=Process.sequential,
            verbose=True)

if __name__ == "__main__":
    print(crew.kickoff())
```

Run it. **Read the verbose output carefully** -- this is the clearest view you will get of what the framework does.

**Then open `multi_agent.py` next to it.** Every idea maps:

| Your Day 14 code | CrewAI |
|---|---|
| `RESEARCHER` system prompt | `role` + `goal` + `backstory` |
| `tool_names` per worker | `tools=[...]` |
| `delegate_research(question)` | a `Task` with `agent=researcher` |
| the `findings` handoff string | `context=[research_task]` |
| `supervise()` loop | `Crew` with `Process.sequential` |
| "report what you could NOT find" | still yours, in the description |

Note the last row. **That line was your discovery on Day 14** -- without it, the writer treats silence as completeness and gaps vanish. No framework supplies it. The framework gives you structure; the quality lines are still yours to write.

---

### Stage 2 -- Give it your tools

The researcher cannot search yet. Wire in your Day 12 pipeline:

```python
from crewai.tools import tool
import tools as my_tools


@tool("Search Documents")
def search_documents(query: str) -> str:
    """Search the user's own documents and notes by meaning. Natural language works;
    you do not need the exact words from the document."""
    return my_tools.search_documents(query)


@tool("Current Time")
def current_time(timezone: str = "Asia/Kolkata") -> str:
    """Get the current date and time in a timezone."""
    return my_tools.get_current_time(timezone)


researcher = Agent(
    ...,
    tools=[search_documents, current_time],
)
```

**The docstring is the tool description**, exactly as with MCP on Day 8 and function schemas on Day 4. Three frameworks, three syntaxes, one idea: describe the tool well or the model chooses badly.

**The writer still has no tools**, deliberately. Day 14's reasoning holds: it cannot search so it cannot wander, and it cannot write files so an injection reaching it can do nothing.

---

### Stage 3 -- Prove that `expected_output` is the lever

This is the stage that teaches the most about CrewAI.

Run three versions of `writing_task` and keep all three outputs side by side:

```python
# Version A - vague
expected_output="A summary of the deadlines."

# Version B - specific
expected_output="Under 200 words. One opening sentence, then bullets, each with its source filename in brackets."

# Version C - specific, with an example
expected_output="""Under 200 words.

Format exactly like this:
You have 3 upcoming deadlines.
- 30 November: final report submission [project-plan.pdf]
- 15 December: budget review [finance-notes.txt]

Gaps: nothing found about the Q1 timeline."""
```

The difference between A and C is large. Much larger than any change you could make to `backstory`.

**That ratio is the lesson.** `backstory` feels like the important field because it reads like a character description. `expected_output` is the important field, because it is a format specification -- Day 3, again, with a new name.

If you are ever tuning a crew and getting nowhere, you are probably editing backstories. Go and edit the expected outputs.

---

### Stage 4 -- Hierarchical, and what it costs

```python
manager = LLM(model="groq/llama-3.3-70b-versatile", api_key=os.environ["GROQ_API_KEY"])

crew = Crew(
    agents=[researcher, writer],
    tasks=[Task(
        description="Find out what the user's documents say about deadlines AND about "
                    "budget, then write one summary covering both with sources.",
        expected_output="Under 300 words, two sections, every claim with its source filename.",
    )],
    process=Process.hierarchical,
    manager_llm=manager,
    verbose=True,
)
```

Note the task has **no agent**. The manager decides who does it.

**Turn on delegation** and watch the difference:

```python
researcher = Agent(..., allow_delegation=True)
```

Now agents can ask each other for help.

**Count the calls in both versions.** Hierarchical with delegation is typically two to four times the tokens of sequential, because the manager reasons about assignment, agents write delegation requests, and results get passed around.

**When is it worth it?** When the work genuinely cannot be ordered in advance. If you already know it is research-then-write, `sequential` does the same job for a fraction of the cost. This is Day 14's conclusion, arriving again from a different direction: coordination is not free, and most tasks do not need it.

---

### Stage 5 -- Map it all back

Fill this in yourself. It is the exercise, not the reference:

| Concept | Your code | LangGraph | CrewAI |
|---|---|---|---|
| A worker | `agent(goal, prompt, tools)` | a node | `Agent` |
| Its instructions | system prompt | node function | `role`+`goal`+`backstory` |
| One unit of work | a delegation call | a node run | `Task` |
| Output shape | Day 3 format rules | your prompt | `expected_output` |
| Handoff | the `findings` string | state | `context=[...]` |
| Orchestration | `supervise()` | edges | `Process` |
| Tools | `TOOL_SCHEMAS` | `@tool` | `@tool` |
| Step limit | `max_steps` | `recursion_limit` | `max_iter` |
| Budget | `SharedBudget` | -- | `max_rpm` |

**Look at the last two rows.** Neither framework gives you Day 9's three-way budget of steps, tokens and wall-clock time. You still have to build that yourself, and it is the thing that stops a runaway run costing real money.

**Frameworks give you structure. They do not give you operational safety.** That gap is where most of Day 15 lives, and it does not close when you adopt a framework.

---

### Stage 6 -- Open the box, and judge honestly

**See what it actually sends:**

```python
import litellm
litellm.set_verbose = True
crew.kickoff()
```

Read the real prompts. You will find framework-written text around your descriptions -- task wrappers, delegation instructions, output-format boilerplate. **Estimate how many tokens that adds per call**, then multiply by the number of calls in a run. That is your framework tax, and it is not small.

**Then run your Day 15 evals** against three implementations of the same task: hand-written Day 14, LangGraph, CrewAI.

```
                 success   tokens   seconds
hand-written        80%     8,400      22
langgraph           80%     9,100      24
crewai              73%    14,200      38
```

Write your own numbers. The shape is usually: **similar quality, meaningfully more tokens** for the more opinionated framework.

**The honest summary:**

| | Best at |
|---|---|
| **Your own code** | Full control, minimum tokens, you can debug anything. Costs your time. |
| **LangGraph** | Custom control flow, persistence, resumable interrupts, deployment. |
| **CrewAI** | Getting a standard role-based team running very fast. |

**And the real recommendation, having built all three:** start with your own code for anything unusual. Reach for LangGraph when you need persistence and branching. Reach for CrewAI when the problem genuinely is a team of roles and you want it working this afternoon.

None of the three makes the model smarter. All of them are ways of organising prompts.

---

## 7. Words I heard today

| Word | Plain meaning |
|---|---|
| **Agent (CrewAI)** | A role with a goal, backstory, tools and an LLM. |
| **Role / goal / backstory** | Three strings that become the system prompt. |
| **Task** | One unit of work, with a description and an expected output. |
| **expected_output** | The format specification. The biggest quality lever here. |
| **context=[...]** | Which earlier task outputs feed this one. The handoff. |
| **Crew** | The team plus the tasks plus the process. |
| **Process.sequential** | Tasks in order. |
| **Process.hierarchical** | A manager LLM assigns work. |
| **allow_delegation** | Whether agents may ask each other for help. |
| **max_iter** | Step limit per agent. |
| **max_rpm** | Requests per minute cap. |
| **kickoff()** | Run the crew. |
| **Opinionated framework** | Fewer decisions, less control. |

---

## 8. Break it on purpose

**1. Empty the expected_output.**
Set it to `"A summary."` on both tasks.
*You will see:* a noticeable quality drop.
*It teaches:* the most useful thing about CrewAI. It is Day 3 with a new name.

**2. Swap the backstories.**
Give the researcher the writer's backstory and vice versa, keeping roles and tasks.
*You will see:* less difference than you expect.
*It teaches:* `backstory` is a style nudge, not a personality. The task description does the work.

**3. Count the delegation tax.**
Same task, `allow_delegation` off then on.
*You will see:* two to four times the tokens.
*It teaches:* coordination has a price tag, and here it is.

**4. Break the handoff.**
Remove `context=[research_task]` from the writing task.
*You will see:* the writer working with nothing, inventing content.
*It teaches:* `context` is the handoff, and the handoff is everything. Day 14's lesson, reconfirmed.

**5. Read the real prompts.**
`litellm.set_verbose = True`.
*You will see:* a lot of text you did not write.
*It teaches:* what you are paying for.

**6. Three-way eval.**
Day 15's eval set against hand-written, LangGraph and CrewAI.
*You will see:* similar quality, different costs.
*It teaches:* how to choose a framework with evidence rather than enthusiasm.

---

## 9. Traps

**Trap 1 -- the default OpenAI model**
*Symptom:* an authentication error mentioning OpenAI when you configured Groq.
*Fix:* pass `llm=` explicitly on every agent, with the `groq/` prefix.

**Trap 2 -- dependency conflicts**
*Symptom:* pip breaks your working environment.
*Fix:* a separate virtual environment for CrewAI.

**Trap 3 -- the backstory trap**
*Symptom:* hours spent writing richer personas, no improvement.
*Fix:* edit `expected_output` and task descriptions instead.

**Trap 4 -- hierarchical by default**
*Symptom:* three times the cost for no gain.
*Fix:* `sequential` unless the ordering genuinely cannot be decided in advance.

**Trap 5 -- delegation loops**
*Symptom:* agents delegating back and forth.
*Fix:* `allow_delegation=False` unless needed, and set `max_iter`.

**Trap 6 -- assuming frameworks bring safety**
*Symptom:* your careful Day 9 budgets and Day 13 permission tiers quietly disappear when you port to a framework.
*Fix:* keep them. `max_iter` and `max_rpm` are not a token budget, a wall-clock limit, or a permission model. Frameworks give structure, not operational safety.

---

## 10. Check yourself

1. Map `Agent`, `Task`, `context` and `Process` to your own Day 14 code.
2. Which CrewAI field has the biggest effect on output quality, and which one only appears to?
3. When is `hierarchical` worth its cost, and when is it waste?
4. Name two things from Day 9 and Day 13 that no framework gives you.
5. You need a research-then-write pipeline this afternoon. Which of the three do you pick, and why?

---

## 11. Where this goes

- **Day 18** builds the research agent for real, and you choose your approach with the three-way eval numbers in hand.
- **Day 19 (LangChain)** is the layer under LangGraph -- document loaders, splitters, retrievers -- some of which would have saved you time on Days 5 and 6, and some of which is a wrapper you do not need.
- **Day 20** deploys it. Framework choice matters here: LangGraph's checkpointing is built for it, CrewAI less so.
- **Day 21** is the capstone, and cost per task is a real constraint. A framework tax of 60% more tokens is a business decision, not a detail.

---

## 12. PROJECT STATE

```
PROJECT STATE after Day 17:

Folders:
  research-assistant/
    ai/
      crew_agent.py        (NEW - Day 14's team rebuilt in CrewAI)
      graph_agent.py       (Day 16 LangGraph version)
      multi_agent.py       (Day 14 hand-written version - all three kept
                            side by side on purpose, for comparison)
      observability.py, evals.py, reliability.py, logs/
      chat.py, agent.py, autonomous.py, planner.py, memory.py
      retrieval.py, golden_set.py, security.py
      vector_store.py, embeddings.py, documents.py, tools.py
      mcp_agent.py, mcp_client.py, mcp_servers/my_tools.py
      prompts.py, classify.py, test_prompt.py
      runs/, notes/, documents/, chroma_db/
    dashboard/             (still empty)

Libraries: crewai, crewai-tools (NEW). Heavy dependency tree with stricter
Python version requirements - installed in a SEPARATE venv (venv-crew) to
avoid breaking the working environment.

CRITICAL CONFIG: CrewAI defaults to OpenAI. Groq must be passed explicitly:
  LLM(model="groq/llama-3.3-70b-versatile", api_key=...)
  the "groq/" prefix is what selects the provider

crew_agent.py:
  researcher Agent - role/goal/backstory, tools=[search_documents,
      current_time], allow_delegation=False
  writer Agent     - NO TOOLS (Day 14 reasoning: cannot wander, cannot be
      used by an injection to write anything)
  research_task    - description includes "state clearly what you could NOT
      find", which was OUR Day 14 discovery, not something the framework
      supplies
  writing_task     - context=[research_task]  <- this IS the handoff
  Crew(process=Process.sequential)

THE MAPPING (fill in and keep):
  concept          your code           LangGraph        CrewAI
  worker           agent(...)          node             Agent
  instructions     system prompt       node function    role+goal+backstory
  unit of work     delegation call     node run         Task
  output shape     Day 3 format rules  your prompt      expected_output
  handoff          findings string     state            context=[...]
  orchestration    supervise()         edges            Process
  tools            TOOL_SCHEMAS        @tool            @tool
  step limit       max_steps           recursion_limit  max_iter
  budget           SharedBudget        --               max_rpm (partial)

MEASURED (Day 15 evals, same tasks, three implementations):
  hand-written   80%   8,400 tokens   22s
  langgraph      80%   9,100 tokens   24s
  crewai         73%  14,200 tokens   38s
  (record your own; the usual shape is similar quality, more tokens for
   the more opinionated framework)

Findings worth remembering:
  - expected_output is the BIGGEST quality lever in CrewAI; it is Day 3's
    format specification with a new name
  - backstory feels important and does very little; it is a style nudge,
    not a personality
  - hierarchical + allow_delegation costs 2-4x sequential; only worth it
    when the ordering genuinely cannot be decided in advance
  - framework prompt wrappers (visible via litellm.set_verbose) add real
    tokens to every single call

Key decisions made:
  - all three implementations kept side by side rather than replacing
  - frameworks judged by running the Day 15 eval set, not by feature lists
  - Day 9 budgets and Day 13 permission tiers are NOT ported away; no
    framework provides a token budget, a wall-clock limit, or a permission
    model

Known problems, left for later:
  - CrewAI lives in a separate venv; the project now has two environments
  - crew_agent.py has no token or wall-clock budget wired in
  - no observability logging from inside the crew; litellm verbose output
    is not captured into logs/calls.jsonl
  - hierarchical process not used in the final version, on cost grounds
```

---

## Answers

**1.** `Agent` is your specialist worker with its own system prompt and tool list. `Task` is one delegation call. `context=[...]` is the `findings` string handed between agents. `Process` is the `supervise()` loop -- sequential is your pipeline, hierarchical is your supervisor with a manager model.

**2.** `expected_output` has the biggest effect, because it is a format specification that goes into the prompt. `backstory` only appears to matter -- it reads like a character description but is a mild style nudge.

**3.** Worth it when the order of work genuinely cannot be decided in advance, so a manager must assign it at runtime. Waste when you already know the sequence, because sequential does the same job at a fraction of the token cost.

**4.** A real budget across steps, tokens and wall-clock time (Day 9), and a permission model separating read-only from write tools (Day 13). `max_iter` and `max_rpm` are not substitutes. You keep building these yourself.

**5.** CrewAI, if it really is just research-then-write and you want it today -- that is exactly the shape it is built for and it is about thirty lines. If it needs to persist across restarts, or branch, or pause for approval, LangGraph instead.
