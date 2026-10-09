# Legacy Systems & Integrations

## Establishing secure connections using Python-native drivers (pyodbc, oracledb) and SQLAlchemy

> Core | Fast CP5 / Slow CP7 | ~1.2 h | Builds on: M01-15, M03-03

### Kahani
Hospital ka billing data MS SQL Server pe hai, pharmacy ka Oracle 19c pe. OmniGuard ko dono se read karna hai.
Customer ke DBA ne pehli meeting mein teen sawaal pooche: "Connection encrypted hai? Certificate verify karte ho? Password kahan rakha hai?"
Aapke prototype mein `TrustServerCertificate=yes` tha (StackOverflow se copy), password `config.py` mein, aur koi timeout nahi. Ek din DB failover hua, OmniGuard ke saare workers 15 minute tak hang rahe.
DBA ne production access dene se mana kar diya. Ye lesson us meeting ko pass karne ke liye hai.

### What it is
**pyodbc** = ODBC driver ke through SQL Server (aur doosre DBs) se connect; **python-oracledb** = Oracle ka official driver (thin mode mein Oracle Client install ki zaroorat nahi).
**SQLAlchemy 2** in drivers ke upar engine, connection pool aur `text()` queries deta hai -- ek hi code style, alag databases.

### Why it matters for an FDE
Customer ka DB unka sabse sensitive asset hai. Unencrypted ya unverified connection, plaintext password, ya bina timeout ka pool -- in mein se koi bhi ek security review fail karne ke liye kaafi hai.

### Key concepts
- **TLS + verification** -- SQL Server: `Encrypt=yes;TrustServerCertificate=no`; Postgres: `sslmode=verify-full`; Oracle: `TCPS` protocol + server DN match. "Encrypted but not verified" = MITM possible.
- **Secrets from env / vault** -- DSN parts env ya secrets manager se; `URL.create()` special characters escape karta hai aur `repr` mein password `***`.
- **Timeouts** -- connect timeout (login), query/call timeout (per statement), pool timeout (free connection ka wait). Teeno set karo.
- **Pool hygiene** -- `pool_pre_ping=True` (failover ke baad dead connections), `pool_recycle` (firewall idle kill se pehle), chhota `pool_size` -- legacy DB ke connection limits tight hote hain.
- **Least privilege login** -- app ka apna login, read-only role (M11-12); DBA ka ya `sa` account kabhi nahi.

### Code example
`pip install sqlalchemy`   (sqlite stands in for the real server; pyodbc/oracledb code is in the real-version block)

```python
# runnable
from sqlalchemy import URL, create_engine, event, text

FAKE_ENV = {"MSSQL_HOST": "billing-db.hospital.internal", "MSSQL_DB": "billing", "MSSQL_USER": "svc_omniguard",
            "MSSQL_PASSWORD": "p@ss;word}1", "PG_PASSWORD": "s3cr@t/#?"}       # real: os.environ / vault

def odbc_escape(value: str) -> str:
    return "{" + value.replace("}", "}}") + "}"               # ODBC rule: wrap in braces, double any }

def mssql_odbc_string(env: dict, connect_timeout: int = 15) -> str:
    parts = {"Driver": "{ODBC Driver 18 for SQL Server}", "Server": f"tcp:{env['MSSQL_HOST']},1433",
             "Database": env["MSSQL_DB"], "Uid": env["MSSQL_USER"], "Pwd": odbc_escape(env["MSSQL_PASSWORD"]),
             "Encrypt": "yes", "TrustServerCertificate": "no", "Connection Timeout": str(connect_timeout),
             "ApplicationIntent": "ReadOnly"}                     # routes to a readable secondary if AG is set up
    return ";".join(f"{k}={v}" for k, v in parts.items()) + ";"

def assert_secure(conn_str: str) -> None:
    kv = {k.strip().lower(): v.strip().lower() for k, v in (p.split("=", 1) for p in conn_str.split(";") if "=" in p)}
    problems = []
    if kv.get("encrypt") not in ("yes", "mandatory", "strict"):
        problems.append("Encrypt must be yes/strict")
    if kv.get("trustservercertificate") == "yes":
        problems.append("TrustServerCertificate=yes disables certificate validation")
    if "connection timeout" not in kv:
        problems.append("missing Connection Timeout")
    if problems:
        raise ValueError("; ".join(problems))

cs = mssql_odbc_string(FAKE_ENV)
assert_secure(cs)
assert "Pwd={p@ss;word}}1}" in cs                                # ; and } inside the password are safe
for bad in [cs.replace("TrustServerCertificate=no", "TrustServerCertificate=yes"), cs.replace("Encrypt=yes", "Encrypt=no")]:
    try:
        assert_secure(bad)
        raise AssertionError("insecure config accepted")
    except ValueError as e:
        print("rejected:", e)

pg_url = URL.create("postgresql+psycopg", username="svc_omniguard", password=FAKE_ENV["PG_PASSWORD"],
                    host="pg.hospital.internal", port=5432, database="pharmacy",
                    query={"sslmode": "verify-full", "connect_timeout": "10"})
print("safe to log:", pg_url)                                     # password rendered as ***
assert FAKE_ENV["PG_PASSWORD"] not in str(pg_url) and "***" in str(pg_url)
assert "s3cr%40t%2F%23%3F" in pg_url.render_as_string(hide_password=False)   # escaped for the URL

engine = create_engine("sqlite://", pool_pre_ping=True, connect_args={"timeout": 5})   # stand-in server
seen = []
@event.listens_for(engine, "before_cursor_execute")
def log_sql(conn, cursor, statement, params, context, executemany):
    seen.append(statement)                                        # log SQL text, never the params (PII)

with engine.connect() as conn:                                    # context manager returns it to the pool
    assert conn.execute(text("SELECT 1")).scalar_one() == 1
engine.dispose()
assert seen == ["SELECT 1"]
print("OK: escaped DSN, TLS flags enforced, password hidden, pooled connection with timeouts")
```

- `odbc_escape` -- password mein `;` ya `}` ho to connection string toot jaata hai ya inject ho sakta hai; braces + `}}` ODBC ka rule hai.
- `assert_secure` -- startup pe fail fast: koi config `TrustServerCertificate=yes` ya bina encrypt ke chale hi nahi.
- `URL.create` -- password escape aur `str(url)` mein `***`; connection URL ko logs mein print karna ab safe hai.
- `pool_pre_ping=True` -- har checkout pe halka ping; failover ke baad dead connection pe query fail nahi hoti.
- `before_cursor_execute` -- SQL text log, params nahi; patient names params mein hote hain.

```python
# real version -- not run here, needs: pip install pyodbc oracledb sqlalchemy  (+ ODBC Driver 18 for SQL Server)
import os
import oracledb
import pyodbc
from sqlalchemy import URL, create_engine

cs = mssql_odbc_string(os.environ)                                  # from the block above
conn = pyodbc.connect(cs, timeout=15, readonly=True)                # login timeout; readonly is a driver hint
conn.timeout = 30                                                   # per-query timeout in seconds
mssql = create_engine(URL.create("mssql+pyodbc", query={"odbc_connect": cs}),
                      pool_size=5, max_overflow=2, pool_timeout=10, pool_recycle=1800, pool_pre_ping=True)

# Oracle thin mode, TLS (TCPS). DSN e.g. "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCPS)(HOST=ph-db)(PORT=2484))
#   (CONNECT_DATA=(SERVICE_NAME=PHARM))(SECURITY=(SSL_SERVER_DN_MATCH=YES)))"
ora = oracledb.connect(user=os.environ["ORA_USER"], password=os.environ["ORA_PASSWORD"],
                       dsn=os.environ["ORA_DSN"], tcp_connect_timeout=10)
ora.call_timeout = 30_000                                           # milliseconds per round trip
oracle = create_engine("oracle+oracledb://", creator=lambda: oracledb.connect(
    user=os.environ["ORA_USER"], password=os.environ["ORA_PASSWORD"], dsn=os.environ["ORA_DSN"],
    tcp_connect_timeout=10), pool_pre_ping=True, pool_size=3)
```

Exact parameter names driver versions ke saath badalte hain (e.g. ODBC Driver 18 mein `Encrypt` default `yes` hai, 17 mein `no`) -- apne driver version ke docs check karo.

### Mini-exercise (30-60 min)
OmniGuard: `omniguard/sql/connection.py` banao.
- `make_engine(settings)` -- `DB_KIND` (sqlite | postgres | mssql | oracle), sab values env se (pydantic-settings ya plain `os.environ`).
- Startup check: non-sqlite pe TLS/verify flags na hon to app start hi na ho; error message mein password kabhi nahi.
- Pool + timeouts config se: `DB_POOL_SIZE`, `DB_CONNECT_TIMEOUT`, `DB_STATEMENT_TIMEOUT_MS`.
- Tests: secure string pass, 3 insecure variants fail, password with `;}@` chars, `str(engine.url)` mein `***`.

### Common pitfalls
- `TrustServerCertificate=yes` / `sslmode=require` -- encrypted hai par server verify nahi hota; customer ka CA bundle maango.
- Password string concat se URL mein -- `@` ya `/` aaya to parse galat, aur stack trace mein password leak.
- Har request pe naya engine/connection -- legacy DB ke connection limits khatam; ek engine per process, pool reuse.

### Checklist before moving on
- [ ] Teeno DBs (MSSQL, Oracle, Postgres) ke TLS-verify flags bata sakta hoon.
- [ ] Credentials sirf env/vault se, logs mein `***`.
- [ ] Connect, query aur pool timeouts set hain.
- [ ] App ka apna least-privilege login hai.

### Related
- M11-11 Constructing safe parameterized queries to prevent SQL injection
- M11-12 Implementing read-only database roles
- M12-09 API keys vs service accounts
- M13-14 Safe logging (never log PII or prompts)

### Self-quiz
1. `Encrypt=yes;TrustServerCertificate=yes` -- kya protect hota hai aur kya nahi?
2. DB failover ke baad pool mein dead connections hain. Kaunsa setting help karta hai aur kaise?
3. Password mein `;` hai. Bina escaping ke ODBC string mein kya ho sakta hai?
4. Connect timeout aur query timeout mein farq kya hai? Dono kyun chahiye?
