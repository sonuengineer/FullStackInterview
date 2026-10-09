# OmniGuard - Secure AI Integration

## SQL database integration

> Deliverable 04 of 12 | Built in: Fast CP5 / Slow CP7 | Time box: 6 h

### Goal
Connect OmniGuard to the customer's MS SQL replica the way a DBA would approve: encrypted, read-only, pooled, time-limited, and with a schema description the LLM can use without seeing restricted columns. This is the foundation Deliverable 02 runs on.

### Customer context (Kavach Finserv)
`ClaimsDB` lives on MS SQL with about 140 columns. Rahul provides a read replica and a read-only login, but only after he sees the role script and the connection settings. The pilot builds on a synthetic schema until the replica arrives (a risk recorded in the SOW, Deliverable 10).

### What to build
- `omniguard/sql/connection.py`: `make_engine(settings)` for `DB_KIND` = `sqlite` (dev/CI) or `mssql` (real). All values from environment.
  - MS SQL via ODBC Driver 18: `Encrypt=yes`, `TrustServerCertificate=no`, `ApplicationIntent=ReadOnly`, connect timeout.
  - Startup refuses to run if a non-sqlite engine lacks TLS verification; passwords never appear in logs or `str(engine.url)`.
- Startup self-test `assert_read_only(engine)`: tries a probe `CREATE TABLE` in a transaction; if it succeeds, roll back and refuse to start.
- Statement timeout on every query; a timeout becomes a friendly "query too expensive, narrow it down" message.
- `docs/db-role.sql`: MS SQL script for the customer DBA (read-only login/user, `db_datareader` or explicit `GRANT SELECT` on allowed views, explicit `DENY` on restricted tables).
- `omniguard/sql/data_dictionary.yaml`: table/column descriptions, aliases, classification per column (from Deliverable 09), PII list.
- `build_context(question, principal) -> str`: only tables the role may use, restricted columns never included.
- Parameterized queries for any fixed lookup tools (no f-strings into SQL).
- Seed data: a synthetic `ClaimsDB` (claims, customers, policies) with `C-1001` present, used by tests and the demo.
- `/readyz` includes a `db` check (`SELECT 1`), used by Deliverable 07.

Config keys: `DB_KIND`, `MSSQL_HOST`, `MSSQL_RO_USER`, `MSSQL_RO_PASSWORD`, `DB_POOL_SIZE`, `DB_CONNECT_TIMEOUT`, `DB_STATEMENT_TIMEOUT_MS`.

### Inputs: lessons to (re)read
- M11-10 Establishing secure connections using Python-native drivers (pyodbc, oracledb) and SQLAlchemy
- M11-11 Constructing safe parameterized queries to prevent SQL injection
- M11-12 Implementing read-only database roles
- M11-13 Mapping complex database schemas to LLM context
- M11-15 Sandboxing and staging before legacy production changes
- M02-03 Dependency injection; M02-12 Fixtures and mocking
- M04-13 Health and readiness checks
- M15-07 Constructing Hybrid RAG alongside secure Text-to-SQL for MS SQL databases (real MS SQL connection notes)

### Acceptance checks
1. Secure connection settings pass; three insecure variants (no encrypt, trust any cert, missing timeout) make startup fail (M11-10).
2. Password containing `;}@` characters connects in tests; `str(engine.url)` shows `***` (M11-10).
3. `assert_read_only` blocks startup against a writable engine and passes against `mode=ro` sqlite (M11-12).
4. Injection corpus (`' OR '1'='1`, `UNION SELECT`, `; DROP TABLE`, `%`, unicode quotes) through parameterized tools: no extra rows, no 500 (M11-11).
5. CI grep check fails on `text(f"` / `exec_driver_sql(f"` with user variables (M11-11).
6. Schema context for an `underwriter` never contains `customers.pan` or `claims.medical_notes` (M11-13, Deliverable 09).
7. Statement timeout: a slow query is cancelled and returns the friendly message (M11-12).
8. `/readyz` returns 503 when the DB is unreachable while `/healthz` stays 200 (M04-13).
9. The M15-07 SQL harness executes guarded queries against the seed database without errors.

### Proof for the gate
Included in the CP5 two-user demo (rows come from the read-only engine). Link the CI run and `docs/db-role.sql`.

### Definition of done
- All checks automated and green in CI on sqlite; MS SQL path documented and tested at least once locally or against a container.
- No secrets in the repo; `.env.example` lists every key with dummy values.

### Out of scope
The SQL guard and router (Deliverable 02), writes of any kind, Oracle/SOAP integrations, replication setup on the customer side.

### Stretch goals
- Run the suite against SQL Server in Docker (`mcr.microsoft.com/mssql/server`) in a CI job.
- Embedding-ranked table selection with a "needed tables recall" score (M11-13).
- Masked staging snapshot script (M11-15).
