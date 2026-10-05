# Async Tests, Fake Timers Aur Flaky Tests

> **Connects to**: [[140-promises-internals-and-async-await]] (floating promise aur `await` ka asli matlab -- yahan wahi test file mein), [[137-event-loop-phases-and-microtasks]] (fake timers macrotask par kaam karte hain, `await` microtask par -- isliye async variants chahiye), [[16-synchronized-connection-pool-expiry]] (test ka DB cleanup na karna pool ko exactly waise hi maarta hai).

## 1. Sabse Khatarnak Test: Jo Pass Hai Kyunki Chala Hi Nahi

```ts
it('rejects a negative amount', async () => {
  expect(svc.pay('order-1', -100)).rejects.toThrow(RangeError);   // await missing
});
```

Ye **hamesha pass** hoga. Chahe `pay` reject kare, resolve kare, ya `-100` ko chup-chaap charge kar de.

Kyun? `expect(p).rejects.toThrow()` ek **promise return karta hai**. Aapne `await` nahi kiya, to test function `undefined` return karke turant khatam -- runner ne dekha "koi error thrown nahi hua" -> green. Assertion ka result ek floating promise mein chala gaya jiska koi handler nahi. Yahi [[140-promises-internals-and-async-await]] ka floating-promise bug hai, bas test file mein -- aur yahan nuksaan zyada hai, kyunki ye **jhoothi safety** deta hai.

```ts
await expect(svc.pay('order-1', -100)).rejects.toThrow(RangeError);   // sahi
```

Doosra variant -- callback ke andar assertion:

```ts
// BUG -- 'mail-sent' event kabhi na aaye to? test pass!
it('emits mail-sent', () => {
  mailer.on('mail-sent', (e) => expect(e.to).toBe('a@b.com'));   // kabhi na chale, green
  mailer.send('welcome', { to: 'a@b.com' });
});

// BEST -- event ko promise bana ke await karo
it('emits mail-sent with the recipient', async () => {
  const once = new Promise<any>((res) => mailer.once('mail-sent', res));
  await mailer.send('welcome', { to: 'a@b.com' });
  await expect(once).resolves.toMatchObject({ to: 'a@b.com' });
});

// OK -- assertion count se guard karo
it('emits mail-sent', async () => {
  expect.assertions(1);                 // 1 assertion chali hi nahi to FAIL
  mailer.once('mail-sent', (e) => expect(e.to).toBe('a@b.com'));
  await mailer.send('welcome', { to: 'a@b.com' });
});
```

### `done()` Callbacks: Do Baar Call, Ya Ek Baar Bhi Nahi

```ts
// BUG 1 -- assertion throw kiya to done() kabhi nahi chala -> 5 second timeout
it('fetches the user', (done) => {
  repo.findById('u1', (err, user) => { expect(user.name).toBe('A'); done(); });
});

// BUG 2 -- done() do baar
it('retries once', (done) => {
  client.on('response', () => done());
  client.on('retry', () => done());     // dono fire -> "done() called multiple times"
  client.send();
});
```

Bug 1 ka failure message "Test timed out in 5000ms" hota hai -- jo asli assertion failure ko **chhupa** deta hai. Aap 20 minute network debug karte ho jabki problem ek `name` field thi.

> Rule: naya `done()` kabhi mat likho. Callback API ko `promisify` karo ya `new Promise` mein wrap karke `await` karo. **Jo bhi async hai, usko promise banao aur `await` karo** -- ye ek niyam aadhe async test bugs khatam kar deta hai.

Lint turant on karo: `@typescript-eslint/no-floating-promises` + `vitest/valid-expect` (ya `jest/valid-expect`, `jest/no-conditional-expect`). Ye poora bug class lint time par pakda jaata hai.

(**Vitest** syntax. Jest same -- `vi` -> `jest`; modern Jest mein `advanceTimersByTimeAsync` bhi hai.)

## 2. Time Ko Test Karna, Uska Wait Nahi Karna

```ts
export async function withRetry<T>(fn: () => Promise<T>, o: { attempts: number; baseMs: number }) {
  let lastErr: unknown;
  for (let i = 1; i <= o.attempts; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      if (i === o.attempts) break;
      await new Promise((r) => setTimeout(r, o.baseMs * 2 ** (i - 1)));   // 1s, 2s, 4s
    }
  }
  throw lastErr;
}
```

Naive test **real 15 second** lega (1+2+4+8). CI mein 40 aise = suite dead. Fake timers se wahi test **2 ms** mein:

```ts
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('retries 4 times with exponential backoff and then gives up', async () => {
  vi.useFakeTimers();
  const fn = vi.fn().mockRejectedValue(new Error('ETIMEDOUT'));

  const p = withRetry(fn, { attempts: 4, baseMs: 1000 });
  const assertion = expect(p).rejects.toThrow('ETIMEDOUT');   // pehle handler lagao

  await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000);      // saara time "guzar gaya"
  await assertion;

  expect(fn).toHaveBeenCalledTimes(4);
});

it('stops retrying as soon as a call succeeds', async () => {
  vi.useFakeTimers();
  const fn = vi.fn().mockRejectedValueOnce(new Error('ETIMEDOUT')).mockResolvedValueOnce('ok');

  const p = withRetry(fn, { attempts: 4, baseMs: 1000 });
  await vi.advanceTimersByTimeAsync(1000);

  await expect(p).resolves.toBe('ok');
  expect(fn).toHaveBeenCalledTimes(2);                 // 3rd attempt nahi hua
});
```

### Teen Baatein Jo Sabko Kaatti Hain

**(a) `advanceTimersByTime` nahi, `advanceTimersByTimeAsync`.** Fake timers `setTimeout`/`setInterval` (**macrotasks**) control karte hain. Par aapka code `await` bhi karta hai, jo **microtask** queue par resume hota hai ([[137-event-loop-phases-and-microtasks]]). Sync version timer fire kar deta hai par microtask queue drain hone ka mauka nahi deta -- yaani `await` wala code aage badha hi nahi. Test lagta hai "atak gaya" ya assertion stale value dekhta hai.

```
advanceTimersByTime       -> "ghadi aage kar do"              (macrotask only)
advanceTimersByTimeAsync  -> "ghadi aage karo AUR saans lo"   (macrotask + microtask drain)
```

Rule: **code mein ek bhi `await` hai to async variant.** Hamesha. Sochne mein time waste mat karo.

**(b) Promise ka handler advance se PEHLE lagao.**

```ts
await vi.advanceTimersByTimeAsync(7000);        // BAD -- rejection hui, handler nahi tha
await expect(p).rejects.toThrow();             //        -> unhandled rejection

const assertion = expect(p).rejects.toThrow(); // GOOD
await vi.advanceTimersByTimeAsync(7000);
await assertion;
```

**(c) Cleanup mandatory.** `afterEach(() => vi.useRealTimers())`. Warna fake timers us file ke baad bhi zinda rehte hain -- agla test jo real `setTimeout` par depend karta hai **hang** ho jaayega, aur uska error message aapko is file ki taraf nahi le jaayega. Sabse confusing flake yahi hai.

### Current Time Fix Karna, Aur Timezone

```ts
it('marks the invoice as overdue 30 days after issue', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-20T00:00:00Z'));
  expect(isOverdue({ issuedAt: new Date('2026-03-20T00:00:00Z'), netDays: 30 })).toBe(true);
});
```

`TZ=UTC` set karo CI mein **aur** local script mein (`"test": "cross-env TZ=UTC vitest run"`). Warna laptop (IST) par pass, CI (UTC) par fail -- ya ulta. Par `TZ=UTC` sab theek nahi karta: agar product IST mein "aaj ka din" calculate karta hai, to **explicitly** `Asia/Kolkata` wale cases test karo -- wahi asli business logic hai.

## 3. Flaky Tests: Ye Engineering Problem Hai, "CI Ki Dikkat" Nahi

Flaky = same code, same commit, kabhi pass kabhi fail. Pehle cost samjho:

```
Ek flaky test
   |  "Arre ye wala flaky hai, re-run kar do"
   v  Team ko aadat: RED CI == re-run
   |  3 mahine baad ek ASLI failure -- kisi ne re-run kiya, merge ho gaya
   v  Production incident
```

> Flaky suite **no suite se bura** hai. Zero tests ke saath aap savdhaan rehte ho. Flaky suite ke saath aap jhoothe confidence se merge karte ho, aur poori team ko red ignore karna sikha dete ho.

**Cause 1 -- Tests ke beech shared state**

```ts
const cache = new InMemoryCache();           // module level -- sab share karte hain
it('caches the user', async () => { await svc.getUser('u1'); expect(cache.size).toBe(1); });
it('caches the order', async () => { await svc.getOrder('o1'); expect(cache.size).toBe(1); });
// parallel ya order change par 2 ho sakta hai -> flake
```

Culprits: module-level Map/array, singleton, `process.env` mutation, DB rows, Redis keys, un-restored mocks. Fix: `beforeEach` mein fresh instance, aur per-test unique keys (`user:${testId}`).

**Cause 2 -- Real time / timezone par depend karna**

```ts
expect(res.body.date).toBe(new Date().toISOString().slice(0, 10));   // midnight par fail
expect(elapsed).toBeLessThan(50);                                    // loaded CI par fail
await new Promise(r => setTimeout(r, 100));                          // "kaafi hoga" -- nahi
```

Teesra sabse common hai: **`sleep` se synchronise karna.** Laptop par 100 ms kaafi hai; CI par 8 test parallel chal rahe hain, 100 ms kam pad gaya -> flake. Log fix karne ke liye 500 ms kar dete hain -> suite slow + still flaky. Fix: sleep nahi, **condition par wait karo**:

```ts
async function waitFor(fn: () => Promise<boolean>, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('waitFor timed out');
}

await waitFor(async () => (await repo.count()) === 1);
```

Ya behtar: wo promise/event directly `await` karo jo kaam khatam hone par settle hota hai. `sleep` sirf tab jab koi observable signal hi na ho.

**Cause 3 -- Concurrency / ordering assumption**

```ts
await Promise.all([slowTask(), fastTask()]);
expect(auditLog.entries[0].name).toBe('fastTask');     // kabhi ulta aayega

// FIX -- order ki assertion hatao, set-based assert karo
expect(auditLog.entries.map(e => e.name).sort()).toEqual(['fastTask', 'slowTask']);
```

Agar order **genuinely** guarantee karna hai (e.g. FIFO queue), usko explicitly serial code se test karo, `Promise.all` se nahi.

**Cause 4 -- Un-awaited promise jo agle test mein leak ho jaata hai** (sabse chaalak wala)

```ts
it('creates a user', async () => {
  svc.addUser({ email: 'a@b.com' });        // await bhool gaye -- insert chal raha hai
  expect(1).toBe(1);                        // test "pass"
});
it('has no users', async () => {
  expect(await repo.count()).toBe(0);       // kabhi 0, kabhi 1 -> FLAKE
});
```

Pehle test ka kaam **doosre test ke dauran** complete hua. Failure doosre test mein dikhti hai, galti pehle mein hai -- isliye debug karna dard. Aur agar wo floating promise reject kar gaya, modern Node mein unhandled rejection -> worker crash -> "test suite failed to run" jaisa cryptic error ([[140-promises-internals-and-async-await]]). Isliye `no-floating-promises` lint non-negotiable hai.

### Flake Dhoondhne Ka Tareeka -- Guess Mat Karo, Reproduce Karo

```bash
vitest run -t 'has no users' --repeat 50        # 1. kitna frequent hai?
vitest run src/users/users.test.ts              # 2. file akeli -- pass? cross-file leak
vitest run --sequence.shuffle --sequence.seed 1 # 3. order dependency pakdo
vitest run --no-file-parallelism                # 4. serial -- pass? shared resource

jest --runTestsByPath src/users/users.test.ts   # Jest equivalents
jest --runInBand
jest --randomize                                # Jest 29.5+
```

| Symptom | Sabse sambhav cause |
|---|---|
| Akela pass, file ke saath fail | file ke andar shared state / ordering |
| File akeli pass, poore suite mein fail | cross-file leak (DB, env, mocks, timers) |
| `--no-file-parallelism` par pass | shared external resource (same DB rows, same Redis keys) |
| Shuffle par fail | tests ek doosre par depend kar rahe hain |
| Sirf CI par fail | timing/sleep, TZ, resource limits, locale |
| Sirf raat ya mahine ke end par fail | real clock / date logic |

### Rule: Fix Karo Ya Delete Karo

Teesra option nahi hai. "Baad mein dekh lenge" ka practical matlab "kabhi nahi". Aaj fix nahi kar sakte to **skip karo loudly, chup-chaap nahi**:

```ts
it.skip('reconciles the ledger', ...);  // TODO(BUG-5120): flaky -- shared ledger fixture, owner: sonu
```

Aur CI auto-retry (`retry: 2`) ke baare mein honest raho: wo **flake chhupane ka tool** hai, fix ka nahi. Ek `retry: 1` naye flake ko merge-block se bachane ke liye acceptable hai, par uske saath ek report honi chahiye jo bataaye kaunse tests retry par pass hue -- warna suite dheere dheere saara signal kho dega.

## 4. DB Test Isolation: Transaction Rollback vs Truncate

Integration tests ka sabse bada flake source: **ek test ka data agle test mein bacha hua.**

```ts
// (a) Transaction rollback per test -- fast
beforeEach(async () => {
  tx = await pool.connect();
  await tx.query('BEGIN');
  setRequestClient(tx);          // app ko yahi client use karna hai
});
afterEach(async () => {
  await tx.query('ROLLBACK');    // sab gayab, truncate ka cost nahi
  tx.release();                  // <-- ye bhoolna = pool leak
});

// (b) Truncate per test -- simple
afterEach(() => pool.query(
  `truncate table order_items, orders, users restart identity cascade`));
```

| | Rollback | Truncate |
|---|---|---|
| Speed | sabse fast | theek (~10-50 ms) |
| Commit test kar sakte? | nahi (seedha) | haan |
| Code change chahiye? | haan (client seam) | nahi |
| Parallel workers | easy (each its own tx) | **each worker ko apna DB/schema chahiye** |

Mera default: **truncate se shuru karo** (simple, kuch chhupata nahi). Suite slow lage tab rollback par jao.

Teen baatein jo log bhoolte hain:

- **`afterEach` mein connection release karna** -- warna 200 tests ke baad pool khatam, aur aapko exactly wahi "connection timeout" error milega jo [[16-synchronized-connection-pool-expiry]] mein production mein dekha tha. Test suite ne khud ko DDoS kar liya.
- **Parallel workers ko alag DB do.** Vitest default mein files parallel chalata hai; ek hi DB par 4 worker truncate kar rahe hain -> random failures. `test_db_${process.env.VITEST_WORKER_ID}` ya per-worker schema.
- **Fixed IDs mat use karo** jahan unique constraint hai. `email: 'a@b.com'` har file mein -> parallel collision. Factory se unique generate karo.

## 5. Timeouts: Default Pe Bharosa Mat Karo

```ts
export default defineConfig({ test: {
  testTimeout: 5_000,      // unit: chhota rakho -- jaldi batao ki kuch atka hai
  hookTimeout: 20_000,     // DB container / migration ke liye bada
}});

it('imports a 50k row CSV', async () => { /* ... */ }, 30_000);   // per-test override
```

1. **Timeout bada karna fix nahi hai.** "5000ms mein timeout" ka 90% matlab hai: ek promise jo kabhi settle nahi hua, ya `done()` jo kabhi call nahi hua -- na ki "code slow hai". Pehle poochho "kya ye atak gaya hai?", "ise 6 second lagne chahiye?" baad mein.
2. **Unit timeout chhota rakho (2-5s).** Agar unit test 5 second le raha hai, wo unit test nahi hai -- usne kahin real network/DB pakad liya hai. Chhota timeout ye khud bata dega.

Classic: suite khatam hone ke baad process exit nahi hota -- matlab koi open handle hai (DB pool, Redis client, `setInterval`, HTTP server). Fix: `afterAll` mein sab close karo. Diagnose: Jest mein `--detectOpenHandles`, ya `why-is-node-running`. `--forceExit` lagana symptom dabana hai -- aur wo aksar aapke prod code ka asli leak chhupa raha hota hai.

## 6. Common Galtiyan

- `await expect(...).rejects` mein `await` chhodna -- test hamesha green
- `advanceTimersByTime` use karna jab code mein `await` hai
- `vi.useRealTimers()` cleanup na karna -- agli file hang
- `setTimeout(100)` se synchronise karna, aur flake par number badhate rehna
- `Promise.all` ke completion order par assert karna
- Floating promise test mein chhodna -- agle test ko corrupt karta hai
- DB connection `afterEach` mein release na karna -- pool exhaustion
- Parallel workers ek hi DB share karna
- Flaky test ko `retry: 3` se dabana aur report na rakhna
- Timeout badha dena asli hang investigate karne ke bajaye

## 🧠 Remember

> Async test ka sabse bada khatra **green hona bina chalne ke** hai -- `await` chhoota `expect(...).rejects` hamesha pass karta hai, aur callback ke andar ki assertion kabhi na chale to bhi pass; isliye har async cheez ko promise banao aur `await` karo, `done()` kabhi mat likho, aur `no-floating-promises` lint on rakho. Time ka wait mat karo, **fake timers se aage badhao** -- aur jahan `await` hai wahan `advanceTimersByTimeAsync` hi chalega, kyunki timers macrotask hain aur `await` microtask. Aur flaky test ko **fix karo ya delete karo**: chaar causes (shared state, real time/TZ, ordering assumption, leaked promise), aur dhoondhne ka tareeka 50 baar chalao / file akeli chalao / order shuffle karo -- kyunki jis suite ko log green hone tak re-run karte hain, wo no suite se bura hai.

## Quick Self-Test

1. `expect(svc.pay(-100)).rejects.toThrow()` **hamesha** pass kyun karta hai? Promise ke level par exactly kya ho raha hai?
2. `advanceTimersByTime` aur `advanceTimersByTimeAsync` mein farak kya hai, aur ye [[137-event-loop-phases-and-microtasks]] se kaise juda hai?
3. Ek test akela pass hota hai, poore suite ke saath fail, aur `--no-file-parallelism` par pass. Diagnosis?
4. "Suite flaky hai par 2 retries se green ho jaata hai" -- ye no-tests se bura kyun hai?
5. DB isolation ke liye rollback-per-test vs truncate-per-test -- kab kaunsa, aur rollback ki ek asli limitation?
6. 200 integration tests chalne ke baad "connection timeout" aane laga. Pehli cheez jo check karoge?
