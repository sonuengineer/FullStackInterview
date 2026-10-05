# HTTP API Testing: Route Se Response Tak

> **Connects to**: [[18-http-status-codes-400-404-409-422]] (status code hi contract hai), [[110-idor-broken-object-level-authorization-hinglish]] (403 ka test hi IDOR pakadta hai), [[147-typescript-at-the-runtime-boundary]] (request body par types jhooth bolte hain), [[02-debugging-random-500-errors]] (jo 500 aap debug kar rahe ho, uska ek test hona chahiye tha).

## 1. Ek Refactor Jo Sab Kuch Unlock Karta Hai

Zyadatar Node codebase mein `src/index.ts` aisa dikhta hai:

```ts
// src/index.ts -- untestable
import express from 'express';
const app = express();
app.use(express.json());
app.use('/api/orders', ordersRouter);
app.listen(3000, () => console.log('up on 3000'));     // problem yahi line hai
```

Is file ko test se `import` karte hi ek asli server port 3000 par uth jaata hai. Do test files = port conflict. CI mein port busy. Test ke baad process exit nahi karta.

**Fix do line ka hai, aur testability ke liye ye single most useful refactor hai:**

```ts
// src/app.ts -- sirf app, listen nahi
import express from 'express';
export function createApp(deps: Deps) {
  const app = express();
  app.use(express.json());
  app.use('/api/orders', ordersRouter(deps));
  app.use(errorHandler);           // error handler sabse last
  return app;
}
```

```ts
// src/server.ts -- sirf yahi file listen karti hai
import { createApp } from './app';
const app = createApp({ db: pool, clock: Date });
app.listen(process.env.PORT ?? 3000);
```

Ab test:

```ts
// test/orders.api.test.ts   (Vitest; Jest mein sirf vi -> jest, baaki same)
import request from 'supertest';
import { createApp } from '../src/app';

const app = createApp({ db: testPool, clock: fixedClock });

it('order return karta hai', async () => {
  const res = await request(app).get(`/api/orders/${id}`).set('Authorization', bearer);
  expect(res.status).toBe(200);
});
```

`supertest` ko `app` do, URL nahi. Wo khud ek ephemeral port par in-process server uthata hai, request maarta hai, band kar deta hai. Koi `localhost:3000`, koi `npm start` background mein, koi race nahi. Ek request ~5-15 ms.

> `createApp(deps)` ka extra faida: test apna DB pool, apna fixed clock, apna fake payment gateway inject kar sakta hai -- bina `vi.mock` ke module graph se khelne ke.

## 2. 200 Se Aage: Actually Kya Assert Karein

Ye test bekaar hai:

```ts
expect(res.status).toBe(200);    // bas itna
```

Kyunki `200 {}` bhi pass ho jaayega. Teen cheezein assert karo:

**A) Exact status code, "2xx/4xx" nahi.** Status code aapka public contract hai -- client uspe retry logic likhta hai. 409 ki jagah 400 bhejna client ko "retry mat karo" bolna hai jab retry hi sahi tha ([[18-http-status-codes-400-404-409-422]]).

**B) Response ka shape, pura snapshot nahi.** Jo fields client use karta hai, unko naam se check karo:

```ts
expect(res.status).toBe(201);
expect(res.body).toMatchObject({
  id: expect.any(String),
  status: 'pending',
  amountPaise: 50000,
});
expect(res.body).not.toHaveProperty('passwordHash');    // leak guard -- ye wala test sach mein bachata hai
expect(res.headers.location).toBe(`/api/orders/${res.body.id}`);
```

Wo `not.toHaveProperty` line interview mein bolne layak hai: API response se internal fields leak hona (`passwordHash`, `internalNotes`, `costPrice`) ek common data-exposure bug hai, aur ek assert usko permanently band kar deta hai.

**C) Error body ka contract.** Clients error parse karte hain. Agar aaj `{ message }` hai aur kal `{ error: { detail } }` ban gaya, mobile app toot gaya -- aur koi test red nahi hua.

```ts
expect(res.status).toBe(422);
expect(res.body).toEqual({
  error: { code: 'VALIDATION_FAILED', fields: { email: 'invalid email' } },
});
```

## 3. Har Endpoint Ke Liye Ye Cases Likho

Ye table hi aapka checklist hai. Ek naya endpoint = ye 6 test.

| Case | Status | Kya verify hota hai | Chhoot jaaye to kya hota hai |
|---|---|---|---|
| Happy path | 200 / 201 | Shape, side effect, `Location` header | Feature hi toot gayi |
| Validation fail | 422 (ya 400) | Field-level error, aur ki **DB mein kuch nahi likha** | Garbage data DB mein, baad mein constraint se crash |
| Token nahi / invalid | 401 | Middleware sach mein lagi hai us route par | Endpoint public reh gaya |
| Token hai, par dusre ka resource | **403** | Ownership check | **IDOR** -- sabse mehnga |
| Resource nahi hai | 404 | Aur ki 404 vs 403 ka leak nahi ho raha | 500, ya existence leak |
| Duplicate / state conflict | 409 | Unique ya state machine | Double charge, duplicate row |

Wo 403 wali row dobara padho. **IDOR ka test exactly yahi hai** ([[110-idor-broken-object-level-authorization-hinglish]]) -- aur ye wo test hai jo log sabse zyada skip karte hain, kyunki happy path to chal raha hai:

```ts
it('user B, user A ka order nahi padh sakta', async () => {
  const userA = await makeUser(db);
  const userB = await makeUser(db);
  const order = await makeOrder(db, { userId: userA.id });

  const res = await request(app)
    .get(`/api/orders/${order.id}`)
    .set('Authorization', `Bearer ${tokenFor(userB)}`);

  expect(res.status).toBe(403);               // 200 aaya = aapka IDOR production mein hai
  expect(res.body).not.toHaveProperty('amountPaise');
});
```

Ye teen-line test har `GET /resource/:id`, `PATCH`, `DELETE` par chahiye. Zyadatar IDOR vulnerabilities isliye bachti hain ki test sirf "apna order" fetch karta hai -- jahan `WHERE id = $1` aur `WHERE id = $1 AND user_id = $2` ka farak hi nahi dikhta.

Aur ek side-point: 404 vs 403 ka decision bhi test mein lock karo. Kuch teams dusre ka resource par 404 bhejti hain (existence chhupane ke liye) -- bilkul valid hai, par **decide karke test mein likho**, warna aadha API 403 dega aur aadha 404.

## 4. Auth: Asli Token Banao, Middleware Mock Mat Karo

Ye tempting shortcut hai:

```ts
vi.mock('../src/middleware/auth', () => ({ requireAuth: (_req, _res, next) => next() }));
```

Isse saare test green ho jaate hain. Aur saath hi **auth middleware ka ek bhi test nahi bacha**. Expired token, galat signature, missing `Bearer` prefix, wrong `aud`, revoked session -- in sab par aapka production code untested hai. Aur 401 wali table row ab jhoothi hai: aap verify hi nahi kar sakte ki middleware us route par lagi hai.

Sahi tareeka: setup mein asli token mint karo, usi secret se jo app padhta hai.

```ts
// test/helpers/auth.ts
import jwt from 'jsonwebtoken';

export const tokenFor = (user: { id: string; role?: string }, over: object = {}) =>
  jwt.sign(
    { sub: user.id, role: user.role ?? 'customer', ...over },
    process.env.JWT_SECRET!,                     // test env mein ek fixed test secret
    { expiresIn: '5m', audience: 'api', issuer: 'test' }
  );

export const asUser = (req: request.Test, user: any) =>
  req.set('Authorization', `Bearer ${tokenFor(user)}`);
```

Ab aap auth ke negative case bhi likh sakte ho -- jo ki asli value hai:

```ts
it.each([
  ['no header',      undefined],
  ['garbage',        'Bearer not-a-jwt'],
  ['expired',        `Bearer ${jwt.sign({ sub: 'u1' }, SECRET, { expiresIn: '-1m' })}`],
  ['wrong secret',   `Bearer ${jwt.sign({ sub: 'u1' }, 'other-secret')}`],
])('401 deta hai: %s', async (_name, header) => {
  const req = request(app).get('/api/orders');
  if (header) req.set('Authorization', header);
  expect((await req).status).toBe(401);
});
```

Rule wahi hai jo backend mein har jagah lagta hai: **jo cheez aapki hai use asli chalao; jo bahar ki hai (Stripe, SMS gateway, S3) use boundary par mock karo.** JWT verification aapki hai.

## 5. Pagination, Filters Aur Side Effects

**Pagination** mein do bug sabse common hain -- off-by-one aur unstable ordering (same `created_at` ke do rows page 1 aur page 2 dono mein aa jaate hain):

```ts
it('cursor pagination overlap nahi karti', async () => {
  const sameTime = new Date('2026-01-01T00:00:00Z');
  for (let i = 0; i < 5; i++) await makeOrder(db, { userId, createdAt: sameTime });  // tie!

  const p1 = await asUser(request(app).get('/api/orders?limit=2'), user);
  const p2 = await asUser(request(app).get(`/api/orders?limit=2&cursor=${p1.body.nextCursor}`), user);

  const ids = [...p1.body.data, ...p2.body.data].map((o: any) => o.id);
  expect(new Set(ids).size).toBe(4);          // koi id repeat nahi -- tiebreaker column hai ya nahi
  expect(p1.body.data).toHaveLength(2);
});
```

Jaan-boojh kar same timestamp dena ye prove karta hai ki aapka `ORDER BY created_at DESC, id DESC` hai, sirf `created_at DESC` nahi.

**Filters** par ek line kaafi hai par zaroori hai: galat filter value par 422 aana chahiye, 500 nahi. `?status=banana`, `?limit=99999`, `?limit=-1`, `?cursor=<random>` -- ye chaar [[02-debugging-random-500-errors]] wale random 500 ka seedha source hain, kyunki validation hai hi nahi aur string DB tak pahunch jaati hai. Yahi [[147-typescript-at-the-runtime-boundary]] ka point hai: `req.query.limit` TypeScript mein `string` type hai par runtime par array bhi ho sakta hai (`?limit=1&limit=2`) -- type aapko bachaata nahi, Zod bachaata hai.

**Side effects** -- ye sabse zyada ignore hone wala assert hai. 201 aa gaya iska matlab nahi ki row likhi gayi:

```ts
it('order banta hai aur email job queue hota hai', async () => {
  const res = await asUser(request(app).post('/api/orders').send(validBody), user);
  expect(res.status).toBe(201);

  const { rows } = await db.query('SELECT status, amount_paise FROM orders WHERE id=$1', [res.body.id]);
  expect(rows).toHaveLength(1);                            // DB mein sach mein hai
  expect(rows[0].amount_paise).toBe(50000);                // paise, rupees nahi -- unit bug yahin pakda jaata hai

  expect(queue.jobs).toEqual([                             // in-memory fake queue
    expect.objectContaining({ name: 'order-confirmation', data: { orderId: res.body.id } }),
  ]);
});
```

Aur iska ulta bhi likho: **422 ke baad DB khaali honi chahiye.** Validation fail hone par aadhi row likh dena asli bug hai, aur response dekh kar wo kabhi nahi dikhta.

## 6. Contract Testing -- Jab Dusri Team Aapka API Consume Kare

Aapke API test prove karte hain ki aapka server aapki expectation puri karta hai. Wo ye **nahi** prove karte ki mobile team ki expectation puri hoti hai. Aap field `amount` ko `amountPaise` kar dete ho, saare test green, mobile app par `NaN`.

Contract testing (Pact jaisa) ise ulta chalata hai: consumer apni expectation ka file publish karta hai ("mujhe `id`, `status`, `amount` chahiye"), aur aapki CI us expectation ke against aapka asli provider verify karti hai. Response se field hatate hi **aapki** pipeline red hoti hai, mobile ki nahi.

Kab worth hai: do se zyada independent consumer teams, ya ek public API. Kab nahi: ek monorepo jahan frontend aur backend ek saath deploy hote hain -- wahan shared types + ek typed client zyada sasta hai.

## 7. Full-Response Snapshot Ek Trap Hai

```ts
expect(res.body).toMatchSnapshot();     // lagta hai smart, hai nahi
```

Teen wajah se ye kharab hai:

1. **Kuch verify nahi karta.** Snapshot kehta hai "response pichhli baar jaisa hai" -- ye nahi ki response **sahi** hai. Pehli baar galat output tha to wo galti permanently lock ho gayi.
2. **Noise se fail hota hai.** `id`, `createdAt`, `updatedAt` har run mein naye. Log `-u` daba kar snapshot update kar dete hain -- aur ab snapshot review hi nahi hota.
3. **Review mein chhup jaata hai.** 80-line snapshot diff mein `"role": "customer"` se `"role": "admin"` kaun pakdega?

Thodi behtar baat: shape explicitly likho (`toMatchObject`), aur poore response ke lock-down ke liye snapshot nahi -- JSON Schema / Zod se validate karo:

```ts
const OrderResponse = z.object({ id: z.string().uuid(), status: z.enum(['pending','paid']), amountPaise: z.int() }).strict();
expect(() => OrderResponse.parse(res.body)).not.toThrow();   // .strict() = extra field bhi fail
```

`.strict()` wala part asli faida deta hai: naya field accidentally leak hua to test red.

## 8. Worth The Time Ya Nahi

API test is track mein **best return per hour** dete hain, kyunki ek test route + middleware + validation + service + SQL + error handler -- poora stack ek saath cover karta hai, aur chalta hai 10 ms mein.

Priority order, practical:

1. Paisa chhoone wale endpoints -- saare 6 cases.
2. Har `:id` wala endpoint -- kam se kam 403 aur 404.
3. Login / token / password reset -- negative cases pehle.
4. Baaki CRUD -- happy path + ek validation case, bas.

Jo skip karna theek hai: internal admin endpoint jo ek banda mahine mein ek baar chalaata hai, aur trivial `GET /health`.

## 🧠 Remember

> `app` ko `server.listen` se alag export karo -- iske baad `supertest` poora HTTP stack bina port, bina running server, 10 ms mein test karta hai. Har endpoint par 6 case: 200, 422, 401, **403**, 404, 409 -- aur 403 wala test hi IDOR pakadta hai. Auth middleware ko mock karne ka matlab hai usko kabhi test na karna. Response ke saath side effect bhi assert karo, aur poore JSON ka snapshot kabhi nahi.

## Quick Self-Test

1. Aapka `index.ts` `app.listen` khud call karta hai. Test likhte waqt exactly kya fail hoga, aur fix kitni lines ka hai?
2. `expect(res.status).toBe(200)` wala test kis tarah ke bug ko miss karta hai?
3. Aapne `requireAuth` ko mock kar diya aur suite green hai. Kaunse chaar production bugs ab bilkul untested hain?
4. Ek `GET /api/orders/:id` par kaunsa single test IDOR pakadta hai? Us test mein kitne users banane padenge?
5. Pagination test mein jaan-boojh kar same `created_at` kyun diya jaata hai?
6. `toMatchSnapshot()` par poore API response ka snapshot lene mein teen problem kya hain?
