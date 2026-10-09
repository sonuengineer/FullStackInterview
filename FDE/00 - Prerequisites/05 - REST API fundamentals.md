# Prerequisites

## REST API fundamentals

> Diagnostic | Fast CP1 / Slow CP1 | ~15 min | Pass = move on. Fail = study only this, then re-test.

FDE ke roop mein aap customer ke systems ko AI se jodoge -- aur har joint ek API hota hai. Yeh test check karta hai ki aapka resource design aur idempotency ka intuition solid hai.

### Self-test (answer without looking anything up)
1. Yeh endpoints REST-style mein dobara design karo: `POST /getUserOrders`, `POST /createOrder`, `GET /deleteOrder?id=5`.
2. Kaun se HTTP methods idempotent hain aur kaun se safe? `PUT` aur `PATCH` mein farak?
3. Payment API pe client ka `POST /payments` timeout ho gaya. Woh retry kare to double charge kaise rokoge? (hint: `Idempotency-Key` header)
4. Pagination ke do tarike likho (offset vs cursor). Badi, badalti table pe cursor kyun better hai?
5. API versioning ke do common tarike? Breaking change kya hota hai -- ek example do.

### Prove it in code
Run karne se pehle predict karo: dusri baar same key ke saath POST karne pe kitne orders banenge?

```python
# runnable
from fastapi import FastAPI, Header, HTTPException, Response
from fastapi.testclient import TestClient
from pydantic import BaseModel

app = FastAPI()
ORDERS: dict[int, dict] = {}
SEEN_KEYS: dict[str, int] = {}          # idempotency key -> order id (use Redis/DB in prod)

class OrderIn(BaseModel):
    sku: str
    qty: int

@app.post("/orders", status_code=201)
def create_order(body: OrderIn, response: Response, idempotency_key: str = Header(...)):
    if idempotency_key in SEEN_KEYS:     # retry: return the original result, no new row
        response.status_code = 200
        return ORDERS[SEEN_KEYS[idempotency_key]]
    oid = len(ORDERS) + 1
    ORDERS[oid] = {"id": oid, **body.model_dump()}
    SEEN_KEYS[idempotency_key] = oid
    response.headers["Location"] = f"/orders/{oid}"
    return ORDERS[oid]

@app.get("/orders/{oid}")
def get_order(oid: int):
    if oid not in ORDERS:
        raise HTTPException(404, "order not found")
    return ORDERS[oid]

c = TestClient(app)
r1 = c.post("/orders", json={"sku": "A1", "qty": 2}, headers={"Idempotency-Key": "k-1"})
r2 = c.post("/orders", json={"sku": "A1", "qty": 2}, headers={"Idempotency-Key": "k-1"})
assert r1.status_code == 201 and r1.headers["location"] == "/orders/1"
assert r2.status_code == 200 and r2.json() == r1.json() and len(ORDERS) == 1
assert c.get("/orders/1").json()["qty"] == 2
assert c.get("/orders/42").status_code == 404
assert c.post("/orders", json={"sku": "A1", "qty": 2}).status_code == 422   # missing header
print("rest: all checks passed")
```

### Pass criteria
- Self-test mein 4/5 sahi; Q1 mein nouns + methods (`GET /users/{id}/orders`, `POST /orders`, `DELETE /orders/5`) aaye.
- Q3 ka answer idempotency key + stored result tha, sirf "client retry mat kare" nahi.

### If you failed
Study: https://developer.mozilla.org/en-US/docs/Web/HTTP (pages: HTTP request methods, Idempotent, Safe).

30-min plan:
- 10 min -- MDN "HTTP request methods" + glossary "Idempotent" aur "Safe (HTTP Methods)".
- 10 min -- Stripe-style idempotency keys ke baare mein padho; socho key kitni der store karoge aur kyun.
- 10 min -- apne kisi purane Express API ke 5 routes ko REST checklist pe review karo, phir re-test.
