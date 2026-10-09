# Legacy Systems & Integrations

## Sandboxing and staging before legacy production changes

> Core | Fast CP5 / Slow CP7 | ~1.2 h | Builds on: M11-12, M11-14, M10-04

### Kahani
Hospital ke scheduling system mein OmniGuard ko pehli baar **write** access chahiye tha: "no-show appointments ko auto-cancel karo."
Aapne staging pe test kiya, sab theek. Prod pe chalaya -- staging mein 200 appointments the, prod mein 40,000, aur ek timezone bug ne aaj ke appointments ko bhi "past" maan liya. 3,100 valid appointments cancel, patients ko SMS chale gaye.
Rollback script tha hi nahi. Customer ke change advisory board (CAB) ne poocha: "Change ticket kahan hai? Dry-run output kahan hai? Approver kaun tha?"
Legacy production ko touch karne ka ek ritual hota hai -- aur wo ritual code mein hona chahiye, sirf Confluence page pe nahi.

### What it is
**Sandbox/staging discipline** = prod change se pehle: realistic copy (snapshot ya read replica) pe **dry-run**, change ticket, doosre insaan ka **approval**, feature flag, expected-impact guard, aur tested **rollback plan**.
Code mein: ek executor jo default dry-run hai, aur real run sirf approved ticket + flag ON + impact match hone pe karta hai.

### Why it matters for an FDE
Legacy systems ke paas aksar undo, audit ya proper staging nahi hota. FDE ki ek galti customer ke patients/customers tak pahunchti hai -- aur trust (aur contract) wahi khatam.

### Key concepts
- **Snapshot / read replica** -- staging data prod jaisa hona chahiye (volume, edge cases); masked prod snapshot best, warna replica pe read-only dry-run.
- **Dry-run by default** -- har write tool pehle "kya badlega" batata hai (row count + sample diff), kuch commit nahi karta.
- **Change ticket + four-eyes approval** -- ticket id, approver != requester; customer ka CAB process follow karo.
- **Blast-radius guard** -- real run mein affected rows dry-run se match na karein ya threshold cross karein -> abort + rollback.
- **Rollback plan** -- before-images save karo (ya reverse script), aur rollback ko bhi staging pe test karo. Feature flag se turant band.

### Code example
stdlib only

```python
# runnable
import sqlite3
from contextlib import closing
from dataclasses import dataclass

def make_prod() -> sqlite3.Connection:
    db = sqlite3.connect(":memory:")
    db.execute("CREATE TABLE appt (id INTEGER PRIMARY KEY, patient TEXT, slot TEXT, status TEXT)")
    db.executemany("INSERT INTO appt (patient, slot, status) VALUES (?, ?, ?)",
                   [(f"p{i}", f"2026-10-{1 + i % 12:02d}", "BOOKED") for i in range(60)])
    db.commit(); return db

@dataclass
class Change:
    ticket: str            # customer's change ticket, e.g. CHG0012345
    requester: str
    sql: str               # parameterized UPDATE
    params: tuple
    max_rows: int          # blast-radius limit agreed in the ticket

FLAGS, APPROVALS, AUDIT = {"auto_cancel_enabled": False}, {}, []   # approvals: ticket -> approver

def dry_run(prod: sqlite3.Connection, ch: Change) -> int:
    with closing(sqlite3.connect(":memory:")) as snap:
        prod.backup(snap)                                 # snapshot; prod is never written in dry-run
        n = snap.execute(ch.sql, ch.params).rowcount
    AUDIT.append(("dry_run", ch.ticket, n))
    return n

def execute(prod: sqlite3.Connection, ch: Change, expected_rows: int) -> list[tuple]:
    approver = APPROVALS.get(ch.ticket)
    if not FLAGS["auto_cancel_enabled"]:
        raise PermissionError("feature flag is off")
    if approver is None or approver == ch.requester:
        raise PermissionError("needs approval from someone other than the requester")
    where = ch.sql.split("WHERE", 1)[1]                   # before-images = rollback plan (same WHERE, same params)
    before = prod.execute(f"SELECT id, status FROM appt WHERE {where}", ch.params[1:]).fetchall()
    try:
        n = prod.execute(ch.sql, ch.params).rowcount
        if n != expected_rows or n > ch.max_rows:
            raise RuntimeError(f"blast radius mismatch: dry-run={expected_rows} now={n} limit={ch.max_rows}")
        prod.commit()
    except Exception:
        prod.rollback()
        AUDIT.append(("aborted", ch.ticket, approver))
        raise
    AUDIT.append(("executed", ch.ticket, approver, n))
    return before                                         # stored as the rollback plan

def rollback(prod: sqlite3.Connection, before: list[tuple], ticket: str) -> None:
    prod.executemany("UPDATE appt SET status = ? WHERE id = ?", [(s, i) for i, s in before])
    prod.commit(); AUDIT.append(("rolled_back", ticket, len(before)))

prod = make_prod()
count = lambda: prod.execute("SELECT COUNT(*) FROM appt WHERE status = 'CANCELLED'").fetchone()[0]
ch = Change("CHG0012345", "omniguard-bot", "UPDATE appt SET status = ? WHERE slot < ? AND status = 'BOOKED'",
            ("CANCELLED", "2026-10-04"), max_rows=20)
expected = dry_run(prod, ch)
assert expected == 15 and count() == 0                    # dry-run touched nothing
for setup in [lambda: None, lambda: FLAGS.update(auto_cancel_enabled=True),
              lambda: APPROVALS.update({ch.ticket: "omniguard-bot"})]:          # flag off, no approver, self-approval
    setup()
    try:
        execute(prod, ch, expected)
        raise AssertionError("should be refused")
    except PermissionError as e:
        print("refused:", e)
APPROVALS[ch.ticket] = "dr.mehta"                         # a different human approves in the change ticket
prod.execute("INSERT INTO appt (patient, slot, status) VALUES ('late', '2026-10-01', 'BOOKED')"); prod.commit()  # drift
try:
    execute(prod, ch, expected)
except RuntimeError as e:
    print("aborted:", e)
assert count() == 0                                       # transaction rolled back
expected = dry_run(prod, ch)                              # re-plan on fresh snapshot, then run
before = execute(prod, ch, expected)
assert count() == 16 == len(before)
rollback(prod, before, ch.ticket); assert count() == 0
assert [a[0] for a in AUDIT] == ["dry_run", "aborted", "dry_run", "executed", "rolled_back"]
print("OK: dry-run on snapshot, flag + four-eyes gate, blast-radius abort, tested rollback")
```

- `prod.backup(snap)` -- sqlite ka online backup = snapshot; dry-run snapshot pe, prod pe zero writes.
- Teen refusals -- flag off, approver missing, requester ne khud approve kiya; teeno `PermissionError`, kuch execute nahi.
- Blast-radius guard -- dry-run ke baad data badla (16 vs 15 rows) to real run abort + `rollback()`; phir naya dry-run, naya expectation.
- `before` -- before-images = rollback plan; `rollback()` ko yahin test kiya, prod pe pehli baar nahi.
- `AUDIT` -- har step (dry_run, aborted, executed, rolled_back) ticket id ke saath; real mein append-only audit table (M12-10).

### Mini-exercise (30-60 min)
OmniGuard: `omniguard/sql/change_runner.py` -- agent ke har write tool (e.g. `cancel_noshow`, M11-04 ticket close) ke liye.
- Modes: `DRY_RUN` (default), `EXECUTE`; env `LEGACY_WRITES_ENABLED=false` default (feature flag).
- Approval: Slack interactive button (M11-02) -- approver ka role check, requester != approver, ticket id mandatory.
- Staging: `make staging-snapshot` script jo prod ka masked copy banaye (PII columns hashed); CI mein dry-run isi pe.
- Runbook `docs/rollback.md`: kaise rollback chalana hai, kisko inform karna hai -- staging pe ek baar practice karke time likho.

### Common pitfalls
- Staging mein 200 rows, prod mein 40,000 -- volume aur edge cases (timezones, nulls, legacy codes) alag; masked prod snapshot pe test karo.
- "Rollback = DB backup restore" -- poore DB ka restore baaki sabke changes bhi mita deta hai; change-specific undo rakho.
- Approval Slack message mein "ok" likh dena -- traceable nahi; ticket id + approver identity system mein record ho.

### Checklist before moving on
- [ ] Har legacy write pehle dry-run (snapshot/replica) pe chalta hai aur impact dikhata hai.
- [ ] Real run ke liye flag + ticket + doosre insaan ka approval chahiye.
- [ ] Blast-radius mismatch pe automatic abort + rollback.
- [ ] Rollback plan staging pe tested hai, aur audit log mein har step hai.

### Related
- M11-12 Implementing read-only database roles
- M11-02 Interactive message payloads
- M10-04 Requesting manual state approval
- M12-10 Audit logging
- M14-01 Idempotency keys for safe tool execution

### Self-quiz
1. Dry-run ke baad aur real run se pehle data badal gaya. Aapka system kya karega aur kyun?
2. Requester khud approve kar sakta hai to kya risk hai? Agent ke case mein "requester" kaun hai?
3. Masked prod snapshot vs read replica -- dry-run ke liye kab kaunsa?
4. Rollback ko staging pe test karna kyun zaroori hai, prod pe pehli baar kyun nahi?
