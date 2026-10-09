# LLM Fundamentals & Prompting

## Managing hallucinated tool calls

> Core | Fast CP2 / Slow CP3 | ~1.2 h | Builds on: M05-12, M05-14

### Kahani
Bank assistant ke paas sirf do tools the: `get_account_status` aur `search_policy`. Ek gussa customer bola "mera paisa wapas karo". Model ne `refund_payment` naam ka tool call kar diya -- jo exist hi nahi karta. Code ne `TOOLS[name]` pe KeyError phenka, request 500.
Fix ke baad naya drama: model ne tool call hi nahi kiya, seedha likh diya "I have refunded Rs 4,999 to your account" -- koi refund hua hi nahi tha. Aur ek conversation mein model same `search_policy` ko 14 baar call karta raha, har baar thoda alag query, jab tak timeout nahi hua.
Hallucination sirf "galat facts" nahi hai. Tool layer mein ye non-existent tools, made-up arguments, fake action claims aur infinite loops ki shakal mein aata hai.

### What it is
**Hallucinated tool call** = model ka aisa tool use jo aapke contract ke bahar ho: unknown tool name, schema ke bahar args, made-up IDs, ya bina tool chalaye action ka claim. Defence layered hai:
(1) unknown/invalid calls ko **error tool_result** se reject (crash nahi, model ko available tools batao), (2) **loop guards** -- max iterations, duplicate-call detection, consecutive error budget, (3) **output guard** -- final text action claim kare to check karo ki matching write tool sach mein successfully chala.

### Why it matters for an FDE
Customer ko "refund ho gaya" bolna jab hua nahi -- ye support ticket nahi, legal/compliance incident hai. Infinite tool loops = cost spike + hung requests. Production agent ka trust inhi guards pe tikta hai.

### Key concepts
- **Unknown tool -> error result** -- `is_error: true`, content mein available tool names; model usually correct karta hai. Kabhi `KeyError` nahi.
- **Max iterations** -- har agent loop pe hard cap (e.g. 6 turns); limit pe graceful fallback message + alert.
- **Duplicate detection** -- same (name, args) dobara aaye to dobara execute mat karo; pichhla result ya error "already called" do.
- **Error budget** -- lagaataar N turns sirf errors -> stop; model stuck hai, aur calls paisa jalaayengi.
- **Action-claim check** -- final text mein "refunded / blocked / cancelled" jaise claims ko executed write tools ke log se verify karo; mismatch pe safe message + human handoff.

### Code example
`pip install pydantic`

> Needs API key for the real version: ANTHROPIC_API_KEY (or OPENAI_API_KEY)

```python
# runnable
import json
import re

from pydantic import BaseModel, ConfigDict, Field, ValidationError

class GetAccountStatus(BaseModel):
    model_config = ConfigDict(extra="forbid")
    account_id: str = Field(pattern=r"^ACC-\d{6}$")

TOOLS = {"get_account_status": (GetAccountStatus, lambda a: {"status": "active", "refund_pending": False})}
WRITE_TOOLS = set()                        # this agent has NO tool that can refund
CLAIMS = re.compile(r"\b(refunded|blocked|cancelled|transferred)\b", re.I)

class ScriptedLLM:
    """Mimics client.messages.create(...) with scripted hallucinations. No network."""
    def __init__(self, turns):
        self.turns, self.calls = list(turns), 0

    def create(self, model, max_tokens, tools, messages):
        self.calls += 1
        content = self.turns.pop(0) if self.turns else [
            {"type": "tool_use", "id": f"loop{self.calls}", "name": "get_account_status",
             "input": {"account_id": "ACC-004211"}}]
        stop = "tool_use" if any(b["type"] == "tool_use" for b in content) else "end_turn"
        return {"stop_reason": stop, "content": content}

def handle(block, seen, executed):
    err = lambda msg: {"type": "tool_result", "tool_use_id": block["id"], "is_error": True, "content": msg}
    if block["name"] not in TOOLS:
        return err(f"Unknown tool {block['name']!r}. Available: {sorted(TOOLS)}. "
                   "If no tool fits, tell the user you cannot do it.")
    key = (block["name"], json.dumps(block["input"], sort_keys=True))
    if key in seen:
        return err("Duplicate call: you already have this result. Answer now.")
    seen.add(key)
    model, fn = TOOLS[block["name"]]
    try:
        args = model.model_validate(block["input"])
    except ValidationError as e:
        return err("; ".join(f"{'.'.join(map(str, x['loc']))}: {x['msg']}" for x in e.errors()[:3]))
    executed.append(block["name"])
    return {"type": "tool_result", "tool_use_id": block["id"], "content": json.dumps(fn(args))}

def run_agent(llm, question, max_iters=6, max_error_turns=2):
    messages, seen, executed, error_turns = [{"role": "user", "content": question}], set(), [], 0
    for _ in range(max_iters):
        resp = llm.create(model="fake", max_tokens=800, tools=[], messages=messages)
        messages.append({"role": "assistant", "content": resp["content"]})
        if resp["stop_reason"] != "tool_use":
            text = "".join(b["text"] for b in resp["content"] if b["type"] == "text")
            if CLAIMS.search(text) and not WRITE_TOOLS & set(executed):
                return "fallback", "I could not complete that action. A human agent will follow up."
            return "ok", text
        results = [handle(b, seen, executed) for b in resp["content"] if b["type"] == "tool_use"]
        messages.append({"role": "user", "content": results})
        error_turns = error_turns + 1 if all(r.get("is_error") for r in results) else 0
        if error_turns >= max_error_turns:
            return "fallback", "Sorry, I am having trouble. A human agent will follow up."
    return "fallback", "This is taking too long. A human agent will follow up."

tu = lambda i, name, inp: {"type": "tool_use", "id": i, "name": name, "input": inp}
# 1) unknown tool + made-up arg, then recovers, then FALSE action claim
llm = ScriptedLLM([[tu("a", "refund_payment", {"amount": 4999}),
                    tu("b", "get_account_status", {"account_id": "ACC-004211", "force": True})],
                   [tu("c", "get_account_status", {"account_id": "ACC-004211"})],
                   [{"type": "text", "text": "I have refunded Rs 4,999 to your account."}]])
print("case 1:", run_agent(llm, "Refund my money"))
# 2) honest answer passes
llm = ScriptedLLM([[tu("d", "get_account_status", {"account_id": "ACC-004211"})],
                   [{"type": "text", "text": "Your account is active; no refund is pending."}]])
print("case 2:", run_agent(llm, "Any refund pending?"))
# 3) model loops on the same call forever
loop = ScriptedLLM([])
print("case 3:", run_agent(loop, "status?"), "calls =", loop.calls)

assert run_agent(ScriptedLLM([[tu("a", "refund_payment", {})], [{"type": "text", "text": "Refunded!"}]]), "x")[0] == "fallback"
assert loop.calls <= 6
print("OK: unknown tools, bad args, loops and false claims all contained")
```

- `handle` -- unknown tool pe `KeyError` nahi, error tool_result jisme available tools ki list + "agar koi tool fit nahi to user ko bata do" -- model ko imaandaar raasta milta hai.
- `force: True` extra arg -> `extra="forbid"` se reject; model next turn pe sahi args bhejta hai (case 1, turn 2).
- `seen` set -- same (name, args) dobara aaya to execute nahi; case 3 mein pehle duplicate pe error, phir error budget (2 turns) pe stop.
- `CLAIMS` + `WRITE_TOOLS & executed` -- "I have refunded" bola lekin koi write tool chala hi nahi -> user ko safe fallback message, galat claim kabhi nahi.
- Teen alag fallback reasons -- production mein inhe metric/alert bana ke track karo (M14-12).

```python
# real version -- not run here, needs: pip install anthropic pydantic
import os
import anthropic

MODEL = os.environ.get("LLM_MODEL", "<your-model-id>")
client = anthropic.Anthropic()


class AnthropicAdapter:
    def create(self, model, max_tokens, tools, messages):
        resp = client.messages.create(model=MODEL, max_tokens=max_tokens, tools=TOOL_DEFS,
                                      system="Only use the provided tools. If none fits, say so.",
                                      messages=messages)
        return {"stop_reason": resp.stop_reason, "content": [b.model_dump() for b in resp.content]}


status, answer = run_agent(AnthropicAdapter(), "Refund my money")
```

`TOOL_DEFS` = the tool list from M05-11. In real code keep the SDK blocks for the history you send back, and use the dicts only for your own checks.

### Mini-exercise (30-60 min)
CP2 capstone finish: `omniguard/agent.py` mein guards jodo aur gate chalao.
- `handle()` for unknown tools/duplicates, `MAX_ITERS` aur `MAX_ERROR_TURNS` env se, action-claim checker with `WRITE_TOOLS`.
- `evals/hallucination_cases.jsonl` -- 10 scripted conversations (unknown tool, extra args, loop, false claim, honest answer); har ek ka expected status.
- Final gate `scripts/gate.py`: `/triage` (strict JSON + 2 tools + repair retry) pe 50 calls -- report: invalid JSON leaked = 0, fallbacks count, hallucinated-tool rejections, total LLM calls.
- Acceptance: pytest -- 10/10 hallucination cases expected status; gate script exit code 0 only if leaked == 0.

### Common pitfalls
- `TOOLS[name]` direct lookup -- ek hallucinated naam = 500 error aur poori conversation khatam.
- Regex claim-check ko hi poora safety system maan lena -- ye ek last guard hai; asli safety ye hai ki write actions sirf validated tool path se hon (aur sensitive ones pe human approval).
- Max iterations pe silently last partial answer return karna -- user ko adhoora/galat answer milta hai; explicit fallback + log + alert.

### Checklist before moving on
- [ ] Unknown tool aur invalid args ko error tool_result se handle karta hoon, crash nahi.
- [ ] Agent loop mein max iterations, duplicate detection aur error budget hai.
- [ ] Final answer ke action claims ko executed tools se verify karta hoon.
- [ ] OmniGuard gate (50 calls, zero invalid JSON) pass karta hai aur numbers report karta hai.

### Related
- M05-12 Parsing and validating tool arguments
- M05-14 Processing tool results into chat history
- M09-02 ReAct framework loops
- M13-01 Identifying major LLM vulnerabilities

### Self-quiz
1. Unknown tool pe error tool_result bhejna aur exception raise karna -- user experience aur cost mein kya fark?
2. Duplicate-call detection args ke exact match pe hai. Model har baar query thodi badal de to? Kya guard kaam aayega?
3. Action-claim regex ke false positives aur false negatives ka ek-ek example do.
4. Aapke agent ke paas ek real `refund_payment` tool aa gaya. Kaunse naye guards chahiye?
