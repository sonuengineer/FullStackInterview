# LLM Fundamentals & Prompting

## Enforcing strict JSON output schemas via APIs

> Core | Fast CP2 / Slow CP3 | ~1.2 h | Builds on: M02-02, M05-01

### Kahani
Ek bank ka fraud-triage pipeline LLM output ko seedha ek downstream service mein bhejta hai jo `{"risk": "high", "score": 0.91}` expect karti hai.
Prompt mein likha tha "Respond in JSON". 98% time theek. Baaki 2%: kabhi "Sure! Here is the JSON:" prefix, kabhi markdown fences, kabhi `"score": "high-ish"`. Raat 2 baje downstream service crash, on-call engineer ne LLM team ko jagaya.
"Usually JSON" production contract nahi hai. Aapko API level pe schema enforce karna hai, aur apni side pe bhi validate karna hai.

### What it is
**Structured outputs** = API ko JSON Schema dena taaki model ka output us schema ke andar constrained ho. Anthropic Messages API mein `output_config={"format": {"type": "json_schema", "schema": ...}}` (aur SDK ka `client.messages.parse(..., output_format=PydanticModel)` helper); tools ke liye `"strict": True`. OpenAI mein `response_format={"type": "json_schema", "json_schema": {..., "strict": True}}`.
Schema ka source of truth ek **Pydantic model** rakho: `Model.model_json_schema()` se schema, `Model.model_validate_json()` se validation.

### Why it matters for an FDE
Customer ka downstream system (CRM, ticketing, core banking) free text nahi samajhta. Ek invalid JSON = failed job, ya worse, galat field silently galat system mein. CP2 gate bhi yahi hai: 50 calls, zero invalid JSON.

### Key concepts
- **Three levels** -- prompt-only ("reply in JSON", weakest) < JSON mode (valid JSON, schema nahi) < schema-constrained structured outputs (strongest).
- **Strict schema rules** -- `additionalProperties: false`, saare fields `required`, enums for closed sets; Pydantic mein `ConfigDict(extra="forbid")` + `Literal`.
- **Still validate** -- API constraint ke baad bhi `model_validate_json` chalao: refusals, `max_tokens` truncation, unsupported schema keywords, ya provider bug.
- **Check stop_reason** -- `max_tokens` pe output adhoora JSON hoga; `refusal` pe JSON hoga hi nahi. Parse se pehle check karo.
- **Schema limits** -- har provider har JSON Schema keyword support nahi karta (jaise kuch formats, recursive refs); check the docs for your version.

### Code example
`pip install pydantic jsonschema`

> Needs API key for the real version: ANTHROPIC_API_KEY (or OPENAI_API_KEY)

```python
# runnable
import json
from typing import Literal

import jsonschema
from pydantic import BaseModel, ConfigDict, Field, ValidationError


class FraudTriage(BaseModel):
    model_config = ConfigDict(extra="forbid")          # -> additionalProperties: false
    risk: Literal["low", "medium", "high"]
    score: float = Field(ge=0, le=1)
    reasons: list[str] = Field(max_length=5)


SCHEMA = FraudTriage.model_json_schema()


class FakeLLM:
    """Mimics client.messages.create(...). No network. Without output_config it behaves like
    a chatty model; with a json_schema format it returns schema-shaped JSON (simulated)."""
    def create(self, model, max_tokens, messages, output_config=None):
        if output_config and output_config["format"]["type"] == "json_schema":
            text = '{"risk": "high", "score": 0.91, "reasons": ["new device", "foreign IP"]}'
        else:
            fence = "`" * 3                            # markdown code fence
            text = f'Sure! Here is the JSON:\n{fence}json\n{{"risk": "high-ish", "score": "0.9"}}\n{fence}'
        return {"stop_reason": "end_turn", "content": [{"type": "text", "text": text}]}


def triage(llm, txn: str, enforce: bool) -> FraudTriage:
    kwargs = {"output_config": {"format": {"type": "json_schema", "schema": SCHEMA}}} if enforce else {}
    resp = llm.create(model="fake", max_tokens=500,
                      messages=[{"role": "user", "content": f"Assess fraud risk: {txn}"}], **kwargs)
    if resp["stop_reason"] in ("max_tokens", "refusal"):
        raise RuntimeError(f"no usable JSON: stop_reason={resp['stop_reason']}")
    text = "".join(b["text"] for b in resp["content"] if b["type"] == "text")
    return FraudTriage.model_validate_json(text)      # our own check, always


print("schema keys:", sorted(SCHEMA["properties"]), "additionalProperties =", SCHEMA["additionalProperties"])
assert SCHEMA["additionalProperties"] is False and set(SCHEMA["required"]) == {"risk", "score", "reasons"}

llm = FakeLLM()
try:
    triage(llm, "card 4111 used in 2 countries in 5 min", enforce=False)
    raise AssertionError("prompt-only output should not validate")
except ValidationError as e:
    print("prompt-only failed:", e.errors()[0]["type"])

ok = triage(llm, "card 4111 used in 2 countries in 5 min", enforce=True)
print("enforced:", ok.model_dump())
assert ok.risk == "high" and 0 <= ok.score <= 1

# Same schema, validated with a plain JSON Schema validator (what the API enforces).
jsonschema.validate(ok.model_dump(), SCHEMA)
bad = {"risk": "high", "score": 1.7, "reasons": [], "debug": "x"}
errors = sorted(e.message for e in jsonschema.Draft202012Validator(SCHEMA).iter_errors(bad))
print("jsonschema errors:", errors)
assert len(errors) == 2                               # score > 1 and extra key
print("OK: schema from Pydantic, enforced via API config, validated locally")
```

- `ConfigDict(extra="forbid")` se schema mein `additionalProperties: false` aata hai -- strict modes ye maangte hain, aur model extra keys nahi bana sakta.
- `Literal[...]` -> JSON Schema `enum`; `Field(ge=0, le=1)` -> `minimum`/`maximum`. Ek Pydantic class = API schema + local validator.
- `output_config={"format": {"type": "json_schema", ...}}` -- real Anthropic API ka shape; FakeLLM sirf iski presence pe behave badalta hai (simulation).
- `stop_reason` check parse se pehle -- truncated ya refused output ko "invalid JSON" bug samajh ke debug mat karo.
- `jsonschema` se same schema dobara check -- dikhata hai ki Pydantic schema plain JSON Schema hai jo koi bhi service validate kar sakti hai.

```python
# real version -- not run here, needs: pip install anthropic pydantic
import os
import anthropic

MODEL = os.environ.get("LLM_MODEL", "<your-model-id>")
client = anthropic.Anthropic()
msgs = [{"role": "user", "content": "Assess fraud risk: card 4111 used in 2 countries in 5 min"}]

# Option A: SDK helper, returns a validated Pydantic object
resp = client.messages.parse(model=MODEL, max_tokens=1000, messages=msgs, output_format=FraudTriage)
result = resp.parsed_output

# Option B: raw JSON Schema
resp = client.messages.create(model=MODEL, max_tokens=1000, messages=msgs,
                              output_config={"format": {"type": "json_schema", "schema": SCHEMA}})
text = next(b.text for b in resp.content if b.type == "text")
result = FraudTriage.model_validate_json(text)
```

OpenAI equivalent: `response_format={"type": "json_schema", "json_schema": {"name": "fraud_triage", "schema": SCHEMA, "strict": True}}` (or the SDK's Pydantic `parse` helper). Supported schema features differ by provider -- check the docs.

### Mini-exercise (30-60 min)
CP2 capstone core: `omniguard/schemas.py` + `omniguard/llm.py`.
- `TriageResult` Pydantic model (category Literal, risk score 0-1, short summary max 300 chars, `extra="forbid"`).
- `call_structured(llm, text) -> TriageResult` jo `output_config` json_schema bheje, `stop_reason` check kare, aur `model_validate_json` kare.
- FastAPI endpoint `POST /triage` (M02) jo validated JSON return kare; invalid ho to 502 with a safe error message (raw model text nahi).
- Acceptance: pytest with FakeLLM -- valid path 200, chatty/fenced output 502, schema mein `additionalProperties` false. Gate prep: script `scripts/gate.py` jo 50 calls chalaye aur invalid count print kare.

### Common pitfalls
- Regex se markdown fences kaat ke "fix" karna -- symptom chhupta hai, schema violation (wrong types) phir bhi aage jaata hai.
- Pydantic model aur API schema alag-alag haath se likhna -- drift. Ek hi source of truth: `model_json_schema()`.
- Invalid model output ko as-is error response mein return/log karna -- usme customer data ho sakta hai (M13-14).

### Checklist before moving on
- [ ] Prompt-only JSON, JSON mode aur schema-constrained output ka fark bata sakta hoon.
- [ ] Pydantic model se strict JSON Schema generate kar sakta hoon (`extra="forbid"`, Literal, bounds).
- [ ] Parse se pehle `stop_reason` check karta hoon.
- [ ] API enforcement ke baad bhi local validation chalata hoon.

### Related
- M02-02 Pydantic data validation
- M05-07 Defining complex nested Pydantic models
- M05-09 Handling and retrying output parsing errors gracefully
- M05-11 Defining precise function schemas for LLMs

### Self-quiz
1. Agar API schema enforce kar raha hai, to `model_validate_json` dobara kyun chalana?
2. `stop_reason == "max_tokens"` pe aapka parser kya karega, aur kyun ye retry ka sahi case ho sakta hai ya nahi?
3. `extra="forbid"` hatane se downstream service pe kya risk aata hai?
4. Customer ka schema 40 optional fields ka hai. Strict mode ke rules ke saath aap ise kaise design karoge?
