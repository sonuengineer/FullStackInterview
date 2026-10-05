# Day 16 — LangGraph

**Module:** 04 — Frameworks
**Time:** about 1 hour
**Builds on:** Day 7 — the agent loop; Day 9 — approval; Day 11 — state

---

## 1. Today in one line

You rebuild your agent as an explicit graph — and recognise every single piece, because you already built all of them by hand.

---

## 2. A word before you start

**You are now allowed to use a framework, because you no longer need one.**

That is the reason the syllabus put Days 16 to 19 at the end. Everything LangGraph does, you have written: the loop, the state, the tool dispatch, the approval gate, the step limit. Today you find out what the framework calls those things, and what it gives you that your version did not.

Two rules for the next four days:

1. **Map every framework concept back to your own code.** If you cannot say which of your files a feature replaces, you do not understand it yet.
2. **Keep looking at what it sends.** Frameworks build their reputation on hiding the prompt. The people who can debug agents in production are the ones who still open the box.

---

## 3. The problem

Your `agent.py` works. Here is what it cannot do.

**The control flow is invisible.** Your agent's logic is spread across an `if`, a `for`, and three `append` calls. Nobody can look at that and see the shape. You cannot draw it.

**It cannot resume.** Kill the program at step 12 of a 20-step task and everything is gone. There is no way to come back tomorrow and continue.

**Approval kills the process.** Day 9's `input("allow?")` blocks. That works in a terminal and is useless in a web app, where the approval might come back four minutes later from a different request.

**Branching gets ugly.** Add "if the question is simple, skip research entirely" and you are nesting conditions inside a loop that already has three exit paths.

**You have written the same loop five times** — `agent.py`, `autonomous.py`, `planner.py`, `multi_agent.py`, `mcp_agent.py`. Each slightly different. Fix a bug in one and the other four still have it.

LangGraph addresses all five. It also hides things, which is why Stage 6 exists.

---

## 4. Mental model

**Your agent is a state machine. You just wrote it implicitly.**

Look at what your loop really does:

- there is a **state** (the message list) passed from step to step
- there are **nodes** (call the model, run the tools)
- there are **edges** (after calling the model, go to tools *or* finish)

LangGraph makes that explicit. You declare the nodes, declare the edges, and it runs the machine.

That is the entire idea. The framework does not add intelligence. It takes the structure that was hiding in your control flow and makes it a thing you can see, draw, pause and resume.

**Where this comparison breaks:**

A state machine is fixed structure, and agents need to be dynamic. LangGraph's answer is **conditional edges** — functions that look at the state and decide where to go next. They do a lot of work, and a graph with many of them becomes just as hard to read as your nested `if` statements were. The structure helps until it does not.

**The translation table.** Keep this next to you today:

| Your code | LangGraph |
|---|---|
| `messages` list | the state |
| `while` loop | a cycle in the graph |
| `if message.tool_calls:` | a conditional edge |
| running the tool | a `ToolNode` |
| `max_steps` | `recursion_limit` |
| `input("allow?")` | `interrupt` |
| `save_history()` | a checkpointer |
| `compress_scratchpad()` | a node |

---

## 5. Setup

```bash
cd research-assistant/ai
source venv/bin/activate

pip install langgraph langchain-openai
pip freeze > requirements.txt

touch graph_agent.py
```

**Groq works unchanged**, because of the decision you made on Day 1:

```python
llm = ChatOpenAI(model="llama-3.3-70b-versatile",
                 base_url="https://api.groq.com/openai/v1",
                 api_key=os.environ["GROQ_API_KEY"])
```

Same OpenAI-compatible client, pointed at Groq. That Day 1 choice is still paying for itself sixteen days later.

---

## 6. Build it

---

### Stage 1 — Your Day 7 agent, as a graph

`graph_agent.py`:

```python
import os
from typing import Annotated, TypedDict
from dotenv import load_dotenv
from langchain_openai import ChatOpenAI
from langchain_core.tools import tool
from langgraph.graph import StateGraph, START, END
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode, tools_condition

import tools as my_tools

load_dotenv()

llm = ChatOpenAI(model="llama-3.3-70b-versatile",
                 base_url="https://api.groq.com/openai/v1",
                 api_key=os.environ["GROQ_API_KEY"])


@tool
def search_documents(query: str) -> str:
    """Search the user's own documents and notes by meaning."""
    return my_tools.search_documents(query)


@tool
def get_current_time(timezone: str = "Asia/Kolkata") -> str:
    """Get the current date and time in a timezone."""
    return my_tools.get_current_time(timezone)


@tool
def save_note(title: str, content: str) -> str:
    """Save a note to a file for the user."""
    return my_tools.save_note(title, content)


TOOLS = [search_documents, get_current_time, save_note]
llm_with_tools = llm.bind_tools(TOOLS)


class State(TypedDict):
    messages: Annotated[list, add_messages]


def call_model(state: State):
    return {"messages": [llm_with_tools.invoke(state["messages"])]}


builder = StateGraph(State)
builder.add_node("model", call_model)
builder.add_node("tools", ToolNode(TOOLS))

builder.add_edge(START, "model")
builder.add_conditional_edges("model", tools_condition)
builder.add_edge("tools", "model")

graph = builder.compile()


if __name__ == "__main__":
    result = graph.invoke({"messages": [
        ("user", "Save a note called 'graph-test' with today's date and anything my documents say about deadlines.")
    ]})
    print(result["messages"][-1].content)
```

Run it. It completes the multi-step task.

**Now read the graph definition against your Day 7 code.**

```
START -> model
model -> tools (if the model asked for tools)
model -> END   (if it answered)
tools -> model
```

That is your `while` loop, drawn. `tools -> model` is the cycle. `tools_condition` is your `if message.tool_calls:`. `ToolNode` is your dispatch code — the `json.loads`, the lookup, the `role: "tool"` append, all of it.

**Everything you wrote by hand is there, with names.** Nothing new is happening, and that is exactly what you should be checking for.

---

### Stage 2 — State and reducers

`Annotated[list, add_messages]` deserves a proper look, because it is the piece that confuses people.

A node returns a **partial** state — just what it changed:

```python
return {"messages": [new_message]}
```

A **reducer** decides how that merges into the existing state. `add_messages` appends rather than replaces, and also handles message ids so an update to an existing message replaces it rather than duplicating.

Without a reducer, returning `{"messages": [x]}` would **overwrite** your whole history with a one-item list. Your agent would forget everything every step — exactly the Day 1 bug, reintroduced by a framework detail.

Add your own state fields:

```python
import operator

class State(TypedDict):
    messages: Annotated[list, add_messages]
    steps: Annotated[int, operator.add]      # each node returns 1, they sum
    findings: list                           # no reducer: last write wins
```

```python
def call_model(state: State):
    return {"messages": [llm_with_tools.invoke(state["messages"])],
            "steps": 1}
```

**The rule to remember:** a node **returns** its changes, it never mutates state in place. Mutating works sometimes and fails silently with checkpointing, which is a miserable bug to track down.

---

### Stage 3 — Persistence, and something your code cannot do

```python
from langgraph.checkpoint.memory import MemorySaver

memory = MemorySaver()
graph = builder.compile(checkpointer=memory)

config = {"configurable": {"thread_id": "conversation-1"}}

graph.invoke({"messages": [("user", "My name is Rahul.")]}, config)
graph.invoke({"messages": [("user", "What's my name?")]}, config)
```

The second call knows. The state was saved against `thread_id` and reloaded.

**`thread_id` is the whole mechanism.** Different id, different conversation. This is how one deployed agent serves many users — and it is exactly the `user` field you put in your memory metadata on Day 11, now appearing as a first-class concept.

Inspect it:

```python
snapshot = graph.get_state(config)
print(f"{len(snapshot.values['messages'])} messages")
print(f"next node: {snapshot.next}")

for old in graph.get_state_history(config):
    print(old.config["configurable"]["checkpoint_id"], old.next)
```

**`get_state_history` is genuinely new.** You can rewind to an earlier checkpoint and run forward again from there. Your `runs/*.json` recorded what happened; this lets you go back and change it. For debugging a long agent run, that is a real capability you did not have.

`MemorySaver` is in-memory. `langgraph-checkpoint-sqlite` gives you a real file, which is what you want from Day 20.

---

### Stage 4 — Approval that does not block

Day 9's approval called `input()` and froze the program. In a web app that is unusable.

```python
graph = builder.compile(checkpointer=memory, interrupt_before=["tools"])

config = {"configurable": {"thread_id": "approval-1"}}

result = graph.invoke({"messages": [("user", "Save a note called 'test' saying hello.")]}, config)

snapshot = graph.get_state(config)
pending = snapshot.values["messages"][-1]
print("wants to call:", pending.tool_calls)

if input("allow? (y/n): ") == "y":
    result = graph.invoke(None, config)      # None = resume from the checkpoint
    print(result["messages"][-1].content)
else:
    print("refused")
```

**Look at `graph.invoke(None, config)`.** Passing `None` means "carry on from where you stopped". The process could have exited in between. The approval could arrive tomorrow, from a different machine, over HTTP.

That is the difference between a terminal script and something deployable, and it is not a difference you could have bolted onto your Day 9 code without building the whole checkpoint mechanism yourself.

**Approve only what matters:**

```python
def approval_needed(state):
    last = state["messages"][-1]
    if any(c["name"] == "save_note" for c in getattr(last, "tool_calls", [])):
        return "approval"
    return "tools"
```

Day 13's least privilege, as a routing decision.

---

### Stage 5 — Branch

Now the thing that was awkward in your code. Route simple questions past the whole agent:

```python
from typing import Literal

def route(state: State) -> Literal["model", "quick"]:
    question = state["messages"][-1].content
    verdict = llm.invoke([
        ("system", "Reply with exactly one word: SIMPLE if this can be answered "
                   "from general knowledge, RESEARCH if it needs the user's own "
                   "documents or a tool."),
        ("user", question)
    ]).content.strip().upper()
    return "quick" if "SIMPLE" in verdict else "model"


def quick_answer(state: State):
    return {"messages": [llm.invoke(state["messages"])]}


builder.add_node("quick", quick_answer)
builder.add_conditional_edges(START, route, {"model": "model", "quick": "quick"})
builder.add_edge("quick", END)
```

Now "what is the capital of France" costs one call with no tools, and "what do my documents say about deadlines" goes through the full agent.

**That is Day 15's model routing, as graph structure.** The cost saving is the same; what changed is that the decision is now visible in the diagram instead of buried in a function.

Print the graph:

```python
print(graph.get_graph().draw_ascii())
```

**Keep that output.** Being able to draw your agent is worth more than it sounds when you are explaining it to someone, or to yourself in three weeks.

---

### Stage 6 — Open the box

The anti-magic stage. Do not skip it.

**See the actual prompt:**

```python
import langchain
langchain.debug = True
graph.invoke({"messages": [("user", "What time is it in Tokyo?")]})
```

Read what it sends. Compare it against the message list you built by hand on Day 4. **Note any extra text the framework added that you did not write** — framework prompt wrappers cost tokens on every single call, and you are paying for them.

**Watch it step by step:**

```python
for event in graph.stream({"messages": [("user", "Find deadlines and save a note.")]},
                          stream_mode="values"):
    last = event["messages"][-1]
    print(f"{type(last).__name__}: {str(last.content)[:100]}")
```

**Then run your Day 15 evals against it.** This is the real test:

```python
# in evals.py, swap the runner for the graph version
```

Compare: success rate, tokens per task, latency. **The framework version is often slightly more expensive** because of its prompt wrapping, and roughly the same on quality — because it is the same model doing the same work.

**So what did you actually buy?** Persistence, resumable interrupts, visible structure, streaming, and one loop instead of five. Those are real and worth having. What you did not buy is better answers, and anyone who implies otherwise is selling something.

**And set your step limit**, because the equivalent of `max_steps` is not on by default:

```python
graph.invoke(inputs, {"recursion_limit": 25, **config})
```

Without it, a looping graph runs to LangGraph's own default and can burn your quota — the Day 7 lesson, in a new costume.

---

## 7. Words I heard today

| Word | Plain meaning |
|---|---|
| **StateGraph** | The graph you define. |
| **Node** | A function taking state and returning changes. |
| **Edge** | A transition between nodes. |
| **Conditional edge** | A function choosing the next node. Your `if`. |
| **State** | The data passed along. Your message list, plus extras. |
| **Reducer** | How a node's return merges into state. `add_messages` appends. |
| **ToolNode** | Prebuilt node that runs tool calls. Your dispatch code. |
| **tools_condition** | Prebuilt edge checking for tool calls. |
| **Checkpointer** | Saves state so a run can be resumed. |
| **thread_id** | Which conversation a checkpoint belongs to. |
| **interrupt** | Pause before a node, for approval. |
| **Time travel** | Rewinding to an earlier checkpoint. |
| **recursion_limit** | The step cap. Your `max_steps`. |
| **Streaming** | Emitting events as the graph runs. |

---

## 8. Break it on purpose

**1. Remove the reducer.**
Change `messages: Annotated[list, add_messages]` to `messages: list`. Run a tool task.
*You will see:* it forgets everything each step, or breaks outright.
*It teaches:* what reducers are for, by removing one. This is the confusing bug people hit in week one with LangGraph.

**2. Mutate instead of returning.**
Have a node do `state["messages"].append(x)` and return `{}`.
*You will see:* it may appear to work, then behave oddly with a checkpointer.
*It teaches:* return changes, never mutate.

**3. Remove the recursion limit.**
Make a graph that loops, and give it an impossible task. Watch your quota.
*It teaches:* `max_steps` did not stop mattering because you changed library.

**4. Read the raw prompt.**
`langchain.debug = True`, then compare to your Day 4 messages.
*You will see:* extra wrapping you did not write.
*It teaches:* frameworks cost tokens. Know how many.

**5. Resume across a restart.**
SQLite checkpointer, start a task, kill the program, restart, resume with the same `thread_id`.
*You will see:* it continues.
*It teaches:* the clearest thing LangGraph gives you that your code did not.

**6. Run your evals on both.**
Day 15's eval set, hand-written agent versus graph.
*You will see:* similar quality, slightly higher cost.
*It teaches:* what frameworks buy, and what they do not.

---

## 9. Traps

**Trap 1 — reducer confusion**
*Symptom:* state disappears or duplicates.
*Fix:* `add_messages` for messages, `operator.add` for counters, nothing for last-write-wins.

**Trap 2 — mutating state**
*Symptom:* works in testing, breaks with checkpointing.
*Fix:* always return a dict of changes.

**Trap 3 — no recursion limit**
*Symptom:* runaway cost.
*Fix:* set it explicitly on every invoke.

**Trap 4 — forgetting thread_id**
*Symptom:* checkpointer configured, nothing persists.
*Fix:* `config={"configurable": {"thread_id": ...}}` on every call, and a different id per user.

**Trap 5 — MemorySaver in production**
*Symptom:* state lost on restart.
*Fix:* SQLite or Postgres checkpointer.

**Trap 6 — version churn**
*Symptom:* tutorials from four months ago do not run.
*Cause:* LangGraph and LangChain move quickly and rename things.
*Fix:* pin versions in `requirements.txt`, and prefer the official docs over blog posts. When something does not exist any more, check the current API rather than assuming you made a mistake.

---

## 10. Check yourself

1. Map four of your Day 7 code pieces to their LangGraph names.
2. What does a reducer do, and what breaks without `add_messages`?
3. What can a checkpointer do that your Day 9 code could not?
4. Why is `interrupt` better than `input("allow?")` for a deployed app?
5. What does LangGraph give you, and what does it not?

---

## 11. Where this goes

- **Day 17 (CrewAI)** is the same problem with a different shape: roles and tasks rather than nodes and edges. Comparing the two is the point of doing both.
- **Day 18** builds the research agent, and you choose which framework — or none — with evidence from your evals.
- **Day 19 (LangChain)** is the layer underneath. Some of it is useful, some is a thin wrapper you do not need.
- **Day 20** is where checkpointing stops being a nice feature. Persistence and resumable interrupts are what let an agent survive a deployment.

---

## 12. PROJECT STATE

```
PROJECT STATE after Day 16:

Folders:
  research-assistant/
    ai/
      graph_agent.py       (NEW - the agent as a LangGraph StateGraph)
      observability.py, evals.py, reliability.py, logs/
      chat.py, agent.py, autonomous.py, planner.py, memory.py
      multi_agent.py, retrieval.py, golden_set.py, security.py
      vector_store.py, embeddings.py, documents.py, tools.py
      mcp_agent.py, mcp_client.py, mcp_servers/my_tools.py
      prompts.py, classify.py, test_prompt.py
      runs/, notes/, documents/, chroma_db/
    dashboard/             (still empty)

Libraries: langgraph, langchain-openai (NEW)

Groq works unchanged:
  ChatOpenAI(model="llama-3.3-70b-versatile",
             base_url="https://api.groq.com/openai/v1", api_key=...)
  The Day 1 decision to use the OpenAI-compatible client is still paying off.

graph_agent.py:
  State = TypedDict with messages: Annotated[list, add_messages]
  nodes: "model" (calls llm_with_tools), "tools" (prebuilt ToolNode)
  edges: START->model, model->[tools|END] via tools_condition, tools->model
  tools wrapped with @tool from langchain_core, delegating to tools.py

THE TRANSLATION TABLE (what each framework concept replaces):
  messages list          -> the state
  while loop             -> the tools->model cycle
  if message.tool_calls  -> tools_condition (a conditional edge)
  tool dispatch code     -> ToolNode
  max_steps              -> recursion_limit (NOT on by default - set it)
  input("allow?")        -> interrupt_before=["tools"]
  save_history()         -> checkpointer
  compress_scratchpad()  -> a node

Reducers:
  a node RETURNS partial state, it never mutates in place
  add_messages appends and handles message ids
  without it, {"messages":[x]} OVERWRITES the whole history - the Day 1
  amnesia bug, reintroduced by a framework detail
  operator.add for counters, no reducer = last write wins

Persistence:
  MemorySaver for testing, SQLite checkpointer for anything real
  thread_id in config identifies the conversation; different id = different
  user. This is the Day 11 "user" metadata field as a first-class concept.
  get_state() and get_state_history() allow rewinding to an earlier
  checkpoint and running forward again - genuinely new, runs/*.json only
  recorded what happened

Interrupts:
  interrupt_before=["tools"] pauses; graph.invoke(None, config) resumes
  the process can exit in between, so approval can arrive later from a
  different request. Day 9's blocking input() could never do this.
  a conditional router sends only save_note through the approval node

Branching:
  a route() conditional edge from START sends simple questions to a "quick"
  node with no tools. This is Day 15 model routing, made visible in the
  graph instead of buried in a function.

Measured against Day 15 evals (hand-written vs graph):
  quality: about the same (same model, same work)
  cost: slightly HIGHER, due to framework prompt wrapping
  what was actually gained: persistence, resumable interrupts, visible
  structure, streaming, and ONE loop instead of five copies

Key decisions made:
  - only adopted a framework after building everything by hand
  - every concept mapped back to the equivalent hand-written code
  - langchain.debug = True used to read the ACTUAL prompt sent, and the
    framework's added wrapper text counted as a cost
  - recursion_limit set explicitly on every invoke

Known problems, left for later:
  - the five hand-written loops still exist and have not been consolidated
  - MemorySaver is in-memory; SQLite needed before deployment
  - the Day 14 multi-agent system has not been ported to a graph
  - framework prompt wrapping adds tokens to every call
  - LangGraph and LangChain change fast; versions must be pinned
```

---

## Answers

**1.** The `messages` list is the state; the `while` loop is the `tools -> model` cycle; `if message.tool_calls:` is `tools_condition`; the tool dispatch code is `ToolNode`; `max_steps` is `recursion_limit`; `input("allow?")` is `interrupt`.

**2.** A reducer decides how a node's returned changes merge into the existing state. `add_messages` appends new messages and handles ids. Without it, returning `{"messages": [x]}` replaces the whole history with a single message, so the agent forgets everything each step.

**3.** Save state and resume it later, including after the process has exited, and rewind to an earlier checkpoint to run forward again from there. Day 9's runs recorded what happened but could not continue or replay.

**4.** Because `input()` blocks the process. `interrupt` saves a checkpoint and returns, so the approval can arrive minutes later, over HTTP, from a different machine — which is what a web application actually needs.

**5.** It gives persistence, resumable interrupts, visible structure, streaming, and one implementation of the loop instead of several copies. It does not give better answers — same model, same tools, same work — and it costs slightly more per call because of its own prompt wrapping.
