# Day 7 — Build Your First AI Agent

**Module:** 02 — AI Agents
**Time:** about 1 hour
**Builds on:** Day 4 — tools; Day 6 — document search

---

## 1. Today in one line

You add a `while` loop around Day 4's code, and a chatbot becomes an agent.

---

## 2. The problem

Remember how Day 4 ended:

```
You: Save a note with today's date in it.
  [tool: get_current_time({})]
Assistant: It's Tuesday, 15 September 2026.
```

It got the date. Then it stopped. No note was saved.

Your code runs tools **once**, then asks for a final answer. The model never gets a second turn to say "good, now I need `save_note` with that date in it".

That ceiling is everywhere once you notice it:

- "Find what my notes say about the budget and save a summary" — needs search, then save.
- "What time is it in Tokyo and how many hours ahead is that?" — needs time, then calculate.
- "Look up the deadline, work out how many days are left" — needs search, then a date calculation.

Every one is two or three steps. Your assistant can do one.

The fix is a loop. Genuinely, that is it. Keep calling the model until it stops asking for tools. **About ten lines.**

And those ten lines change what the thing *is*. Up to now you have been building a very good assistant that answers questions. After today you have something that takes a goal and works at it. That is the line between a chatbot and an agent, and it is much thinner than the word "agent" suggests.

---

## 3. Mental model

**Day 4 was asking a colleague one question and getting one answer.**

**An agent is handing a colleague a goal and letting them work.**

They try something. They look at what came back. They decide what to do next. They try again. Eventually they come back and tell you what happened.

You are not directing each step. You set the goal and the boundaries; they choose the path.

**Where this comparison breaks, and both breaks are today's real content:**

**A person notices when they are going in circles.** After searching the same thing three times with no luck, a human stops and asks you for help. The model will happily search the same thing thirty times. It has no sense of "this is not working". You must supply that from outside, in code.

**A person knows when they have actually finished.** The model can decide it is done while having done nothing at all — it will announce "I have saved your note" without ever calling `save_note`. Fluent text about success is exactly as easy to produce as success.

So the agent is the loop, but **the engineering is the stopping**. Any beginner can write the loop. Knowing when to cut it off, and how to tell success from a confident claim of success, is the actual skill. It runs through Days 9, 10 and 15.

---

## 4. How it really works

Here is the whole thing in plain words:

```
add the user's goal to the message list

repeat:
    send the whole message list, with tools

    if the model asked for tools:
        run them
        add the request and the results to the message list
        go round again

    if the model answered in words:
        that's the answer, stop

    if we've gone round too many times:
        stop anyway
```

That is the agent. Everything in Days 9, 10, 14 and 16 is a variation on those nine lines.

**Three things worth understanding properly:**

**The message list is the agent's working memory.** There is no other state anywhere. Every time round the loop, the model re-reads the entire list: the goal, every tool it called, every result it got back. That is how it knows what it has already tried. This is why Day 2 mattered so much — the agent's ability to reason about its own progress is built entirely on the conversation history.

Some people call it the **scratchpad**. Same thing, better name.

**Each step is a full API call.** A five-step task means five calls, each carrying everything from all the previous steps. Look at the shape of it:

```
step 1:  sends 400 tokens
step 2:  sends 900
step 3:  sends 1,600
step 4:  sends 2,500
step 5:  sends 3,800
```

One task, about 9,000 tokens. Your free minute is 6,000. **Agents are expensive in a way chatbots are not**, and this is the mechanism. Day 15 is largely about this graph.

**You decide how much freedom it gets.** It is not on or off. `max_steps=3` is a short leash. `max_steps=20` with a file-writing tool is a long one. Which tools exist, how many steps are allowed, and whether a human approves anything — these are your dials, and choosing them badly is how agents cause damage.

---

## 5. Setup

Nothing to install.

```bash
cd research-assistant/ai
source venv/bin/activate

touch agent.py
rm -f conversation.json
```

We build the agent as a new file rather than editing `chat.py`, so you can compare the two side by side.

---

## 6. Build it

---

### Stage 1 — The loop

`agent.py`:

```python
import os, json, time
from dotenv import load_dotenv
from openai import OpenAI, RateLimitError
from tools import TOOL_SCHEMAS, AVAILABLE_TOOLS

load_dotenv()
client = OpenAI(api_key=os.environ["GROQ_API_KEY"],
                base_url="https://api.groq.com/openai/v1")

MODEL = "llama-3.3-70b-versatile"


def call_model(messages, tools=None, tries=4):
    for attempt in range(tries):
        try:
            return client.chat.completions.create(
                model=MODEL, messages=messages, tools=tools
            )
        except RateLimitError:
            wait = 2 ** attempt
            print(f"  [rate limited, waiting {wait}s]")
            time.sleep(wait)
    raise RuntimeError("Rate limited too many times.")


def run_agent(goal, max_steps=8):
    messages = [
        {"role": "system", "content": "You are a capable assistant. Use your tools to complete the user's request. Work step by step."},
        {"role": "user", "content": goal}
    ]

    for step in range(1, max_steps + 1):
        print(f"\n--- step {step} ---")

        response = call_model(messages, tools=TOOL_SCHEMAS)
        message = response.choices[0].message

        if not message.tool_calls:
            print("Model answered.")
            return message.content

        messages.append(message.model_dump(exclude_none=True))

        for call in message.tool_calls:
            name = call.function.name
            args = json.loads(call.function.arguments)
            print(f"  calling {name}({args})")

            try:
                result = AVAILABLE_TOOLS[name](**args)
            except Exception as error:
                result = f"Tool failed: {error}"

            print(f"  -> {str(result)[:120]}")
            messages.append({
                "role": "tool",
                "tool_call_id": call.id,
                "content": str(result)
            })

    return "I ran out of steps before finishing."


if __name__ == "__main__":
    print(run_agent("Save a note called 'today' that contains today's date and the time in Tokyo."))
```

Run it.

```
--- step 1 ---
  calling get_current_time({'timezone': 'Asia/Kolkata'})
  -> Tuesday, 15 September 2026, 06:12 PM

--- step 2 ---
  calling get_current_time({'timezone': 'Asia/Tokyo'})
  -> Tuesday, 15 September 2026, 09:42 PM

--- step 3 ---
  calling save_note({'title': 'today', 'content': 'Date: Tuesday...'})
  -> Saved to notes/today.txt

--- step 4 ---
Model answered.
I've saved a note called 'today' with the current date and the Tokyo time.
```

**Open `notes/today.txt`.** The file is really there.

That is your first agent. Look back at what changed from Day 4: the `if` became a `for`, and results feed back in. Nothing else.

**The key line is `messages.append(...)` inside the loop.** Each round, the list grows with what happened. On step 3 the model can see both times it fetched, so it can write them into the note. Remove those appends and it would forget every step immediately and loop forever.

---

### Stage 2 — Make it show its reasoning

Right now the model acts without saying why. When something goes wrong, you cannot tell what it was thinking.

Change the system prompt:

```python
AGENT_PROMPT = """You are a capable assistant that completes tasks using tools.

HOW TO WORK
- Work in small steps. One or two tools per step.
- Before using a tool, say in one short sentence what you are about to do and why.
- After getting a result, say in one short sentence what you learned.
- When the task is fully done, give a final answer with no tool calls.

RULES
- Never claim you have done something unless a tool actually returned success.
- If a tool fails twice in a row, stop and explain the problem instead of retrying.
- If the task is impossible with your tools, say so immediately."""
```

Also print the model's text when there are tool calls, since models often write a sentence alongside:

```python
        if message.content:
            print(f"  thinking: {message.content}")
```

Run it again. Now you get a trail:

```
--- step 1 ---
  thinking: I need today's date first.
  calling get_current_time({})
```

**Two lines in that prompt are doing heavy lifting.**

`"Never claim you have done something unless a tool actually returned success"` — this fights the failure from section 3. Without it, models regularly announce completed work they never did.

`"If a tool fails twice in a row, stop"` — a stopping condition written in words. You will also add one in code, because words alone are not reliable enough. Belt and braces, like Day 3.

This "say what you will do, do it, say what you learned" shape has a name: **ReAct**, short for Reasoning and Acting. It is the most common agent pattern in use, and you have now built it.

---

### Stage 3 — Watch the cost

Add token tracking, because agents are where cost stops being theoretical:

```python
def run_agent(goal, max_steps=8):
    ...
    total_tokens = 0

    for step in range(1, max_steps + 1):
        response = call_model(messages, tools=TOOL_SCHEMAS)
        total_tokens += response.usage.total_tokens
        print(f"--- step {step} --- (sent {response.usage.prompt_tokens}, "
              f"total so far {total_tokens})")
```

Run a task that takes four or five steps. Watch `prompt_tokens` climb each step.

**This is Day 2's problem, amplified.** Every step re-sends everything from every previous step. Cost does not grow with steps — it grows faster than that, because each step is both longer and one more.

On the free tier, a six-step task can consume your entire minute. That is not a bug; that is what agents cost. Every technique on Day 15 exists because of this number.

---

### Stage 4 — Give it something worth doing

Now combine Day 6 with today. This is where it stops feeling like a demo:

```python
    print(run_agent(
        "Search my documents for anything about deadlines. "
        "Then save a note called 'deadlines' summarising what you found, "
        "with the source filename for each item."
    ))
```

Watch the trail: it searches, reads what came back, possibly searches again with better words, then writes the note.

**Look carefully for a second search.** If the first one returns poor results, a good model reformulates and tries again. This is genuinely important: it means the agent can partly compensate for weak retrieval, which is one answer to yesterday's list of RAG failures. Repeated searching beats better searching more often than you would expect.

Try one that needs comparison, which failed yesterday:

```python
    run_agent("Compare what my documents say about the budget with what they say about the timeline. Are they consistent?")
```

One search could not do this. An agent searching twice can.

---

### Stage 5 — Find the failure modes

Break it deliberately. All three of these will happen to you in real use.

**Failure A — the loop that never ends.**

```python
    run_agent("Find the current share price of Reliance Industries.", max_steps=20)
```

You have no web tool. Watch what happens. Many models will search documents repeatedly, rephrase, search again, and keep going until your step limit cuts it off — burning your entire quota.

**Fix, in code, not in words:**

```python
def run_agent(goal, max_steps=8):
    ...
    recent_calls = []

    for step in range(1, max_steps + 1):
        ...
        for call in message.tool_calls:
            name = call.function.name
            args = json.loads(call.function.arguments)

            signature = f"{name}:{json.dumps(args, sort_keys=True)}"
            if recent_calls.count(signature) >= 2:
                result = ("You have already called this exact tool with these exact "
                          "arguments twice and it did not help. Try something different, "
                          "or tell the user you cannot complete this task.")
                messages.append({"role": "tool", "tool_call_id": call.id, "content": result})
                continue
            recent_calls.append(signature)
            ...
```

**Read what that does.** It does not crash or stop. It sends a *message back to the model* telling it to change approach. You are steering it with feedback rather than killing it, which usually leads to a graceful "I can't do this" instead of a hard failure.

**Failure B — claiming success without doing the work.**

Break `save_note` so it returns `"Error: disk full"`. Run a save task.

A well-prompted agent reports the failure. A poorly-prompted one says "Saved!" anyway. Try it with and without the `"Never claim..."` rule to see the difference.

**The real lesson:** never trust the agent's summary of what it did. Trust the tool results. Day 15 builds checks that verify outcomes instead of believing reports.

**Failure C — running out of steps.**

Set `max_steps=2` on a task needing four. It stops mid-way, having done half the work — a note created but empty, or a search done but nothing saved.

**Partial completion is the dangerous state.** Not failure, not success. Half-done with no clean rollback. Worth knowing about before you give an agent a tool that sends email.

---

### Stage 6 — Ask before doing damage (optional, 10 minutes)

Your agent can write files on its own. Later it will send messages and call APIs. Add a pause:

```python
NEEDS_APPROVAL = {"save_note"}

            if name in NEEDS_APPROVAL:
                print(f"\n  AGENT WANTS TO: {name}({args})")
                if input("  allow? (y/n): ").lower() != "y":
                    result = "The user refused permission for this action."
                    messages.append({"role": "tool", "tool_call_id": call.id, "content": result})
                    continue
```

Notice the refusal also goes back as a tool result. The agent learns it was blocked and can respond sensibly, rather than being left confused.

This is called **human in the loop**, and it is the main dial between "useful" and "safe". Day 9 is about turning it down on purpose, and what you need in place first.

---

## 7. Words I heard today

| Word | Plain meaning |
|---|---|
| **Agent** | A model in a loop with tools, working towards a goal. |
| **Step / iteration** | One trip round the loop: one model call plus any tools. |
| **Scratchpad** | The growing message list. The agent's working memory. |
| **Trajectory** | The full path an agent took — every step and result. |
| **ReAct** | Reason, then act, then observe, then repeat. Today's pattern. |
| **Stopping condition** | Any rule that ends the loop. |
| **max_steps** | The hard limit. Your seatbelt. |
| **Loop detection** | Noticing the same action repeated with no progress. |
| **Human in the loop** | A person approving actions before they run. |
| **Autonomy** | How much it does without asking. A dial, not a switch. |
| **Partial completion** | Stopped halfway. Neither done nor undone. |
| **Tool chaining** | Using one tool's output as another tool's input. |

---

## 8. Break it on purpose

**1. Remove the step limit.**
`while True` instead of `for step in range(...)`. Give it an impossible task. **Watch your quota.**
*You will see:* it runs until the rate limiter stops it.
*It teaches:* `max_steps` is not a nicety. It is the difference between a bug and a bill.

**2. Empty the scratchpad.**
Stop appending tool results — keep only the goal each round.
*You will see:* it calls the same first tool forever, because from its point of view nothing has happened yet.
*It teaches:* the message list *is* the agent. No history, no agent.

**3. A tool that always fails.**
Make `calculate` return `"Error: service unavailable"`. Ask a maths question.
*You will see:* with the "fails twice" rule, it gives up sensibly. Without it, it retries until the steps run out.
*It teaches:* prompt-level stopping conditions genuinely work, and are genuinely not sufficient.

**4. Two tools that both fit.**
Ask something either `search_documents` or the model's own knowledge could answer.
*You will see:* inconsistent choices between runs.
*It teaches:* tool selection is probabilistic. If you need determinism, decide in code, not in the prompt.

**5. Watch it recover from bad retrieval.**
Ask about something in your documents using very odd wording.
*You will see, sometimes:* a poor first search, then a reformulated second search that works.
*It teaches:* the loop compensates for weak retrieval. This is one real answer to yesterday's failures.

**6. Measure the cost of autonomy.**
Run the same request through `chat.py` and through `run_agent`. Compare total tokens.
*You will see:* the agent costs several times more.
*It teaches:* do not make everything an agent. Many jobs are one call. Day 15 covers choosing.

---

## 9. Traps

**Trap 1 — no step limit**
*Symptom:* quota gone, or a program that never returns.
*Fix:* `max_steps`, always, from the first version. Never "just for testing".

**Trap 2 — forgetting to append the assistant message**
*Symptom:* an API error about tool messages without a matching assistant message, or an agent that repeats step 1 forever.
*Cause:* Day 4's trap 3, now inside a loop where it is much more confusing.
*Fix:* `messages.append(message.model_dump(exclude_none=True))` before running the tools.

**Trap 3 — trimming that cuts a tool pair**
*Symptom:* works for short tasks, fails on long ones with an orphaned-tool-call error.
*Cause:* Day 2's `trim_history` slicing between a request and its result. Agents produce many such pairs, so it finally bites.
*Fix:* for now, do not trim inside the agent loop. Proper fix on Day 11.

**Trap 4 — believing the final answer**
*Symptom:* "I've saved your note" and no file.
*Fix:* check the tool results, not the summary. If it matters, verify in code.

**Trap 5 — dangerous tools with no brakes**
*Symptom:* fine in testing, then an agent deletes something.
*Cause:* a tool with side effects, no approval, a high step limit.
*Fix:* Stage 6. Separate read-only tools from tools that change things, and treat them differently.

**Trap 6 — the cost surprise**
*Symptom:* constant rate limiting once you start using the agent properly.
*Cause:* every step re-sends everything.
*Fix:* fewer steps, fewer tools, shorter tool results. Day 15.

---

## 10. Check yourself

1. What exactly is the difference between Day 4's code and an agent?
2. Where does the agent keep track of what it has already done?
3. Why does `prompt_tokens` grow faster than the number of steps?
4. Name two stopping conditions your agent has, and say which one you trust more.
5. The agent says "I've saved your note." What must you check before believing it?

---

## 11. Where this goes

- **Day 8 (MCP)** answers a question today should have raised: your tools only exist inside this one Python file. MCP makes them a standard plug that any app can use.
- **Day 9** turns the autonomy dial up. Longer tasks, no approval, which means everything in Stage 5 becomes essential rather than interesting.
- **Day 10** adds planning: writing the whole plan first, then working through it, instead of deciding one step at a time.
- **Day 11** fixes the scratchpad. Long tasks overflow the context window, and choosing what to keep is the job.
- **Day 14** makes one of the tools *another agent*. That is genuinely all multi-agent is.
- **Day 16 (LangGraph)** is today's loop drawn as an explicit map of states. You will recognise every piece — which is exactly why frameworks come after this and not before.

---

## 12. PROJECT STATE

```
PROJECT STATE after Day 7:

Folders:
  research-assistant/
    ai/
      venv/, .env, .gitignore, requirements.txt
      chat.py            (Day 4 single-round-of-tools version, kept)
      agent.py           (NEW - the agent loop)
      prompts.py, classify.py, test_prompt.py
      tools.py           (unchanged today: time, calculate, save_note,
                          search_documents via Chroma)
      documents.py, embeddings.py, vector_store.py, chroma_db/
      conversation.json, notes/, documents/
    dashboard/           (still empty)

Libraries: no new installs today

agent.py contains:
  MODEL constant
  call_model(messages, tools, tries)  - exponential backoff, same as Day 1
  run_agent(goal, max_steps=8):
    - builds messages = [AGENT_PROMPT, user goal]
    - for step in range(1, max_steps+1):
        call model with TOOL_SCHEMAS
        if no tool_calls -> return the text answer
        append message.model_dump(exclude_none=True)
        run every requested tool, append role="tool" with tool_call_id
    - returns "ran out of steps" if the limit is reached
  prints the step number, the model's reasoning sentence, each tool call
    and a truncated result
  tracks total_tokens across all steps and prints it

AGENT_PROMPT (in agent.py):
  ReAct shape - say what you will do, do it, say what you learned
  "Never claim you have done something unless a tool returned success"
  "If a tool fails twice in a row, stop and explain"
  "If the task is impossible with your tools, say so immediately"

Loop protection added:
  recent_calls list holds "toolname:sorted-json-args" signatures
  the same signature 3 times returns a message to the MODEL telling it to
  change approach, rather than crashing or silently stopping

Optional human-in-the-loop:
  NEEDS_APPROVAL = {"save_note"}; prompts y/n before running;
  a refusal is sent back as a tool result so the agent can react

Key decisions made:
  - agent.py is a separate file from chat.py so the two can be compared
  - max_steps is mandatory and was never omitted, even in the first version
  - stopping is handled in BOTH the prompt and in code, deliberately
  - loop detection steers the model with feedback instead of killing the run
  - no trimming inside the agent loop (it splits tool_calls/tool pairs)

Verified working:
  - "save a note with today's date and the time in Tokyo" now completes.
    Day 4 could not do this. Real file appears in notes/.
  - multi-step document tasks work: search -> summarise -> save
  - the agent sometimes reformulates a failed search on its own, which
    partly compensates for Day 6's retrieval limits

Known problems, left for later:
  - tokens grow steeply per step; a 6-step task can use the whole free minute
  - no trimming or summarising of the scratchpad yet (Day 11)
  - the agent decides one step at a time, with no overall plan (Day 10)
  - partial completion is possible when max_steps is hit; no rollback
  - tools live only inside this Python project, hand-written schemas (Day 8)
  - no verification that claimed actions really happened (Day 15)
```

---

## Answers

**1.** A loop. Day 4 runs tools once and then asks for a final answer. The agent keeps going — calling the model, running tools, feeding results back — until the model replies without asking for a tool, or the step limit is reached.

**2.** In the message list. Every request and every result is appended, and the whole list is re-sent each step, so the model re-reads its own history to know what it has already tried. There is no other memory.

**3.** Because every step re-sends everything from all previous steps. Step 5 carries steps 1 to 4 inside it. So the cost per step rises as well as the number of steps, and the total climbs steeply rather than linearly.

**4.** The prompt rule ("stop if a tool fails twice") and the code limits (`max_steps` and loop detection). Trust the code. The prompt is steering and can be ignored; `max_steps` cannot.

**5.** The tool results in the trajectory — did `save_note` actually return a success message? And ideally the file itself. Producing a fluent sentence about having saved something is exactly as easy for the model as saving something.
