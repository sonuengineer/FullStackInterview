# Legacy Systems & Integrations

## Mapping complex database schemas to LLM context

> Core | Fast CP5 / Slow CP7 | ~1.2 h | Builds on: M11-12, M05-03, M05-05

### Kahani
Distributor customer ka ERP 1998 ka hai: 640 tables, naam jaise `CUST_MST`, `ORD_HDR`, `ORD_DTL`, `X_FLG2`. OmniGuard se sawaal aata hai: "Pune ke kitne customers ke orders pending hain?"
Pehle try mein poora DDL prompt mein daala -- 180k tokens, har sawaal pe $2, aur model ne `customers` naam ki table invent kar di jo exist hi nahi karti.
Status column mein `'P'`, `'S'`, `'X'` the -- model ne `WHERE status = 'pending'` likha, zero rows, confident galat jawab.
Fix: sirf relevant tables, compact format, business descriptions, aur low-cardinality columns ke sample values.

### What it is
**Schema context** = DB schema ka chhota, LLM-friendly text: tables, columns, types, PK/FK, ek line description, aur categorical columns ke allowed values.
**Schema linking** = sawaal ke hisaab se sirf relevant tables chunna (keyword/alias match ya embeddings) + unke FK neighbours, taaki joins possible rahein.

### Why it matters for an FDE
Text-to-SQL ki accuracy aksar model se zyada context pe depend karti hai. Legacy schemas cryptic hote hain; customer ke domain expert se data dictionary banwana aapka kaam hai, aur galat context = galat numbers jo CFO tak pahunchte hain.

### Key concepts
- **Reflect, don't hand-write** -- SQLAlchemy `inspect(engine)` se tables/columns/FKs; descriptions alag data dictionary (YAML) mein.
- **Compact format** -- `ORD_HDR(ORD_ID int PK, CUST_ID int -> CUST_MST.CUST_ID, STS text in ['P','S','X'] -- P=pending)`; DDL se bahut kam tokens.
- **Sample values** -- sirf low-cardinality, non-PII columns; PII columns ke values kabhi prompt mein nahi.
- **Table selection** -- question ke words vs table names + aliases + descriptions; phir FK neighbours add (join path ke liye). Bade schemas pe embeddings (M06) se ranking.
- **Token budget** -- schema context ki hard limit (e.g. 3k tokens); zyada ho to kam relevant tables drop.

### Code example
`pip install sqlalchemy`

```python
# runnable
import re
from sqlalchemy import create_engine, inspect, text

engine = create_engine("sqlite://")
with engine.begin() as c:
    for ddl in [
        "CREATE TABLE CUST_MST (CUST_ID INTEGER PRIMARY KEY, CUST_NM TEXT, CITY_CD TEXT, PHONE TEXT)",
        "CREATE TABLE ORD_HDR (ORD_ID INTEGER PRIMARY KEY, CUST_ID INTEGER REFERENCES CUST_MST(CUST_ID), STS TEXT, ORD_DT TEXT)",
        "CREATE TABLE ORD_DTL (ORD_ID INTEGER REFERENCES ORD_HDR(ORD_ID), SKU TEXT, QTY INTEGER, AMT NUMERIC)",
        "CREATE TABLE EMP_MST (EMP_ID INTEGER PRIMARY KEY, EMP_NM TEXT, SALARY NUMERIC)",
        "CREATE TABLE X_FLG2 (K TEXT, V TEXT)"]:
        c.execute(text(ddl))
    c.execute(text("INSERT INTO CUST_MST VALUES (1,'Asha','PUN','98450-1'),(2,'Ravi','DEL','98450-2'),(3,'Meera','PUN','98450-3')"))
    c.execute(text("INSERT INTO ORD_HDR VALUES (10,1,'P','2026-09-01'),(11,2,'S','2026-09-02'),(12,3,'P','2026-09-03'),(13,1,'X','2026-09-04')"))

DICTIONARY = {   # from the customer's domain expert; real: data_dictionary.yaml in the repo
    "CUST_MST": {"desc": "customers master", "aliases": ["customer", "client"],
                 "cols": {"CITY_CD": "city code, PUN=Pune DEL=Delhi"}, "pii": ["CUST_NM", "PHONE"]},
    "ORD_HDR": {"desc": "order header, one row per order", "aliases": ["order", "orders", "pending"],
                "cols": {"STS": "order status: P=pending S=shipped X=cancelled", "ORD_DT": "ISO date text"}, "no_samples": ["ORD_DT"]},
    "ORD_DTL": {"desc": "order lines", "aliases": ["sku", "quantity", "line"], "cols": {}},
    "EMP_MST": {"desc": "employees", "aliases": ["employee", "staff"], "pii": ["EMP_NM", "SALARY"], "cols": {}},
}
HIDDEN = {"X_FLG2"}                                               # internal junk, never exposed

def describe_table(insp, conn, table: str, max_distinct: int = 5) -> str:
    meta = DICTIONARY.get(table, {})
    pks = set(insp.get_pk_constraint(table)["constrained_columns"])
    fks = {fk["constrained_columns"][0]: f"{fk['referred_table']}.{fk['referred_columns'][0]}" for fk in insp.get_foreign_keys(table)}
    parts = []
    for col in insp.get_columns(table):
        name = col["name"]
        s = f"{name} {str(col['type']).lower()}" + (" PK" if name in pks else "") + (f" -> {fks[name]}" if name in fks else "")
        if name in meta.get("pii", []):
            s += " [pii]"                                           # name only, never values
        elif str(col["type"]).upper() == "TEXT" and name not in meta.get("no_samples", []):
            vals = [r[0] for r in conn.execute(text(f'SELECT DISTINCT "{name}" FROM "{table}" LIMIT {max_distinct + 1}'))]
            if 0 < len(vals) <= max_distinct:
                s += f" in {sorted(vals)}"
        if name in meta.get("cols", {}):
            s += f" -- {meta['cols'][name]}"
        parts.append(s)
    return f"{table}: {meta.get('desc', '')}\n  " + "\n  ".join(parts)

def select_tables(question: str, insp) -> list[str]:
    words = set(re.findall(r"[a-z]+", question.lower()))
    tables = [t for t in insp.get_table_names() if t not in HIDDEN]
    score = {t: len(words & set(DICTIONARY.get(t, {}).get("aliases", []) + DICTIONARY.get(t, {}).get("desc", "").split())) for t in tables}
    picked = [t for t in tables if score[t] > 0]
    for t in list(picked):                                          # add FK neighbours so joins are possible
        for fk in insp.get_foreign_keys(t):
            if fk["referred_table"] not in picked:
                picked.append(fk["referred_table"])
    return picked

def schema_context(question: str, token_budget: int = 400) -> str:
    insp = inspect(engine)
    with engine.connect() as conn:
        blocks = [describe_table(insp, conn, t) for t in select_tables(question, insp)]
    out, used = [], 0
    for b in blocks:                                                # crude budget: ~4 chars per token
        if used + len(b) // 4 > token_budget:
            break
        out.append(b); used += len(b) // 4
    return "\n".join(out)

ctx = schema_context("How many customers in Pune have pending orders?")
print(ctx)
assert "ORD_HDR" in ctx and "CUST_MST" in ctx                       # both sides of the join
assert "EMP_MST" not in ctx and "X_FLG2" not in ctx and "ORD_DTL" not in ctx
assert "STS text in ['P', 'S', 'X'] -- order status: P=pending" in ctx
assert "CUST_ID integer -> CUST_MST.CUST_ID" in ctx and "ORD_DT text -- ISO date text" in ctx
assert "PHONE text [pii]" in ctx and "98450" not in ctx and "Asha" not in ctx   # no PII values
print(f"~{len(ctx) // 4} tokens instead of the full DDL")
print("OK: relevant tables only, FKs, enum values, PII-safe, budgeted")
```

- `inspect(engine)` -- schema DB se reflect, haath se likha DDL purana ho jaata hai.
- `DICTIONARY` -- cryptic names ka business matlab; `STS` ka `P=pending` mapping hi model ko `'P'` likhne deta hai.
- `[pii]` -- column ka naam dikhta hai (taaki model `SELECT PHONE` maange to guard rok sake), values kabhi nahi.
- `select_tables` -- keyword/alias score + FK neighbours; question mein "customers" aur "orders" dono hain to join path complete.
- Sample query mein `"{name}"` -- identifiers reflection se aaye hain (trusted), user se nahi; user values hamesha bind (M11-11).

### Mini-exercise (30-60 min)
OmniGuard: `omniguard/sql/schema_context.py` banao.
- `data_dictionary.yaml` (desc, aliases, column notes, pii list) + `build_context(question, user) -> str`.
- RBAC: user ke role ke allowed tables hi candidate hon (M12-06) -- analyst ko `EMP_MST` kabhi context mein na dikhe.
- Ranking v2: table descriptions ke embeddings (M06) + keyword score; 20 sample questions pe "needed tables recall" measure karo, target >= 0.9.
- Cache: reflected schema 10 min cache, sample values daily refresh.

### Common pitfalls
- Poora DDL/640 tables prompt mein -- cost, latency aur hallucinated joins teeno badhte hain.
- High-cardinality ya PII columns ke sample values -- prompt logs mein customer data leak (M13-14).
- FK neighbours bhool jaana -- model ko join key nahi pata, wo guess karta hai (`ORDERS.CUSTOMER_ID`).

### Checklist before moving on
- [ ] Schema reflection + data dictionary se compact context bana sakta hoon.
- [ ] Sirf relevant tables + FK neighbours select hote hain.
- [ ] Categorical columns ke codes aur meanings context mein hain.
- [ ] PII values kabhi prompt mein nahi jaate; context per-role filtered hai.

### Related
- M11-14 Handling Text-to-SQL logic constraints and fallbacks
- M11-12 Implementing read-only database roles
- M05-03 Token calculation
- M05-05 Context compression
- M12-06 Implementing Role-Based Access Control

### Self-quiz
1. Model ne `WHERE status = 'pending'` likha aur zero rows aaye. Context mein kya missing tha?
2. FK neighbours add karna kyun zaroori hai? Ek example do jahan iske bina query galat banegi.
3. PII column ka naam context mein dikhana chahiye ya nahi? Dono side ke arguments do.
4. 640 tables ke liye keyword matching kab fail hogi, aur aap kya use karoge?
