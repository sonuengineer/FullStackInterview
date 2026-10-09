# LLM Fundamentals & Prompting

## Validating LLM responses natively against type hints

> Core | Fast CP2 / Slow CP3 | ~1.2 h | Builds on: M05-06, M05-07

### Kahani
Ek logistics customer ke codebase mein 30 chhote LLM helpers hain: `extract_tags(text) -> list[str]`, `score_lanes(...) -> dict[str, float]`, `parse_eta(...) -> datetime`. Har ek ke liye alag BaseModel wrapper banana kisi ne nahi kiya -- sab `json.loads()` karke "hope for the best" chal rahe the.
Ek din `score_lanes` ne `{"DEL-BOM": "0.8"}` (string) return kiya, aur routing code ne `"0.8" > 0.5` pe TypeError phenka -- production routing 40 minute band.
Function signature mein type hint pehle se likha tha. Kaash wahi hint validation bhi kar deta.

### What it is
Pydantic v2 ka **`TypeAdapter`** kisi bhi Python type hint ko validator bana deta hai -- `list[str]`, `dict[str, float]`, `TypedDict`, `Literal`, `Annotated[int, Field(ge=0)]`, dataclasses -- bina BaseModel class likhe. `TypeAdapter(T).validate_json(text)` parse + validate ek step mein karta hai, aur `.json_schema()` wahi schema deta hai jo LLM API ko bhejna hai.
Function ke return annotation (`typing.get_type_hints`) se type nikaal ke ek generic "LLM function" wrapper bana sakte ho.

### Why it matters for an FDE
Customer codebases mein chhote-chhote LLM calls har jagah hote hain. Ek generic, type-hint-driven validator har call ko ek line mein safe bana deta hai -- naya helper likhne wale ko validation yaad rakhne ki zaroorat nahi.

### Key concepts
- **`TypeAdapter(T)`** -- kisi bhi type ke liye `validate_python`, `validate_json`, `json_schema`, `dump_json`. Adapter banana mehnga hai: module level pe ek baar banao, reuse karo.
- **Lax vs strict** -- default lax mode `"0.8"` ko `0.8` mein coerce kar deta hai; `strict=True` reject karega. LLM output ke liye decide karo kaunsa chahiye.
- **`Annotated` constraints** -- `Annotated[float, Field(ge=0, le=1)]` se type hint hi range check ban jaata hai.
- **`TypedDict`** -- dict-shaped output ke liye lightweight; `total=False` / `NotRequired` se optional keys.
- **Return-annotation driven** -- `get_type_hints(fn)["return"]` se type lo -> schema bhejo -> response usi type se validate karo.

### Code example
`pip install pydantic`

> Needs API key for the real version: ANTHROPIC_API_KEY (or OPENAI_API_KEY)

```python
# runnable
import json
from datetime import datetime
from functools import wraps
from typing import Annotated, Literal, TypedDict, get_type_hints

from pydantic import Field, TypeAdapter, ValidationError

Score = Annotated[float, Field(ge=0, le=1)]

class Eta(TypedDict):
    shipment_id: str
    eta: datetime
    confidence: Literal["low", "medium", "high"]

class FakeLLM:
    """Mimics a structured-output call: returns JSON text for a given schema. No network."""
    replies = {
        "score_lanes": '{"DEL-BOM": "0.8", "BLR-MAA": 0.35}',
        "extract_tags": '["fragile", "cold-chain", 42]',
        "parse_eta": '{"shipment_id": "S-77", "eta": "2026-05-01T14:30:00Z", "confidence": "high"}',
    }
    def create(self, name, schema, prompt):
        assert schema, "schema must be sent to the model"
        return {"content": [{"type": "text", "text": self.replies[name]}]}

def llm_function(llm, strict=False, name=None):
    """Decorator: the function's return type hint IS the output contract."""
    def deco(fn):
        hint = get_type_hints(fn, include_extras=True)["return"]   # keep Annotated[...]
        adapter = TypeAdapter(hint)                                 # built once
        schema = adapter.json_schema()
        @wraps(fn)
        def wrapper(*args):
            resp = llm.create(name or fn.__name__, schema, fn(*args))
            text = "".join(b["text"] for b in resp["content"] if b["type"] == "text")
            return adapter.validate_json(text, strict=strict)
        wrapper.schema = schema
        return wrapper
    return deco

llm = FakeLLM()

@llm_function(llm)
def score_lanes(lanes: list[str]) -> dict[str, Score]:
    return f"Score delay risk 0-1 for lanes: {lanes}"

@llm_function(llm, strict=True, name="score_lanes")
def score_lanes_strict(lanes: list[str]) -> dict[str, Score]:
    return f"Score delay risk 0-1 for lanes: {lanes}"

@llm_function(llm)
def extract_tags(text: str) -> list[Literal["fragile", "cold-chain", "hazmat"]]:
    return f"Tags for: {text}"

@llm_function(llm)
def parse_eta(text: str) -> Eta:
    return f"Extract ETA from: {text}"

print("schema:", json.dumps(score_lanes.schema))
assert score_lanes.schema["additionalProperties"]["maximum"] == 1   # Annotated survived
lax = score_lanes(["DEL-BOM", "BLR-MAA"])
print("lax  :", lax)
assert lax["DEL-BOM"] == 0.8 and isinstance(lax["DEL-BOM"], float)   # "0.8" coerced

try:
    score_lanes_strict(["DEL-BOM"])
    raise AssertionError("strict mode should reject a string score")
except ValidationError as e:
    print("strict:", e.errors()[0]["type"], e.errors()[0]["loc"])

try:
    extract_tags("box of vaccines")
    raise AssertionError("42 is not an allowed tag")
except ValidationError as e:
    print("tags :", e.errors()[0]["loc"], e.errors()[0]["type"])

eta = parse_eta("Shipment S-77 arrives May 1st afternoon")
print("eta  :", eta)
assert isinstance(eta["eta"], datetime) and eta["eta"].tzinfo is not None
print("OK: return type hints drive schema + validation")
```

- `Score = Annotated[float, Field(ge=0, le=1)]` -- reusable constrained type; schema mein `minimum`/`maximum` aata hai.
- `get_type_hints(fn, include_extras=True)` -- function ka return hint hi contract. `include_extras` ke bina `Annotated` ki `Field(ge, le)` chupchaap gayab ho jaati hai (schema mein bounds nahi aate). Adapter decorator time pe ek baar banta hai.
- Lax mode ne `"0.8"` ko float bana diya -- routing bug fix. Strict mode same input reject karta hai -- jab aap model ke type mistakes ko retry se fix karwana chahte ho (M05-09).
- `list[Literal[...]]` -- `42` ka error `loc` `(2,)` -- list index tak exact.
- `TypedDict` + `datetime` -- ISO string se timezone-aware `datetime` mil gaya, koi manual parsing nahi.

```python
# real version -- not run here, needs: pip install anthropic pydantic
import os
import anthropic

MODEL = os.environ.get("LLM_MODEL", "<your-model-id>")
client = anthropic.Anthropic()
adapter = TypeAdapter(dict[str, Score])
# Structured outputs usually need an object at the top level -- wrap non-object types.
wrapped = TypeAdapter(TypedDict("Out", {"result": dict[str, Score]}))
resp = client.messages.create(
    model=MODEL, max_tokens=500,
    messages=[{"role": "user", "content": "Score delay risk 0-1 for lanes DEL-BOM, BLR-MAA"}],
    output_config={"format": {"type": "json_schema", "schema": wrapped.json_schema()}},
)
text = next(b.text for b in resp.content if b.type == "text")
scores = wrapped.validate_json(text)["result"]
```

Top-level arrays/primitives and some `additionalProperties` forms may not be accepted by structured-output modes -- wrap in an object and check the docs for your provider.

### Mini-exercise (30-60 min)
`omniguard/typed_llm.py` mein `@llm_function(llm, strict=...)` decorator banao.
- Do helpers: `detect_language(text) -> Literal["en", "hi", "other"]` aur `extract_entities(text) -> list[EntityDict]` (TypedDict).
- Non-object return types ko automatically `{"result": ...}` mein wrap/unwrap karo, taaki structured-output API ko hamesha object schema mile.
- Acceptance: pytest -- adapter har call pe dobara nahi banta (counter/mock se prove), strict vs lax ka ek-ek test, invalid output pe `ValidationError` with `loc`.

### Common pitfalls
- Har call pe `TypeAdapter(...)` banana -- schema build CPU waste karta hai; module/decorator level pe cache karo.
- Lax mode ko bina soche use karna -- `"yes"` -> `True`, `"1"` -> `1` jaise coercions galat data ko "valid" bana sakte hain. Critical fields pe strict.
- `dict[str, Any]` return type -- validation kuch check hi nahi karta; "typed" dikhta hai, safe nahi hai.

### Checklist before moving on
- [ ] `TypeAdapter` se kisi bhi type hint ko validate aur schema mein convert kar sakta hoon.
- [ ] Lax aur strict mode ka fark aur kab kaunsa, bata sakta hoon.
- [ ] `Annotated` constraints aur `TypedDict` use kar sakta hoon.
- [ ] Return annotation se generic LLM wrapper bana sakta hoon.

### Related
- M05-06 Enforcing strict JSON output schemas via APIs
- M05-07 Defining complex nested Pydantic models
- M05-09 Handling and retrying output parsing errors gracefully
- M05-12 Parsing and validating tool arguments

### Self-quiz
1. `TypeAdapter` aur `BaseModel` -- kab kaunsa choose karoge?
2. Lax mode ne `"0.8"` accept kiya. Ek example do jahan lax coercion production mein galat decision karwa sakta hai.
3. Structured-output API ko top-level `list[str]` schema dena kyun problem ho sakta hai, aur fix kya hai?
4. Decorator mein adapter ko wrapper ke andar banaya to kya hoga 10k calls/min pe?
