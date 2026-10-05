# Mocking Aur Test Doubles: Kab Mock Karein, Kab Nahi

> **Connects to**: [[161-unit-tests-what-makes-a-test-good]] (deterministic test ka asli mechanism yahi hai), [[116-solid-principles-nodejs]] (D = Dependency Inversion -- mocking uska cash payout hai), [[120-lld-rate-limiter-class-design]] (injected Clock pattern), [[160-testing-strategy-what-to-test]] (over-mocking hi wo reason hai jisse integration tests zaroori hain).

## 1. Wo Test Jo Green Tha Aur Production Down Tha

Team ne `OrderService` ke 22 unit tests likhe. Coverage 91%. CI hara. Deploy hua. 4 minute baad `/orders` par 500 ki barsaat. Reason?

```ts
// orders.repo.ts
async findPendingForUser(userId: string) {
  return this.db.query(
    `select * from orders where user_id = $1 and status = 'PENDNIG'`, [userId]);  // typo
}
```

22 tests ne kyun nahi pakda?

```ts
const mockRepo = {
  findPendingForUser: vi.fn().mockResolvedValue([{ id: 'o1', status: 'PENDING' }]),
  save: vi.fn(),
};
```

Kyunki test ne **repository ko hi fake kar diya tha** -- yaani jis layer mein bug tha, usi ko bypass kar diya. Test ne sirf verify kiya: "agar repo sahi data de, to service sahi kaam karti hai". Wo true tha. Aur useless tha.

> Over-mocking ka nuksaan ye nahi ki test kam value deta hai. Nuksaan ye hai ki wo **confidence deta hai jo jhoothi hai** -- aur us confidence par aap deploy kar dete ho.

(**Vitest** syntax. Jest identical -- `vi.fn()` -> `jest.fn()`, `vi.mock()` -> `jest.mock()`.)

## 2. Paanch Doubles, Ek Ek Line Mein

"Mock" ko log umbrella word ki tarah use karte hain, par paanch alag cheezein hain -- interview mein ye distinction poocha jaata hai.

| Double | Kaam | Ek line mein |
|---|---|---|
| **Dummy** | Sirf slot bharna, use nahi hota | `new UserService(repo, mailer, {} as Logger)` |
| **Stub** | Canned answer deta hai | `getRate: () => 0.18` |
| **Spy** | Record karta hai kya call hua | `vi.spyOn(mailer, 'send')` |
| **Mock** | Pre-programmed expectations, interaction par assert | `expect(gw.charge).toHaveBeenCalledTimes(1)` |
| **Fake** | Chhota, kaam karne wala implementation | `InMemoryUserRepo` -- actual Map ke saath |

```ts
// FAKE -- sabse underrated, sabse useful
class InMemoryUserRepo implements UserRepo {
  private rows = new Map<string, User>();
  async save(u: User) {
    if ([...this.rows.values()].some(r => r.email === u.email)) {
      throw new ConflictError('email exists');      // real constraint ka behaviour
    }
    this.rows.set(u.id, u);
  }
  async findByEmail(e: string) {
    return [...this.rows.values()].find(r => r.email === e) ?? null;
  }
}
```

**Practical advice: Fake > Mock, 90% waqt.** Fake ek baar likho, 40 tests mein reuse karo, aur wo *behave* karta hai -- duplicate email par wo actually throw karega, jabki `vi.fn()` wahi karega jo aapne us test mein bola. Fake aapko surprise de sakta hai; mock sirf aapki apni assumptions wapas bolta hai.

> **Stub state verify karne ke liye hai, Mock interaction verify karne ke liye.** Stub ke saath aap poochte ho "result kya aaya?"; Mock ke saath "kaun call hua?". Pehla refactor-safe hai, doosra nahi.

## 3. Asli Rule: Boundary Par Mock Karo, Apne Andar Nahi

```
+-------------------------------------------------------+
|  AAPKA CODE -- yahan kuch mock NAHI karna             |
|   Controller -> Service -> Domain logic -> Repository |
+-----------------------+-------------------------------+
                        |  <-- BOUNDARY: yahan mock/fake karo
        +---------------+---------------+
        |       |       |       |       |
     Payment  SMS/    Clock  Random   S3 /
     gateway  Email                   external API
```

**Mock karo (boundary -- aapka code nahi, ya non-deterministic):** payment gateway (real call galat bhi hai aur paisa bhi lagta hai), email/SMS/push, clock aur randomness, third-party HTTP APIs (unka downtime aapka CI red nahi karna chahiye), file system/S3.

**Mat mock karo (aapka khud ka code):** apna Service (taaki apna Controller test karein), apna Repository (unit test mein **Fake** chalega -- par us SQL ka ek integration test hona chahiye), apna domain logic, apni validation schemas.

Kyun? Agar aap apne code ko apne code ko test karne ke liye fake kar dete ho, to un dono ke **beech ka contract** test nahi hua -- aur bug exactly wahin rehta hai. Controller ne `userId` bheja, service `user_id` expect karta tha? Mock ne dono accept kar liya.

Simple test: *"Jo cheez main mock kar raha hoon, uska code mere repo mein hai? Agar haan, to main shayad galat kar raha hoon."*

## 4. Database: Yahan Honest Hona Padega

DB boundary par hai (aapka code nahi), par **aapki SQL aapka code hai.** Isliye special case:

| Approach | Pakadta hai | Miss karta hai |
|---|---|---|
| `vi.fn()` mock repo | service logic | SQL, constraint, transaction, migration -- yaani sab |
| In-memory Fake repo | service logic + rough constraint behaviour | wahi SQL/transaction |
| Real Postgres (integration) | sab | kuch nahi (bas slow hai) |

**Dono karo, alag levels par.** Service unit test -> `InMemoryUserRepo` (2 ms, logic branches). Repository integration test -> real Postgres (80 ms, SQL sach mein chalta hai). Repository ke 4-5 integration tests kaafi hain -- wahi `PENDNIG` typo pehle hi test mein mar jaata:

```ts
it('returns only PENDING orders for the given user', async () => {
  await seed([
    { id: 'o1', userId: 'u1', status: 'PENDING' }, { id: 'o2', userId: 'u1', status: 'PAID' },
    { id: 'o3', userId: 'u2', status: 'PENDING' },
  ]);
  expect((await repo.findPendingForUser('u1')).map(r => r.id)).toEqual(['o1']);
});
```

Aur **SQLite ko Postgres ka stand-in mat samjho** -- JSON operators, arrays, `on conflict`, isolation levels, `for update` sab different behave karte hain.

## 5. Dependency Injection: Mocking Framework Ki Zaroorat Hi Khatam

Sabse important technique, aur isme koi library nahi lagti.

```ts
// BAD -- untestable: hard imports, asli network call, asli clock
import { razorpay } from '../lib/razorpay';
import { mailer } from '../lib/mailer';

export class PaymentService {
  async pay(orderId: string, amountPaise: number) {
    const charge = await razorpay.charge(amountPaise);
    await mailer.send('receipt', { orderId, at: new Date() });
    return charge.id;
  }
}
```

Isko test karne ka ek hi raasta hai: `vi.mock('../lib/razorpay')` -- module-level surgery (section 6).

```ts
// GOOD -- constructor injection
export interface PaymentGateway { charge(paise: number, idemKey: string): Promise<{ id: string }>; }
export interface Mailer { send(tpl: string, data: unknown): Promise<void>; }
export interface Clock { now(): number; }

export class PaymentService {
  constructor(
    private gateway: PaymentGateway,
    private mailer: Mailer,
    private clock: Clock = { now: () => Date.now() },      // prod default
  ) {}

  async pay(orderId: string, amountPaise: number, idemKey: string) {
    const charge = await this.gateway.charge(amountPaise, idemKey);
    await this.mailer.send('receipt', { orderId, at: new Date(this.clock.now()) });
    return charge.id;
  }
}
```

Hand-written fakes, zero mocking framework:

```ts
class FakeGateway implements PaymentGateway {
  calls: Array<{ paise: number; idemKey: string }> = [];
  private seen = new Map<string, { id: string }>();
  failWith?: Error;

  async charge(paise: number, idemKey: string) {
    if (this.failWith) throw this.failWith;
    this.calls.push({ paise, idemKey });
    // asli gateway ki tarah: same idempotency key -> same charge, double nahi
    const existing = this.seen.get(idemKey);
    if (existing) return existing;
    const charge = { id: `ch_${this.seen.size + 1}` };
    this.seen.set(idemKey, charge);
    return charge;
  }
}

class FakeMailer implements Mailer {
  sent: Array<{ tpl: string; data: any }> = [];
  async send(tpl: string, data: unknown) { this.sent.push({ tpl, data: data as any }); }
}

const fixedClock: Clock = { now: () => Date.parse('2026-03-15T10:00:00Z') };
```

```ts
it('charges once even when the same idempotency key is retried', async () => {
  const gw = new FakeGateway();
  const svc = new PaymentService(gw, new FakeMailer(), fixedClock);

  const a = await svc.pay('o1', 50000, 'idem-1');
  const b = await svc.pay('o1', 50000, 'idem-1');

  expect(a).toBe(b);                  // gateway ne 1 hi charge banaya
  expect(gw.calls).toHaveLength(2);   // service ne 2 baar poocha
});                                   // [[32-payment-idempotency-double-click]] ka contract

it('does not send a receipt when the charge fails', async () => {
  const gw = new FakeGateway();
  gw.failWith = new Error('gateway timeout');
  const mailer = new FakeMailer();

  await expect(new PaymentService(gw, mailer, fixedClock).pay('o1', 50000, 'k'))
    .rejects.toThrow('gateway timeout');
  expect(mailer.sent).toHaveLength(0);
});

it('stamps the receipt with the injected clock, not wall time', async () => {
  const mailer = new FakeMailer();
  await new PaymentService(new FakeGateway(), mailer, fixedClock).pay('o1', 100, 'k');
  expect(mailer.sent[0].data.at.toISOString()).toBe('2026-03-15T10:00:00.000Z');
});
```

Kya mila: koi `vi.mock()` nahi; `FakeGateway` 40 tests mein reuse hoga; fake mein **real behaviour** (idempotency) hai isliye wo contract violation bata sakta hai; aur test padhne mein saaf hai.

**Aur yahi SOLID ke "D" ka asli payout hai.** [[116-solid-principles-nodejs]] mein Dependency Inversion padha tha -- log isko theory bolte hain. Asli jawab:

> "Dependency Inversion ka concrete benefit testability hai. Jab `PaymentService` `PaymentGateway` interface par depend karta hai, Razorpay ke concrete client par nahi, to main `FakeGateway` pass karke gateway failure, timeout, duplicate charge -- sab 2 ms mein test kar sakta hoon. Bina DI ke mujhe module-level mocking karni padti, jo brittle hai."

**Injected Clock** wahi pattern hai jo [[120-lld-rate-limiter-class-design]] mein use hua -- rate limiter ka window test karne ke liye aap 60 second wait nahi kar sakte, clock aage badha dete ho. Ek design decision, do fayde: testability + flexibility.

## 6. Module Mocking (`vi.mock` / `jest.mock`) -- Last Resort

Kabhi aap DI add nahi kar sakte (legacy code, third-party module deep inside). Tab:

```ts
vi.mock('../lib/razorpay', () => ({
  razorpay: { charge: vi.fn().mockResolvedValue({ id: 'ch_1' }) },
}));
import { razorpay } from '../lib/razorpay';     // ab mocked version
beforeEach(() => vi.clearAllMocks());
```

Kaam karta hai. Char asli problems:

1. **Global hai.** Poore file ke liye module replace ho gaya. Ek test mein real chahiye? `vi.doMock` + dynamic import ka dance.
2. **Hoisted aur order-sensitive.** `vi.mock` call imports se **upar** uthta hai, chahe aapne neeche likha ho. Factory mein outer variable use karo to "cannot access before initialization" -- yahi naye logon ka 2 ghanta khaata hai.
3. **File path se bandha hai.** `../lib/razorpay` ko move kiya -> mock chup-chaap lagna band, aur test **asli network call** karne lagta hai. TypeScript help nahi karta -- string hai.
4. **Refactor-hostile.** Mock ko module ka internal shape pata hona chahiye (named vs default export, ESM vs CJS -- [[143-commonjs-vs-esm-module-resolution]] wala confusion yahan bhi ghusta hai).

> **DI pehli choice. `vi.spyOn` doosri. `vi.mock` teesri aur aakhri.** Jab `vi.mock` ki taraf jaa rahe ho, 10 second socho -- kya main ek constructor parameter add kar sakta hoon?

`vi.spyOn` beech ka rasta hai -- real object, ek method replace. Aur **hamesha cleanup karo**: `afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); })` -- warna ek file ka mock agli file mein leak hoga aur aapko "ye test akele pass hota hai" wala dard milega ([[163-async-tests-fake-timers-flaky]]).

## 7. Fake Time -- Clock Bhi Ek Dependency Hai

Do raaste: **(a) Clock inject karo** -- behtar, kyunki ye design improvement bhi hai. **(b) Fake timers** -- jab inject karna practical na ho:

```ts
afterEach(() => vi.useRealTimers());

it('expires the cache entry after the TTL', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-15T10:00:00Z'));

  const cache = new TtlCache({ ttlMs: 60_000 });
  cache.set('k', 'v');
  vi.advanceTimersByTime(60_001);          // 60 second "guzar gaye" -- 0 ms mein
  expect(cache.get('k')).toBeNull();
});
```

Gotcha jo sabko kaatta hai: **fake timers promise-based code ke saath** `advanceTimersByTimeAsync` maangte hain, kyunki microtask queue ko bhi drain hona padta hai. Ye [[163-async-tests-fake-timers-flaky]] ka core topic hai, aur [[137-event-loop-phases-and-microtasks]] samjhata hai *kyun*.

## 8. Over-Mocked Test -- Classic Anti-Pattern

```ts
it('creates an order', async () => {
  await svc.createOrder(input);

  expect(mockRepo.beginTransaction).toHaveBeenCalled();
  expect(mockRepo.insertOrder).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1' }));
  expect(mockInventory.reserve).toHaveBeenCalledWith('sku-1', 2);
  expect(mockRepo.commit).toHaveBeenCalled();
  expect(mockMailer.send).toHaveBeenCalledWith('order-confirmed', expect.anything());
});
```

Paanch "was called with". Ab poochho: **ye test kya guarantee deta hai?** Order DB mein save hua? -- nahi pata, repo fake tha. Amount sahi calculate hua? -- check hi nahi kiya. Rollback hota hai error par? -- `commit` call hua, bas. Inventory sach mein kam hui? -- `reserve` call hua, effect verify nahi.

Ye test **implementation ka transcript** hai, behaviour ka proof nahi. Cost real hai: kal `insertOrder` ko `saveOrder` rename karo, ya transaction handling ko wrapper mein move karo -- behaviour same, **test fail.** Yaani test refactor ko rok raha hai, bug ko nahi.

Fix -- **outcome assert karo, calls nahi:**

```ts
it('creates an order and reserves its inventory', async () => {
  const repo = new InMemoryOrderRepo();
  const inv = new FakeInventory({ 'sku-1': 10 });

  const { id } = await new OrderService(repo, inv, new FakeMailer())
    .createOrder({ userId: 'u1', items: [{ sku: 'sku-1', qty: 2 }] });

  expect(await repo.findById(id)).toMatchObject({ userId: 'u1', amountPaise: 23600 });
  expect(inv.stockOf('sku-1')).toBe(8);               // asli effect
});

it('reserves nothing when the order insert fails', async () => {
  const repo = new InMemoryOrderRepo();
  repo.failNextInsert(new Error('db down'));
  const inv = new FakeInventory({ 'sku-1': 10 });

  await expect(new OrderService(repo, inv, new FakeMailer())
    .createOrder({ userId: 'u1', items: [{ sku: 'sku-1', qty: 2 }] })).rejects.toThrow();

  expect(inv.stockOf('sku-1')).toBe(10);              // rollback ka asli proof
});
```

Interaction assertion kab **sahi** hai? Jab interaction hi behaviour hai, yaani side effect verify karne ka doosra raasta nahi: "gateway par **exactly ek** charge gaya" ([[32-payment-idempotency-double-click]] ka poora point), "retry ke beech backoff ke saath 3 attempt hue", "audit log likha gaya" (compliance). Baaki sab jagah: **state/outcome assert karo.**

## 9. Trade-offs

| | Mock (`vi.fn`) | Fake (hand-written) | Real thing |
|---|---|---|---|
| Setup | sabse fast | ek baar mehnat | docker, config |
| Speed | 0 ms | ~0 ms | 50 ms+ |
| Confidence | sabse kam | medium | sabse zyada |
| Refactor-safe | nahi (call shape par bandha) | haan | haan |
| Surprise de sakta hai? | kabhi nahi | haan | haan |

Last row dono tarah se padho: "surprise de sakta hai" ek **feature** hai. Jo double aapko kabhi surprise nahi deta, wo aapki assumptions verify kar raha hai -- aapka code nahi.

## 10. Common Galtiyan

- **Apne service ko mock karke apna controller test karna** -- contract aur wiring dono untested
- **Repository poori tarah mock karna aur integration test na likhna** -- `PENDNIG` production mein milega
- `toHaveBeenCalledWith` ko outcome assertion samajhna
- `vi.mock` ka path hardcode, aur file rename par silent real network call
- Mock cleanup na karna (`restoreAllMocks`, `useRealTimers`) -- cross-file leak
- Fake ko over-engineer karna (`InMemoryRepo` mein SQL parser) -- chhota rakho; jahan fidelity chahiye wahan real DB
- `expect.anything()` / `expect.any(Object)` se assertion ko khokhla karna
- SQLite ko Postgres ka fake samajhna

## 🧠 Remember

> **Boundary par mock karo, apne andar nahi** -- payment gateway, mailer, clock aur random fake karo; apna service/repository/domain logic kabhi nahi, kyunki jis contract mein bug hai usi ko aap fake kar rahe ho (wahi `PENDNIG` wala green test). Hand-written **Fake** 90% jagah `vi.fn()` se behtar hai kyunki wo *behave* karta hai, aur **constructor injection** mocking framework ki zaroorat hi khatam kar deta hai -- yahi SOLID ke D ka asli cash payout hai; `vi.mock` last resort hai (global, hoisted, path se bandha). Aur `toHaveBeenCalledWith` x5 wala test implementation ka transcript hai, behaviour ka proof nahi -- **outcome assert karo.**

## Quick Self-Test

1. Stub aur Mock mein asli farak kya hai -- ek line mein, "verify" shabd use karke?
2. Fake ko `vi.fn()` mock se behtar kyun kehte hain? Ek concrete case jahan Fake bug bataye par mock na bataye.
3. "Boundary par mock karo" -- aapke Express app mein wo boundary exactly kahan hai? 3 cheezein andar, 3 bahar.
4. 91% coverage wala suite `PENDNIG` typo kyun miss kar gaya, aur usko pakadne ka sabse sasta test kaunsa hai?
5. `vi.mock('../lib/razorpay')` wale test mein file ko naye folder mein move kiya. Kya hoga, aur kya CI bataayega?
6. Kaunse teen cases mein `toHaveBeenCalledTimes(1)` genuinely sahi assertion hai?
