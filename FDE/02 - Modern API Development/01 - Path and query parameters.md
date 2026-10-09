# Modern API Development

## Path and query parameters

> Core | Fast CP2 / Slow CP2 | ~1.2 h | Builds on: M01-03, M01-04

### Kahani
Ek private bank ke liye aap document search API bana rahe ho -- compliance team ko KYC aur AML policies dhoondhni hain.
Purana Express service `GET /documents/:id` pe `req.params.id` seedha SQL mein daal deta tha. Kisi ne `/documents/abc` hit kiya -> 500, stack trace log mein.
`?limit=100000` bheja -> poori table ek response mein, DB 20 second hang.
`?tag=kyc&tag=aml` bheja -> code ko kabhi string milti, kabhi array, aur filter galat chal gaya.
Customer ka CISO poochta hai: "Input validation kahan hai?" Aapko har parameter ka type, range aur shape API boundary pe hi lock karna hai.

### What it is
**Path parameter** = URL path ka hissa jo resource identify karta hai (`/documents/{doc_id}`) -- Express ka `req.params`.
**Query parameter** = `?` ke baad ka optional filter/sort/paging input (`?status=approved&limit=20`) -- Express ka `req.query`.
FastAPI mein dono function arguments hain; type hint + `Path()` / `Query()` se parsing aur validation free mein milti hai, aur galat input pe automatic 422.

### Why it matters for an FDE
Customer ke internal tools aapki API ko ajeeb inputs bhejenge. Boundary pe validation nahi hai to 500s, slow queries aur security review fail -- aur OpenAPI docs bhi galat banenge jo unki team integration ke liye use karti hai.

### Key concepts
- **Type hint = parser** -- `doc_id: int` likha to `"abc"` pe handler chalta hi nahi, 422 milta hai. Express mein `req.params` hamesha string hota hai.
- **Path vs query decision** -- path = "kaunsa resource" (required), query = "kaise dikhana hai" (filter, sort, page; usually optional with default).
- **`Annotated[int, Query(ge=1, le=100)]`** -- validation rules type ke saath; ye zod ke `z.number().min(1).max(100)` jaisa, par OpenAPI schema mein bhi jaata hai.
- **List query params** -- `?tag=a&tag=b` ke liye `Annotated[list[str], Query()]` chahiye; bina `Query()` ke FastAPI list ko body samajhta hai.
- **Route order** -- `/documents/search` ko `/documents/{doc_id}` se PEHLE declare karo, warna "search" ko int parse karne ki koshish -> 422.

### Code example
`pip install fastapi httpx`

```python
# runnable
from enum import Enum
from typing import Annotated

from fastapi import FastAPI, HTTPException, Path, Query
from fastapi.testclient import TestClient

DOCS = {
    1: {"id": 1, "title": "KYC policy", "tags": ["kyc", "policy"], "status": "approved"},
    2: {"id": 2, "title": "Loan SOP", "tags": ["loan"], "status": "draft"},
    3: {"id": 3, "title": "AML checklist", "tags": ["aml", "kyc"], "status": "approved"},
}


class Status(str, Enum):
    draft = "draft"
    approved = "approved"


app = FastAPI()


@app.get("/documents/search")          # declared BEFORE /documents/{doc_id}
def search(q: Annotated[str, Query(min_length=2, max_length=50)]):
    return [d for d in DOCS.values() if q.lower() in d["title"].lower()]


@app.get("/documents/{doc_id}")
def get_document(doc_id: Annotated[int, Path(ge=1, description="Document id")]):
    if doc_id not in DOCS:
        raise HTTPException(status_code=404, detail="document not found")
    return DOCS[doc_id]


@app.get("/documents")
def list_documents(
    status: Status | None = None,                       # optional, enum-checked
    tag: Annotated[list[str], Query()] = [],            # ?tag=kyc&tag=aml
    limit: Annotated[int, Query(ge=1, le=100)] = 20,    # hard cap protects the DB
):
    rows = [d for d in DOCS.values() if status is None or d["status"] == status]
    rows = [d for d in rows if all(t in d["tags"] for t in tag)]
    return {"items": rows[:limit], "count": len(rows)}


@app.get("/files/{file_path:path}")    # path converter: keeps the slashes
def get_file(file_path: str):
    return {"path": file_path}


c = TestClient(app)
assert c.get("/documents/2").json()["title"] == "Loan SOP"
assert c.get("/documents/99").status_code == 404
r = c.get("/documents/abc")                             # Express would pass "abc" through
assert r.status_code == 422 and r.json()["detail"][0]["loc"] == ["path", "doc_id"]
assert c.get("/documents/0").status_code == 422          # ge=1
assert c.get("/documents/search", params={"q": "kyc"}).json()[0]["id"] == 1
assert c.get("/documents/search", params={"q": "k"}).status_code == 422

body = c.get("/documents", params={"status": "approved", "tag": ["kyc", "aml"]}).json()
assert [d["id"] for d in body["items"]] == [3], body
assert c.get("/documents", params={"status": "deleted"}).status_code == 422
assert c.get("/documents", params={"limit": 100000}).status_code == 422
assert c.get("/files/policies/2026/kyc.pdf").json() == {"path": "policies/2026/kyc.pdf"}

spec = c.get("/openapi.json").json()["paths"]["/documents"]["get"]["parameters"]
limit_schema = next(p for p in spec if p["name"] == "limit")["schema"]
assert limit_schema["maximum"] == 100                   # validation is also documentation
print("OK: typed path + query params, 404 vs 422, list params, path converter")
```

- `doc_id: Annotated[int, Path(ge=1)]` -- conversion aur range check handler se pehle; `"abc"` aur `0` dono 422, aur error mein `loc: ["path", "doc_id"]` batata hai kaunsa field galat tha.
- 404 vs 422 -- 422 = "aapka input galat shape ka hai", 404 = "input sahi tha, resource nahi mila". Ye fark customer ke client developers ke liye debugging aasaan karta hai.
- `status: Status | None = None` -- Enum se allowed values lock; `?status=deleted` pe 422 aur OpenAPI mein dropdown.
- `tag: Annotated[list[str], Query()]` -- repeated keys list ban jaati hain. Bina `Query()` ke FastAPI ise request body maan leta.
- `limit` ka `le=100` -- unbounded page size production DB ka sabse common killer hai; cap API contract mein hi likh do.
- `/openapi.json` check -- jo rules aapne likhe wahi docs mein dikhte hain; Express + swagger-jsdoc mein ye do jagah maintain karna padta.

### Mini-exercise (30-60 min)
CP2 capstone shuru: apna `omniguard` repo banao (`omniguard/app/main.py`, `pyproject.toml` ya `requirements.txt`).
- `GET /health` -> `{"status": "ok", "version": "0.1.0"}`.
- `GET /documents` with `status` (Enum), `tag` (list), `limit` (1-100, default 20), `offset` (>= 0) -- abhi in-memory list se.
- `GET /documents/{doc_id}` -- 404 agar nahi mila; `GET /documents/search?q=` route order sahi rakho.
- Acceptance: `uvicorn app.main:app --reload` chalao, `/docs` mein saare params constraints ke saath dikhein; `curl "localhost:8000/documents/abc"` 422 de, `curl "localhost:8000/documents?limit=500"` 422 de. M02-02 mein in dicts ko Pydantic models se replace karoge.

### Common pitfalls
- Mutable default se darr ke `tag: list[str] = None` likh dena aur phir `None` handle bhool jaana -- FastAPI defaults ko copy karta hai, `= []` yahan safe hai.
- Sensitive data query string mein bhejna (`?api_key=...`, `?ssn=...`) -- query strings access logs, proxies aur browser history mein store hote hain. Secrets header mein, PII body mein.
- `limit` ka cap na lagana ya `offset` ko unbounded chhodna -- ek scraper customer ka DB hila dega. Deep paging ke liye cursor pagination (M02-05).

### Checklist before moving on
- [ ] Main bata sakta hoon kab path param aur kab query param use karna hai.
- [ ] Mujhe pata hai 422 kab aata hai aur 404 kab bhejna mera kaam hai.
- [ ] `Annotated[..., Query(...)]` se range, length aur list params bana sakta hoon.
- [ ] Route order wali galti pehchaan sakta hoon.

### Related
- M02-02 Pydantic data validation
- M02-05 Building scalable CRUD endpoints
- M02-10 Implementing URL-based vs Header-based API versioning
- M13-14 Safe logging (never log PII or prompts)

### Self-quiz
1. Express mein `req.params.id` aur FastAPI mein `doc_id: int` -- `"abc"` aane pe dono mein kya hota hai, aur kyun FastAPI wala behaviour production mein behtar hai?
2. `/documents/search` route `/documents/{doc_id}` ke BAAD declare kiya to `GET /documents/search?q=kyc` ka kya response aayega? Kyun?
3. Ek customer chahta hai ki "date range" se filter ho. Ise path mein rakhoge ya query mein? Validation kaise likhoge ki `from <= to`?
4. `limit` pe `le=100` lagane ke baad bhi `?offset=5000000` slow kyun ho sakta hai?
