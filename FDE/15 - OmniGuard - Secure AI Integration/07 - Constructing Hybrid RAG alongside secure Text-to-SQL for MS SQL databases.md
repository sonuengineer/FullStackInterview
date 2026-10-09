# OmniGuard - Secure AI Integration

## Constructing Hybrid RAG alongside secure Text-to-SQL for MS SQL databases

> Core | Fast CP6 / Slow CP8 | ~1.2 h | Builds on: M06-10, M06-12, M06-13, M11-11, M11-12, M11-13, M11-14

### Kahani
Kavach ki analyst Neha ka asli sawaal hota hai: "Claim C-1001 abhi kis status mein hai, aur kya knee surgery policy ke clause 7.3(b) ke under covered hai?"
Aadha jawab MS SQL ClaimsDB mein hai (status), aadha SharePoint PDF mein (clause wording). Aapke paas M06 ka Hybrid RAG hai aur M11 ka Text-to-SQL -- alag-alag demo mein dono chalte hain.
Ab dono ko ek API ke peeche jodna hai, aur Rahul ki shart: "LLM ka likha T-SQL mere replica pe tabhi chalega jab main prove dekh loon ki `DROP`, `UPDATE`, `SELECT INTO`, `EXEC` kabhi nahi chal sakte, aur 5 lakh rows ka dump nahi aayega."
MS SQL mein `LIMIT` hota hi nahi (`TOP` hota hai), aur `SELECT ... INTO` chupchaap nayi table bana deta hai -- sqlite pe likha guard yahan kaafi nahi.

### What it is
Ek **router** sawaal ko `rag` (documents), `sql` (structured data) ya dono mein bhejta hai. RAG path = BM25 + dense + RRF + ACL filter; SQL path = schema context -> LLM writes T-SQL -> **guard** (T-SQL dialect) -> read-only login -> MS SQL replica.
Is lesson ka runnable ek **acceptance harness** hai jo aapke guard aur `/v1/ask` ko test karta hai -- implementation aapki hai (M11-14 ka guard, T-SQL ke liye adapt karke).

### Why it matters for an FDE
Customer ka DBA aapke code ko nahi, aapke test evidence ko approve karta hai. Ek repeatable harness = "ye saare attacks block hote hain, ye report hai" -- yahi replica access unlock karta hai.

### Key concepts
- **Dialect matters** -- `sqlglot.parse(sql, read="tsql")`; row cap T-SQL mein `TOP n` hai, sqlglot ise `limit` arg mein rakhta hai.
- **T-SQL specific dangers** -- `SELECT ... INTO` (creates table), `EXEC`/`xp_cmdshell`, `OPENROWSET`, multi-statement batches.
- **Defense in depth** -- guard (parse) + read-only DB login (M11-12) + parameters (M11-11) + query timeout. Guard toota to bhi login write nahi kar sakta.
- **Router as a contract** -- response mein `route` aur `sources` -- tests aur UAT dono isi pe check karte hain.
- **Exact-ID retrieval** -- "clause 7.3(b)" jaise IDs pe dense search kamzor, BM25 strong; isliye hybrid (M06-12/13).

Architecture:
```text
POST /v1/ask (JWT, M15-06) -> router --docs--> BM25 (M06-11) + dense (M06-10) -> RRF (M06-13) -> ACL filter (M12-07)
                                  \                                                     -> answer + citations
                                   --data--> schema ctx (M11-13) -> LLM writes T-SQL -> guard (tsql)
                                             -> read-only login (M11-12), timeout -> MS SQL replica -> rows -> answer
```

Threat / failure list: write/DDL statements, `SELECT INTO`, `EXEC`, multi-statement batch, restricted table (`customers` with PAN, M15-02), unbounded result set, slow query (timeout), router misroute, RAG chunk above user's level.

### Code example
`pip install fastapi httpx sqlglot`

```python
# runnable
import importlib, os, sqlite3
import sqlglot
from fastapi import FastAPI
from fastapi.testclient import TestClient

DIALECT, MAX_ROWS = "tsql", 200
def load(env, default):  # point at your real code: OMNIGUARD_SQL_GUARD="omniguard.sql.guard:guard"
    if target := os.environ.get(env):
        mod, attr = target.split(":")
        return getattr(importlib.import_module(mod), attr)
    return default

def standin_guard(sql: str) -> str:
    """STAND-IN, deliberately naive. It is NOT the answer -- the harness shows what it misses."""
    s = sql.strip()
    if not s.upper().startswith("SELECT") or ";" in s:
        raise ValueError("only a single SELECT")
    return s if " TOP " in s.upper() else s.replace("SELECT", "SELECT TOP 200", 1)

MUST_REJECT = {"drop": "DROP TABLE claims", "update": "UPDATE claims SET status = 'approved'",
               "multi": "SELECT claim_id FROM claims; DELETE FROM claims",
               "select into": "SELECT claim_id INTO claims_copy FROM claims",
               "exec": "EXEC xp_cmdshell 'dir'", "restricted table": "SELECT pan FROM customers"}
MUST_CAP = {"top 5000": "SELECT TOP 5000 claim_id, status FROM claims",
            "no top": "SELECT status, COUNT(*) AS n FROM claims GROUP BY status"}

def sql_harness(guard) -> list[str]:
    db = sqlite3.connect(":memory:")                     # stand-in for the MS SQL replica
    db.execute("CREATE TABLE claims (claim_id TEXT, status TEXT)")
    db.executemany("INSERT INTO claims VALUES (?, ?)", [(f"C-{i}", "pending") for i in range(300)])
    fails = []
    for name, sql in MUST_REJECT.items():
        try:
            guard(sql); fails.append(f"accepted dangerous SQL: {name}")
        except Exception:
            pass
    for name, sql in MUST_CAP.items():
        out = guard(sql)
        limit = sqlglot.parse_one(out, read=DIALECT).args.get("limit")
        if limit is None or int(limit.expression.name) > MAX_ROWS:
            fails.append(f"row cap missing or > {MAX_ROWS}: {name}")
        rows = db.execute(sqlglot.transpile(out, read=DIALECT, write="sqlite")[0]).fetchall()
        if len(rows) > MAX_ROWS:
            fails.append(f"returned {len(rows)} rows: {name}")
    return fails

def standin_app() -> FastAPI:
    """STAND-IN /v1/ask with keyword routing and canned sources -- not OmniGuard."""
    app = FastAPI()
    @app.post("/v1/ask")
    def ask(body: dict):
        if any(w in body["question"].lower() for w in ("how many", "count", "total")):
            return {"route": "sql", "answer": "42 pending", "sources": ["ClaimsDB.claims"]}
        return {"route": "rag", "answer": "Clause 7.3(b): 24-month waiting period.", "sources": ["wording#7.3b"]}
    return app

ASK_CASES = [("What does clause 7.3(b) say about knee surgery?", "rag", "wording#7.3b"),
             ("How many claims are pending this month?", "sql", "ClaimsDB.claims")]

def ask_harness(client) -> list[str]:
    fails = []
    for q, route, source in ASK_CASES:
        r = client.post("/v1/ask", json={"question": q}).json()
        if r.get("route") != route or source not in r.get("sources", []):
            fails.append(f"{q!r}: got route={r.get('route')} sources={r.get('sources')}")
    return fails

sql_fails = sql_harness(load("OMNIGUARD_SQL_GUARD", standin_guard))
ask_fails = ask_harness(TestClient(load("OMNIGUARD_APP", None) or standin_app()))
print("SQL guard failures:", sql_fails)
print("/v1/ask failures:", ask_fails)
if not os.environ.get("OMNIGUARD_SQL_GUARD"):      # expected misses of the naive stand-in
    assert sql_fails == ["accepted dangerous SQL: select into", "accepted dangerous SQL: restricted table",
                         "row cap missing or > 200: top 5000", "returned 300 rows: top 5000"]
assert ask_fails == []
print("OK: harness runs; your guard must reach zero failures")
```

- `standin_guard` jaan-boojh ke naive hai: `SELECT INTO`, restricted table aur `TOP 5000` miss karta hai. Harness teeno pakadta hai -- ye aapke real guard ke liye target list hai.
- `read=DIALECT` ("tsql") -- guard ka output T-SQL hai; cap check `TOP` ko sqlglot ke `limit` arg se padhta hai.
- `transpile(..., write="sqlite")` -- harness guarded query ko sqlite stand-in pe chala ke dekhta hai ki woh syntactically valid aur executable hai.
- `load(env, default)` -- `OMNIGUARD_SQL_GUARD` / `OMNIGUARD_APP` set karte hi wahi harness aapke real code pe chalta hai; naive-stand-in wala assert apne aap skip.
- `ASK_CASES` -- route + source contract; exact-ID question ("7.3(b)") hybrid retrieval ki BM25 strength test karta hai.

Real MS SQL connection (OmniGuard ke `omniguard/sql/db.py` ke liye):

```python
# real version -- not run here, needs: pip install pyodbc sqlalchemy + Microsoft ODBC Driver 18 for SQL Server
import os, urllib.parse
from sqlalchemy import create_engine, event, text

odbc = (
    "DRIVER={ODBC Driver 18 for SQL Server};"
    f"SERVER={os.environ['MSSQL_HOST']},1433;DATABASE=ClaimsDB;"
    f"UID={os.environ['MSSQL_RO_USER']};PWD={os.environ['MSSQL_RO_PASSWORD']};"   # read-only login (M11-12)
    "Encrypt=yes;TrustServerCertificate=no;ApplicationIntent=ReadOnly;Connection Timeout=5;"
)
engine = create_engine("mssql+pyodbc:///?odbc_connect=" + urllib.parse.quote_plus(odbc), pool_pre_ping=True)

@event.listens_for(engine, "connect")
def set_query_timeout(dbapi_conn, _record):
    dbapi_conn.timeout = 10          # pyodbc query timeout in seconds -- check the docs for your version

with engine.connect() as conn:
    rows = conn.execute(text(guard(llm_sql))).fetchmany(200)    # guard() = your omniguard/sql/guard.py
```

`Encrypt=yes` + `TrustServerCertificate=no` = TLS with real certificate validation; `ApplicationIntent=ReadOnly` read-only replica/secondary pe route karta hai (agar Availability Group configured ho -- Rahul se confirm karo).

### Mini-exercise (30-60 min)
OmniGuard deliverables #1, #2, #4: `omniguard/tests/acceptance/test_rag_sql.py`.
- Apna M11-14 guard T-SQL dialect pe port karo (`SELECT INTO`, `EXEC`, allowed tables per role, `TOP` cap). Harness ko `OMNIGUARD_SQL_GUARD` se usi pe chalao: zero failures.
- `MUST_REJECT` mein 5 aur cases add karo (e.g. `OPENROWSET`, `WAITFOR`, nested subquery into restricted table). Unparseable SQL = reject.
- `/v1/ask` ke liye 10 `ASK_CASES` (docs-only, data-only, both) aur ek case jahan underwriter ko RAG source restricted level ka na mile.
- Acceptance: CI mein harness green; README mein "SQL guard evidence" table (attack -> blocked by -> test name) jo Rahul ko bheja ja sake.

### Common pitfalls
- Guard ko sqlite/postgres dialect pe parse karna jabki DB MS SQL hai -- `TOP`, `INTO`, `EXEC` ke rules galat ho jaate hain.
- Sirf guard pe bharosa, DB login `db_owner` -- ek parser bypass = data loss. Read-only login non-negotiable.
- Query timeout na lagana -- ek LLM-generated cross join replica ko 10 minute busy rakh sakta hai.

### Checklist before moving on
- [ ] Router, RAG path aur SQL path ka diagram bina dekhe bana sakta hoon.
- [ ] T-SQL ke 4 dangerous patterns jo sqlite guard miss karta, bata sakta hoon.
- [ ] Mera guard is harness pe zero failures deta hai.
- [ ] pyodbc connection string ke Encrypt/TrustServerCertificate/ApplicationIntent ka matlab samjha sakta hoon.

### Related
- M06-10 End-to-end basic retrieval
- M06-12 Combining dense and sparse signals
- M06-13 Implementing RRF algorithms
- M11-11 Constructing safe parameterized queries to prevent SQL injection
- M11-12 Implementing read-only database roles
- M11-13 Mapping complex database schemas to LLM context
- M11-14 Handling Text-to-SQL logic constraints and fallbacks

### Self-quiz
1. `SELECT claim_id INTO claims_copy FROM claims` read query jaisa dikhta hai. Ye dangerous kyun hai aur kaunsi layer ise rokegi?
2. Guard ke alawa do aur layers batao jo LLM-generated SQL ka damage limit karti hain.
3. Neha ka sawaal (status + clause) router kaise handle kare? Response mein kya hona chahiye?
4. `TrustServerCertificate=yes` dev mein convenient hai. Production mein kya risk hai?
