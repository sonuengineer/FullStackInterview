# Day 4 -- AI Tools: Teach Your AI Assistant to Use Tools

**Module:** 01 -- Build the Foundation
**Time:** about 1 hour (this is the biggest day so far)
**Builds on:** Day 3 -- `prompts.py`, JSON output, `chat.py` with memory

---

## 1. Today in one line

Your assistant stops being a talker and becomes a doer: it can run your Python functions, and that single change is what makes everything from Day 7 onwards possible.

---

## 2. The problem

Ask your assistant three questions right now:

```
You: What is today's date?
You: What is 8472 multiplied by 391?
You: Save this to a file called notes.txt
```

Watch what happens. For the date, it either refuses or gives you a date from its training period as if it were today. For the multiplication, it produces a confident number that is very often wrong. For the file, it either refuses or -- worse -- says "Done! I've saved that for you." No file exists.

**It is not lying.** It has no clock, no calculator and no hands. It is guessing what the answer would look like, because guessing what text comes next is the only thing it does. The answer to `8472 * 391` *looks* like a seven-digit number, so it produces a seven-digit number.

Here is the frustrating part. You could write `get_date()` in one line. You have Python right there. The model cannot reach it, and you cannot tell in advance which questions need it.

Today you build the bridge. And I want to be clear about the size of this: **Days 7 through 21 are all variations on what you learn in the next hour.** An agent is this, in a loop. MCP is this, standardised. Multi-agent is this, where one of the tools is another agent. If one day deserves your full attention, it is this one.

---

## 3. Mental model

**Think of a brilliant consultant locked in a room with no phone, no internet and no window.**

Enormously well read. Excellent reasoning. Cannot check a single fact, cannot look outside, cannot do anything in the world.

Now you slide a menu under the door:

> Available requests: (1) current time, (2) calculate a sum, (3) save a note.
> To use one, write it on a form and slide it back.

The consultant does not leave the room. They fill in the form. **You** pick it up, do the actual work, and slide the result back. Then they write their answer using it.

Two things follow, and both are mistakes people make on this exact day:

**The model never runs your code.** It asks. Your program does the running. The model is behind the door the entire time.

**Every tool use needs at least two conversations with the model.** Once to receive the request. Once more, after you have the result, to get the actual answer. Two API calls for one question.

**Where this comparison breaks:** a real consultant knows what is on the menu and knows what is not. The model will sometimes ignore an obvious tool, sometimes use the wrong one, and sometimes invent a value for a field you did not fill in. Choosing correctly is driven by your tool **descriptions** -- which are prompts, which means everything from Day 3 applies here.

---

## 4. How it really works

Follow one question all the way through. This is the most important section of the week.

**You ask:** "What time is it in Tokyo?"

**Step 1 -- you send messages plus a menu.**

Same call as always, one new parameter:

```
messages = [system, user: "What time is it in Tokyo?"]
tools    = [ description of get_current_time, description of calculate ]
```

The `tools` list is written in JSON Schema -- a standard way to describe a function's name, purpose and inputs.

**Step 2 -- the model replies with a request, not an answer.**

```
finish_reason = "tool_calls"          <- not "stop"
message.content = None                <- no text at all
message.tool_calls = [
    id: "call_abc123",
    function.name: "get_current_time",
    function.arguments: '{"timezone": "Asia/Tokyo"}'
]
```

Three things worth staring at:

- `finish_reason` is `tool_calls`, not `stop`. That is your signal.
- `content` is empty. There is no answer yet, only a request.
- `arguments` is a **string containing JSON**, not a dictionary. You must run `json.loads` on it. This trips up nearly everyone.

Notice the model turned "Tokyo" into `"Asia/Tokyo"` on its own. Nobody told it the timezone format. That kind of translation is what makes this feel like magic, and it is also where it silently gets things wrong.

**Step 3 -- your code runs the function.**

```
result = get_current_time(timezone="Asia/Tokyo")
# "Tuesday, 15 September 2026, 09:42 PM"
```

Plain Python. No AI involved. It is just a function call.

**Step 4 -- you send everything back.**

Now the history must contain **two** new messages:

```
messages = [
    system,
    user: "What time is it in Tokyo?",
    assistant: (the message with tool_calls in it),        <- must be included
    tool: { tool_call_id: "call_abc123", content: "Tuesday, 15 September..." }
]
```

The assistant message must be added even though it has no text. The API requires every `tool` message to follow the assistant message that requested it, matched by `tool_call_id`. Leave it out and you get a hard error.

**Step 5 -- second call, and now you get words.**

```
finish_reason = "stop"
content = "It's currently 9:42 PM on Tuesday in Tokyo."
```

**The shape to remember:**

```
send + tools  ->  model asks for a tool
                  YOUR code runs it
send results  ->  model answers
```

Read that three times. On Day 7 you put a `while` loop around it, and it becomes an agent. That is genuinely the whole difference.

---

## 5. Setup

No new installs. Everything today uses Python's own libraries.

```bash
cd research-assistant/ai
source venv/bin/activate

touch tools.py
mkdir -p notes
```

---

## 6. Build it

---

### Stage 1 -- Write the functions first, with no AI at all

Put this in `tools.py`. It is ordinary Python. Test it by itself before the model ever sees it.

```python
import ast
import json
import operator
import os
from datetime import datetime
from zoneinfo import ZoneInfo


def get_current_time(timezone="Asia/Kolkata"):
    """Return the current date and time in a given timezone."""
    try:
        now = datetime.now(ZoneInfo(timezone))
    except Exception:
        return f"I do not recognise the timezone '{timezone}'."
    return now.strftime("%A, %d %B %Y, %I:%M %p")


SAFE_OPS = {
    ast.Add: operator.add, ast.Sub: operator.sub,
    ast.Mult: operator.mul, ast.Div: operator.truediv,
    ast.Pow: operator.pow, ast.USub: operator.neg,
}


def _evaluate(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return node.value
    if isinstance(node, ast.BinOp) and type(node.op) in SAFE_OPS:
        return SAFE_OPS[type(node.op)](_evaluate(node.left), _evaluate(node.right))
    if isinstance(node, ast.UnaryOp) and type(node.op) in SAFE_OPS:
        return SAFE_OPS[type(node.op)](_evaluate(node.operand))
    raise ValueError("That expression is not allowed.")


def calculate(expression):
    """Work out a maths expression, safely."""
    try:
        return str(_evaluate(ast.parse(expression, mode="eval").body))
    except Exception:
        return f"I could not calculate '{expression}'."


def save_note(title, content):
    """Save a note to the notes folder."""
    safe_title = "".join(c for c in title if c.isalnum() or c in " -_").strip()
    if not safe_title:
        return "That title cannot be used as a filename."

    path = os.path.join("notes", f"{safe_title}.txt")
    with open(path, "w") as f:
        f.write(content)
    return f"Saved to {path}"


if __name__ == "__main__":
    print(get_current_time("Asia/Tokyo"))
    print(calculate("8472 * 391"))
    print(save_note("test note", "hello"))
```

Run it: `python tools.py`. Three lines of output, and a real file in `notes/`.

**Two things to notice, because they matter more than they look:**

**Why not just use `eval()`?** Because `eval` runs *any* Python. The model decides what goes into `expression`. If someone types a question that makes the model produce `__import__('os').system('rm -rf ~')`, `eval` would happily run it. The `_evaluate` function above allows numbers and six arithmetic operations, and nothing else.

**Why `save_note` cleans the title:** without that line, a title like `../../.env` writes outside your folder. The model generates that title from whatever the user typed.

Both of these are the same lesson, and it is the one people skip:

> Tool arguments are untrusted input. The model wrote them, and the model can be talked into writing anything.

Day 13 is largely about this. Today you just build the habit.

**Also notice:** every function returns a **string**, and returns a polite message instead of crashing. The result goes straight back to the model, which reads it as text. An exception here would kill your program; a returned error message lets the model say "that timezone didn't work, could you check the spelling?"

---

### Stage 2 -- Describe the tools for the model

The model cannot see your code. It only sees descriptions. Add to `tools.py`:

```python
TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "get_current_time",
            "description": "Get the current date and time in a specific timezone. Use this whenever the user asks about the current time, today's date, or what day it is.",
            "parameters": {
                "type": "object",
                "properties": {
                    "timezone": {
                        "type": "string",
                        "description": "An IANA timezone name, for example 'Asia/Kolkata', 'Asia/Tokyo' or 'Europe/London'. Defaults to Asia/Kolkata if the user does not say."
                    }
                },
                "required": []
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "calculate",
            "description": "Do exact arithmetic. Use this for ANY calculation, even easy ones, because you cannot do arithmetic reliably yourself.",
            "parameters": {
                "type": "object",
                "properties": {
                    "expression": {
                        "type": "string",
                        "description": "A maths expression using only numbers and the operators + - * / ** and brackets. For example '8472 * 391'."
                    }
                },
                "required": ["expression"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "save_note",
            "description": "Save a note to a file for the user to read later. Use this when the user asks to save, remember or write something down.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "A short filename-friendly title, no file extension."},
                    "content": {"type": "string", "description": "The full text to save."}
                },
                "required": ["title", "content"]
            }
        }
    }
]

AVAILABLE_TOOLS = {
    "get_current_time": get_current_time,
    "calculate": calculate,
    "save_note": save_note,
}
```

**This is Day 3 all over again.** Every description is a prompt. Look at what the good ones do:

- `"Use this whenever the user asks..."` -- tells it *when*, not just what. The most common weakness in tool descriptions is describing the function and forgetting to say when to reach for it.
- `"even easy ones, because you cannot do arithmetic reliably yourself"` -- tells it about its own weakness. Without this line, models confidently do arithmetic themselves and get it wrong.
- The `timezone` description gives an actual format and examples. Without that, you get `"Tokyo"` or `"JST"` and your function fails.

`AVAILABLE_TOOLS` is a plain dictionary mapping names to real functions. When the model asks for `"calculate"`, this is how your code finds the function to run. It is sometimes called a **registry** or **dispatcher**, and it is just a dict.

---

### Stage 3 -- Look at the request before running anything

Do not wire it up yet. First, see what the model actually sends back.

Make `tool_test.py`:

```python
import os, json
from dotenv import load_dotenv
from openai import OpenAI
from tools import TOOL_SCHEMAS

load_dotenv()
client = OpenAI(api_key=os.environ["GROQ_API_KEY"],
                base_url="https://api.groq.com/openai/v1")

response = client.chat.completions.create(
    model="llama-3.3-70b-versatile",
    messages=[{"role": "user", "content": "What time is it in Tokyo right now?"}],
    tools=TOOL_SCHEMAS
)

message = response.choices[0].message

print("finish_reason:", response.choices[0].finish_reason)
print("content:", message.content)
print("tool_calls:", message.tool_calls)
```

Run it. You should see roughly:

```
finish_reason: tool_calls
content: None
tool_calls: [ChatCompletionMessageToolCall(
    id='call_a1b2c3',
    function=Function(arguments='{"timezone": "Asia/Tokyo"}', name='get_current_time'),
    type='function')]
```

Nothing has run. The model asked, and is waiting.

Now change the question to `"Who wrote Hamlet?"` and run again. `finish_reason` is `stop`, `tool_calls` is `None`, and you get a normal answer. **The model decides whether a tool is needed.** You do not have to detect it.

Try `"What is 8472 * 391?"` and confirm it reaches for `calculate` rather than guessing.

---

### Stage 4 -- Complete the loop

Now run the function and send the result back. Add to `tool_test.py`:

```python
from tools import AVAILABLE_TOOLS

messages = [{"role": "user", "content": "What time is it in Tokyo right now?"}]

response = client.chat.completions.create(
    model="llama-3.3-70b-versatile",
    messages=messages,
    tools=TOOL_SCHEMAS
)
message = response.choices[0].message

if message.tool_calls:
    # 1. add the assistant's request to the history
    messages.append(message.model_dump(exclude_none=True))

    # 2. run each requested tool
    for call in message.tool_calls:
        name = call.function.name
        arguments = json.loads(call.function.arguments)

        print(f"[running {name} with {arguments}]")
        result = AVAILABLE_TOOLS[name](**arguments)

        # 3. add the result, tied to the request by id
        messages.append({
            "role": "tool",
            "tool_call_id": call.id,
            "content": str(result)
        })

    # 4. ask again, now that it can see the result
    second = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=messages,
        tools=TOOL_SCHEMAS
    )
    print(second.choices[0].message.content)
else:
    print(message.content)
```

**The four lines that matter:**

- `message.model_dump(exclude_none=True)` -- turns the response object into a plain dictionary. **Do not skip this.** Your Day 2 code saves history with `json.dump`, and the raw object cannot be saved to JSON. This one line prevents a confusing crash later.
- `json.loads(call.function.arguments)` -- arguments arrive as a JSON **string**. Without this, `**arguments` fails.
- `AVAILABLE_TOOLS[name](**arguments)` -- look up the function, unpack the dictionary into keyword arguments. `{"timezone": "Asia/Tokyo"}` becomes `timezone="Asia/Tokyo"`.
- `"tool_call_id": call.id` -- links your result to the exact request. With several tools in one turn, this is how the model knows which result is which.

Run it. Something like:

```
[running get_current_time with {'timezone': 'Asia/Tokyo'}]
It's currently 9:42 PM on Tuesday, 15 September 2026 in Tokyo.
```

**Your AI just did something real.** Pause on that for a moment -- it is a bigger step than it looks.

---

### Stage 5 -- Put it into the real assistant

Now move it into `chat.py`, where memory lives.

First, teach `ask_model` about tools. Change its signature:

```python
def ask_model(messages, tools=None, max_tries=4):
    for attempt in range(max_tries):
        try:
            return client.chat.completions.create(
                model="llama-3.3-70b-versatile",
                messages=messages,
                tools=tools
            )
        except RateLimitError:
            wait_seconds = 2 ** attempt
            print(f"[Rate limited. Waiting {wait_seconds}s...]")
            time.sleep(wait_seconds)
    raise RuntimeError("Still rate limited after several tries.")
```

Then add a handler:

```python
from tools import TOOL_SCHEMAS, AVAILABLE_TOOLS

def run_tool_calls(message, messages):
    """Run every tool the model asked for and add the results to messages."""
    messages.append(message.model_dump(exclude_none=True))

    for call in message.tool_calls:
        name = call.function.name

        try:
            arguments = json.loads(call.function.arguments)
        except json.JSONDecodeError:
            result = "Your arguments were not valid JSON. Please try again."
            messages.append({"role": "tool", "tool_call_id": call.id, "content": result})
            continue

        print(f"  [tool: {name}({arguments})]")

        if name not in AVAILABLE_TOOLS:
            result = f"There is no tool called {name}."
        else:
            try:
                result = AVAILABLE_TOOLS[name](**arguments)
            except Exception as error:
                result = f"That tool failed: {error}"

        messages.append({"role": "tool", "tool_call_id": call.id, "content": str(result)})
```

And change the main loop:

```python
    messages.append({"role": "user", "content": question})

    response = ask_model(trim_history(messages), tools=TOOL_SCHEMAS)
    message = response.choices[0].message

    if message.tool_calls:
        run_tool_calls(message, messages)
        response = ask_model(trim_history(messages), tools=TOOL_SCHEMAS)
        message = response.choices[0].message

    answer = message.content
    messages.append({"role": "assistant", "content": answer})
    save_history(messages)
    print(f"\nAssistant: {answer}\n")
```

**Notice the error handling.** Every failure turns into a string that goes back to the model rather than crashing your program. The model can then recover -- "that timezone wasn't recognised, did you mean Asia/Tokyo?" A crash gives the user nothing.

**One line here has a bug waiting in it.** `trim_history` can cut the list between an assistant message with `tool_calls` and its matching `tool` message. The API rejects that with an error about an orphaned tool call. It will not happen in your first few tests, and it will happen eventually. Fix: raise `MAX_HISTORY` to 20 for now, and note it for Day 11, where history gets handled properly.

Now talk to it:

```
You: What time is it in Tokyo, and what is 8472 * 391?
  [tool: calculate({'expression': '8472 * 391'})]
  [tool: get_current_time({'timezone': 'Asia/Tokyo'})]
Assistant: It's 9:47 PM on Tuesday in Tokyo, and 8472 x 391 = 3,312,552.
```

Two tools, one turn. The `for` loop over `message.tool_calls` already handled that -- you did not write anything special for it.

---

### Stage 6 -- The thing that is still missing

Try this:

```
You: Save a note with today's date in it.
```

Watch carefully. It will usually call `get_current_time`, then stop, and tell you the time -- without ever calling `save_note`.

**Why?** Your code runs tools exactly once, then asks for a final answer. It never gives the model a chance to say "good, now I need a second tool, using that result".

That is the ceiling of Day 4. One round of tools, then done.

Removing that ceiling takes one `while` loop, and it is called an agent. **That is Day 7.** You are three days away and the gap is genuinely about ten lines.

---

## 7. Words I heard today

| Word | Plain meaning |
|---|---|
| **Tool / function calling** | Letting the model ask your code to run a function. |
| **Tool schema** | The JSON description of a function: name, purpose, inputs. |
| **JSON Schema** | The standard format those descriptions are written in. |
| **tool_calls** | The list of requests the model made. |
| **tool_call_id** | The label linking a result back to its request. |
| **`role: "tool"`** | A message carrying a tool result back to the model. |
| **finish_reason** | Why the model stopped. `stop` = answered. `tool_calls` = asked for a tool. |
| **Registry / dispatcher** | The dict mapping tool names to real functions. |
| **Parallel tool calls** | Several tools requested in one turn. |
| **Side effect** | A tool that changes something -- writes a file, sends an email. Needs more care. |
| **Hallucinated arguments** | The model inventing a value for something the user never said. |
| **tool_choice** | A setting to force, forbid or free the use of tools. |

---

## 8. Break it on purpose

**1. Ruin a description.**
Change `calculate`'s description to just `"A calculator."`. Ask three maths questions.
*You will see:* it sometimes ignores the tool and answers from its head, wrongly.
*It teaches:* tool selection is prompt engineering. The "you cannot do arithmetic reliably yourself" line was doing real work.

**2. Watch it invent an argument.**
Ask `"Save a note about my meeting."` without saying what should be in it.
*You will see:* it fills `content` with something plausible that you never said.
*It teaches:* required fields get filled whether or not the information exists. Never trust an argument you did not verify.

**3. Break the function on purpose.**
Make `get_current_time` raise an exception on its first line. Ask for the time.
*You will see:* your error handler catches it, sends the message back, and the model explains the problem to the user.
*It teaches:* tool errors are conversation, not crashes. This is what makes Day 9's autonomy survivable.

**4. Forbid tools.**
Add `tool_choice="none"` to your call. Ask for the time.
*You will see:* it answers from its own head, confidently and wrongly.
*It teaches:* this is exactly the Day 1 assistant. Useful for seeing how much tools changed.

**5. Force a tool.**
Set `tool_choice={"type": "function", "function": {"name": "calculate"}}` and ask `"Who wrote Hamlet?"`.
*You will see:* it calls the calculator anyway, with something nonsensical.
*It teaches:* forcing removes judgement. Sometimes exactly what you want, usually not.

**6. Remove the assistant message.**
Delete the `messages.append(message.model_dump(...))` line. Run anything that uses a tool.
*You will see:* a hard API error about a tool message without a matching assistant message.
*It teaches:* the message order is a strict protocol, not a suggestion.

---

## 9. Traps

**Trap 1 -- thinking the model runs your code**
*Symptom:* confusion about why nothing happened.
*Reality:* the model only ever produces text describing a request. If your code does not run the function, nothing runs.

**Trap 2 -- arguments are a string, not a dict**
*Symptom:* `TypeError: argument after ** must be a mapping, not str`.
*Fix:* `json.loads(call.function.arguments)`. Everyone hits this once.

**Trap 3 -- appending the raw object to history**
*Symptom:* `TypeError: Object of type ChatCompletionMessage is not JSON serializable` when `save_history` runs. Confusing, because it happens in Day 2 code you have not touched.
*Fix:* `message.model_dump(exclude_none=True)`.

**Trap 4 -- trimming that splits a tool pair**
*Symptom:* an API error about an assistant message with `tool_calls` not being followed by tool responses. Appears randomly in long chats.
*Cause:* `trim_history` cut between the request and its result.
*Fix:* keep more history for now; handle it properly on Day 11.

**Trap 5 -- trusting the arguments**
*Symptom:* nothing, for a long time. Then a file written where it should not be, or a query doing something unexpected.
*Cause:* a tool argument used directly without checking.
*Fix:* validate inside the function, always. `save_note` cleaning the title is not decoration.

**Trap 6 -- tool name not in the registry**
*Symptom:* `KeyError` and a dead program.
*Cause:* you added a schema but forgot the `AVAILABLE_TOOLS` entry. The model can request a name you never wired up.
*Fix:* the `if name not in AVAILABLE_TOOLS` check above.

---

## 10. Check yourself

1. Who runs the function -- the model or your code? What does the model actually produce?
2. Why does one tool question need at least two API calls?
3. What is `tool_call_id` for, and when would things break without it?
4. Your arithmetic tool is described as "A calculator." What goes wrong, and why is that a Day 3 problem?
5. Ask it to save a note containing today's date and it fails. Why, and what single change fixes it?

---

## 11. Where this goes

- **Day 5** adds a tool that reads files. Same machinery, new function.
- **Day 6** adds a tool that searches across many documents.
- **Day 7 is today, in a `while` loop.** Keep going until the model stops asking for tools. That is the whole definition of an agent.
- **Day 8 (MCP)** answers: why should everyone rewrite `TOOL_SCHEMAS` by hand? MCP is a standard shape so tools can be shared between apps.
- **Day 9** lets the loop run many steps without you approving each one, which is why today's error handling matters.
- **Day 13** takes trap 5 seriously: tool arguments as an attack surface.
- **Day 14** makes one of the tools *another agent*. That is all multi-agent really is.

---

## 12. PROJECT STATE

```
PROJECT STATE after Day 4:

Folders:
  research-assistant/
    ai/
      venv/, .env, .gitignore, requirements.txt
      hello.py, chat_day1_backup.py
      chat.py          (memory + prompts + TOOLS)
      prompts.py       (Day 3)
      classify.py      (Day 3)
      test_prompt.py   (Day 3)
      tools.py         (NEW)
      tool_test.py     (NEW - standalone tool experiment)
      conversation.json
      notes/           (NEW - files written by save_note)
    dashboard/         (still empty)

Libraries: openai, python-dotenv (no new installs; uses ast, json,
           operator, datetime, zoneinfo from the standard library)

tools.py contains:
  get_current_time(timezone)  - uses zoneinfo, returns a friendly string
  calculate(expression)       - SAFE evaluator built on ast, NOT eval().
                                Allows numbers and + - * / ** and unary minus
  save_note(title, content)   - writes to notes/, strips unsafe characters
  TOOL_SCHEMAS                - JSON Schema list for all three
  AVAILABLE_TOOLS             - dict of name -> function

chat.py now:
  - ask_model(messages, tools=None) passes tools through
  - run_tool_calls(message, messages) appends message.model_dump(exclude_none=True),
    json.loads the arguments, runs the function, appends role="tool" with
    tool_call_id
  - every tool failure returns a string to the model instead of crashing
  - unknown tool names handled, bad JSON arguments handled
  - after tools run, a SECOND ask_model call produces the final answer
  - MAX_HISTORY raised to 20 to avoid trimming between a tool_calls message
    and its tool results

Key decisions made:
  - never eval(); arithmetic goes through an ast allowlist
  - all tool arguments treated as untrusted input
  - tool errors become conversation, not exceptions
  - tool descriptions say WHEN to use the tool, not just what it does
  - calculate's description explicitly tells the model it is bad at arithmetic

Known problems, left on purpose for later:
  - only ONE round of tool calls per turn. "Save a note with today's date"
    fails because it cannot chain time -> save. This is exactly what the
    Day 7 while-loop fixes.
  - trim_history can still split a tool_calls / tool pair (Day 11)
  - tool schemas are hand-written and live only in this project (Day 8, MCP)
  - no limit on how many tools can run, no confirmation before side effects
    (Day 9, Day 15)
```

---

## Answers

**1.** Your code runs it. The model only produces text: a request naming a function and giving arguments. It has no ability to execute anything.

**2.** The first call returns a request, not an answer -- `content` is empty. Only after you run the tool and send the result back can the model write a reply using it.

**3.** It links each result to the request that asked for it. With several tools in one turn, without matching ids the model cannot tell which result belongs to which call. The API also rejects a `tool` message whose id does not match a preceding request.

**4.** It stops telling the model *when* to use the tool, so the model falls back on doing arithmetic itself and gets it wrong. It is a Day 3 problem because a tool description is a prompt, and the same rules apply: be specific, say when, and name the model's weakness directly.

**5.** Because your code runs tools once and then asks for a final answer. It gets the time, and never gets a second chance to call `save_note` with it. The fix is a `while` loop that keeps going until the model stops asking for tools -- which is Day 7.
