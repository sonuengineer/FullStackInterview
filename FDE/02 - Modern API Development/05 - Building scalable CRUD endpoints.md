# Modern API Development

## Building scalable CRUD endpoints

> Core | Fast CP2 / Slow CP2 | ~1.2 h | Builds on: M02-01, M02-02, M02-03

### Kahani
Ek logistics customer ki ops team aapke document service pe 4 lakh SOPs aur shipping manifests load karti hai.
Unka dashboard `GET /documents?page=4000` karta hai -- `OFFSET 80000` har baar 80k rows scan karke phenkta hai, p95 latency 6 second.
Mobile app weak network pe `PUT` retry karta hai -- har retry version badha deta hai aur audit log mein 3 fake edits.
Duplicate title pe API 500 deti hai (`IntegrityError` ka stack trace), to unki integration team retry loop mein phas jaati hai.
Aapko CRUD chahiye jo bade data pe tez rahe, retries pe safe ho, aur har failure ka sahi status code de.

### What it is
**CRUD endpoints** = Create/Read/Update/Delete ke liye REST routes: `POST /documents` (201), `GET /documents` (list + pagination), `GET/PUT/DELETE /documents/{id}`.
"Scalable" ka matlab: bounded pages (limit + cursor), DB constraints pe bharosa (unique -> 409), idempotent updates, aur har request ka apna short-lived DB session (DI se, M02-03).
FastAPI + SQLAlchemy 2.0 style (`Mapped`, `mapped_column`, `select()`, `db.scalars()`) -- TypeORM/Prisma ka Python equivalent.

### Why it matters for an FDE
POC 100 rows pe chalta hai, customer ka production 10 lakh rows pe. Offset pagination, 500-on-duplicate aur non-idempotent retries wahi cheezein hain jo go-live ke pehle hafte mein pager bajaati hain.

### Key concepts
- **Status codes as contract** -- 201 created, 404 not found, 409 conflict (unique violation), 422 invalid body, 412 precondition failed (If-Match mismatch). Clients inhi pe retry/no-retry decide karte hain.
- **Offset vs cursor pagination** -- `OFFSET n` DB ko n rows padhke skip karwata hai (deep pages slow, beech mein insert hone pe rows duplicate/miss); cursor = `WHERE id > last_id ORDER BY id LIMIT n` index seek hai, har page same speed.
- **`limit + 1` trick** -- ek extra row maango; mili to `next_cursor` do. Alag `COUNT(*)` query ki zaroorat nahi.
- **Idempotent PUT** -- PUT full replace hai; same body do baar = same state. Content same hai to version mat badhao. POST idempotent nahi hota -- uske liye idempotency keys (M14-01).
- **Optimistic concurrency** -- `ETag: "<version>"` response mein, client `If-Match` bheje; version alag ho to 412. Do log ek saath edit karein to "lost update" nahi hota.

### Code example
`pip install fastapi httpx sqlalchemy pydantic`

```python
# runnable
from contextlib import asynccontextmanager
from typing import Annotated
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.testclient import TestClient
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import String, create_engine, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker
from sqlalchemy.pool import StaticPool

engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
SessionLocal = sessionmaker(engine, expire_on_commit=False)
class Base(DeclarativeBase): ...
class Document(Base):
    __tablename__ = "documents"
    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(200), unique=True)
    body: Mapped[str]
    version: Mapped[int] = mapped_column(default=1)
class DocIn(BaseModel):
    title: Annotated[str, Field(min_length=3, max_length=200)]
    body: str
class DocOut(DocIn):
    model_config = ConfigDict(from_attributes=True)     # build from ORM objects
    id: int
    version: int

@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(engine)                    # demo only -- use Alembic in prod
    yield
    engine.dispose()

app = FastAPI(lifespan=lifespan)
def get_db():
    with SessionLocal() as db:
        yield db
DB = Annotated[Session, Depends(get_db)]

def save(db: Session, doc: Document) -> Document:
    db.add(doc)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "title already exists")
    return doc

@app.post("/documents", status_code=201, response_model=DocOut)
def create(data: DocIn, db: DB):
    return save(db, Document(**data.model_dump()))

@app.get("/documents")
def list_docs(db: DB, limit: Annotated[int, Query(ge=1, le=100)] = 20,
              offset: Annotated[int, Query(ge=0)] = 0, cursor: int | None = None):
    stmt = select(Document).order_by(Document.id).limit(limit + 1)    # +1 = "is there more?"
    stmt = stmt.where(Document.id > cursor) if cursor is not None else stmt.offset(offset)
    rows = db.scalars(stmt).all()
    return {"items": [DocOut.model_validate(d) for d in rows[:limit]],
            "next_cursor": rows[limit - 1].id if len(rows) > limit else None}

@app.put("/documents/{doc_id}", response_model=DocOut)
def replace(doc_id: int, data: DocIn, db: DB):
    if (doc := db.get(Document, doc_id)) is None:
        raise HTTPException(404, "document not found")
    if (doc.title, doc.body) != (data.title, data.body):    # same PUT again = no-op
        doc.title, doc.body, doc.version = data.title, data.body, doc.version + 1
        save(db, doc)
    return doc

with TestClient(app) as c:                              # "with" runs the lifespan
    codes = {c.post("/documents", json={"title": f"Policy {i:02}", "body": "v1"}).status_code
             for i in range(25)}
    assert codes == {201}
    assert c.post("/documents", json={"title": "Policy 00", "body": "x"}).status_code == 409
    assert c.post("/documents", json={"title": "x", "body": "x"}).status_code == 422
    assert c.put("/documents/999", json={"title": "Nope", "body": "x"}).status_code == 404
    assert len(c.get("/documents?limit=10&offset=20").json()["items"]) == 5
    seen, url = [], "/documents?limit=10"
    while url:                                          # walk every page with the cursor
        page = c.get(url).json()
        seen += [d["id"] for d in page["items"]]
        url = page["next_cursor"] and f"/documents?limit=10&cursor={page['next_cursor']}"
    assert seen == list(range(1, 26)), seen
    new = {"title": "Policy 00 v2", "body": "v2"}
    r1, r2 = c.put("/documents/1", json=new), c.put("/documents/1", json=new)   # retry
    assert r1.json() == r2.json() and r2.json()["version"] == 2         # idempotent
    assert c.put("/documents/2", json=new).status_code == 409          # title taken
print("OK: 201/404/409/422, offset + cursor pagination, idempotent PUT, lifespan")
```

- `StaticPool` + `check_same_thread=False` -- in-memory sqlite ko TestClient ke threads ke beech ek hi connection pe rakhta hai. Real Postgres pe normal pool + `pool_pre_ping=True` use karo.
- `lifespan` -- startup/shutdown ek jagah (`on_event` deprecated hai). Yahan `create_all`; production mein schema Alembic migrations se aata hai, app startup se nahi.
- `save()` -- unique constraint DB enforce karta hai, hum `IntegrityError` ko 409 mein translate karte hain. "Pehle SELECT karke check karo" race-prone hai: do requests dono check pass kar lengi.
- `list_docs` -- `cursor` aaya to `WHERE id > cursor` (index seek), warna `OFFSET`. Cursor stable sort key pe hona chahiye (yahan `id`); `created_at` pe sort karna ho to `(created_at, id)` tuple cursor banao.
- `replace` -- content same hai to kuch nahi likhta, isliye retry pe `version` 2 hi rehta hai. Title kisi aur document ka ho to wahi `save()` 409 deta hai.
- `DocOut.model_validate(d)` with `from_attributes=True` -- ORM object se seedha response model (Pydantic v1 ka `orm_mode`).

ETag + If-Match ka add-on (mini-exercise mein lagaoge):

```python
# add-on, not standalone: extends the block above (also import Header, Response from fastapi)
@app.put("/documents/{doc_id}", response_model=DocOut)
def replace(doc_id: int, data: DocIn, db: DB, response: Response,
            if_match: Annotated[str | None, Header()] = None):
    doc = get_or_404(db, doc_id)                      # db.get(...) or raise 404
    if (doc.title, doc.body) != (data.title, data.body):
        if if_match is not None and if_match != f'"{doc.version}"':
            raise HTTPException(412, "document changed -- re-fetch and retry")
        doc.title, doc.body, doc.version = data.title, data.body, doc.version + 1
        save(db, doc)
    response.headers["ETag"] = f'"{doc.version}"'
    return doc
```

### Mini-exercise (30-60 min)
`omniguard` ke in-memory store ko SQLAlchemy se replace karo.
- `app/db.py` (engine `OMNIGUARD_DB_URL` se, default `sqlite:///./omniguard.db`), `app/models.py` (`Document`: id, tenant, title, classification, body, version, created_at; unique `(tenant, title)`), lifespan mein `create_all`.
- Routes: `POST /documents` (201/409/422), `GET /documents` (limit 1-100 + offset + cursor, sirf current user ke tenant ke docs -- M02-03 ka `get_current_user`), `GET /documents/{id}` (404 + `ETag`), `PUT` (idempotent + `If-Match` -> 412), `DELETE` (204; dobara delete pe bhi 204 -- decide karke README mein likho).
- Acceptance: 1000 docs seed karke cursor se saare pages walk karo -- koi duplicate/missing id nahi; tenant A ka token tenant B ka doc GET kare to 404 (403 nahi -- existence leak mat karo).

### Common pitfalls
- `limit` ka upper bound na rakhna aur list endpoint pe `body` jaise bade columns bhejna -- response MBs mein, latency aur cost dono. List mein summary fields, detail mein full.
- `IntegrityError` ko generic `except Exception` se pakad ke 500/200 return karna, ya rollback bhool jaana -- session broken state mein rehta hai.
- Tenant filter har query mein haath se likhna -- ek route pe bhoole to data leak. Ise dependency/repository layer mein centralize karo.

### Checklist before moving on
- [ ] 201/404/409/412/422 kab bhejna hai bina dekhe bata sakta hoon.
- [ ] Offset aur cursor pagination ka fark aur `limit + 1` trick samjha sakta hoon.
- [ ] Mera PUT retry-safe hai aur version sirf asli change pe badhta hai.
- [ ] Unique violation ko DB pe chhodta hoon aur 409 mein translate karta hoon.
- [ ] Lifespan se startup/shutdown handle karta hoon, `on_event` se nahi.

### Related
- M02-03 Dependency injection
- M02-08 Handling N+1 query problems
- M02-12 Fixtures and mocking
- M14-01 Idempotency keys for safe tool execution
- M12-07 Enforcing data-level permissions in retrieval layers

### Self-quiz
1. Page 1 padhne ke baad kisi ne 3 naye documents insert kiye (id chhote nahi, bade). Offset pagination aur cursor pagination mein page 2 pe kya fark dikhega?
2. "Pehle `SELECT` karke dekho title exist karta hai, phir `INSERT` karo" -- ye 409 ke liye kaafi kyun nahi hai?
3. PUT idempotent hai, POST nahi. Mobile app ka `POST /documents` timeout pe retry hua -- kya hoga, aur kaise fix karoge?
4. Tenant B ke document pe tenant A ko 404 dena behtar hai ya 403? Kyun?
