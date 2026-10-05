# Day 8 — Model Context Protocol (MCP)

**Module:** 02 — AI Agents
**Time:** about 1 hour
**Builds on:** Day 4 — tool schemas; Day 7 — the agent loop

---

## 1. Today in one line

Your tools move out of your Python file and become a standard plug that any AI app can use — including apps you did not write.

---

## 2. The problem

Look at what you have built. `tools.py` holds four useful tools: time, calculate, save notes, search your documents. Genuinely good.

Now try to use them anywhere else.

- In Claude Desktop? Rewrite them.
- In your Node dashboard on Day 20? Rewrite them.
- In a friend's project? Send them your file and hope.
- With a different AI provider that uses a different schema format? Rewrite them.

And the reverse is worse. Someone has already written an excellent GitHub tool, a Postgres tool, a Slack tool. You cannot use any of them, because there is no shared shape. Every project builds its own tools from scratch, forever.

There is a second problem, quieter but more interesting. Your agent knows its tools at **build time** — `TOOL_SCHEMAS` is a list you typed. It can never gain a new ability while running. To add a tool you edit code and restart.

MCP fixes both. It is a standard way to describe and offer tools, so tools become things you *connect to* rather than things you *contain*.

**A word of warning about today.** Day 8 often feels abstract, and that is normal. You are not gaining new powers — your tools already work. You are learning a plug shape. It properly clicks on Day 13. Today, aim to understand the shape and get one working.

---

## 3. Mental model

**MCP is USB-C for AI tools.**

Before USB-C, every device had its own charger. Twelve cables in a drawer, none of them interchangeable. The chargers worked fine; they just did not work *together*.

USB-C did not make charging better. It made it **shared**. One shape, so any cable fits any device, and a new device works with cables that already exist.

MCP is that for tools:

- An **MCP server** offers capabilities — tools, data, prompts.
- An **MCP client** connects and uses them.
- Any client can talk to any server, because the shape is agreed.

Your agent becomes a client. Your tools become a server. And suddenly your tools work in Claude Desktop, in your Node app, in anything that speaks MCP — and servers other people wrote work in yours.

**Where the comparison breaks:**

USB-C is physically enforced. The wrong plug will not fit. MCP is a convention over JSON messages, so a badly written server is perfectly legal and will disappoint you in ways a cable cannot.

More importantly: **standardising the plug does nothing for the description**. Your model still chooses tools based on how well they are described. Everything from Day 4 still applies. MCP moves your schemas; it does not improve them.

---

## 4. How it really works

**Three roles**

- **Host** — the app the user sees. Claude Desktop, your `agent.py`.
- **Client** — the part inside the host that speaks MCP. One per server.
- **Server** — the thing offering tools. Usually a separate small program.

**Servers offer three kinds of thing**

- **Tools** — functions the model can call. What you built on Day 4.
- **Resources** — data the model can read. A file, a database row, a document.
- **Prompts** — reusable prompt templates the user can pick.

Today is tools only. Day 13 covers the other two.

**The conversation**

MCP uses **JSON-RPC**: plain JSON messages with a method name, parameters and an id. Over **stdio** — the server's standard input and output — or over HTTP.

Stdio surprises people, so be clear about it: your server is a normal program, launched as a subprocess, and messages travel down the pipe you would normally use for printing. That has one sharp consequence, which is trap 1 below and the single most common MCP mistake.

The exchange:

```
client -> initialize                    "hello, I speak version X"
server -> capabilities                  "hello, I offer tools"
client -> tools/list                    "what have you got?"
server -> [ schemas ]                   "here, in JSON Schema"
client -> tools/call {name, arguments}  "run this one"
server -> result                        "here you go"
```

**Now the important observation.** Look at what `tools/list` returns: name, description, input schema. **That is exactly what you hand-wrote in `TOOL_SCHEMAS` on Day 4.**

MCP did not invent a new idea. It took the thing you already built and standardised two things around it:

1. **Transport** — how the description travels between programs.
2. **Discovery** — the client asks at runtime instead of being told at build time.

Discovery is the part that matters. Your agent no longer needs to know its tools in advance. Connect a server, ask what it has, offer that to the model. Add a tool to the server and the agent can use it without a single change to the agent's code.

---

## 5. Setup

```bash
cd research-assistant/ai
source venv/bin/activate

pip install mcp
pip freeze > requirements.txt

mkdir -p mcp_servers
```

MCP is async, so today has `async` and `await` in it. If those are new: `async def` marks a function that can pause while waiting, and `await` is where it pauses. You do not need a deep understanding today — follow the shape and read up later.

---

## 6. Build it

---

### Stage 1 — Build a server

`mcp_servers/my_tools.py`:

```python
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from mcp.server.fastmcp import FastMCP
from tools import get_current_time, calculate, save_note, search_documents

mcp = FastMCP("research-tools")


@mcp.tool()
def current_time(timezone: str = "Asia/Kolkata") -> str:
    """Get the current date and time in a specific timezone.

    Use this whenever the user asks about the current time or today's date.

    Args:
        timezone: An IANA timezone name, for example 'Asia/Kolkata' or 'Asia/Tokyo'.
    """
    return get_current_time(timezone)


@mcp.tool()
def maths(expression: str) -> str:
    """Do exact arithmetic. Use this for ANY calculation, even easy ones,
    because language models cannot do arithmetic reliably.

    Args:
        expression: A maths expression such as '8472 * 391'.
    """
    return calculate(expression)


@mcp.tool()
def note_save(title: str, content: str) -> str:
    """Save a note to a file for the user to read later.

    Args:
        title: A short filename-friendly title, no extension.
        content: The full text to save.
    """
    return save_note(title, content)


@mcp.tool()
def documents_search(query: str) -> str:
    """Search the user's own documents, notes and PDFs by meaning.
    Natural language works; you do not need the exact words from the document.

    Args:
        query: What to look for.
    """
    return search_documents(query)


if __name__ == "__main__":
    mcp.run()
```

**What FastMCP is doing for you.**

Look at `current_time`. You wrote no JSON Schema. FastMCP reads the **type hints** (`timezone: str`) and the **docstring**, and generates the schema automatically.

Compare that with your Day 4 version — twenty lines of nested JSON per tool. This is the same information in a form humans can actually maintain.

**That docstring is now your tool description**, which means it is now a prompt. Everything from Day 3 applies: say *when* to use it, be specific about argument formats, name the model's weaknesses. The `maths` docstring keeps the "cannot do arithmetic reliably" line for exactly that reason. Vague docstrings mean a model that picks badly.

**The `sys.path.insert` line** lets the server import your existing `tools.py` from the parent folder. The server is launched as its own program, so it does not inherit your project folder automatically.

Test that it starts:

```bash
python mcp_servers/my_tools.py
```

It will sit there doing nothing. **That is correct.** It is waiting for JSON on standard input. Press `Ctrl+C`.

---

### Stage 2 — Look at the raw protocol

Before using a client library, see the actual messages. This is the Day 1 habit.

Run the server again and paste this into the terminal, as one line, then press enter:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"manual","version":"1.0"}}}
```

You get a JSON response describing the server's capabilities.

Now send:

```json
{"jsonrpc":"2.0","method":"notifications/initialized"}
```

then:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
```

And there they are — your four tools, with descriptions and input schemas, as JSON.

**Read that output next to your Day 4 `TOOL_SCHEMAS`.** Slightly different key names, identical information. This is the moment MCP stops feeling mysterious: it is your own tool descriptions, sent down a pipe, with an agreed envelope around them.

---

### Stage 3 — Write a client

`mcp_client.py`:

```python
import asyncio
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

server = StdioServerParameters(
    command="python",
    args=["mcp_servers/my_tools.py"]
)


async def main():
    async with stdio_client(server) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()

            tools = await session.list_tools()
            print("Tools this server offers:")
            for tool in tools.tools:
                print(f"  {tool.name}: {tool.description.splitlines()[0]}")

            result = await session.call_tool("maths", {"expression": "8472 * 391"})
            print("\nResult:", result.content[0].text)


asyncio.run(main())
```

Run it:

```
Tools this server offers:
  current_time: Get the current date and time in a specific timezone.
  maths: Do exact arithmetic. Use this for ANY calculation, even easy ones,
  note_save: Save a note to a file for the user to read later.
  documents_search: Search the user's own documents, notes and PDFs by meaning.

Result: 3312552
```

**Your client did not know any of those tools existed.** It asked. That is discovery, and it is the whole point.

`stdio_client` launched the server as a subprocess, held the pipes open, and shuts it down cleanly when the `async with` block ends.

---

### Stage 4 — Put MCP under your agent

Now replace the hardcoded schemas in `agent.py` with discovered ones. `mcp_agent.py`:

```python
import os, json, asyncio
from dotenv import load_dotenv
from openai import OpenAI
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

load_dotenv()
client = OpenAI(api_key=os.environ["GROQ_API_KEY"],
                base_url="https://api.groq.com/openai/v1")
MODEL = "llama-3.3-70b-versatile"

server = StdioServerParameters(command="python", args=["mcp_servers/my_tools.py"])


def to_openai_schema(mcp_tool):
    """Turn an MCP tool description into the shape the chat API expects."""
    return {
        "type": "function",
        "function": {
            "name": mcp_tool.name,
            "description": mcp_tool.description,
            "parameters": mcp_tool.inputSchema
        }
    }


async def run_agent(goal, max_steps=8):
    async with stdio_client(server) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()

            listed = await session.list_tools()
            schemas = [to_openai_schema(t) for t in listed.tools]
            print(f"Discovered {len(schemas)} tools: {[t.name for t in listed.tools]}\n")

            messages = [
                {"role": "system", "content": "You are a capable assistant. Use your tools. Work step by step."},
                {"role": "user", "content": goal}
            ]

            for step in range(1, max_steps + 1):
                print(f"--- step {step} ---")

                response = client.chat.completions.create(
                    model=MODEL, messages=messages, tools=schemas
                )
                message = response.choices[0].message

                if not message.tool_calls:
                    return message.content

                messages.append(message.model_dump(exclude_none=True))

                for call in message.tool_calls:
                    args = json.loads(call.function.arguments)
                    print(f"  {call.function.name}({args})")

                    try:
                        outcome = await session.call_tool(call.function.name, args)
                        text = outcome.content[0].text
                    except Exception as error:
                        text = f"Tool failed: {error}"

                    print(f"  -> {text[:120]}")
                    messages.append({
                        "role": "tool",
                        "tool_call_id": call.id,
                        "content": text
                    })

            return "Ran out of steps."


if __name__ == "__main__":
    print(asyncio.run(run_agent(
        "Search my documents for anything about deadlines, then save a note called 'deadlines' summarising what you found."
    )))
```

**What changed from Day 7, and it is only two things:**

- `TOOL_SCHEMAS` is now fetched at runtime with `list_tools()` instead of being imported.
- `AVAILABLE_TOOLS[name](**args)` became `await session.call_tool(name, args)`.

Everything else — the loop, the appends, the step limit — is identical. The agent pattern did not change. Only where the tools live.

**The `to_openai_schema` function is worth noticing.** MCP has its shape, the chat API has another. This small translator sits between them. Every framework you meet from Day 16 onwards has a version of this function. Now you know what it is doing.

**Now prove the point.** Add a tool to `mcp_servers/my_tools.py`:

```python
@mcp.tool()
def word_count(text: str) -> str:
    """Count the words in a piece of text.

    Args:
        text: The text to count.
    """
    return f"{len(text.split())} words"
```

Run `mcp_agent.py` again and ask it to count words in something.

**You did not touch the agent.** It discovered the new tool on startup and used it. On Day 7, adding a tool meant editing agent code. That difference is the entire value of MCP.

---

### Stage 5 — Use a server you did not write

This is where it stops being theory. There are MCP servers for filesystems, GitHub, Postgres, Slack, web fetching and much more.

Add a second server to your client:

```python
servers = {
    "mine":  StdioServerParameters(command="python", args=["mcp_servers/my_tools.py"]),
    "files": StdioServerParameters(
        command="npx",
        args=["-y", "@modelcontextprotocol/server-filesystem", os.path.abspath("documents")]
    ),
}
```

You connect to each, list tools from both, and keep a map from tool name to which session owns it:

```python
tool_owner = {}   # tool name -> session
```

When the model calls a tool, look up the owner and route the call there.

**Two real warnings, which is why this stage is short:**

**Name collisions.** Two servers can both offer `search`. The model sees two identical names and behaves unpredictably. Real clients prefix them — `files.search`, `mine.search`. If you build this, prefix.

**Trust.** You just gave a program written by a stranger the ability to read and write files on your machine, and your agent decides when to call it. Note the `os.path.abspath("documents")` argument — that server is scoped to one folder deliberately. Read what a server can do before you connect it. Day 13 goes into this properly.

---

## 7. Words I heard today

| Word | Plain meaning |
|---|---|
| **MCP** | Model Context Protocol. A shared shape for offering tools to AI apps. |
| **Server** | A program offering tools, resources or prompts. |
| **Client** | The part of your app that talks to one server. |
| **Host** | The app the user sees, which may hold many clients. |
| **Transport** | How messages travel. stdio (a pipe) or HTTP. |
| **stdio** | Standard input and output. The server's normal print channel, used as the wire. |
| **JSON-RPC** | The message format: method, params, id. |
| **initialize** | The opening handshake. |
| **tools/list** | "What can you do?" |
| **tools/call** | "Run this one." |
| **Discovery** | Learning what tools exist at runtime instead of build time. |
| **Resources** | Data a server offers for reading. Day 13. |
| **Prompts** | Reusable prompt templates a server offers. Day 13. |
| **FastMCP** | The helper that builds schemas from your type hints and docstrings. |

---

## 8. Break it on purpose

**1. Print to stdout in the server.**
Add `print("starting up")` at the top of `my_tools.py`. Run the client.
*You will see:* the connection fails or hangs, with a confusing parse error.
*It teaches:* **stdout is the wire.** Anything you print corrupts the protocol. This is trap 1 and it catches nearly everyone.

**2. Empty a docstring.**
Delete the body of `documents_search`'s docstring. Run the agent on a document question.
*You will see:* it stops choosing that tool, or chooses it badly.
*It teaches:* MCP standardised transport, not quality. Description is still everything.

**3. Add a tool while the agent is written.**
Add a new `@mcp.tool()` and re-run the agent without editing it.
*You will see:* it appears and gets used.
*It teaches:* runtime discovery, felt rather than described. This is the payoff of the whole day.

**4. Kill the server mid-run.**
Find the subprocess and kill it while the agent is working.
*You will see:* an ugly exception, and probably a stuck program.
*It teaches:* MCP adds a process boundary, and process boundaries fail. A real client reconnects or degrades gracefully. Yours does not.

**5. Wrong types.**
Make a tool take `count: int` and have the model pass `"three"`.
*You will see:* a validation error returned as a tool result.
*It teaches:* schemas are enforced, unlike your Day 4 code where a bad argument crashed Python. This is a genuine improvement.

**6. Compare the two.**
Put `tools/list` output side by side with your Day 4 `TOOL_SCHEMAS`.
*You will see:* the same information, different envelope.
*It teaches:* MCP is not a new idea. It is your idea, standardised.

---

## 9. Traps

**Trap 1 — printing to stdout**
*Symptom:* JSON parse errors, hangs, or a client that gets nothing.
*Cause:* `print()` in a stdio server writes into the message channel.
*Fix:* log to **stderr** (`print(..., file=sys.stderr)`) or to a file. Never stdout. This is the number one MCP bug.

**Trap 2 — the server cannot import your modules**
*Symptom:* `ModuleNotFoundError: No module named 'tools'`.
*Cause:* the server is launched as a separate process from a different working directory.
*Fix:* the `sys.path.insert` line at the top, or absolute imports plus a proper package layout.

**Trap 3 — forgetting await**
*Symptom:* `RuntimeWarning: coroutine was never awaited`, and a result object with nothing useful in it.
*Cause:* async. `session.call_tool(...)` without `await` returns a coroutine, not a result.
*Fix:* `await` every session method.

**Trap 4 — name collisions between servers**
*Symptom:* the wrong tool runs, inconsistently.
*Fix:* prefix tool names per server.

**Trap 5 — trusting a stranger's server**
*Symptom:* nothing visible, which is the problem.
*Cause:* an MCP server is a program with your permissions, called by a model that can be talked into things.
*Fix:* read the source, scope it to a folder, prefer well-known servers. Day 13.

**Trap 6 — expecting MCP to make tools better**
*Symptom:* disappointment. "I did all this and it behaves the same."
*Reality:* correct. Same tools, same model, same choices. What changed is that the tools are now portable and discoverable.

---

## 10. Check yourself

1. What two things does MCP actually standardise? What does it not touch?
2. Why must an MCP server never print to stdout?
3. What is discovery, and what could you do after Stage 4 that you could not do on Day 7?
4. `tools/list` returns something you had already written by hand. What, and where?
5. You connect a filesystem server someone else wrote. What is the risk, and what reduces it?

---

## 11. Where this goes

- **Day 9** runs the agent autonomously. Tools behind a process boundary matter more when nobody is watching each call.
- **Day 13 is MCP properly.** Resources and prompts, authentication, sampling, and the security questions from trap 5. Today's abstract feeling largely disappears there.
- **Day 14** can give each agent its own set of MCP servers, so agents differ by capability rather than by code.
- **Day 20** is where today pays off in a way you can see: your Node dashboard can talk to the same MCP server this Python agent uses. Two languages, one set of tools, written once.

---

## 12. PROJECT STATE

```
PROJECT STATE after Day 8:

Folders:
  research-assistant/
    ai/
      venv/, .env, .gitignore, requirements.txt
      chat.py, agent.py            (Day 7 agent, hardcoded tools, kept)
      mcp_agent.py                 (NEW - agent using discovered MCP tools)
      mcp_client.py                (NEW - minimal client, lists and calls)
      mcp_servers/
        my_tools.py                (NEW - FastMCP server wrapping tools.py)
      tools.py, prompts.py, classify.py, test_prompt.py
      documents.py, embeddings.py, vector_store.py, chroma_db/
      conversation.json, notes/, documents/
    dashboard/                     (still empty)

Libraries: mcp (NEW). Everything else unchanged.

mcp_servers/my_tools.py:
  FastMCP("research-tools"), run over stdio
  sys.path.insert at the top so it can import ../tools.py
  exposes 4 tools, each a thin wrapper over the existing functions:
    current_time, maths, note_save, documents_search
  (plus word_count, added to prove runtime discovery works)
  schemas are generated automatically from type hints + docstrings,
  so docstrings are now the tool descriptions and matter as prompts

mcp_client.py:
  StdioServerParameters(command="python", args=["mcp_servers/my_tools.py"])
  async: stdio_client -> ClientSession -> initialize -> list_tools -> call_tool

mcp_agent.py:
  same loop as Day 7, with two changes only:
    - schemas fetched at runtime via session.list_tools()
    - tools run via await session.call_tool(name, args)
  to_openai_schema() translates MCP tool shape -> chat API tool shape
  prints the discovered tool list on startup

Verified working:
  - manual JSON-RPC over stdin: initialize, notifications/initialized,
    tools/list. Output compared against Day 4 TOOL_SCHEMAS - same
    information, different envelope.
  - added word_count to the SERVER and the agent used it with NO change
    to agent code. This is runtime discovery.

Key decisions made:
  - tools.py kept as the real implementation; the MCP server is a thin
    wrapper, so agent.py (Day 7) still works unchanged
  - docstrings written as prompts: when to use, argument formats, and the
    model's own weaknesses named
  - nothing is ever printed to stdout inside the server

Known problems, left for later:
  - no reconnect or graceful failure if the server process dies
  - multiple servers would collide on tool names; no prefixing yet
  - no authentication, no permission model, third-party servers run with
    full user permissions (Day 13)
  - resources and prompts not used at all yet (Day 13)
  - mcp_agent.py has no loop detection or approval step; those live in
    agent.py and still need merging
```

---

## Answers

**1.** Transport (how tool descriptions and calls travel between programs) and discovery (asking at runtime what tools exist). It does not touch how good the tool is, how well it is described, or whether the model chooses it sensibly — all of that is still Day 3 and Day 4 work.

**2.** Because with stdio transport, standard output *is* the message channel. Anything printed lands in the middle of the JSON-RPC stream and corrupts it. Log to stderr or a file instead.

**3.** Discovery is asking the server at runtime what tools it offers rather than knowing them at build time. After Stage 4 you can add a tool to the server and the agent uses it immediately, with no change to the agent's code. On Day 7 that required editing the agent.

**4.** The tool name, description and input schema — exactly the contents of `TOOL_SCHEMAS` in `tools.py` from Day 4. MCP puts a standard envelope around the same information.

**5.** It is a program running with your permissions, and a model that can be influenced by text decides when to call it. Reduce the risk by reading the source, scoping it to a single folder as with `abspath("documents")`, preferring well-known servers, and requiring approval for anything that changes data.
