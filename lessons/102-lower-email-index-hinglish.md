# `WHERE LOWER(email) = ...` - Staging Mein Index, Production Mein Full Scan (Hinglish)

> **Similar-question flag**: [[50-slow-query-500m-rows]] mein ye rule aa chuka hai ("column par function lagaoge to index use nahi hoga"). Naya yahan ye hai: **staging vs production ka farak** aur teen fixes mein se kaunsa lena chahiye.

## 1. Pehli Galatfehmi Door Karo

Index "gayab" nahi hua. `email` par bana normal B-tree index **dono jagah** is query ke liye useless hai:

```sql
SELECT * FROM users WHERE LOWER(email) = 'alex@gmail.com';
```

Index `email` ki **original values** sorted rakhta hai (`Alex@Gmail.com`), par aap `LOWER(email)` maang rahe ho. Database ko har row par function chalana padega, tabhi pata chalega match hua ya nahi - isliye index skip, **full scan**.

**Phir staging mein "fast" kyun laga?** Kyunki 20,000 rows ka full scan bhi 5-10 ms mein ho jaata hai. Wahan bhi scan hi ho raha tha, bas dard nahi hua. 48 million rows par wahi scan seconds le leta hai.

> Sabak: staging "sahi" nahi tha - sirf chhota tha. Production-jaisa data volume ke bina plan test karna dhokha hai.

Pehla step hamesha: `EXPLAIN ANALYZE` - staging **aur** production dono par.

## 2. Teen Fixes - Kaunsa Kab

**Fix A: Expression (functional) index - turant raahat**

```sql
CREATE INDEX CONCURRENTLY idx_users_email_lower ON users (LOWER(email));
```

Ab index ki values wahi hain jo query maang rahi hai. Code badalna nahi padta. 48M rows par `CONCURRENTLY` zaroori hai warna table lock ho jaayega ([[81-delete-150m-rows-safely]] wali soch).

**Fix B: Generated column + index**

```sql
ALTER TABLE users ADD COLUMN email_lower text GENERATED ALWAYS AS (LOWER(email)) STORED;
CREATE INDEX CONCURRENTLY idx_users_email_lower2 ON users (email_lower);
```

Faida: doosri jagah bhi `email_lower` use kar sakte ho, aur `SELECT` mein saaf dikhta hai. Nuksan: extra storage aur schema change.

**Fix C (asli, lamba jawab): column ko function mein lapetna band karo**

Email case-insensitive hai hi - to **likhte waqt normalize karo**, padhte waqt nahi:

```sql
-- Postgres: citext extension, ya simply lowercase store karo
ALTER TABLE users ADD CONSTRAINT users_email_lower_ck CHECK (email = LOWER(email));
-- app side: user.email = email.trim().toLowerCase();  (signup + login dono par)
CREATE UNIQUE INDEX CONCURRENTLY uq_users_email ON users (email);
```

Phir query seedhi ho jaati hai: `WHERE email = 'alex@gmail.com'` - normal index, normal plan, aur duplicate emails bhi ruk jaate hain ([[26-duplicate-email-race-condition]]).

## 3. Interview Mein Kya Bolna Hai

> "Index gayab nahi hua - `LOWER(email)` ki wajah se wo kabhi use ho hi nahi raha tha; staging mein 20k rows ka scan sasta tha isliye dikha nahi. Turant fix expression index hai. Sahi fix hai email ko write time par normalize karke store karna, phir plain index aur unique constraint dono milte hain. Migration ke liye pehle `CONCURRENTLY` index, phir backfill batches mein."

## 4. Ek Aur Cheez: `SELECT *`

48M rows wali table par `SELECT *` har column laata hai. Index-only scan ka faida lena hai to sirf zaroori columns maango ([[57-two-indexes-still-slow-composite]]).

## 🧠 Remember

> Column ko function mein lapetna index ko mara deta hai - chhoti staging table par ye dikhta nahi. Expression index turant bachata hai, par asli fix hai email ko lowercase mein store karna aur query seedhi rakhna.

## Quick Self-Test

1. Staging mein query "fast" thi - iska matlab index use ho raha tha? Kyun nahi?
2. Expression index aur generated column - kab konsa chunoge?
3. Email lowercase store karne se ek *aur* bug bhi rukta hai - kaunsa?
