# Dev Mein Query Fast, Production Mein 30 Second - Kya Badla? (Hinglish)

> **Similar-question flag**: [[102-lower-email-index-hinglish]] mein ye pattern aa chuka hai (staging chhota tha isliye scan dikha nahi) aur method [[50-slow-query-500m-rows]] se hai. Yahan naya ye hai: ek **checklist** - dev aur prod ke beech exactly kya-kya alag hota hai, aur kis order mein check karna hai.

## 1. Sabse Pehla Sawaal: "Kya Badla?" Ka Jawab Aksar "Kuch Nahi" Hota

Code same hai, query same hai - phir bhi 30 second. Matlab badla hai **environment**. Chaar cheezein alag hoti hain:

| | Dev / staging | Production |
|---|---|---|
| Data | 1000 rows, ya sirf recent | 1 million+, saalon ka |
| Distribution | Uniform test data | Skewed - kuch users ke paas lakhs rows |
| Concurrency | Sirf aap | Sau requests ek saath, locks, pool |
| Cache/memory | Chhota data poora RAM mein | Working set RAM se bada, disk se padhna padta hai |

Dev mein full scan bhi 3 ms hota hai, isliye **galat plan kabhi dikha hi nahi**.

## 2. Check Order (upar se neeche)

**1. `EXPLAIN ANALYZE` production par chalao** (read-only replica par safe hai). Dev ka plan mat dekho - dono ka plan alag ho sakta hai, kyunki planner **row count estimate** ke hisaab se decide karta hai.

```sql
EXPLAIN (ANALYZE, BUFFERS) SELECT ... ;
-- dekhna kya hai: Seq Scan vs Index Scan, rows estimated vs actual ka farak,
-- "Sort Method: external merge  Disk: 240MB" (memory kam pad gayi),
-- "Rows Removed by Filter" bahut zyada (matlab index se pehle hi bahut kuch padha)
```

**2. Index hai bhi ya nahi - production mein?** Aksar migration dev mein chali, prod mein nahi (ya `CONCURRENTLY` fail hui aur kisi ne dekha nahi).

```sql
SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'orders';
```

**3. Query index use kar paa rahi hai?** `LOWER(col)`, `col::text`, `LIKE '%abc'`, ya type mismatch - teeno index ko mar dete hain ([[102-lower-email-index-hinglish]]).

**4. Statistics purane to nahi?** Planner stale stats se galat plan chun leta hai. `ANALYZE orders;` chalao aur phir plan dekho. Bade bulk import ke baad ye bahut common hai.

**5. Data skew.** "Average user ke 50 orders" - lekin ek B2B customer ke 4 lakh. Wahi user ki request slow hoti hai. Test karo: `SELECT user_id, count(*) FROM orders GROUP BY 1 ORDER BY 2 DESC LIMIT 5;`

**6. Concurrency aur locks.** Query akele fast, load mein slow = lock wait ya connection pool wait. Dekho:

```sql
SELECT pid, state, wait_event_type, wait_event, now() - query_start AS dur, left(query, 60)
FROM pg_stat_activity WHERE state <> 'idle' ORDER BY dur DESC LIMIT 10;
```

**7. Cache/memory.** Pehli baar slow, dusri baar fast = data disk se aaya tha ([[63-query-faster-second-time]]). Agar working set RAM se bada ho gaya hai to har baar disk - buffer cache hit ratio dekho.

**8. `SELECT *` aur N+1.** Dev mein 10 rows par N+1 dikhta hi nahi; prod mein wahi 1000 queries ban jaata hai ([[103-n-plus-1-vs-connection-pool-hinglish]]).

## 3. Turant Kya Karein (aur baad mein kya)

| Abhi (minutes) | Baad mein (permanent) |
|---|---|
| Sahi composite index `CONCURRENTLY` banao ([[57-two-indexes-still-slow-composite]]) | Prod-jaise data volume par test karo (anonymised dump ya generated data) |
| `ANALYZE` chalao | CI mein "query plan regression" check ya slow query log alerts |
| Query se function/`SELECT *` hatao | Pagination + result cap (no unbounded `LIMIT`) |
| Statement timeout lagao taaki ek query poori DB na rok de | Bade table ke liye partitioning ([[21-database-partitioning]]) |

## 4. Interview Mein Jawab

> "Mera pehla step guess karna nahi, production par `EXPLAIN ANALYZE` dekhna hai. Dev mein 1000 rows par har plan fast lagta hai; 1 million par planner ka chunav badal jaata hai. Main dekhta hoon: index maujood hai ya nahi, query use kar paa rahi hai ya function ne use disable kar diya, stats fresh hain ya nahi, aur skew/locks to nahi. 90% cases mein ya to index missing hai, ya query index-friendly nahi hai."

## 🧠 Remember

> "Dev mein fast, prod mein slow" ka matlab hai data volume aur concurrency ne plan badal diya - guess mat karo, production ka `EXPLAIN ANALYZE` dekho, phir index / query shape / stats / skew / locks is order mein check karo.

## Quick Self-Test

1. Dev aur prod ka query plan alag kyun ho sakta hai, jabki query same hai?
2. Bulk data import ke baad query achanak slow ho gayi - sabse pehla shak kis par?
3. Query akele chalane par fast hai par load mein slow - ab kya dekhoge?
