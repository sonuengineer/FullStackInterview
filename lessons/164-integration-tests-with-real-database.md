# Integration Test Asli Database Ke Saath

> **Connects to**: [[103-n-plus-1-vs-connection-pool-hinglish]] aur [[16-synchronized-connection-pool-expiry]] (pool test mein bhi khatam hota hai), [[26-duplicate-email-race-condition]] aur [[32-payment-idempotency-double-click]] (ye do bugs sirf asli DB par pakde jaate hain), [[50-slow-query-500m-rows]] (index/plan ka sach).

## 1. Pehle Argument, Phir Tooling

Ek repository test dekho jo sabke codebase mein milta hai:

```ts
// userRepo.test.ts -- mocked db
const db = { query: vi.fn().mockResolvedValue({ rows: [{ id: 1, email: 'a@b.com' }] }) };

it('finds user by email', async () => {
  const repo = new UserRepo(db);
  const user = await repo.findByEmail('a@b.com');
  expect(user.id).toBe(1);
  expect(db.query).toHaveBeenCalled();
});
```

Ye test green hai. Ab seedha sawaal: **isne kya verify kiya?**

Isne verify kiya ki `db.query` ka return value aapke mapping code se guzar kar object ban jaata hai. Yaani **aapka mock kaam karta hai**. Jo SQL aap bhej rahe ho -- us string mein column ka naam galat ho, join ki condition ulti ho, `WHERE tenant_id` chhoot gaya ho -- test ko farak hi nahi padta. Mock ko SQL samajh nahi aata, wo sirf string hai.

Aur production mein jo bugs jaate hain, wo theek yahi class ke hote hain:

| Bug | Mocked unit test pakdega? | Asli DB wala test pakdega? |
|---|---|---|
| Join ki condition galat (duplicate rows ya missing rows) | Nahi | Haan |
| Column rename hua, query purani reh gayi | Nahi | Haan (query fail) |
| `NOT NULL` / `UNIQUE` / FK constraint bhool gaye | Nahi | Haan |
| `ON DELETE CASCADE` ne 3 extra tables saaf kar diye | Nahi | Haan |
| Migration jo khaali DB par chalti hai, bhare data par todti hai | Nahi | Haan |
| Transaction rollback aadha hua | Nahi | Haan |
| Timezone / `timestamptz` ka conversion | Nahi | Haan |
| Index na hone se 40 second ka query | Nahi | Haan (agar data daala ho) |

Isliye integration test ki value emotional nahi hai, arithmetic hai: **jo bug aapko raat 2 baje jagaata hai, wo is column mein hai, us column mein nahi.** Service-layer logic ke liye mock theek hai; SQL ke liye nahi.

## 2. Asli DB Lana -- Dard Ke Bina

Do practical raaste hain.

**A) Docker Compose -- ek local Postgres jo chalta rehta hai:**

```yaml
# docker-compose.test.yml
services:
  pg-test:
    image: postgres:16-alpine
    environment: { POSTGRES_PASSWORD: test, POSTGRES_DB: app_test }
    ports: ["5433:5432"]
    tmpfs: /var/lib/postgresql/data    # RAM par data -- disk fsync ka kharcha hat gaya
    command: postgres -c fsync=off -c full_page_writes=off -c synchronous_commit=off
```

`fsync=off` production mein **kabhi nahi**, par test DB mein ye 2-3x speed deta hai aur data kho jaane se kuch bigadta bhi nahi.

**B) Testcontainers -- test khud apna container uthata hai:**

```ts
// test/setup/global.ts
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from '../../src/db/migrate';

export async function setup() {
  const pg = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = pg.getConnectionUri();
  await migrate(process.env.DATABASE_URL);   // migrations = setup ka hissa
  (globalThis as any).__pg = pg;
}
export async function teardown() { await (globalThis as any).__pg?.stop(); }
```

Isko `vitest.config.ts` mein `test.globalSetup: ['./test/setup/global.ts']` se wire karo (Jest: `globalSetup`/`globalTeardown` -- API lagbhag same).

Farak kyun matter karta hai: Compose mein **aapko** container yaad rakhna padta hai aur CI pipeline mein `services:` block likhna padta hai. Testcontainers mein `npm test` kaafi hai -- naye developer ke laptop par aur CI par bilkul same. Trade-off: har run mein ~2-4 second container startup, aur CI runner ko Docker chahiye.

> **Zaroori**: migrations ko test setup se chalao, `schema.sql` dump se nahi. Tab aapke migrations bhi roz test ho jaate hain -- aur "migration prod par fail ho gayi" wali raat kam ho jaati hai.

(Code Vitest ka hai; Jest mein `vi.fn` ko `jest.fn` padh lo, baaki sab waisa hi.)

## 3. Test Isolation -- Asli Design Decision

Problem: test A ne 3 users banaye, test B `count(*)` par assert kar raha hai. Teen strategies hain.

| Strategy | Kaise | Speed | Kab tootti hai |
|---|---|---|---|
| **TRUNCATE between tests** | `afterEach` mein saari tables ek hi `TRUNCATE ... CASCADE` se | Theek (1 statement) | Table list maintain karni padti hai; sequences `RESTART IDENTITY` ke bina chalte rehte hain |
| **Transaction + rollback** | `beforeEach` mein `BEGIN`, `afterEach` mein `ROLLBACK`; wahi connection inject karo | Sabse fast | **Code under test khud transaction chalaye to toot jaati hai** |
| **Fresh schema per worker** | Har parallel worker ka apna schema/database, migrations ek baar template se copy | Startup slow, run fast | Migration cost x workers; cross-schema queries confuse karti hain |

Transaction trick ka exact failure samajh lo:

```ts
// test
await client.query('BEGIN');
await createOrder(client, input);   // andar: BEGIN ... COMMIT
await client.query('ROLLBACK');     // kya actually rollback hua?
```

Postgres mein nested `BEGIN` ek warning deta hai aur ignore ho jaata hai; andar ka `COMMIT` **aapka** outer transaction commit kar deta hai. Ab rollback ke paas rollback karne ko kuch nahi bacha, aur agla test gandi state par chalta hai. Savepoints se bachaa jaa sakta hai, par uske liye aapke code ko savepoint-aware connection chahiye -- yaani production code test ke liye badal rahe ho.

**Practical default**: `TRUNCATE` use karo. Boring hai, sab cases mein kaam karta hai, aur ek statement mein poori DB saaf:

```ts
// test/setup/truncate.ts
const tables = await db.query<{ t: string }>(`
  SELECT quote_ident(tablename) AS t FROM pg_tables
  WHERE schemaname = 'public' AND tablename <> 'schema_migrations'
`);
await db.query(`TRUNCATE ${tables.rows.map(r => r.t).join(', ')} RESTART IDENTITY CASCADE`);
```

Transaction-rollback tab lo jab speed sach mein chubh rahi ho **aur** aapka code upar se transaction accept karta ho (`repo.create(tx, data)` style). Fresh-schema tab lo jab test suite bahut bada ho aur aap 8 workers chala rahe ho.

## 4. Data Setup -- Factory, Fixture File Nahi

Giant `seed.sql` ya 400-line JSON fixture ka end hamesha ek hi hota hai: koi ek row badalta hai, 30 unrelated test fail hote hain, aur phir koi fixture ko chhoona band kar deta hai.

Factory ka pattern seedha hai -- sensible defaults + override:

```ts
// test/factories.ts
let n = 0;
export async function makeUser(db: Db, over: Partial<User> = {}) {
  n++;
  return db.one(
    `INSERT INTO users (email, name, role) VALUES ($1,$2,$3) RETURNING *`,
    [over.email ?? `user${n}@test.com`, over.name ?? 'Test User', over.role ?? 'customer']
  );
}

export async function makeOrder(db: Db, over: Partial<Order> = {}) {
  const user = over.userId ? { id: over.userId } : await makeUser(db);
  return db.one(
    `INSERT INTO orders (user_id, amount_paise, status) VALUES ($1,$2,$3) RETURNING *`,
    [user.id, over.amountPaise ?? 50000, over.status ?? 'pending']
  );
}
```

Do niyam:

1. **Sirf wahi insert karo jo test ko chahiye.** Test padhne wale ko `makeOrder(db, { status: 'paid' })` se turant pata chalta hai ki is test ke liye `status` hi maayne rakhta hai.
2. **Unique fields unique hone chahiye** (counter ya `crypto.randomUUID()`). Warna aapke test khud unique-constraint violation dete hain aur aap frustration mein constraint hata dete hain -- wahi constraint jo prod mein aapko bacha raha tha.

## 5. Ab In Tests Ko Kya Assert Karna Chahiye

Yahan asli return on investment hai. Ye teen test aise bugs pakadte hain jo kisi mock se nahi pakde jaate.

**A) Unique constraint duplicate ko sach mein reject karta hai** ([[26-duplicate-email-race-condition]]):

```ts
it('do parallel signup mein se sirf ek jeetta hai', async () => {
  const email = 'race@test.com';
  const results = await Promise.allSettled([
    signup({ email, password: 'x' }),
    signup({ email, password: 'y' }),
  ]);

  const ok = results.filter(r => r.status === 'fulfilled');
  expect(ok).toHaveLength(1);                                   // DB ne race decide ki
  const { rows } = await db.query('SELECT count(*) FROM users WHERE email=$1', [email]);
  expect(Number(rows[0].count)).toBe(1);

  const failed = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
  expect(failed.reason.status).toBe(409);        // 23505 ko 409 mein map kiya ya 500 leak hua?
});
```

Dhyan do ye test **do** cheezein pakadta hai: ek, `UNIQUE INDEX` migration mein hai ya nahi; do, aapka error handler Postgres `23505` ko 409 banata hai ya user ko raw 500 dikha deta hai ([[18-http-status-codes-400-404-409-422]] ka backend side).

**B) Idempotency key double charge rokti hai** ([[32-payment-idempotency-double-click]]):

```ts
it('same idempotency key = ek hi charge', async () => {
  const key = 'idem-' + randomUUID();
  const a = await pay({ orderId, amountPaise: 50000, idempotencyKey: key });
  const b = await pay({ orderId, amountPaise: 50000, idempotencyKey: key });

  expect(b.paymentId).toBe(a.paymentId);          // naya payment nahi bana
  const { rows } = await db.query('SELECT count(*) FROM payments WHERE order_id=$1', [orderId]);
  expect(Number(rows[0].count)).toBe(1);          // asli proof row count mein hai
  expect(gatewayCalls).toHaveLength(1);           // gateway ek hi baar hit hua
});
```

Yahan gateway mock hai (wo aapka nahi hai), par **idempotency store asli DB hai** -- kyunki poora bug hi uske unique index aur transaction boundary mein rehta hai. Rule: *jo cheez aap own karte ho use asli rakho, jo doosre ki hai use mock karo.*

**C) Failure par transaction pura rollback hota hai:**

```ts
it('inventory fail hone par order row nahi bachni chahiye', async () => {
  vi.spyOn(inventory, 'reserve').mockRejectedValue(new Error('out of stock'));

  await expect(placeOrder({ userId, items })).rejects.toThrow('out of stock');

  const o = await db.query('SELECT count(*) FROM orders WHERE user_id=$1', [userId]);
  const i = await db.query('SELECT count(*) FROM order_items');
  expect(Number(o.rows[0].count)).toBe(0);
  expect(Number(i.rows[0].count)).toBe(0);        // orphan rows = asli production bug
});
```

Ye wo test hai jo "orders table mein 12,000 adhoore order pade hain" wali Monday morning ko rokta hai.

## 6. Inhe Fast Kaise Rakhein

Integration test slow hone ki wajah aksar DB nahi, aapka setup hota hai.

- **Ek container, N workers.** Container `globalSetup` mein, per-file nahi. Har file apni schema/truncate karti hai.
- **`sleep` kabhi nahi.** `await sleep(500)` sabse mehnga aur sabse flaky line hai. Condition par wait karo (`waitFor` loop jo 10ms par poll kare, 2s ka cap), ya aur achha -- code ko aisa banao ki wo promise return kare jiska aap `await` kar sako.
- **Migrations ek baar.** Agar per-worker DB chahiye to ek `template` database se `CREATE DATABASE x TEMPLATE app_test` -- ye migrations dobara chalane se bahut tez hai.
- **Seed data chhota rakho.** 10 rows mein jo logic test hota hai wahi 10,000 rows mein hota hai. Bade data set sirf index/plan wale test ke liye ([[50-slow-query-500m-rows]]), aur wo alag, nightly suite mein.

## 7. Connection Pool -- Test Suite Ka Chhupa Hua Killer

Ye hamesha hota hai: 8 parallel workers, har worker apna pool `max: 10`, Postgres `max_connections = 100`. 80 app connections + migrations + aapka `psql` = `FATAL: sorry, too many clients already`. Test suite randomly red, code mein koi galti nahi.

```ts
// test ke liye pool chhota
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: process.env.NODE_ENV === 'test' ? 2 : 10,
});
```

Doosra classic: test ke baad `pool.end()` na karna. Vitest/Jest hang ho jaata hai ya "a worker process failed to exit gracefully" deta hai, aur log ise flakiness samajh lete hain. Ek `afterAll(() => pool.end())` chahiye.

Aur ek bonus: integration test **N+1 pakadne ki sabse saste jagah** hai. Query counter lagao:

```ts
let queries = 0;
pool.on('query', () => queries++);          // ya Prisma: prisma.$on('query', ...)

it('order list 2 se zyada query nahi maarti', async () => {
  await Promise.all([makeOrder(db), makeOrder(db), makeOrder(db)]);
  queries = 0;
  await listOrders({ limit: 20 });
  expect(queries).toBeLessThanOrEqual(2);   // 101 ho gaya to CI red
});
```

Yahi [[103-n-plus-1-vs-connection-pool-hinglish]] ka regression guard hai: aaj aapne N+1 fix kiya, kal koi `include` hata dega -- ye test use PR par pakad lega, prod par nahi. Aur [[16-synchronized-connection-pool-expiry]] wala pool-exhaustion bug bhi reproducible ban jaata hai: pool `max: 1` karke dekho, agar aapka code ek request mein do connection maangta hai to test wahin deadlock ho jaayega.

## 8. Worth The Time Ya Nahi

Seedhi baat, kyunki time infinite nahi hai:

| Code | Integration test worth it? |
|---|---|
| Payments, billing, idempotency, ledger | Haan, pehle yahi |
| Auth / ownership checks (IDOR surface) | Haan |
| Multi-table transactions, state machines | Haan |
| Migrations jo existing data badalti hain | Haan -- purana data daalo, migrate karo, assert karo |
| Pure functions, formatting, mapping | Nahi, unit test se sasta |
| Thin CRUD jisme sirf ek `SELECT *` hai | Ek smoke test kaafi |

Mota rule: **jahan paisa, permission ya ek se zyada table hai, wahan asli DB.** Baaki jagah unit test.

Setup ki cost ek baar hai (ek din, zyada se zyada do). Uske baad har naya test ek function call hai.

## 🧠 Remember

> Mocked DB ke saath likha gaya repository test ye prove karta hai ki **aapka mock kaam karta hai**, aapka SQL nahi. Constraint, join, cascade, transaction rollback aur migration -- production ke asli bugs -- sirf asli Postgres par dikhte hain. Container ek, migrations setup mein, isolation ke liye boring `TRUNCATE`, data factories se, aur pool test mein chhota rakho.

## Quick Self-Test

1. Aapka mocked repo test green hai aur query mein `WHERE tenant_id` chhoot gaya hai. Test kyun pass ho raha hai?
2. "Har test ko transaction mein wrap karke rollback" sabse fast strategy hai -- phir default kyun nahi? Exactly kahan tootti hai?
3. Idempotency wale test mein aapne gateway mock kiya par DB asli rakhi. Ye line kis rule se khinchi gayi?
4. 8 parallel workers, per-worker pool `max: 10`, Postgres `max_connections=100`. Kya hoga aur do fix kya hain?
5. Ek `sleep(500)` wala test aaj pass ho raha hai. Wo CI par kis din fail karega aur uski jagah kya likhoge?
