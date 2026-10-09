# OmniGuard - Secure AI Integration

## Secure Text-to-SQL

> Deliverable 02 of 12 | Built in: Fast CP5 / Slow CP7 | Time box: 9 h

### Goal
Let analysts ask data questions in plain English and get rows from the MS SQL claims replica, while proving that LLM-written T-SQL can never write, never read restricted columns, and never dump unbounded result sets.

### Customer context (Kavach Finserv)
Rahul (Data lead) owns `ClaimsDB` on MS SQL. His condition for replica access: evidence that `DROP`, `UPDATE`, `SELECT ... INTO`, `EXEC` can never run, and that no query returns 5 lakh rows. MS SQL has `TOP`, not `LIMIT`, and `SELECT ... INTO` silently creates a table, so a sqlite-dialect guard is not enough. `customers.pan` and `claims.medical_notes` are `restricted` (Deliverable 09).

### What to build
- SQL path: schema context (Deliverable 04) -> LLM writes T-SQL (strict JSON, M05-06) -> guard -> read-only engine with timeout -> rows -> answer.
- Guard in `omniguard/sql/guard.py`, parsing with the `tsql` dialect. Rules, at minimum:
  - exactly one statement, and it is a `SELECT`; unparseable SQL is rejected
  - reject `SELECT ... INTO`, `EXEC`/`xp_cmdshell`, `OPENROWSET`, `WAITFOR`, any DDL/DML, also inside CTEs and subqueries
  - allowed tables and columns per role (from `config/rbac.yaml` / data dictionary); restricted columns never allowed
  - row cap: inject or lower `TOP` to `MAX_ROWS` (200)
  - data-level filter injected into the AST for non-admin roles (for example `region = :user_region`, M12-07)
- Interface: `guard(sql: str, role: str) -> str` (returns the safe SQL or raises). The M15-07 harness calls `guard(sql)` with one argument, so also expose a one-argument adapter bound to the most restricted role, and point `OMNIGUARD_SQL_GUARD` at it.
- Router in `/v1/ask`: data questions -> `"route": "sql"`, `"sources": ["ClaimsDB.claims", ...]`; mixed questions -> `"route": "both"`.
- Fallbacks: guard rejection or timeout -> `200` with a `cannot_answer` style message and no rows, never a 500.
- `docs/sql-guard-evidence.md`: table "attack -> blocked by (guard rule / DB role / timeout) -> test name", ready to send to Rahul.

Config keys: `SQL_DIALECT=tsql`, `SQL_MAX_ROWS=200`, `DB_STATEMENT_TIMEOUT_MS`, `SQL_ALLOWED_TABLES_FILE`.

### Inputs: lessons to (re)read
- M11-11 Constructing safe parameterized queries to prevent SQL injection
- M11-12 Implementing read-only database roles
- M11-13 Mapping complex database schemas to LLM context
- M11-14 Handling Text-to-SQL logic constraints and fallbacks
- M05-06 Enforcing strict JSON output schemas via APIs; M05-09 Handling and retrying output parsing errors gracefully
- M12-06 Implementing Role-Based Access Control; M12-07 Enforcing data-level permissions in retrieval layers
- M15-07 Constructing Hybrid RAG alongside secure Text-to-SQL for MS SQL databases (the harness)

### Acceptance checks
Automated by the M15-07 harness (`omniguard/tests/acceptance/test_rag_sql.py`, `OMNIGUARD_SQL_GUARD=omniguard.sql.guard:<adapter>`):
1. Rejected: `DROP TABLE`, `UPDATE`, multi-statement batch, `SELECT ... INTO`, `EXEC xp_cmdshell`, `SELECT pan FROM customers`.
2. Rejected (your 5 additions): `OPENROWSET`, `WAITFOR DELAY`, nested subquery into a restricted table, CTE that deletes, unparseable SQL.
3. Capped: `SELECT TOP 5000 ...` and a query with no `TOP` both come out with `TOP <= 200`, and executing them returns at most 200 rows.
4. `/v1/ask` routing: 10 `ASK_CASES` (docs-only, data-only, both) return the expected `route` and source id.
5. Two roles, same data question -> different rows (data-level filter), and the restricted-role user asking for a forbidden table gets `cannot_answer`.
6. A `DELETE` request from any role, including admin, is blocked and zero rows change (M11-12, M11-14).
7. A deliberately slow query hits the statement timeout and returns a friendly message within the timeout budget.
8. Fault injection: disable one guard rule in a branch -> the harness goes red in CI (screenshot in README).

### Proof for the gate
Part of the CP5 two-user demo: same question, two users, different allowed rows, plus one blocked write. Link the CI run and `docs/sql-guard-evidence.md`.

### Definition of done
- Zero failures from the M15-07 SQL harness on your real guard; the naive stand-in assertions no longer apply.
- Every guard rule has at least one test; the evidence table lists every rule.
- No user input is ever string-formatted into SQL (CI grep check from M11-11).

### Out of scope
Connection, pooling, TLS and the read-only DB login itself (Deliverable 04), JWT verification (Deliverable 03), write tools or change runners (M11-15), query result caching.

### Stretch goals
- 200 adversarial prompts end-to-end through the LLM: report "0 write statements executed" (the SOW D2 criterion in M15-03).
- "Needed tables recall" >= 0.9 on 20 sample questions for schema context ranking (M11-13).
- Show the generated SQL to the user in a debug mode gated by a permission.
