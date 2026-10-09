# LLM Fundamentals & Prompting

## Defining complex nested Pydantic models

> Core | Fast CP2 / Slow CP3 | ~1.2 h | Builds on: M02-02, M05-06

### Kahani
Ek insurance customer chahta hai ki claim emails + attached invoice text se LLM ek poora claim record nikaale: claimant, policy, multiple incidents, har incident ke multiple line items, currency ke saath amounts.
Pehla version flat tha: `item1_name, item1_amount, item2_name...` -- 4 items ke baad toot gaya. Doosre version mein `amount: str` tha -- "Rs 1,200", "1200 INR", "12k" sab aaye. Teesre mein total aur line items ka sum match nahi karta tha, aur kisi ne notice nahi kiya jab tak finance ne reconcile nahi kiya.
Aapko ek nested, typed model chahiye jo real-world shape pakde, LLM ko clear schema de, aur galat data ko andar aate hi reject kare.

### What it is
**Nested Pydantic model** = models ke andar models aur unki lists (`Claim -> list[Incident] -> list[LineItem] -> Money`). `model_json_schema()` inhe JSON Schema `$defs` + `$ref` mein convert karta hai, jo structured-output APIs ko diya jaata hai.
Validators (`field_validator`, `model_validator`) business rules (currency format, totals match) ko validation mein hi daal dete hain.

### Why it matters for an FDE
Enterprise data hamesha nested hota hai (orders -> lines, claims -> incidents, patients -> encounters). Galat shape = downstream ETL mein manual cleanup; sahi typed model = LLM output seedha customer ke system mein jaa sakta hai.

### Key concepts
- **Small reusable models** -- `Money`, `Party`, `LineItem` alag classes; schema mein `$defs` banti hain aur model unhe reuse karta hai.
- **Money as integer minor units** -- `amount_minor: int` (paise/cents) + `currency: Literal[...]`; floats aur free-text amounts nahi.
- **Nullable vs optional** -- strict structured outputs mein usually saare fields required hote hain; "maybe missing" ko `str | None` (required but nullable) se express karo.
- **`Field(description=...)`** -- description schema mein jaati hai aur model ke liye instruction ka kaam karti hai; har ambiguous field pe likho.
- **Cross-field rules** -- `model_validator(mode="after")` se total == sum(lines) jaise checks; error message model ko retry mein wapas bhej sakte ho (M05-09).

### Code example
`pip install pydantic`

> Needs API key for the real version: ANTHROPIC_API_KEY (or OPENAI_API_KEY)

```python
# runnable
import json
from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Money(Strict):
    amount_minor: int = Field(ge=0, description="Amount in minor units, e.g. paise or cents")
    currency: Literal["INR", "USD", "EUR"]


class LineItem(Strict):
    description: str = Field(max_length=120)
    cost: Money


class Incident(Strict):
    occurred_on: date
    kind: Literal["theft", "accident", "fire", "water_damage"]
    items: list[LineItem] = Field(min_length=1)


class Party(Strict):
    full_name: str
    phone: str | None = Field(description="E.164 phone, null if not in the email")


class Claim(Strict):
    policy_number: str = Field(pattern=r"^POL-\d{6}$")
    claimant: Party
    incidents: list[Incident] = Field(min_length=1)
    total: Money

    @model_validator(mode="after")
    def total_matches_items(self):
        costs = [li.cost for inc in self.incidents for li in inc.items]
        if any(c.currency != self.total.currency for c in costs):
            raise ValueError("all line items must use the total's currency")
        if sum(c.amount_minor for c in costs) != self.total.amount_minor:
            raise ValueError("total.amount_minor must equal the sum of all line item costs")
        return self


schema = Claim.model_json_schema()
print("defs:", sorted(schema["$defs"]))
assert {"Money", "LineItem", "Incident", "Party"} <= set(schema["$defs"])
assert "phone" in schema["$defs"]["Party"]["required"]          # required but nullable

# What a structured-output call would return (fake LLM output, no network)
fake_llm_json = json.dumps({
    "policy_number": "POL-004211",
    "claimant": {"full_name": "Asha Rao", "phone": None},
    "incidents": [{"occurred_on": "2026-03-02", "kind": "theft", "items": [
        {"description": "Laptop", "cost": {"amount_minor": 8500000, "currency": "INR"}},
        {"description": "Phone", "cost": {"amount_minor": 2500000, "currency": "INR"}}]}],
    "total": {"amount_minor": 11000000, "currency": "INR"},
})
claim = Claim.model_validate_json(fake_llm_json)
print("parsed:", claim.claimant.full_name, claim.incidents[0].occurred_on, claim.total.amount_minor)
assert isinstance(claim.incidents[0].occurred_on, date)

bad = json.loads(fake_llm_json)
bad["total"]["amount_minor"] = 9999
bad["incidents"][0]["items"][0]["cost"]["currency"] = "inr"
try:
    Claim.model_validate(bad)
    raise AssertionError("should fail")
except ValidationError as e:
    locs = [".".join(map(str, err["loc"])) for err in e.errors()]
    print("errors at:", locs)
    assert "incidents.0.items.0.cost.currency" in locs   # exact path, useful for retries
print("OK: nested schema with $defs, typed parsing, cross-field validation")
```

- `Strict` base class -- har nested model `extra="forbid"` inherit karta hai; ek jagah rule, sab jagah lagu.
- `Money.amount_minor: int` -- "12k" ya "Rs 1,200" type errors validation pe hi ruk jaate hain; maths integers mein, rounding bug nahi.
- `phone: str | None` bina default -- schema mein required + nullable; model ko field bhejna hi padega, value null ho sakti hai.
- `model_validator(mode="after")` -- total vs sum check. Pehle field-level errors aate hain (currency "inr"); jab wo theek honge tab ye rule chalega.
- `err["loc"]` exact path deta hai (`incidents.0.items.0.cost.currency`) -- retry prompt mein yahi bhejoge.

```python
# real version -- not run here, needs: pip install anthropic pydantic
import os
import anthropic

MODEL = os.environ.get("LLM_MODEL", "<your-model-id>")
client = anthropic.Anthropic()
email_text = open("claim_email.txt", encoding="utf-8").read()
resp = client.messages.parse(
    model=MODEL, max_tokens=2000, output_format=Claim,
    system="Extract the insurance claim. Amounts in minor units. Use null when a value is absent.",
    messages=[{"role": "user", "content": email_text}],
)
claim = resp.parsed_output        # Claim instance (still re-check business rules)
```

Deep nesting, recursion and some keywords (`pattern`, min/max) may be unsupported or ignored by a provider's constrained decoding -- check the docs; your Pydantic validation still enforces them.

### Mini-exercise (30-60 min)
`omniguard/schemas.py` mein `TriageResult` ko nested banao.
- `TriageResult -> customer: CustomerRef`, `findings: list[Finding]` (each with `severity` Literal, `evidence: str`), `actions: list[Action]`, aur `money_at_risk: Money | None`.
- Rule: agar koi `Finding.severity == "critical"` hai to `actions` khaali nahi ho sakta (model_validator).
- Acceptance: pytest -- 3 valid fake JSONs parse, 3 invalid (wrong currency case, missing action for critical, extra key) fail with exact `loc` paths; `model_json_schema()` snapshot test `tests/snapshots/triage_schema.json` mein (schema drift pakadne ke liye).

### Common pitfalls
- Amounts ko `float` rakhna -- 0.1 + 0.2 problems, aur model "1,200.50" strings deta hai. Minor units integer ya `Decimal` with clear rules.
- Bahut gehri nesting (6-7 levels) aur 100+ fields ek call mein -- quality girti hai aur kuch providers ke schema limits hit hote hain; zaroorat ho to 2 calls mein todo.
- Validator mein external call (DB lookup) karna -- validation slow aur flaky; aise checks validation ke baad service layer mein karo.

### Checklist before moving on
- [ ] Nested models + lists bana ke `$defs` wala schema samajh sakta hoon.
- [ ] Nullable-required aur optional-with-default ka fark jaanta hoon.
- [ ] Money ko safe type mein model karta hoon.
- [ ] Cross-field business rule `model_validator` mein likh sakta hoon aur error `loc` padh sakta hoon.

### Related
- M02-02 Pydantic data validation
- M05-06 Enforcing strict JSON output schemas via APIs
- M05-08 Validating LLM responses natively against type hints
- M05-10 Using discriminator fields for union types

### Self-quiz
1. `phone: str | None` aur `phone: str | None = None` -- JSON Schema mein aur LLM behaviour mein kya fark aayega?
2. Total-mismatch rule ko field validator mein kyun nahi likh sakte?
3. Model ne currency "inr" bheji. Isse case-insensitive accept karna chahiye ya reject? Trade-off batao.
4. 120-field customer form ko ek schema mein extract karna hai. Aap kaise todoge aur kyun?
