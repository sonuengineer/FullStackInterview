# Modern API Development

## Pydantic data validation

> Core | Fast CP2 / Slow CP2 | ~1.2 h | Builds on: M02-01, M01-03

### Kahani
Ek hospital chain apne discharge summaries aapki API pe upload karti hai taaki LLM unka summary bana sake.
Unka integration team JSON bhejta hai -- kabhi `"pages": "12"` (string), kabhi `"classification": "Confidential "` (trailing space), kabhi extra field `"patient_ssn"` jo aapne maanga hi nahi tha.
Purani Node service mein zod schema tha, lekin response mein poora DB row chala jaata tha -- internal `storage_path` aur `owner_email` bhi.
Security review ne pakda: "Input mein unknown fields accept ho rahe hain aur output mein internal fields leak ho rahe hain." Dono taraf ka contract strict chahiye.

### What it is
**Pydantic v2** = Python ka validation + serialization library; class banao, type hints likho, aur `model_validate()` input ko parse + validate karke typed object deta hai (Rust core, fast).
FastAPI request body ko Pydantic model se validate karta hai (galat -> 422) aur `response_model` se output ko filter karta hai. Ye class-validator + class-transformer (NestJS) ya zod ka Python version samjho.

### Why it matters for an FDE
Customer data kabhi clean nahi hota. Boundary pe strict model nahi to garbage DB tak jaata hai, aur response_model nahi to PII/internal fields client tak leak hote hain -- dono audit findings hain.

### Key concepts
- **`Annotated[str, Field(min_length=3)]`** -- constraint type ke saath; zod ka `z.string().min(3)`.
- **Lax vs strict mode** -- default lax: `"12"` -> `12` coerce hota hai. `model_config = ConfigDict(strict=True)` ya `StrictInt` se coercion band.
- **`extra="forbid"`** -- unknown fields pe error. Default `"ignore"` chupchaap drop karta hai -- typo wale fields bhi.
- **`@field_validator` / `@model_validator`** -- custom rule ek field pe ya cross-field (jaise `from <= to`).
- **In / Out models alag** -- `DocumentIn` (client kya bhej sakta hai) aur `DocumentOut` (client kya dekh sakta hai); internal fields kabhi Out mein nahi.

### Code example
`pip install fastapi httpx pydantic pytest`

```python
# runnable
from datetime import date
from typing import Annotated, Literal

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

Classification = Literal["public", "internal", "confidential"]


class DocumentIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    title: Annotated[str, Field(min_length=3, max_length=200)]
    classification: Classification = "internal"
    pages: Annotated[int, Field(gt=0, le=5000)]
    tags: list[str] = []
    valid_from: date
    valid_to: date | None = None

    @field_validator("tags")
    @classmethod
    def normalize_tags(cls, v: list[str]) -> list[str]:
        return sorted({t.strip().lower() for t in v if t.strip()})

    @model_validator(mode="after")
    def check_dates(self):
        if self.valid_to and self.valid_to < self.valid_from:
            raise ValueError("valid_to must be on or after valid_from")
        return self


class DocumentOut(BaseModel):
    id: int
    title: str
    classification: Classification
    tags: list[str]


class DocumentRow(DocumentOut):        # what the DB has -- never return this directly
    storage_path: str
    owner_email: str


raw = {"title": "  Discharge SOP ", "classification": "confidential", "pages": "12",
       "tags": ["Cardio", "cardio ", ""], "valid_from": "2026-01-01"}
doc = DocumentIn.model_validate(raw)
assert doc.title == "Discharge SOP" and doc.pages == 12 and doc.tags == ["cardio"]
assert doc.valid_from == date(2026, 1, 1)                     # str -> date parsed

with pytest.raises(ValidationError) as ei:                     # fails the script if no error
    DocumentIn.model_validate({**raw, "patient_ssn": "123-45-6789", "pages": 0})
errs = {(err["loc"][0], err["type"]) for err in ei.value.errors()}
assert errs == {("pages", "greater_than"), ("patient_ssn", "extra_forbidden")}, errs

with pytest.raises(ValidationError, match="valid_to must be on or after valid_from"):
    DocumentIn.model_validate({**raw, "valid_to": "2025-01-01"})

app = FastAPI()


@app.post("/documents", response_model=DocumentOut, status_code=201)
def create(doc: DocumentIn):
    row = DocumentRow(id=1, title=doc.title, classification=doc.classification, tags=doc.tags,
                      storage_path="s3://phi-bucket/1.pdf", owner_email="dr.rao@hospital.example")
    return row                          # response_model filters out the internal fields


c = TestClient(app)
r = c.post("/documents", json=raw)
assert r.status_code == 201 and set(r.json()) == {"id", "title", "classification", "tags"}
assert "storage_path" not in r.text and "owner_email" not in r.text
bad = c.post("/documents", json={**raw, "classification": "secret"})
assert bad.status_code == 422 and bad.json()["detail"][0]["loc"] == ["body", "classification"]
print(doc.model_dump(mode="json"))
print("OK: coercion, strip, extra=forbid, cross-field rule, response filtering")
```

- `ConfigDict(extra="forbid", str_strip_whitespace=True)` -- `patient_ssn` jaisa unexpected field reject; `"  Discharge SOP "` trim ho gaya.
- `"pages": "12"` -> `12` -- lax mode coercion. Agar customer contract strict hai to `strict=True` lagao; dono ka decision conscious hona chahiye.
- `ei.value.errors()` -- har error ka `loc` aur `type` deta hai; isi se FastAPI ka 422 `detail` banta hai, aur aap apne logs/metrics mein error types count kar sakte ho.
- `@model_validator(mode="after")` -- poora object ban jaane ke baad cross-field check; zod ke `.refine()` jaisa.
- `response_model=DocumentOut` -- handler ne `DocumentRow` return kiya, lekin client ko sirf 4 fields mile. NestJS mein ye kaam `ClassSerializerInterceptor` + `@Exclude()` karta.
- `model_dump(mode="json")` -- date ko `"2026-01-01"` string bana deta hai; JSON logging ya queue pe bhejne se pehle useful.

### Mini-exercise (30-60 min)
`omniguard` repo mein `app/schemas.py` banao.
- `DocumentCreate` (title 3-200, `classification: Literal[...]`, `source: HttpUrl | None`, `tags` normalized, `extra="forbid"`), `DocumentUpdate` (PUT ke liye -- saare fields required), `DocumentOut` (id, title, classification, tags, created_at).
- `Settings` model abhi simple `BaseModel` rakho (M02-03 mein DI se inject hoga).
- M02-01 ke in-memory routes ko in models se type karo: `POST /documents` -> 201 + `response_model=DocumentOut`.
- Acceptance: unknown field -> 422; `classification: "secret"` -> 422; internal field `storage_path` kabhi response mein nahi (ek `assert "storage_path" not in r.text` likh ke dekho).

### Common pitfalls
- Ek hi model input aur output dono ke liye -- kal DB mein naya internal column aaya aur wo seedha API se leak. In/Out alag rakho.
- Pydantic v1 code copy karna (`.dict()`, `.parse_obj()`, `@validator`, `class Config`) -- v2 mein `model_dump()`, `model_validate()`, `@field_validator`, `model_config` use karo; purane naam deprecation warnings dete hain.
- ValidationError ko poore input ke saath log karna -- `input` field mein PII ho sakti hai. Log mein sirf `loc` aur `type` rakho.

### Checklist before moving on
- [ ] Lax aur strict mode ka fark ek example se bata sakta hoon.
- [ ] `field_validator` aur `model_validator` mein kab kaunsa use karna hai, pata hai.
- [ ] Mere API mein request aur response models alag hain.
- [ ] Pydantic v1 vs v2 APIs pehchaan sakta hoon.

### Related
- M02-01 Path and query parameters
- M02-03 Dependency injection
- M02-05 Building scalable CRUD endpoints
- M13-14 Safe logging (never log PII or prompts)

### Self-quiz
1. `extra="ignore"` (default) production mein kis tarah ka silent bug la sakta hai? Ek client-side typo ka example do.
2. Aapke customer ka billing system `"amount": "100.50"` bhejta hai. Lax mode mein `float` field ke saath kya hoga, aur paise ke liye `float` kyun galat choice hai?
3. `response_model` hata do aur handler DB row return kare -- kya badlega? Ye kis security category ka issue hai?
4. Cross-field rule `field_validator` mein kyun reliably nahi likha ja sakta?
