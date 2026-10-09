# Legacy Systems & Integrations

## Handling Text-to-SQL logic constraints and fallbacks

> Core | Fast CP5 / Slow CP7 | ~1.2 h | Builds on: M11-11, M11-12, M11-13, M05-09

### Kahani
Distributor customer ke sales head ne OmniGuard se poocha: "Top customers dikhao." Model ne `SELECT * FROM CUST_MST` likha -- 2 lakh rows, phone numbers ke saath, browser hang.
Agle din: "orders saaf karo" pe `DELETE` (read-only role ne bachaya, M11-12), aur ek user ne prompt mein `; DROP TABLE` chhupaya.
Teesra case sabse subtle: "last quarter revenue" -- schema mein revenue column hi nahi tha, model ne `AMT * 1.18` invent karke ek number de diya. CFO ne wahi number board deck mein daala.
Guard ka kaam sirf "dangerous SQL rokna" nahi -- "jab jawab pata nahi, to number mat banao" bhi hai.

### What it is
**Text-to-SQL guard** = LLM ke generated SQL ko execute karne se pehle **parse** karke rules enforce karna: ek hi `SELECT`, allowed tables/columns only, koi comments/multiple statements nahi, `LIMIT` forced.
**Fallbacks** = jab guard fail ho, sawaal ambiguous ho, ya data available na ho: clarifying question, ya honest "can't answer" -- kabhi bhi failed SQL execute nahi.

### Why it matters for an FDE
Text-to-SQL demos 10 minute mein ban jaate hain; production mein galat-par-confident numbers aur PII leaks hi project ko khatam karte hain. Customer ko "ye kya kabhi nahi karega" ki list chahiye -- wo yahi guard hai.

### Key concepts
- **Parse, don't regex** -- `sqlglot.parse()` se AST; `"DELETE"` string search CTE-with-DELETE ya comments se bypass hota hai.
- **Allow-lists** -- tables (role ke hisaab se, M12-06) aur PII columns deny; `SELECT *` reject (kaunse columns aayenge pata nahi).
- **LIMIT rewrite** -- missing ya bada limit -> cap (e.g. 200); results bhi row-capped.
- **Structured LLM output** -- `{"sql": ...}` ya `{"clarify": ...}` ya `{"cannot_answer": ...}`; model ko "na" bolne ka rasta do.
- **One repair attempt** -- guard error model ko wapas (M05-09), ek baar; phir bhi fail = fallback message. Defense in depth: read-only role + timeout (M11-12).

### Code example
`pip install sqlalchemy sqlglot`

> Needs API key for the real version: ANTHROPIC_API_KEY (or OPENAI_API_KEY). Here a FakeLLM returns canned answers.

```python
# runnable
import json
import sqlglot
from sqlglot import exp
from sqlalchemy import create_engine, text
engine = create_engine("sqlite://")
with engine.begin() as c:
    c.execute(text("CREATE TABLE CUST_MST (CUST_ID INTEGER PRIMARY KEY, CITY_CD TEXT, PHONE TEXT)"))
    c.execute(text("CREATE TABLE ORD_HDR (ORD_ID INTEGER PRIMARY KEY, CUST_ID INTEGER, STS TEXT)"))
    c.execute(text("CREATE TABLE EMP_MST (EMP_ID INTEGER PRIMARY KEY, SALARY NUMERIC)"))
    c.execute(text("INSERT INTO CUST_MST VALUES (1,'PUN','9-1'),(2,'DEL','9-2'),(3,'PUN','9-3')"))
    c.execute(text("INSERT INTO ORD_HDR VALUES (10,1,'P'),(11,2,'S'),(12,3,'P'),(13,1,'X')"))
ALLOWED_TABLES = {"CUST_MST", "ORD_HDR"}             # per role (M12-06); EMP_MST is not for this user
PII_COLUMNS, MAX_ROWS = {"PHONE"}, 200
class GuardError(ValueError): ...

def guard(sql: str) -> str:
    if any(t.comments for t in sqlglot.tokenize(sql, read="sqlite")):
        raise GuardError("comments are not allowed")
    try:
        stmts = sqlglot.parse(sql, read="sqlite")
    except sqlglot.errors.ParseError:
        raise GuardError("SQL does not parse")
    if len(stmts) != 1 or not isinstance(stmts[0], exp.Select):
        raise GuardError("exactly one SELECT statement is allowed")
    tree = stmts[0]
    if any(isinstance(n, (exp.Insert, exp.Update, exp.Delete, exp.Drop, exp.Create, exp.Command)) for n in tree.walk()):
        raise GuardError("write/DDL inside the query")
    tables = {t.name.upper() for t in tree.find_all(exp.Table)} - {c.alias_or_name.upper() for c in tree.find_all(exp.CTE)}
    if not tables <= ALLOWED_TABLES:
        raise GuardError(f"table(s) not allowed: {sorted(tables - ALLOWED_TABLES)}")
    if any(isinstance(n, exp.Star) for n in tree.walk()) and not any(isinstance(n, exp.Count) for n in tree.walk()):
        raise GuardError("SELECT * is not allowed; name the columns")
    if {c.name.upper() for c in tree.find_all(exp.Column)} & PII_COLUMNS:
        raise GuardError("PII column requested")
    if (limit := tree.args.get("limit")) is None or int(limit.expression.name) > MAX_ROWS:
        tree = tree.limit(MAX_ROWS)
    return tree.sql(dialect="sqlite")
class FakeLLM:   # stands in for client.messages.create(...) with structured output; canned JSON per question
    ANSWERS = {
        "pending orders in pune": [{"sql": "SELECT COUNT(DISTINCT o.CUST_ID) AS n FROM ORD_HDR o JOIN CUST_MST c ON c.CUST_ID = o.CUST_ID WHERE o.STS = 'P' AND c.CITY_CD = 'PUN'"}],
        "clean cancelled orders": [{"sql": "DELETE FROM ORD_HDR WHERE STS = 'X'"}, {"sql": "DELETE FROM ORD_HDR WHERE STS = 'X'"}],
        "customer phones": [{"sql": "SELECT PHONE FROM CUST_MST"}, {"cannot_answer": "phone numbers are restricted"}],
        "list customers": [{"sql": "SELECT * FROM CUST_MST"}, {"sql": "SELECT CUST_ID, CITY_CD FROM CUST_MST"}],
        "salaries": [{"sql": "SELECT SUM(SALARY) FROM EMP_MST; -- x\nDROP TABLE ORD_HDR"}, {"sql": "SELECT SUM(SALARY) FROM EMP_MST"}],
        "top customers": [{"clarify": "Top by order count or by order value?"}],
    }
    def __init__(self): self.calls = {}
    def complete(self, question: str, feedback: str | None = None) -> str:
        n = self.calls[question] = self.calls.get(question, -1) + 1
        return json.dumps(self.ANSWERS[question][min(n, len(self.ANSWERS[question]) - 1)])
def answer(question: str, llm: FakeLLM) -> dict:
    feedback = None
    for _ in range(2):                                  # first try + one repair attempt
        out = json.loads(llm.complete(question, feedback))
        for kind in ("clarify", "cannot_answer"):     # the model is allowed to say "ask" or "no"
            if kind in out:
                return {"type": kind, "message": out[kind]}
        try:
            safe_sql = guard(out["sql"])
        except GuardError as e:
            feedback = str(e)                          # sent back to the model, never executed
            continue
        with engine.connect() as c:                    # real: read-only role + statement timeout (M11-12)
            rows = c.execute(text(safe_sql)).fetchmany(MAX_ROWS)
        return {"type": "rows", "sql": safe_sql, "rows": [list(r) for r in rows]}
    return {"type": "cannot_answer", "message": f"I could not build a safe query ({feedback})."}

llm = FakeLLM()
results = {q: answer(q, llm) for q in FakeLLM.ANSWERS}
for q, r in results.items():
    print(f"{q:24} -> {r['type']:13} {r.get('rows', r.get('message', ''))}")
assert results["pending orders in pune"]["rows"] == [[2]] and "LIMIT 200" in results["pending orders in pune"]["sql"]
assert results["clean cancelled orders"]["type"] == results["customer phones"]["type"] == "cannot_answer"
assert results["list customers"]["rows"] == [[1, "PUN"], [2, "DEL"], [3, "PUN"]]          # repaired after SELECT *
assert results["salaries"]["type"] == "cannot_answer" and "not allowed" in results["salaries"]["message"]
assert results["top customers"]["type"] == "clarify"
with engine.connect() as c:
    assert c.execute(text("SELECT COUNT(*) FROM ORD_HDR")).scalar_one() == 4                # nothing deleted
print("OK: single SELECT, allow-listed tables, no PII, LIMIT forced, clarify/cannot-answer fallbacks")
```

- `sqlglot.tokenize` comments check -- `--`/`/* */` se attackers baaki SQL chhupaate hain; strict rule: koi comment nahi.
- `len(stmts) != 1` + `isinstance(Select)` -- `; DROP TABLE` aur `DELETE` dono yahin ruk jaate hain; `walk()` CTE ke andar chhupi writes pakadta hai.
- `tables - ctes` -- CTE names asli tables nahi; baaki sab `ALLOWED_TABLES` mein hone chahiye.
- `tree.limit(MAX_ROWS)` -- AST level pe LIMIT add, phir `fetchmany(MAX_ROWS)` second cap.
- `answer()` -- guard fail = SQL kabhi execute nahi; ek repair attempt, phir honest `cannot_answer`. `clarify` model ka valid output hai, error nahi.

```python
# real version -- not run here, needs: pip install anthropic
import os
import anthropic

client = anthropic.Anthropic()                                    # ANTHROPIC_API_KEY from env
SCHEMA = {"type": "object", "additionalProperties": False, "properties": {
    "sql": {"type": "string"}, "clarify": {"type": "string"}, "cannot_answer": {"type": "string"}}}
resp = client.messages.create(
    model=os.environ["LLM_MODEL"], max_tokens=800,
    system="Write ONE SQLite SELECT using only the schema below. If the question is ambiguous, return clarify. "
           "If the data is not in the schema, return cannot_answer. Never invent columns.\n" + schema_context_text,
    messages=[{"role": "user", "content": question + (f"\nPrevious attempt rejected: {feedback}" if feedback else "")}],
    output_config={"format": {"type": "json_schema", "schema": SCHEMA}})
out_json = resp.content[0].text
```

### Mini-exercise (30-60 min)
OmniGuard CP5 build: `omniguard/sql/guard.py` + `/sql/ask` endpoint.
- `guard(sql, role) -> str` -- allowed tables/PII columns role se (RBAC, M12-06); data-level permission: non-admin ke liye `WHERE region = :user_region` filter AST mein inject karo (M12-07).
- Endpoint flow: auth (OAuth2/JWT) -> schema context (M11-13) -> LLM -> guard -> read-only engine -> row cap -> response with `sql`, `rows`, `type`.
- Tests: 15+ adversarial cases (`DELETE`, CTE-delete, `;`, comments, `SELECT *`, EMP table, PII column, 10k limit, unparseable) -- har case mein zero execution.
- **CP5 gate -- two-user demo:** analyst (Pune region) vs admin; same question -> alag rows; analyst ka EMP_MST sawaal -> `cannot_answer`; dono ka `DELETE` -> blocked.

### Common pitfalls
- Regex se "DELETE" dhundhna -- comments, case, CTE aur functions se bypass; AST use karo.
- Guard fail hone pe "best effort" mein original SQL chala dena -- fallback ka matlab hai **mat chalao**.
- Model ko "cannot answer" ka option na dena -- wo hamesha koi na koi SQL banayega, chahe columns invent karne pade.

### Checklist before moving on
- [ ] Guard sqlglot AST pe chalta hai: single SELECT, allowed tables, no comments, no PII, LIMIT forced.
- [ ] Guard fail = kabhi execute nahi; ek repair attempt, phir fallback.
- [ ] Clarify aur cannot_answer dono user ko clearly dikhte hain.
- [ ] Guard ke peeche read-only role aur statement timeout hai.

### Related
- M11-13 Mapping complex database schemas to LLM context
- M11-12 Implementing read-only database roles
- M11-11 Constructing safe parameterized queries to prevent SQL injection
- M12-07 Enforcing data-level permissions in retrieval layers
- M05-09 Handling and retrying output parsing errors gracefully

### Self-quiz
1. `WITH d AS (DELETE ... RETURNING *) SELECT * FROM d` -- regex guard isse kyun miss karega, aur AST guard kaise pakadta hai?
2. Guard ne query reject ki. User ko kya dikhna chahiye, aur kya kabhi nahi hona chahiye?
3. Model ne existing columns se "revenue" calculate kar diya jo business definition se match nahi karta. Ise kaise rokoge?
4. Analyst aur admin same sawaal poochte hain -- data-level permission guard mein kahan enforce karoge?
