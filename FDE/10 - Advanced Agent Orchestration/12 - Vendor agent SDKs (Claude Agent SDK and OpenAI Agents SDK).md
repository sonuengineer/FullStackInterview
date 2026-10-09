# Advanced Agent Orchestration

## Vendor agent SDKs (Claude Agent SDK and OpenAI Agents SDK)

> Core | Fast CP7 / Slow CP9 | ~1.2 h | Builds on: M05-14, M09-04, M10-10

### Kahani
Ek healthcare SaaS ke kickoff mein teen engineers teen raaste lekar aaye. Ek bola "raw API pe apna tool loop likhte hain" (M05-14). Doosra: "LangGraph -- graph, checkpoints, HITL sab control mein." Teesra: "Vendor ka agent SDK le lo, handoffs aur guardrails built-in hain, ek hafte mein demo."
Teen hafte debate chali. Phir pata chala ki use-case ke do alag hisse hain: ek code-repo pe kaam karne wala ops agent (files padho, scripts chalao), aur ek patient-intake triage jo sahi specialist agent ko handoff kare.
Sahi sawaal "kaunsa framework best hai" nahi tha -- "is kaam ke liye loop kaun own kare: hum ya vendor?" tha.

### What it is
**Vendor agent SDKs** = model vendors ki libraries jo agent loop (model call -> tool -> result -> repeat) tumhare liye chalati hain:
**Claude Agent SDK** (`claude-agent-sdk`) -- Claude Code ka harness as a library: `query(prompt, options)`, built-in file/bash/web tools, permission modes, hooks, subagents, MCP servers.
**OpenAI Agents SDK** (`openai-agents`) -- lightweight primitives: `Agent`, `Runner`, function tools, **handoffs** (ek agent doosre ko control de), **guardrails** (input/output checks), built-in **tracing**.

### Why it matters for an FDE
Customer aksar pehle hi kisi vendor se committed hota hai. FDE ko batana hai SDK kya free mein deta hai, kahan lock-in hai, aur kab LangGraph ya raw loop behtar hai -- aur security controls (M10-09/11) har option mein kahan lagenge.

### Key concepts
- **Raw API loop (M05-14)** -- full control, zero magic, sab khud: retries, guards, state. Chhote single-agent tools ke liye best.
- **Claude Agent SDK** -- "agent that works on a computer": files, shell, web, subagents, hooks (`PreToolUse` pe deny); permission mode aur allowed tools se blast radius control.
- **OpenAI Agents SDK** -- multi-agent routing via handoffs, guardrail tripwires, tracing out of the box; graph/checkpoint ka control kam.
- **LangGraph** -- tum graph own karte ho: durable checkpoints, `interrupt()` HITL (M10-01..04), multi-vendor models; zyada code.
- **Common rule** -- SDK koi bhi ho, tool allow-list, secrets, approval aur logging policy tumhari hai.

| Need | Raw loop | Claude Agent SDK | OpenAI Agents SDK | LangGraph |
|---|---|---|---|---|
| Agent edits files / runs commands | build yourself | strong (built-in tools) | build tools | build tools |
| Multi-agent routing / handoffs | manual | subagents | strong (handoffs) | strong (graph edges) |
| Durable pause/resume for days | manual | check docs (sessions) | check docs (sessions) | strong (checkpointer) |
| Model vendor flexibility | any | Claude | OpenAI-first (others via adapters, check docs) | any |
| Lines of code for first demo | most | few | few | medium |

### Code example
`stdlib only`

```python
# runnable
from dataclasses import dataclass, field

# --- Teaching stand-in shaped like OpenAI Agents SDK: Agent, Runner, handoffs, input guardrails ---
class GuardrailTripped(Exception):
    pass

@dataclass
class Agent:
    name: str
    instructions: str
    tools: dict = field(default_factory=dict)
    handoffs: list = field(default_factory=list)
    input_guardrails: list = field(default_factory=list)

class FakeRouterLLM:
    """Stand-in for the model: picks a handoff or a tool from keywords. No network."""
    def decide(self, agent, text):
        for h in agent.handoffs:
            if h.name.split("_")[0] in text.lower():
                return ("handoff", h)
        if agent.tools:
            name = next(iter(agent.tools))
            return ("tool", name)
        return ("final", f"{agent.name}: I can only help with intake routing.")

class Runner:
    @staticmethod
    def run(agent, text, llm, max_turns=5):
        for g in agent.input_guardrails:                    # guardrails run before the model sees input
            if g(text):
                raise GuardrailTripped(g.__name__)
        path = [agent.name]
        for _ in range(max_turns):
            kind, value = llm.decide(agent, text)
            if kind == "handoff":
                agent = value
                path.append(agent.name)
            elif kind == "tool":
                return {"final_output": agent.tools[value](text), "path": path}
            else:
                return {"final_output": value, "path": path}
        raise RuntimeError("max_turns exceeded")

def no_card_numbers(text):
    return any(len(w) >= 13 and w.isdigit() for w in text.split())

billing = Agent("billing_agent", "Handle invoices", tools={"lookup_invoice": lambda t: "Invoice INV-22 is paid"})
clinical = Agent("clinical_agent", "Book specialist", tools={"book_slot": lambda t: "Cardiology slot booked Mon 10:30"})
triage = Agent("triage", "Route patient requests", handoffs=[billing, clinical], input_guardrails=[no_card_numbers])

llm = FakeRouterLLM()
r1 = Runner.run(triage, "I have a billing question about my invoice", llm)
r2 = Runner.run(triage, "Need a clinical appointment for chest pain follow-up", llm)
r3 = Runner.run(triage, "What is the weather?", llm)
print(r1, r2, r3, sep="\n")
assert r1["path"] == ["triage", "billing_agent"] and "INV-22" in r1["final_output"]
assert r2["path"] == ["triage", "clinical_agent"]
assert r3["path"] == ["triage"]
try:
    Runner.run(triage, "billing for card 4111111111111111", llm)
    raise AssertionError("guardrail should trip")
except GuardrailTripped as e:
    print("guardrail tripped:", e)

# --- Decision helper: who should own the loop? ---
def choose(needs):
    if "durable_hitl_days" in needs or "multi_vendor_models" in needs:
        return "langgraph"
    if "computer_use" in needs:                            # files, shell, repo work
        return "claude-agent-sdk"
    if "handoffs" in needs:
        return "openai-agents (or langgraph if customer is not on OpenAI)"
    return "raw api loop"

assert choose({"computer_use"}) == "claude-agent-sdk"
assert choose({"handoffs", "durable_hitl_days"}) == "langgraph"
assert choose({"handoffs"}).startswith("openai-agents")
assert choose({"single_tool"}) == "raw api loop"
print("OK: handoffs, guardrail tripwire, and a loop-ownership decision")
```

- `Agent` + `Runner.run` stand-in ka shape OpenAI Agents SDK jaisa hai; real SDK mein model khud handoff "tool" call karta hai (`transfer_to_<agent>` jaisa), yahan `FakeRouterLLM` keywords se.
- Guardrail input ko model se *pehle* check karta hai aur tripwire pe exception -- real SDK mein bhi tripwire exception raise hota hai (naam docs mein check karo).
- `path` -- kaunse agents se request guzri; production mein ye tracing span hai (M14-10).
- `choose()` jaan-bujh ke simple hai -- asli decision mein customer ka vendor contract, data residency aur team skills bhi aate hain.

```python
# real version -- not run here, needs: pip install claude-agent-sdk
# Claude Agent SDK: check the docs for your version (option names and message types evolve).
import anyio
from claude_agent_sdk import query, ClaudeAgentOptions

async def main():
    options = ClaudeAgentOptions(system_prompt="You audit infra repos. Never modify files.",
                                 allowed_tools=["Read", "Grep", "Glob"], max_turns=10)
    async for message in query(prompt="Find hardcoded secrets in ./infra", options=options):
        print(message)

anyio.run(main)
```

```python
# real version -- not run here, needs: pip install openai-agents
# OpenAI Agents SDK: check the docs for your version.
from agents import Agent, Runner, function_tool

@function_tool
def lookup_invoice(invoice_id: str) -> str:
    return billing_api.get(invoice_id)          # your safe executor (M10-09)

billing = Agent(name="Billing agent", instructions="Answer invoice questions.", tools=[lookup_invoice])
triage = Agent(name="Triage", instructions="Route to the right specialist.", handoffs=[billing])
result = Runner.run_sync(triage, "Is invoice INV-22 paid?")
print(result.final_output)
```

> Needs API key for the real version: ANTHROPIC_API_KEY (or OPENAI_API_KEY)

### Mini-exercise (30-60 min)
`fde-exercises/m10_sdks/`: AuditMesh ka ek chhota hissa teen tarah banao aur compare karo.
- Task: "finding text lo -> KB search tool -> Jira draft tool". Version A: raw loop (M05-14) with FakeLLM. Version B: upar wala Agent/Runner stand-in with handoff (evidence -> ticketing). Version C (optional, agar install kar sako): real SDK with your own API key.
- `DECISION.md` -- 1 page: AuditMesh supervisor ke liye kaunsa aur kyon (HITL multi-day approval, Jira MCP, customer vendor), ek table ke saath.
- Acceptance: A aur B dono same 5 scripted inputs pe same final output; guardrail test (card number) dono mein trip; decision doc mein kam se kam 3 trade-offs.

### Common pitfalls
- SDK ke built-in tools (bash, file write) default/broad permissions ke saath customer infra pe chalana -- allowed tools + hooks + sandbox pehle set karo.
- Vendor tracing ko bina soche on rakhna -- prompts/PII vendor dashboard pe chale jaate hain; customer ki data policy check karo, zaroorat ho to disable/redact.
- "SDK hai to guardrails ho gaye" -- SDK guardrail ek hook hai; kya check karna hai (PII, scope, approval) wo abhi bhi tumhe likhna hai.

### Checklist before moving on
- [ ] Chaaron options (raw loop, Claude Agent SDK, OpenAI Agents SDK, LangGraph) ka ek-ek best use-case bata sakta hoon.
- [ ] Handoff aur guardrail tripwire ka flow samajh aata hai.
- [ ] Jaanta hoon kaunse controls har option mein mere hi zimme hain.
- [ ] AuditMesh ke liye apna choice justify kar sakta hoon.

### Related
- M05-14 Processing tool results into chat history
- M09-04 Supervisor and Router patterns
- M10-07 Managed agent provisioning
- M10-10 Host/Client/Server architectures
- M14-10 Capturing deep span-level execution traces

### Self-quiz
1. Customer ko 3 din tak pending approval chahiye aur Claude models. Claude Agent SDK ya LangGraph + Claude API? Kyon?
2. Handoff aur "supervisor calls sub-agent as a tool" (M09-04) mein kya fark hai -- conversation control kiske paas rehta hai?
3. Vendor SDK ka version upgrade hua aur ek option ka naam badal gaya. Isse bachne ke liye apne code mein kya boundary banaoge?
4. Claude Agent SDK ka bash tool customer ke laptop pe -- kaunse teen controls pehle lagaoge?
