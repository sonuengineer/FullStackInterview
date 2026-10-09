# Prerequisites

## Database basics (tables, keys, normalization)

> Diagnostic | Fast CP1 / Slow CP1 | ~15 min | Pass = move on. Fail = study only this, then re-test.

Customer ka legacy schema dekh ke aapko 10 minute mein batana padega: "yahan duplicate data hai, yahan key missing hai". Yeh test usi nazar ko check karta hai.

### Self-test (answer without looking anything up)
1. Primary key, foreign key, unique constraint aur composite key -- har ek ek line mein. Natural key vs surrogate key kab?
2. Ek table `orders(order_id, customer_email, customer_city, product_id, product_name, qty)` -- isme kaun si update anomaly hai? 3NF tak kaise todoge?
3. 1NF, 2NF, 3NF ka ek-ek line rule likho (hint: atomic values / full key pe depend / sirf key pe depend).
4. Many-to-many relationship (students <-> courses) ko tables mein kaise model karte ho?
5. Kab jaan bujh ke denormalize karoge? Ek production example do (hint: read-heavy reporting, search index).

### Prove it in code
Run karne se pehle predict karo: kaun se inserts fail honge?

```python
# runnable
import sqlite3

db = sqlite3.connect(":memory:")
db.execute("PRAGMA foreign_keys = ON")     # SQLite enforces FKs only when this is ON
db.executescript("""
CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, city TEXT);
CREATE TABLE products  (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE orders    (id INTEGER PRIMARY KEY,
                        customer_id INTEGER NOT NULL REFERENCES customers(id));
CREATE TABLE order_items (order_id INTEGER REFERENCES orders(id),
                          product_id INTEGER REFERENCES products(id),
                          qty INTEGER NOT NULL CHECK (qty > 0),
                          PRIMARY KEY (order_id, product_id));   -- composite key, M:N bridge
INSERT INTO customers VALUES (1, 'asha@x.com', 'Pune');
INSERT INTO products VALUES (10, 'Valve'), (11, 'Pipe');
INSERT INTO orders VALUES (100, 1), (101, 1);
INSERT INTO order_items VALUES (100, 10, 2), (100, 11, 1), (101, 10, 5);
""")

def fails(sql):
    try:
        db.execute(sql)
        return False
    except sqlite3.IntegrityError:
        return True

assert fails("INSERT INTO customers VALUES (2, 'asha@x.com', 'Delhi')")   # UNIQUE
assert fails("INSERT INTO orders VALUES (102, 999)")                     # FK
assert fails("INSERT INTO order_items VALUES (100, 10, 3)")              # composite PK
assert fails("INSERT INTO order_items VALUES (101, 11, 0)")              # CHECK

# City lives in ONE row, so a move is one update -- no update anomaly
db.execute("UPDATE customers SET city = 'Mumbai' WHERE id = 1")
cities = db.execute("""SELECT DISTINCT c.city FROM order_items oi
    JOIN orders o ON o.id = oi.order_id JOIN customers c ON c.id = o.customer_id""").fetchall()
assert cities == [("Mumbai",)]
print("db basics: all checks passed")
```

### Pass criteria
- Self-test mein 4/5 sahi; Q2 mein aapne `customers`, `products`, `orders`, `order_items` jaisa split nikaala.
- Code mein chaaron failing inserts sahi predict kiye, aur `PRAGMA foreign_keys` wali SQLite gotcha pata thi (ya ab yaad hai).

### If you failed
Study: https://www.sqlitetutorial.net/ (lessons: Primary Key, Foreign Key, UNIQUE, CHECK constraints).

30-min plan:
- 10 min -- Primary Key + Foreign Key lessons (FK pragma note bhi padho).
- 10 min -- kisi bhi source se 1NF/2NF/3NF ka ek example padho aur Q2 wali table ko kagaz pe todo.
- 10 min -- apne kisi purane project ka schema kholo, ek denormalized jagah dhundo aur likho ki woh jaan bujh ke tha ya galti; phir re-test.
