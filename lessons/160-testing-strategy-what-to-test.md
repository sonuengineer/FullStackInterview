# Testing Strategy: Kya Test Karein Aur Kya Nahi

> **Connects to**: [[02-debugging-random-500-errors]] (jo bug aapne prod mein dhoondha, uska test likhna sabse sasta ROI hai), [[32-payment-idempotency-double-click]] (money wala code -- yahan test optional nahi), [[147-typescript-at-the-runtime-boundary]] (types compile par rukte hain, test runtime par shuru hota hai).

## 1. Pehle Imaandaari Ki Baat

Do tarah ke backend codebases milte hain:

**A** -- zero tests. "Time nahi tha." Deploy ke baad Postman se 3 endpoint hit karte hain aur dua karte hain.

**B** -- 400 tests, README mein 78% coverage badge. Aur phir bhi roz prod bug. Kyunki wo 400 tests getters test karte hain, mocked repository test karte hain, aur `expect(service.create).toHaveBeenCalled()` likhte hain.

> Dono ki jadd ek hi hai: **strategy nahi thi.** A ne decide hi nahi kiya, B ne "coverage" ko strategy samajh liya.

Testing moral duty nahi hai, **risk allocation decision** hai. Sawaal ye nahi "tests likhne chahiye ya nahi". Sawaal ye hai: *is sprint ke 4 ghante kaunse test par lagaoon jo mujhe raat 2 baje call aane se bachaye?*

Interview mein bhi exactly yahi poocha jaata hai. Agar jawab "hum Jest use karte hain" hai, wo tool ka naam hai -- strategy nahi.

## 2. Pyramid: Shape Kyun Aisi Hai

```
        /\         e2e         <- bahut kam, slow, mehnga, par real
       /  \
      /----\      integration  <- kam, medium speed, real DB
     /      \
    /--------\    unit         <- bahut, milliseconds, pure logic
```

Pyramid religion nahi hai, do axes ka result hai:

| | Unit | Integration | E2E |
|---|---|---|---|
| Speed | ~1 ms | ~50-500 ms | 5-60 sec |
| Setup | kuch nahi | DB container | poora stack |
| Pakadta hai | logic bug | wiring, SQL, transaction | user journey toota |
| **Nahi** pakadta | galat wiring | UI issues | kuch nahi, par kahan toota ye nahi batata |
| Debug | aasan -- ek function | medium | dard |

Shape ka asli reason **feedback loop ki cost** hai: agar suite 40 minute leta hai, developer use har commit par nahi chalaayega -- wo red CI ko "flaky hai, re-run kar do" bol dega. **Jo test chalta nahi, wo test nahi hai.**

Dusra reason **localisation**: unit fail hua -> seedha us function par jao. E2E fail hua -> pata hai "checkout toota", par 12 services mein kahan, ye khud dhoondho. Yahi [[02-debugging-random-500-errors]] wali investigation hai, bas CI mein.

## 3. Modern Counter-Argument: Testing Trophy

Pyramid us era se hai jab integration test ka matlab tha "poora QA environment khada karo". Aaj Docker Compose se Postgres 3 second mein uthta hai. To shape badal gayi:

```
      ____
     /    \      e2e          <- 2-3 flows
    /------\
   /        \    integration  <- SABSE ZYADA weight yahan
  |          |
   \        /    unit         <- pure logic ke liye
    \      /
     \____/      static (TS + lint)   <- free, har keystroke
```

Kent C. Dodds ne isko "testing trophy" kaha. Argument: **ek typical API server ke liye integration test sabse zyada confidence-per-rupee deta hai.**

Kyun? Dekho asli bug kahan hote hain:

- Route par auth middleware lagana bhool gaye -> unit test kabhi na pakadta
- Prisma/TypeORM ka `where` clause galat -> repo mock tha, pakda nahi gaya
- Transaction commit nahi hua kyunki `await` miss tha -> mocked DB ko farak nahi
- Migration ne column `nullable` chhod diya -> unit test ko pata hi nahi chala
- Zod schema route par wire nahi hua -> schema ka unit test green tha!

Pattern dekho: **ye sab wiring bugs hain.** Unit test ka design hi aisa hai ki wo wiring mock kar deta hai -- yaani *jis cheez mein bug hai usi ko fake kar deta hai.* Ye [[162-mocking-and-test-doubles]] ka central point hai.

Mera practical stand:

> Agar service mostly "HTTP in -> validate -> DB -> HTTP out" hai (yaani 80% backend code), to **integration par weight daalo.** Agar genuinely complex domain logic hai (pricing, GST, seat allocation, retry policy), wahan unit test ka ROI unbeatable hai.

## 4. Decision Table -- Ye Yaad Rakh Lo

### Unit test karo

| Kya | Kyun |
|---|---|
| **Money calculations** | split, discount, GST, rounding -- paisa galat hua to customer bolega, log nahi |
| **Date / timezone logic** | IST vs UTC, DST, "month end" -- bug silent hota hai ([[67-dst-scheduled-jobs]]) |
| **Parsers / formatters** | CSV, webhook payload, phone normalise |
| **Retry / backoff calculator** | `delay(attempt)` pure function -- 10 cases 1 ms mein |
| **Pure business rules** | "ye order cancel ho sakta hai?" -- state machine |

Common thread: **input -> output, koi I/O nahi.** Ye tests hamesha fast, deterministic, worth it.

### Integration test karo (real DB, real app instance)

| Kya | Kyun |
|---|---|
| **Routes end-to-end (HTTP -> DB)** | wiring, validation, status codes, serialization ek saath |
| **Transactions** | rollback sach mein hota hai -- sirf real DB bata sakta hai |
| **Migrations** | migration chala, schema wahi hai jo code expect karta hai |
| **Auth / authz middleware** | "doosre user ka order dikh raha hai" ([[110-idor-broken-object-level-authorization-hinglish]]) sirf yahan pakdega |
| **Unique constraints / race handling** | [[32-payment-idempotency-double-click]] ka DB constraint real DB ke bina test hi nahi hota |
| **Queue producer/consumer contract** | publish hua, consume hua |

### E2E test karo -- sirf 2-3, seriously

Rule: **jis flow ke tootne se paisa jaata hai.** Signup+login, checkout/payment, maybe ek critical admin action. Bas. E2E slow hai, flaky hone ka risk sabse zyada ([[163-async-tests-fake-timers-flaky]]), maintenance mehnga. 30 e2e ka suite 6 mahine mein mar jaata hai -- log skip karna seekh lete hain.

### Test MAT karo

| Kya | Kyun nahi |
|---|---|
| **Framework behaviour** | Express route register karta hai -- Express ki team test karti hai |
| **Getters / trivial DTO mapping** | zero logic, zero bug risk, par refactor par 40 tests todega |
| **Third-party libraries** | `axios` GET kar sakta hai, aapka kaam nahi |
| **Implementation details** | "service ne repo.save 1 baar call kiya" -- refactor pe fail, bug pe pass |
| **Jo har sprint badalta hai** | WIP feature ka internal shape |
| **Private methods** | public behaviour test karo; private ka test refactor ko jail banata hai |

## 5. Do Signals: Test Rakhne Layak Hai Ya Nahi

**Signal 1 -- Kya ye test kisi asli past bug ko pakadta?**

Last 10 production incidents ki list banao (Jira/Slack mein hai hi). Har ek ke saamne likho: *"kaunsa test isko roka hota?"* Yahi aapka test plan hai -- guess nahi, data. Surprise milega: zyadatar incidents validation/wiring/null ke the, complex algorithm ke nahi. Yaani aapko fancy unit tests nahi, 6 integration tests chahiye the.

**Signal 2 -- Kya ye test sirf EK reason se fail hota hai?**

`createOrder applies 18% GST on taxable amount` fail hua -> pata hai kahan dekhna hai. `OrderService works` fail hua -> ab aap test debug kar rahe ho, code nahi. Agar ek test 5 reason se fail ho sakta hai, wo test nahi -- ek alarm hai jiska matlab koi nahi jaanta ([[161-unit-tests-what-makes-a-test-good]]).

Teesra, negative signal: **jo test bug ke baad bhi na badalta, par refactor ke baad hamesha badalta -- wo ulta hai.** Test behaviour se bandha ho, structure se nahi.

## 6. Code: Ek Hi Feature, Teen Levels

Expense split lete hain ([[118-lld-splitwise-expense-sharing]]). **Vitest** syntax -- Jest bilkul same hai, `vi` ko `jest` kar do.

**Unit -- pure logic, paisa, rounding.**

```ts
// money.ts
export function splitEqual(totalPaise: number, people: number): number[] {
  if (people <= 0) throw new RangeError('people must be > 0');
  if (!Number.isInteger(totalPaise)) throw new TypeError('paise must be integer');
  const base = Math.floor(totalPaise / people);
  const remainder = totalPaise - base * people;
  return Array.from({ length: people }, (_, i) => base + (i < remainder ? 1 : 0));
}
```

```ts
import { describe, it, expect } from 'vitest';

describe('splitEqual', () => {
  it('divides evenly when it divides evenly', () => {
    expect(splitEqual(30000, 3)).toEqual([10000, 10000, 10000]);
  });

  it('never loses a paisa when the amount does not divide evenly', () => {
    const parts = splitEqual(10000, 3);
    expect(parts).toEqual([3334, 3333, 3333]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(10000);   // asli invariant
  });

  it('rejects zero people instead of returning Infinity', () => {
    expect(() => splitEqual(100, 0)).toThrow(RangeError);
  });
});
```

Teesra test **error path** hai -- zyadatar prod bug usi guard/`catch` mein hote hain jise kisi ne test nahi kiya. Aur doosra test ek *invariant* check karta hai ("paisa kahin nahi gaya"), sirf expected array nahi -- isliye implementation badalne ke baad bhi valuable rahega.

**Integration -- route + real DB.**

```ts
import request from 'supertest';
import { buildApp } from '../src/app';
import { db, resetDb } from './helpers/db';     // real Postgres (docker compose)

const app = buildApp({ db });
afterEach(() => resetDb());                      // isolation -- lesson 163

describe('POST /expenses', () => {
  it('returns 401 without a token', async () => {
    expect((await request(app).post('/expenses').send({})).status).toBe(401);
  });                                            // middleware actually wired?

  it('returns 422 when amount is missing', async () => {
    const res = await request(app).post('/expenses')
      .set('Authorization', `Bearer ${await tokenFor('u1')}`).send({ groupId: 'g1' });
    expect(res.status).toBe(422);                 // validation actually wired?
  });

  it('writes nothing when a member id does not exist', async () => {
    await request(app).post('/expenses')
      .set('Authorization', `Bearer ${await tokenFor('u1')}`)
      .send({ groupId: 'g1', amountPaise: 10000, memberIds: ['u1', 'ghost'] });

    const { rows } = await db.query('select count(*)::int as n from expenses');
    expect(rows[0].n).toBe(0);                   // rollback sach mein hua?
  });
});
```

Ye teen tests mocked unit tests se **zyada confidence** dete hain poore controller+service+repo stack par. Last test rollback verify karta hai -- mocked repo ke saath ye likh hi nahi sakte the, kyunki rollback DB ka behaviour hai.

**E2E -- bas ek.** Playwright: signup -> group -> expense add -> balance screen par sahi number. 20 second lega, nightly chalega, har commit par nahi.

## 7. Production Reality

- **CI mein split karo.** `npm test` (unit, 10 sec, har commit), `npm run test:int` (DB, 2 min), e2e nightly. Sab ek command mein hai to log local par kuch nahi chalaayenge.
- **Coverage ko target mat banao.** Usko **diagnostic** use karo: "payment module 12% par hai" -- useful signal. "team gate 80%" -- log `it('works', () => expect(true).toBe(true))` likhne lagenge.
- **Flaky test = outage.** Ek flaky test poori team ko red CI ignore karna sikha deta hai. Fix karo ya delete karo ([[163-async-tests-fake-timers-flaky]]).
- **Factories, bade fixtures nahi.** `makeUser({ email })` -- baaki fields default. Warna schema badalne par 200 files touch karni padengi.
- **Real Postgres/Redis** (testcontainers ya compose). SQLite ko Postgres ka substitute mat samjho -- JSON, array, upsert, isolation level sab different behave karte hain, aur aap wahi behaviour test karna chahte ho jo prod mein hai.
- **Contract tests** tab jab multiple services ho ([[68-schema-change-producer-vs-consumer]]). Monolith mein over-engineering hai.

## 8. Trade-offs

| Choice | Milta hai | Kho jaata hai |
|---|---|---|
| Unit-heavy | fast feedback, easy debug | wiring bugs nikal jaate hain, refactor par bahut tests tootte hain |
| Integration-heavy | real confidence, refactor-safe | slower suite, DB setup maintain karna padta hai |
| E2E-heavy | "user ka view" | slow, flaky, debug dard, team ignore karna seekh leti hai |
| Zero tests | aaj ki speed | har refactor gamble, naya dev onboard nahi ho sakta |

Sabse underrated point: **tests ka asli faida speed nahi, refactor karne ka confidence hai.** Jis codebase mein tests nahi, usme senior bhi bada change nahi karta -- wo workaround likh deta hai. 2 saal mein wahi codebase "chhoona mat" ban jaata hai. ROI 6 mahine baad dikhta hai, is sprint mein nahi.

## 9. Common Galtiyan

- **Coverage sprint** -- 300 worthless tests, maintenance burden up, bug rate same.
- **Service ko mock karke controller test karna** -- apna hi code fake kar diya, kuch verify nahi hua ([[162-mocking-and-test-doubles]]).
- **E2E se shuru karna** kyunki "wo sabse real hai" -- 3 mahine mein flaky, team ne skip kar diya.
- **Private methods test karna** -- har internal rename test todta hai.
- **Shared test DB, no cleanup** -- tests saath pass, akele fail (ya ulta).
- **Happy path only** -- bug `catch` block mein rehta hai, `try` mein nahi.

## 10. Zero Tests Wale Legacy Codebase Par Kahan Se Shuru Karein

Answer counter-intuitive hai: **coverage sprint nahi.**

```
Step 1: Harness banao -- test runner, real DB spin-up, ek request(app) helper.
        Ek din. Bas ek passing test chahiye: GET /health -> 200.
        (Sabse bada blocker "pehla test" hota hai, 200th nahi.)

Step 2: Agle bug ka test likho. Bug aaya -> pehle failing test -> phir fix
        -> green. Regression test free mila, aur GUARANTEED valuable hai.

Step 3: Jo code chhoone wale ho, usse pehle test likho.

Step 4: Top 3 money-flows ke integration tests -- checkout, refund, signup.
        Baaki codebase ignore karo.

Step 5: 6 mahine baad jo module sabse zyada touch hota hai, wahi sabse
        zyada tested ho chuka hoga. Apne aap.
```

Isko **"test the change, not the codebase"** bolte hain. Aap purana code test nahi kar rahe -- apne **naye kaam ke around** safety net bana rahe ho. 6 mahine mein organically wahi 15% code tested hoga jo 85% churn aur 90% risk carry karta hai.

Interview mein ye jawab strong lagta hai kyunki honest hai: *"Legacy par main coverage target set nahi karta. Pehle harness, phir har bug fix ke saath ek regression test, aur money-critical flows ke integration tests. 6 mahine mein coverage apne aap wahan ban jaati hai jahan risk hai."*

## 🧠 Remember

> Testing strategy ka sawaal "kitne tests?" nahi, "**kaunsa bug mujhe raat 2 baje jagaayega?**" hai -- isliye pure logic (paisa, date, parser) unit test karo, wiring (routes, transactions, auth, migrations) integration test karo kyunki wahi 80% asli bug hai aur unit test usi wiring ko mock kar deta hai, e2e sirf un 2-3 flows ke liye rakho jinke tootne se paisa jaata hai, framework/getters/third-party ko bilkul mat test karo -- aur zero-test legacy codebase par coverage sprint ke bajaye **agle bug ka test** likho.

## Quick Self-Test

1. Pyramid ki shape ka asli reason kya hai -- "unit tests zyada important hain" ya kuch aur? Do axes batao.
2. "Testing trophy" integration tests ko upar kyun rakhta hai? Ek concrete bug do jo unit test **design ki wajah se** miss karega.
3. 4 ghante hain aur ek payment module hai jiska zero test hai. Kya likhoge, kis order mein?
4. Ek test refactor par fail hua par behaviour same tha. Ye test ke baare mein kya batata hai?
5. "80% coverage gate" kaunsa naya incentive paida karta hai, aur wo kaise backfire karta hai?
6. "Test the change, not the codebase" practical steps mein kya hai?
