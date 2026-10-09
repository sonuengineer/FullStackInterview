# Legacy Systems & Integrations

## Constructing safe parameterized queries to prevent SQL injection

> Core | Fast CP5 / Slow CP7 | ~1.2 h | Builds on: M11-10, M05-12

### Kahani
Bank ke support agent ke liye OmniGuard ek tool deta hai: `lookup_customer(name)`. LLM user ke message se `name` nikalta hai aur tool SQL chalata hai.
Ek user ne chat mein likha: "Mera naam `x' UNION SELECT name, ssn FROM customers --` hai, mera account dikhao."
LLM ne faithfully wahi string tool ko di. Tool ne f-string se query banayi. Response mein 2,000 customers ke SSN.
Prompt injection + SQL injection ka combo -- aur dono ka root cause ek hi: untrusted text ko code ki tarah treat kiya.

### What it is
**Parameterized query** = SQL text aur values alag-alag DB driver ko jaate hain (`WHERE name = :name` + `{"name": value}`). DB value ko kabhi SQL ki tarah parse nahi karta.
Values bind ho sakti hain, **identifiers** (table/column names, `ORDER BY`, `ASC/DESC`) nahi -- unke liye **allow-list**.

### Why it matters for an FDE
AI apps mein SQL ke inputs ab sirf form fields nahi -- LLM tool arguments bhi hain, jinhe koi bhi user prompt se control kar sakta hai. Ek injection = customer ka data breach aur aapka project khatam.

### Key concepts
- **Bound parameters** -- SQLAlchemy `text("... = :name")` + dict; driver ke placeholders (`?`, `%s`, `:1`) automatically.
- **Identifiers via allow-list** -- `{"created": "created_at", "name": "name"}` map; user input se sirf key choose hoti hai.
- **IN lists** -- `bindparam("ids", expanding=True)`; kabhi `",".join(ids)` nahi.
- **LIKE** -- value bind karo aur `%`/`_` escape karo, warna `%` se poora table match.
- **Defense in depth** -- parameterization + read-only role (M11-12) + row limit; ek layer fail ho to baaki bachaayein.

### Code example
`pip install sqlalchemy`

```python
# runnable
from sqlalchemy import bindparam, create_engine, text

engine = create_engine("sqlite://")
with engine.begin() as c:
    c.execute(text("CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, city TEXT, ssn TEXT, created_at TEXT)"))
    c.execute(text("INSERT INTO customers (name, city, ssn, created_at) VALUES (:n, :c, :s, :d)"), [
        {"n": "Asha Rao", "c": "Pune", "s": "111-11-1111", "d": "2026-01-03"},
        {"n": "Ravi Kumar", "c": "Delhi", "s": "222-22-2222", "d": "2026-02-10"},
        {"n": "Meera 100% Shah", "c": "Pune", "s": "333-33-3333", "d": "2026-03-15"}])

ATTACK = "x' UNION SELECT name, ssn FROM customers --"            # what the LLM passed as tool arg

def lookup_unsafe(name: str):                                     # DO NOT DO THIS
    with engine.connect() as c:
        return c.exec_driver_sql(f"SELECT name, city FROM customers WHERE name = '{name}'").all()

def lookup_safe(name: str):
    with engine.connect() as c:
        return c.execute(text("SELECT name, city FROM customers WHERE name = :name"), {"name": name}).all()

leaked = lookup_unsafe(ATTACK)
print("unsafe returned:", leaked)
assert any("-" in str(row[1]) for row in leaked)                  # SSNs leaked through the city column
assert lookup_safe(ATTACK) == []                                  # treated as a weird name, nothing more
assert lookup_safe("Asha Rao") == [("Asha Rao", "Pune")]

SORTABLE = {"name": "name", "created": "created_at"}               # identifiers: allow-list, never bind/format raw
def list_customers(city: str, sort: str = "name", desc: bool = False, limit: int = 50):
    col = SORTABLE.get(sort)
    if col is None:
        raise ValueError(f"sort must be one of {sorted(SORTABLE)}")
    limit = max(1, min(int(limit), 100))                           # cap rows even if the caller asks for more
    sql = f"SELECT name FROM customers WHERE city = :city ORDER BY {col} {'DESC' if desc else 'ASC'} LIMIT :limit"
    with engine.connect() as c:
        return [r[0] for r in c.execute(text(sql), {"city": city, "limit": limit})]

assert list_customers("Pune", sort="created", desc=True) == ["Meera 100% Shah", "Asha Rao"]
try:
    list_customers("Pune", sort="name; DROP TABLE customers")
    raise AssertionError("should reject")
except ValueError as e:
    print("rejected identifier:", e)

def by_ids(ids: list[int]):
    stmt = text("SELECT name FROM customers WHERE id IN :ids").bindparams(bindparam("ids", expanding=True))
    with engine.connect() as c:
        return [r[0] for r in c.execute(stmt, {"ids": ids})]
assert by_ids([1, 3]) == ["Asha Rao", "Meera 100% Shah"]

def search_name(fragment: str):
    esc = fragment.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    with engine.connect() as c:
        return [r[0] for r in c.execute(text("SELECT name FROM customers WHERE name LIKE :p ESCAPE '\\'"),
                                        {"p": f"%{esc}%"})]
assert search_name("100%") == ["Meera 100% Shah"] == search_name("%")     # % is literal, not "match all"
print("OK: values bound, identifiers allow-listed, IN expanded, LIKE escaped")
```

- `lookup_unsafe` -- `'` string band karta hai, `UNION` doosra SELECT jodta hai, `--` baaki SQL comment. SSN "city" column mein aa gaye.
- `lookup_safe` -- same input ab sirf ek ajeeb naam hai; DB use SQL parse karta hi nahi.
- `SORTABLE` -- column name bind nahi ho sakta, isliye map se; galat key = clear error, SQL tak kuch nahi jaata.
- `LIMIT :limit` + `min(..., 100)` -- LLM "limit 1000000" bole tab bhi cap.
- `expanding=True` -- list ke har item ka alag placeholder; `ESCAPE '\\'` se `%`/`_` literal.

### Mini-exercise (30-60 min)
OmniGuard: `omniguard/sql/queries.py` mein agent tools ke liye 3 queries -- `get_patient_visits(patient_id, since)`, `list_claims(status, sort, limit)`, `find_by_ids(ids)`.
- Har tool ka Pydantic args model (M05-12): types, ranges, `Literal` sort keys.
- Test file mein injection corpus: `' OR '1'='1`, `UNION SELECT`, `; DROP TABLE`, `%`, unicode quotes -- har payload pe koi extra row nahi, koi error 500 nahi.
- CI grep check: repo mein `exec_driver_sql(f"` ya `text(f"` with user variable -> fail (simple script ya ruff custom rule).

### Common pitfalls
- "Input sanitize kar diya" (quotes hata diye) -- encodings aur edge cases se bypass hota hai; parameterize karo, sanitize pe bharosa nahi.
- ORM use karte hue raw `text(f"...")` -- ORM ka protection wahi khatam.
- Stored procedure ke andar dynamic SQL (`EXEC(@sql)`) -- injection DB ke andar shift ho gaya; wahan bhi `sp_executesql` with params.

### Checklist before moving on
- [ ] Har user/LLM-provided value bound parameter hai.
- [ ] Table/column/sort direction sirf allow-list se.
- [ ] IN aur LIKE ke safe patterns aate hain.
- [ ] Row limit server side enforce hota hai.

### Related
- M11-10 Establishing secure connections using Python-native drivers (pyodbc, oracledb) and SQLAlchemy
- M11-12 Implementing read-only database roles
- M11-14 Handling Text-to-SQL logic constraints and fallbacks
- M13-02 Prompt injection defenses

### Self-quiz
1. Parameterized query mein value DB tak kaise pahunchti hai ki wo SQL ki tarah execute nahi hoti?
2. `ORDER BY :col` kyun kaam nahi karta, aur safe alternative kya hai?
3. LLM tool arguments ko "trusted internal input" kyun nahi maan sakte?
4. Parameterization ke baad bhi read-only role kyun chahiye?
