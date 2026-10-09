# Prerequisites

## SQL fundamentals (queries, joins)

> Diagnostic | Fast CP1 / Slow CP1 | ~15 min | Pass = move on. Fail = study only this, then re-test.

Customer site pe pehla kaam aksar hota hai: "unke DB se data nikaalo, phir AI usse use karega". Yeh test check karta hai ki joins aur aggregation aap bina Google kiye likh sakte ho.

### Self-test (answer without looking anything up)
1. `INNER JOIN` aur `LEFT JOIN` mein farak kya hai? Jis customer ka ek bhi order nahi, woh kis join mein dikhega?
2. `WHERE` aur `HAVING` mein farak? `WHERE COUNT(*) > 1` kyun error deta hai?
3. LEFT JOIN ke baad `COUNT(*)` vs `COUNT(o.id)` -- zero orders wale customer ke liye dono kya denge?
4. LEFT JOIN ke baad right table ke column pe `WHERE o.status = 'paid'` lagane se kya hota hai? Sahi jagah kahan lagaoge?
5. SQL ka logical execution order likho: FROM, WHERE, GROUP BY, HAVING, SELECT, ORDER BY, LIMIT.

### Prove it in code
Run karne se pehle har query ka result predict karo.

```python
# runnable
import sqlite3

db = sqlite3.connect(":memory:")
db.executescript("""
CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id),
                     amount REAL, status TEXT);
INSERT INTO customers VALUES (1,'Asha'),(2,'Bilal'),(3,'Chen');
INSERT INTO orders VALUES (1,1,100,'paid'),(2,1,50,'refunded'),(3,2,70,'paid');
""")

inner = db.execute("SELECT c.name FROM customers c JOIN orders o ON o.customer_id = c.id "
                   "GROUP BY c.id ORDER BY c.name").fetchall()
assert inner == [("Asha",), ("Bilal",)]                      # Chen has no orders

counts = db.execute("""
SELECT c.name, COUNT(*) AS rows_, COUNT(o.id) AS orders_
FROM customers c LEFT JOIN orders o ON o.customer_id = c.id
GROUP BY c.id ORDER BY c.name""").fetchall()
assert counts == [("Asha", 2, 2), ("Bilal", 1, 1), ("Chen", 1, 0)]  # COUNT(*) counts the NULL row

wrong = db.execute("SELECT c.name FROM customers c LEFT JOIN orders o ON o.customer_id = c.id "
                   "WHERE o.status = 'paid' ORDER BY c.name").fetchall()
right = db.execute("SELECT c.name FROM customers c LEFT JOIN orders o "
                   "ON o.customer_id = c.id AND o.status = 'paid' ORDER BY c.name").fetchall()
assert wrong == [("Asha",), ("Bilal",)]                     # WHERE turned it into an inner join
assert right == [("Asha",), ("Bilal",), ("Chen",)]

big = db.execute("""
SELECT c.name, SUM(o.amount) AS total FROM customers c JOIN orders o ON o.customer_id = c.id
WHERE o.status = 'paid' GROUP BY c.id HAVING SUM(o.amount) > 80""").fetchall()
assert big == [("Asha", 100.0)]
print("sql: all checks passed")
```

### Pass criteria
- Self-test mein 4/5 sahi, aur Q3 + Q4 dono sahi -- yeh do galtiyan reporting/AI-context queries mein silently galat numbers deti hain.
- `wrong` vs `right` query ka farak bina run kiye samjha paaye.

### If you failed
Study: https://www.sqlitetutorial.net/ (lessons: Inner Join, Left Join, Group By, Having).

30-min plan:
- 10 min -- Inner Join + Left Join lessons; Venn diagram ki jagah "rows multiply / NULL fill" socho.
- 10 min -- Group By + Having lessons; logical execution order yaad karo.
- 10 min -- upar wale tables pe khud 3 queries likho: "har customer ka paid total (0 bhi)", "refund wale customers", "top customer", phir re-test.
