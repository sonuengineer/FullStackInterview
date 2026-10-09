# LLM Fundamentals & Prompting

## Parsing and validating tool arguments

> Core | Fast CP2 / Slow CP3 | ~1.2 h | Builds on: M05-08, M05-11

### Kahani
Bank assistant ke `get_account_status` tool ko model ne `{"account_id": "ACC-004211 "}` (trailing space) bheja -- DB lookup "not found", user ko bola gaya "account exist nahi karta". Doosre din `{"account_id": "ACC-009999"}` aaya -- format bilkul sahi, lekin ye account kisi aur customer ka tha; ek email mein chhupe prompt injection ne model ko ye ID pakda di thi.
Aur OpenAI pe migrate karte hi pata chala wahan arguments ek JSON **string** mein aate hain, dict mein nahi -- `args["account_id"]` pe TypeError.
Tool args ko model ka "suggestion" samjho, command nahi. Parse karo, validate karo, authorize karo -- tab execute.

### What it is
Tool call aane pe teen gates: (1) **Parse** -- provider shape normalise (Anthropic `block.input` dict; OpenAI `function.arguments` JSON string). (2) **Validate** -- args ka Pydantic model (`extra="forbid"`, patterns, bounds) se `model_validate`. (3) **Authorize** -- valid hone ke baad bhi check karo ki current user/session ko is resource ka access hai.
Fail hone pe crash nahi: model ko `tool_result` with `is_error: true` aur short error message bhejo, taaki wo correct karke dobara call kare.

### Why it matters for an FDE
Tool = customer ke real systems pe action. Bina validation ke model ka typo outage banta hai; bina authorization ke prompt injection data breach banta hai (OWASP LLM top 10 mein "excessive agency").

### Key concepts
- **Normalise first** -- `input` dict ho ya JSON string, ek function `raw_args()` se dict banao; invalid JSON bhi ek error result hai.
- **Validate with the same model** -- tool schema (M05-11) aur validator ek hi Pydantic class; `str_strip_whitespace` jaisi safe normalisation config mein.
- **Authorize separately** -- schema "format" check karta hai, ownership nahi. `account_id in session.allowed_accounts` server side.
- **Error as tool_result** -- `{"type": "tool_result", "tool_use_id": id, "is_error": True, "content": "account_id: must match ACC-######"}`; model ko fix karne ka mauka.
- **Don't trust strict mode alone** -- strict/constrained decoding schema shape deta hai; business rules aur auth aapki zimmedari.

### Code example
`pip install pydantic`

> Needs API key for the real version: ANTHROPIC_API_KEY (or OPENAI_API_KEY)

```python
# runnable
import json
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

class Args(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

class GetAccountStatus(Args):
    account_id: str = Field(pattern=r"^ACC-\d{6}$")

class SearchPolicy(Args):
    query: str = Field(min_length=3, max_length=200)
    category: Literal["fees", "refunds", "cards", "any"]
    top_k: int = Field(ge=1, le=5)

REGISTRY = {"get_account_status": GetAccountStatus, "search_policy": SearchPolicy}

class Session:
    def __init__(self, user_id, allowed_accounts):
        self.user_id, self.allowed_accounts = user_id, set(allowed_accounts)

def raw_args(block) -> dict:
    data = block["input"]
    if isinstance(data, str):                 # OpenAI style: arguments is a JSON string
        data = json.loads(data)
    if not isinstance(data, dict):
        raise ValueError("arguments must be a JSON object")
    return data

def error_result(block, msg):
    return {"type": "tool_result", "tool_use_id": block["id"], "is_error": True, "content": msg}

def check_tool_call(block, session):
    """Returns (validated_args, None) or (None, error tool_result)."""
    model = REGISTRY.get(block["name"])
    if model is None:
        return None, error_result(block, f"unknown tool {block['name']!r}")
    try:
        args = model.model_validate(raw_args(block))
    except (ValueError, ValidationError) as e:        # ValidationError is a ValueError too
        if isinstance(e, ValidationError):
            msg = "; ".join(f"{'.'.join(map(str, x['loc']))}: {x['msg']}" for x in e.errors()[:3])
        else:
            msg = f"invalid arguments: {e}"
        return None, error_result(block, msg)
    if isinstance(args, GetAccountStatus) and args.account_id not in session.allowed_accounts:
        return None, error_result(block, "access denied for this account")   # no hint if it exists
    return args, None

# tool_use blocks as they appear in response.content (fake model output, no network)
blocks = [
    {"type": "tool_use", "id": "t1", "name": "get_account_status", "input": {"account_id": "ACC-004211 "}},
    {"type": "tool_use", "id": "t2", "name": "get_account_status", "input": {"account_id": "ACC-009999"}},
    {"type": "tool_use", "id": "t3", "name": "search_policy",
     "input": '{"query": "card block fee", "category": "cards", "top_k": "3"}'},
    {"type": "tool_use", "id": "t4", "name": "search_policy",
     "input": {"query": "refund", "category": "refunds", "top_k": 500, "debug": True}},
    {"type": "tool_use", "id": "t5", "name": "search_policy", "input": "{not json"},
]
session = Session("u_17", allowed_accounts=["ACC-004211"])
outcomes = {}
for b in blocks:
    args, err = check_tool_call(b, session)
    outcomes[b["id"]] = args if args else err
    print(b["id"], "->", args.model_dump() if args else err["content"])

assert outcomes["t1"].account_id == "ACC-004211"              # whitespace stripped
assert outcomes["t2"]["is_error"] and "denied" in outcomes["t2"]["content"]
assert outcomes["t3"].top_k == 3                              # JSON string parsed, "3" coerced
assert "top_k" in outcomes["t4"]["content"] and "debug" in outcomes["t4"]["content"]
assert outcomes["t5"]["is_error"] and outcomes["t5"]["tool_use_id"] == "t5"
print("OK: parse -> validate -> authorize, errors returned as tool_result")
```

- `raw_args` -- Anthropic dict aur OpenAI JSON-string dono handle; broken JSON `ValueError` ban ke error result mein jaata hai.
- `str_strip_whitespace=True` -- "ACC-004211 " ka trailing space safe tareeke se hat gaya, phir pattern check pass.
- t2 format mein valid hai lekin session ka account nahi -- "access denied", aur message mein ye nahi batate ki account exist karta hai ya nahi.
- t4 -- ek hi error message mein dono problems (`top_k` bound, extra `debug` key); model ek baar mein fix kar sakta hai.
- Har error ek `tool_result` with same `tool_use_id` -- M05-14 mein ye history mein jaata hai; crash kabhi nahi.

```python
# real version -- not run here, needs: pip install anthropic pydantic
import os
import anthropic

MODEL = os.environ.get("LLM_MODEL", "<your-model-id>")
client = anthropic.Anthropic()
resp = client.messages.create(model=MODEL, max_tokens=1000, tools=TOOLS, messages=messages)
for block in resp.content:
    if block.type == "tool_use":
        args, err = check_tool_call({"id": block.id, "name": block.name, "input": block.input}, session)

# OpenAI: for call in resp.choices[0].message.tool_calls:
#     check_tool_call({"id": call.id, "name": call.function.name, "input": call.function.arguments}, session)
```

### Mini-exercise (30-60 min)
`omniguard/tools/validate.py` mein `check_tool_call(block, session)` banao (M05-11 ke schemas reuse karo).
- Session FastAPI dependency (M02-03) se aaye; `allowed_accounts` fake user store se.
- Har rejected call ka structured log: tool name, error type (`validation` / `auth` / `parse` / `unknown_tool`), `tool_use_id` -- args ki values nahi (PII).
- Acceptance: pytest -- ek parametrized test 8 cases ke saath (valid, whitespace, other user's account, extra key, bound violation, JSON string, broken JSON, unknown tool); koi bhi case exception raise nahi karta.

### Common pitfalls
- Validation pass = authorized samajhna -- prompt injection ka sabse common raasta (M13-02).
- Error message mein internal detail ("SELECT ... failed", stack trace) -- model ke through user tak, ya attacker tak, pahunchta hai.
- Lax coercion pe bharosa jahan meaning badal jaaye (`"0"` -> `False`, float IDs) -- critical args pe `strict=True` fields.

### Checklist before moving on
- [ ] Anthropic aur OpenAI dono ke tool args shape normalise kar sakta hoon.
- [ ] Tool args ko execution se pehle Pydantic se validate karta hoon.
- [ ] Validation ke baad server-side authorization check karta hoon.
- [ ] Har failure `is_error` tool_result banta hai, crash nahi.

### Related
- M05-11 Defining precise function schemas for LLMs
- M05-14 Processing tool results into chat history
- M05-15 Managing hallucinated tool calls
- M12-01 Authentication vs authorization

### Self-quiz
1. Strict tool mode on hai -- teen cheezein batao jo phir bhi aapko khud check karni padengi.
2. "Access denied" message mein "account not found" kyun nahi likhna chahiye?
3. `str_strip_whitespace` jaisi normalisation kab dangerous ho sakti hai?
4. Model ne galat args bheje aur aapne error tool_result bheja. Model 5 baar same galti kare to kya hoga? Guard kahan lagaoge?
