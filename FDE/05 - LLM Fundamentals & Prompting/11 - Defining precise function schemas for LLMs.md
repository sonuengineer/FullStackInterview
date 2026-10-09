# LLM Fundamentals & Prompting

## Defining precise function schemas for LLMs

> Core | Fast CP2 / Slow CP3 | ~1.2 h | Builds on: M05-06, M05-07

### Kahani
Ek bank ke support assistant ko do tools diye gaye: `get_data(id)` aur `search(q)`. Description: "Gets data" aur "Searches".
Model ne customer ke card number ko `id` mein bhej diya (account ID chahiye tha), "refund policy" ke liye `get_data` call kiya, aur ek baar `search` ko `{"query": ..., "limit": 500}` bhej diya -- jo parameter exist hi nahi karta tha.
Model ko tools sirf name + description + JSON Schema se samajh aate hain. Vague schema = galat calls. Aapko tools ko aise define karna hai jaise kisi naye junior developer ke liye API docs likh rahe ho.

### What it is
**Tool (function) schema** = model ko diya gaya contract: `name`, `description` (kab use karna hai, kab NAHI, kya return hota hai), aur `input_schema` (JSON Schema: types, enums, formats, required, `additionalProperties: false`).
Anthropic: `tools=[{"name", "description", "input_schema"}]`, optional `"strict": True` taaki input schema ke exactly match kare. OpenAI: `tools=[{"type": "function", "function": {"name", "description", "parameters", "strict": True}}]`.

### Why it matters for an FDE
Customer ke internal APIs ko LLM tools banana FDE ka roz ka kaam hai. Galat tool choice ya galat argument = galat customer data access, failed workflows, ya model ka "creative" API use.

### Key concepts
- **Name** -- verb_noun, specific (`get_account_status`, not `get_data`); naming rules `^[a-zA-Z0-9_-]{1,64}$`.
- **Description** -- 3-4 sentences: kya karta hai, kab use karo, kab mat karo, kya return karta hai, limits. Ye prompt ka hissa hai.
- **Tight input schema** -- har property pe `description`, closed sets ke liye `enum`, `pattern` for IDs, `minimum`/`maximum`, `required`, `additionalProperties: false`.
- **Pydantic as source** -- tool args ka Pydantic model -> `model_json_schema()` -> `input_schema`; wahi model execution se pehle validate karega (M05-12).
- **Few tools, distinct jobs** -- overlapping tools model ko confuse karte hain; 2 clear tools > 6 fuzzy tools.

### Code example
`pip install pydantic`

> Needs API key for the real version: ANTHROPIC_API_KEY (or OPENAI_API_KEY)

```python
# runnable
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class GetAccountStatus(BaseModel):
    """Look up the live status of ONE bank account: active/frozen/closed, open disputes and
    last login. Use when the user asks about their account state. Do NOT use for policy
    questions (use search_policy). Never pass card numbers -- only account IDs like ACC-123456."""
    model_config = ConfigDict(extra="forbid")
    account_id: str = Field(pattern=r"^ACC-\d{6}$", description="Internal account ID, e.g. ACC-004211")


class SearchPolicy(BaseModel):
    """Search the bank's published policy documents (fees, refunds, card blocking) and return
    the top matching passages with titles. Use for 'what is the rule/fee/limit' questions.
    Does NOT access any customer data."""
    model_config = ConfigDict(extra="forbid")
    query: str = Field(min_length=3, max_length=200, description="Short search query in English")
    category: Literal["fees", "refunds", "cards", "any"] = Field(description="Policy area; use 'any' if unsure")
    top_k: int = Field(ge=1, le=5, description="How many passages to return, 1-5")


def to_tool(model: type[BaseModel]) -> dict:
    schema = model.model_json_schema()
    schema.pop("title", None)
    schema.pop("description", None)                      # description goes at tool level
    name = re.sub(r"(?<!^)(?=[A-Z])", "_", model.__name__).lower()
    return {"name": name, "description": " ".join(model.__doc__.split()),
            "strict": True, "input_schema": schema}


def lint_tool(tool: dict) -> list[str]:
    problems = []
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", tool["name"]):
        problems.append("bad name")
    if len(tool.get("description", "")) < 80:
        problems.append("description too short: say when to use / not use")
    s = tool["input_schema"]
    if s.get("additionalProperties") is not False:
        problems.append("additionalProperties must be false")
    for prop, spec in s.get("properties", {}).items():
        if "description" not in spec:
            problems.append(f"property '{prop}' has no description")
        if prop not in s.get("required", []):
            problems.append(f"property '{prop}' not required (use nullable instead)")
    return problems


TOOLS = [to_tool(GetAccountStatus), to_tool(SearchPolicy)]
vague = {"name": "get_data", "description": "Gets data",
         "input_schema": {"type": "object", "properties": {"id": {"type": "string"}}}}

for t in TOOLS:
    print(t["name"], "->", lint_tool(t) or "clean")
    assert lint_tool(t) == []
print("get_data ->", lint_tool(vague))
assert len(lint_tool(vague)) == 4

names = [t["name"] for t in TOOLS]
assert names == ["get_account_status", "search_policy"]
cat = TOOLS[1]["input_schema"]["properties"]["category"]
assert cat["enum"] == ["fees", "refunds", "cards", "any"]
assert TOOLS[0]["input_schema"]["properties"]["account_id"]["pattern"] == r"^ACC-\d{6}$"
print("OK: precise tool schemas generated from Pydantic and linted")
```

- Docstring hi tool `description` hai -- "kab use karo / kab mat karo / kya pass mat karo" teeno likhe hain; card number wali galti yahin rokte hain.
- `pattern=r"^ACC-\d{6}$"` + example -- model ko exact ID format dikhta hai; strict mode ya hamari validation (M05-12) baaki pakdegi.
- `category: Literal[...]` -> `enum`; `top_k` pe `ge/le` -- "limit: 500" jaisi values schema hi mana karta hai.
- `to_tool` Pydantic se Anthropic tool dict banata hai (`name`, `description`, `strict`, `input_schema`) -- ek source of truth.
- `lint_tool` -- CI mein chalao; vague tool pe 4 problems: chhota description, `additionalProperties`, missing property description, not required.

```python
# real version -- not run here, needs: pip install anthropic pydantic
import os
import anthropic

MODEL = os.environ.get("LLM_MODEL", "<your-model-id>")
client = anthropic.Anthropic()
resp = client.messages.create(
    model=MODEL, max_tokens=1000, tools=TOOLS,
    messages=[{"role": "user", "content": "Is my account ACC-004211 frozen?"}],
)
for block in resp.content:
    if block.type == "tool_use":
        print(block.id, block.name, block.input)    # input is a dict
```

OpenAI equivalent: `tools=[{"type": "function", "function": {"name": ..., "description": ..., "parameters": schema, "strict": True}}]`. Strict modes support only a subset of JSON Schema (e.g. some `pattern`/length keywords may be ignored or rejected) -- check the docs and keep your own validation.

### Mini-exercise (30-60 min)
CP2 capstone ke 2 tools: `omniguard/tools/schemas.py`.
- `GetAccountStatus` aur `SearchPolicy` (ya apne domain ke 2 tools) Pydantic models, `to_tool()` aur `lint_tool()`.
- `tests/test_tool_schemas.py`: dono tools lint-clean; tool names unique; snapshot of generated tool JSON (`tests/snapshots/tools.json`) taaki koi bina review ke schema na badle.
- Bonus: 10 user questions ki list banao aur likho kaunsa tool expected hai -- M05-15 mein isi se tool-choice eval karoge.

### Common pitfalls
- Description mein internal details (DB table names, auth tokens, internal URLs) -- ye model ke context mein jaata hai aur prompt injection se leak ho sakta hai.
- Optional params ki bheed -- model unhe random fill karta hai; zaroorat na ho to hatao, ho to nullable + description.
- Tool output ka format description mein na batana -- model result ko galat interpret karta hai; "returns JSON with fields x, y" likho.

### Checklist before moving on
- [ ] Achha tool name aur 3-4 sentence description likh sakta hoon (use / don't use / returns).
- [ ] Input schema mein enums, patterns, bounds, required aur `additionalProperties: false` lagata hoon.
- [ ] Pydantic model se tool definition generate karta hoon.
- [ ] Tool definitions CI mein lint/snapshot hoti hain.

### Related
- M05-06 Enforcing strict JSON output schemas via APIs
- M05-12 Parsing and validating tool arguments
- M05-15 Managing hallucinated tool calls
- M13-02 Prompt injection defenses

### Self-quiz
1. `get_data` aur `get_account_status` -- naam badalne se model behaviour kyun badalta hai?
2. Tool description mein "Do NOT use for X" likhna kab zaroori hai?
3. Strict mode on hai. Phir bhi aap tool args ko execution se pehle validate kyun karoge?
4. Customer ke API mein 25 endpoints hain. Kya aap 25 tools doge? Kya alternative hai?
