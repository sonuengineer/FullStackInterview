# Legacy Systems & Integrations

## Implementing read-only database roles

> Core | Fast CP5 / Slow CP7 | ~1.2 h | Builds on: M11-10, M11-11, M03-09

### Kahani
Logistics customer ke saath OmniGuard ka Text-to-SQL pilot chal raha tha. App ka DB user `ops_admin` tha -- "setup jaldi ho jaayega" bol ke customer ke dev ne diya tha.
Ek din LLM ne "purane cancelled orders saaf karke dikhao" ka matlab `DELETE FROM orders WHERE status='CANCELLED'` samjha. Guard code mein ek bug tha. 18,000 rows gaye; restore mein 6 ghante.
Post-mortem mein customer ke DBA ka ek line ka jawab: "Agar login read-only hota, ye query DB khud reject kar deta."
Code guards zaroori hain, par last line of defense DB permissions hain.

### What it is
**Read-only role** = DB login/role jisko sirf `SELECT` (aur sirf zaroori schemas/views pe) permission hai. `INSERT/UPDATE/DELETE/DDL` DB level pe deny.
Saath mein **statement timeout** aur sensitive columns ke liye **views** -- taaki ek bhaari ya nosy query bhi nuksaan na kare.

### Why it matters for an FDE
Customer ka DBA aapke Python guard pe bharosa nahi karega -- karna bhi nahi chahiye. Read-only role security review ka pehla sawaal hai, aur incident ke time aapki sabse badi bachat.

### Key concepts
- **Separate login per app** -- `svc_omniguard_ro`, shared `admin`/`sa` nahi; audit logs mein clearly dikhta hai kisne kya chalaya.
- **GRANT SELECT on a schema/views** -- poore DB pe nahi; PII columns ke bina views (`reporting.v_orders`) expose karo.
- **Default read-only transaction** -- Postgres: `ALTER ROLE ... SET default_transaction_read_only = on` (extra layer, permission ka replacement nahi).
- **Statement timeout** -- Postgres `statement_timeout`, MSSQL client-side query timeout, Oracle profile/Resource Manager; ek LLM ki cartesian join prod DB ko slow na kare.
- **Read replica** -- jahan possible, pilot replica/snapshot pe chalao (M11-15); primary pe load zero.

### Code example
`pip install sqlalchemy`   (sqlite read-only URI simulates a read-only role; real GRANTs are in the sql block)

```python
# runnable
import sqlite3, tempfile, time
from contextlib import closing
from pathlib import Path
from sqlalchemy import create_engine, event, text
from sqlalchemy.exc import OperationalError

with tempfile.TemporaryDirectory() as d:
    db = Path(d) / "ops.db"
    admin = create_engine(f"sqlite:///{db.as_posix()}")                  # migration/owner account
    with admin.begin() as c:
        c.execute(text("CREATE TABLE orders (id INTEGER PRIMARY KEY, status TEXT, customer_phone TEXT)"))
        c.execute(text("INSERT INTO orders (status, customer_phone) VALUES ('OPEN','98450-11111'), ('CANCELLED','98450-22222')"))
        c.execute(text("CREATE VIEW v_orders AS SELECT id, status FROM orders"))   # no PII column
    admin.dispose()

    # The app's engine: read-only at the connection level (like a role with only SELECT).
    deadline = {"t": 0.0}                                                    # per-statement budget
    ro = create_engine("sqlite://", creator=lambda: sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True))

    @event.listens_for(ro, "connect")
    def harden(dbapi_conn, _):
        dbapi_conn.execute("PRAGMA query_only = ON")                         # second layer, like default_transaction_read_only
        dbapi_conn.set_progress_handler(lambda: int(time.monotonic() > deadline["t"]), 10_000)   # nonzero = abort

    def run(sql: str):
        with ro.connect() as c:
            deadline["t"] = time.monotonic() + 0.5                            # statement timeout: 0.5 s
            return c.execute(text(sql)).all()

    assert run("SELECT id, status FROM v_orders ORDER BY id") == [(1, "OPEN"), (2, "CANCELLED")]
    blocked = []
    for sql in ["DELETE FROM orders WHERE status = 'CANCELLED'", "DROP TABLE orders",
                "UPDATE orders SET status = 'OPEN'", "CREATE TABLE x (a INT)"]:
        try:
            run(sql)
        except OperationalError as e:
            blocked.append(sql.split()[0])
            print(f"blocked {sql.split()[0]:6} -> {str(e.orig)}")
    assert blocked == ["DELETE", "DROP", "UPDATE", "CREATE"]

    t0 = time.monotonic()
    try:                                                                     # runaway query (think: LLM cartesian join)
        run("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT count(*) FROM n")
        raise AssertionError("should time out")
    except OperationalError as e:
        assert "interrupted" in str(e.orig)
    print(f"runaway query stopped after {time.monotonic() - t0:.2f}s")
    assert time.monotonic() - t0 < 10

    with closing(sqlite3.connect(db)) as check:                              # data untouched
        assert check.execute("SELECT count(*) FROM orders").fetchone()[0] == 2
    ro.dispose()
print("OK: writes and DDL rejected by the database, runaway query cut off, data intact")
```

- `mode=ro` URI -- connection hi read-only; DB khud `attempt to write a readonly database` deta hai. Real DB mein yahi kaam `GRANT SELECT` karta hai.
- `PRAGMA query_only` -- doosri layer, Postgres ke `default_transaction_read_only` jaisi.
- `set_progress_handler` -- sqlite mein statement timeout simulate; real DB pe `statement_timeout` / driver query timeout.
- `v_orders` -- view bina phone number ke; real role ko sirf view pe SELECT do, base table pe nahi.
- Last check -- alag connection se count; prove kiya ki koi row nahi gayi.

```sql
-- PostgreSQL: group role + login role (run by the customer's DBA, reviewed in the change ticket)
CREATE ROLE omniguard_ro NOLOGIN;
GRANT CONNECT ON DATABASE logistics TO omniguard_ro;
GRANT USAGE ON SCHEMA reporting TO omniguard_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO omniguard_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA reporting GRANT SELECT ON TABLES TO omniguard_ro;
CREATE ROLE svc_omniguard LOGIN PASSWORD 'from-vault' IN ROLE omniguard_ro;
ALTER ROLE svc_omniguard SET default_transaction_read_only = on;
ALTER ROLE svc_omniguard SET statement_timeout = '5s';
ALTER ROLE svc_omniguard CONNECTION LIMIT 10;

-- SQL Server: database role scoped to one schema, PII column denied
CREATE LOGIN svc_omniguard WITH PASSWORD = 'from-vault';
CREATE USER svc_omniguard FOR LOGIN svc_omniguard;
CREATE ROLE omniguard_ro;
GRANT SELECT ON SCHEMA::reporting TO omniguard_ro;
DENY SELECT ON dbo.orders (customer_phone) TO omniguard_ro;
ALTER ROLE omniguard_ro ADD MEMBER svc_omniguard;
```

Exact syntax DB version ke hisaab se check karo; Oracle mein `CREATE ROLE` + `GRANT SELECT ON schema.view` + `PROFILE` limits use hote hain.

### Mini-exercise (30-60 min)
OmniGuard CP5 build: `omniguard/sql/` mein Text-to-SQL ka DB layer read-only banao.
- Local docker-free setup: sqlite `mode=ro` engine (dev) aur `docs/db-role.sql` (customer DBA ke liye Postgres + MSSQL scripts).
- Startup self-test `assert_read_only(engine)`: transaction mein `CREATE TABLE __og_probe(x int)` try karo; succeed ho jaaye to rollback karke app **start na kare**.
- Statement timeout config `DB_STATEMENT_TIMEOUT_MS`; timeout pe user ko "query too expensive, narrow it down" message.
- Gate prep: two-user demo mein dikhao ki admin user bhi Text-to-SQL se `DELETE` nahi chala sakta.

### Common pitfalls
- `db_datareader` / `SELECT ANY TABLE` de dena -- read-only hai par poora DB, PII tables bhi; schema/view level pe scope karo.
- Sirf code-level guard (regex "no DELETE") pe bharosa -- bypass hote hain (CTE with DELETE, functions with side effects).
- Read-only role, par timeout nahi -- ek galat join prod DB ko 20 minute busy rakh sakta hai.

### Checklist before moving on
- [ ] App ka login sirf SELECT kar sakta hai, sirf zaroori schema/views pe.
- [ ] Startup pe read-only self-test hai.
- [ ] Statement timeout DB ya driver level pe set hai.
- [ ] PII columns views se bahar hain.

### Related
- M11-11 Constructing safe parameterized queries to prevent SQL injection
- M11-14 Handling Text-to-SQL logic constraints and fallbacks
- M11-15 Sandboxing and staging before legacy production changes
- M03-09 Principle of least privilege
- M12-07 Enforcing data-level permissions in retrieval layers

### Self-quiz
1. Code mein SQL guard hai, phir bhi read-only role kyun? Ek concrete bypass socho.
2. `default_transaction_read_only = on` akela kaafi kyun nahi hai?
3. PII column ko LLM se kaise chhupaoge -- view, column DENY, ya dono? Trade-off?
4. Statement timeout 5 s hai aur ek legit report 8 s leti hai. Kya karoge?
