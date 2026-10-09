# Prerequisites

## HTTP methods and status codes

> Diagnostic | Fast CP1 / Slow CP1 | ~15 min | Pass = move on. Fail = study only this, then re-test.

LLM provider ka 429 aur 503 alag handle karna hai, customer ka 401 aur 403 alag debug karna hai. Status codes galat padhe to retries galat hongi aur bill ya outage dono badhenge.

### Self-test (answer without looking anything up)
1. Har code ka matlab ek line mein: 200, 201, 204, 301, 400, 401, 403, 404, 409, 422, 429, 500, 503.
2. 401 vs 403: token expired hai to kaun sa? Token valid hai par role "viewer" hai to kaun sa?
3. 400 vs 422 vs 409: JSON parse nahi hua / field `qty=-1` / email pehle se registered -- kaun sa kab?
4. Kaun se codes pe client ko retry karna chahiye aur kaun se pe kabhi nahi? `Retry-After` header kis code ke saath aata hai?
5. `GET`, `POST`, `PUT`, `PATCH`, `DELETE` -- kaun sa body bhejta hai, kaun sa idempotent hai?

### Prove it in code
Run karne se pehle `classify()` ka output har code ke liye predict karo.

```python
# runnable
from fastapi import FastAPI, HTTPException, Response
from fastapi.testclient import TestClient
from pydantic import BaseModel, Field

def classify(code: int) -> str:
    """Retry policy an LLM/HTTP client should use."""
    if code in (429, 503, 502, 504):
        return "retry-with-backoff"      # honour Retry-After if present
    if 200 <= code < 300:
        return "ok"
    if 300 <= code < 400:
        return "follow-redirect"
    return "fail-fast"                   # 4xx: fix the request; 500: alert, maybe one retry

expected = {200: "ok", 201: "ok", 204: "ok", 301: "follow-redirect", 400: "fail-fast",
            401: "fail-fast", 403: "fail-fast", 404: "fail-fast", 409: "fail-fast",
            422: "fail-fast", 429: "retry-with-backoff", 500: "fail-fast", 503: "retry-with-backoff"}
assert {c: classify(c) for c in expected} == expected

app = FastAPI()
USERS = {"asha@x.com"}

class UserIn(BaseModel):
    email: str
    age: int = Field(ge=18)

@app.post("/users", status_code=201)
def create(u: UserIn):
    if u.email in USERS:
        raise HTTPException(409, "email already exists")
    USERS.add(u.email)
    return {"email": u.email}

@app.delete("/users/{email}", status_code=204)
def delete(email: str):
    USERS.discard(email)
    return Response(status_code=204)

c = TestClient(app)
assert c.post("/users", json={"email": "b@x.com", "age": 30}).status_code == 201
assert c.post("/users", json={"email": "b@x.com", "age": 30}).status_code == 409
assert c.post("/users", json={"email": "c@x.com", "age": 5}).status_code == 422
assert c.post("/users", content=b"{bad json", headers={"content-type": "application/json"}).status_code == 422
assert c.delete("/users/b@x.com").status_code == 204
print("http codes: all checks passed")
```

Note: FastAPI malformed JSON pe bhi 422 deta hai; bahut se APIs isko 400 dete hain. Dono dikhenge -- customer ka contract padho.

### Pass criteria
- Q1 mein 13 mein se kam se kam 12 sahi, aur Q2 (401 vs 403) bilkul sahi.
- Q4 mein aapne 429/503 ko retryable aur 400/401/403/422 ko non-retryable bataya.

### If you failed
Study: https://developer.mozilla.org/en-US/docs/Web/HTTP (pages: HTTP response status codes, HTTP request methods, Retry-After).

30-min plan:
- 15 min -- MDN status codes page: upar ke 13 codes ka description padho aur flashcards banao.
- 5 min -- MDN `Retry-After` header page.
- 10 min -- `classify()` mein exponential backoff + jitter add karo (sirf logic, network nahi), phir re-test.
