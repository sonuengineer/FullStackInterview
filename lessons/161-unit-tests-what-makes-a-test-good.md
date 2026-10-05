# Unit Test: Achha Test Kaisa Dikhta Hai

> **Connects to**: [[160-testing-strategy-what-to-test]] (kya unit test karna hai -- ye lesson batata hai *kaise*), [[138-closures-and-scope-real-bugs]] (shared mutable state wala bug test file mein bhi aata hai), [[147-typescript-at-the-runtime-boundary]] (types compile par rukte hain, test runtime par shuru hota hai).

## 1. Ek Test Jo Green Hai Aur Bekaar Hai

```ts
it('test addUser', async () => {
  const svc = new UserService(mockRepo, mockMailer, mockLogger);
  const result = await svc.addUser({ name: 'A', email: 'a@b.com', age: 30 });
  expect(result).toBeDefined();
  expect(mockRepo.save).toHaveBeenCalled();
  expect(mockMailer.send).toHaveBeenCalled();
});
```

Green hai. Kuch verify nahi karta. Naam se nahi pata kya behaviour expected tha; `toBeDefined()` `null` ke alawa kuch bhi pass kar dega; `toHaveBeenCalled()` -- kis argument se? Aur fail hone ke 5 reason hain, to fail hua to aap test debug karoge, code nahi.

```ts
it('saves the user with a lowercased email', async () => {
  const repo = new InMemoryUserRepo();
  await new UserService(repo, noopMailer, noopLogger)
    .addUser({ name: 'A', email: 'A@B.COM', age: 30 });

  expect(repo.findByEmail('a@b.com')).toBeTruthy();
});
```

Ek behaviour. Ek reason to fail. Naam hi documentation hai. Kal `addUser` ka internal structure poora badal jaaye, ye test tabhi failega jab **behaviour** toote.

(**Vitest** syntax. Jest bilkul same -- `vi` ko `jest` kar do, top imports hata do.)

## 2. Arrange - Act - Assert

```ts
// retry.ts
export function backoffDelay(attempt: number, p: BackoffPolicy, rand = Math.random): number {
  if (attempt < 1) throw new RangeError('attempt starts at 1');
  const capped = Math.min(p.baseMs * 2 ** (attempt - 1), p.maxMs);
  return p.jitter ? Math.floor(capped * (0.5 + rand() * 0.5)) : capped;
}
```

```ts
it('doubles the delay on each attempt', () => {
  const policy = { baseMs: 100, maxMs: 10_000, jitter: false };        // Arrange
  const delays = [1, 2, 3, 4].map((a) => backoffDelay(a, policy));    // Act
  expect(delays).toEqual([100, 200, 400, 800]);                       // Assert
});

it('applies jitter between 50% and 100% of the capped delay', () => {
  const p = { baseMs: 1000, maxMs: 10_000, jitter: true };
  expect(backoffDelay(1, p, () => 0)).toBe(500);      // worst case
  expect(backoffDelay(1, p, () => 1)).toBe(1000);     // best case
});
```

Dhyan do `rand = Math.random` -- **injected randomness**. Isi ek default parameter ne function ko testable banaya; ye [[162-mocking-and-test-doubles]] wali DI ka sabse chhota form hai.

AAA kyun? Test fail hone par aap 10 second mein samajhna chahte ho "kya setup tha, kya kiya, kya expect kiya". Arrange aur assert mixed hain to padhne mein 2 minute lagenge -- aur raat 2 baje wo 2 minute mehenge hote hain.

## 3. Property 1: Naam Behaviour Bataye, Method Nahi

```ts
// BAD                                 // GOOD
it('test addUser')                     it('lowercases the email before saving')
it('should work')                      it('returns 422 when email is missing')
it('UserService > addUser > case 3')   it('throws ConflictError when the email exists')
```

Rule: `describe` + `it` milakar **ek English sentence** bane -- `POST /orders > returns 409 when the idempotency key was already used`. Ye naam CI failure report mein hi bug ka 70% diagnosis de deta hai. "`test addUser` failed" se aapko repo khol ke padhna padega.

## 4. Property 2: Fail Hone Ka Sirf Ek Reason

```ts
// BAD -- 5 behaviours ek test mein
it('handles user creation', async () => {
  const res = await svc.addUser(validInput);
  expect(res.id).toBeTruthy();
  expect(res.email).toBe('a@b.com');
  expect(mailer.sent).toHaveLength(1);
  await expect(svc.addUser(validInput)).rejects.toThrow(ConflictError);
});
```

Pehla assert fail hua to baaki **chale hi nahi** -- aapko ek failure dikha, par teen tooti ho sakti hain. Aur last line poori tarah alag behaviour hai. Teen `it()` banao: *returns the created user with a lowercased email*, *sends exactly one welcome mail*, *rejects a duplicate email with ConflictError*.

Exception: multiple asserts jo **ek hi behaviour** describe karte hain theek hain -- `toEqual([3334,3333,3333])` ke saath `expect(sum).toBe(10000)` dono "split sahi hua" ka hissa hain.

## 5. Property 3: Test Mein Logic Nahi

```ts
// BAD -- test ne implementation duplicate kar di
it('validates emails', () => {
  for (const e of emails) {
    if (e.includes('@')) expect(isValid(e)).toBe(true);
    else expect(isValid(e)).toBe(false);
  }
});
```

Agar `isValid` ka rule hi galat hai, test wahi galti (`includes('@')`) karega aur green rahega. Aur loop khaali array par chala to zero assertion chale -- phir bhi pass. Test mein `if`/`for` hai to aapne **ek untested program likha hai jo aapke program ko test kar raha hai.**

```ts
// GOOD -- expected values HARDCODED, calculated nahi
it.each([
  ['a@b.com', true], ['a@b.co.in', true], ['a@b', false],
  ['a b@c.com', false], ['', false], ['a@@b.com', false],
])('isValid(%s) -> %s', (input, expected) => {
  expect(isValid(input)).toBe(expected);
});
```

Rule: **expected value likho, compute mat karo.** `expect(total).toBe(1180)` likho, `expect(total).toBe(1000 * 1.18)` nahi -- warna formula dubara likh diya.

## 6. Property 4: Deterministic

```ts
expect(token.expiresAt.getDate()).toBe(new Date().getDate() + 1);   // 11:59 PM par fail
const u = await fetch('https://api.example.com/users/1');           // CI firewall/rate-limit
const amt = Math.floor(Math.random() * 10000);                      // failure reproduce nahi hoti
```

Teen culprits: `Date.now()`, `Math.random()`, real I/O. Ek hi ilaaj -- **inject karo**:

```ts
export function createToken(ttlMs: number, now: () => number = Date.now) {
  return { token: crypto.randomUUID(), expiresAt: new Date(now() + ttlMs) };
}

it('sets expiry exactly ttlMs after now', () => {
  const t = createToken(3600_000, () => Date.parse('2026-03-15T10:00:00Z'));
  expect(t.expiresAt.toISOString()).toBe('2026-03-15T11:00:00.000Z');
});
```

Ya `vi.useFakeTimers()` + `vi.setSystemTime()` -- detail [[163-async-tests-fake-timers-flaky]] mein. Random data ke liye: random **mat** use karo, uske edge cases hardcode karo. (Property-based testing jaise `fast-check` valid hai -- wo seed print karti hai taaki failure reproducible ho; bare `Math.random()` nahi karta.)

> Non-deterministic test ka asli nuksaan ye nahi ki wo galat fail hota hai. Nuksaan ye hai ki team usko **ignore karna seekh leti hai**, aur phir asli failure bhi ignore ho jaati hai.

## 7. Property 5: Independent

```ts
// BAD -- module-level shared mutable state
const users: User[] = [];
it('adds a user', () => { users.push(makeUser()); expect(users).toHaveLength(1); });
it('adds another', () => { users.push(makeUser()); expect(users).toHaveLength(1); }); // FAIL

// GOOD -- har test apna fresh world
beforeEach(() => { repo = new InMemoryUserRepo(); svc = new UserService(repo, noopMailer); });
```

Ye exactly wahi shared-state bug hai jo [[138-closures-and-scope-real-bugs]] mein production code mein dekha tha -- bas yahan test file mein.

Teen checks: **(1)** test akela chalao (`vitest run -t '...'`), **(2)** file akeli chalao, **(3)** random order (`--sequence.shuffle`). Teeno pass hone chahiye. Koi fail hua to tests ke beech **invisible dependency** hai, jo CI par kabhi bhi random fail degi jab parallelism ya order badlega. Culprits: module-level Map/array, singleton cache, `process.env` mutation, DB rows jo cleanup nahi hue, fake timers jo restore nahi kiye.

## 8. Taste: Kaunse Cases Likhne Hain

### Bucket 1: Boundaries -- 0, 1, Many, Negative, Max

Bug kinaare par milta hai, beech mein nahi. `splitEqual(30000, 3)` obviously kaam karta hai. Interesting cases:

```ts
it('rejects zero people instead of dividing by zero', () =>
  expect(() => splitEqual(100, 0)).toThrow(RangeError));

it('gives the whole amount to a single person', () =>
  expect(splitEqual(999, 1)).toEqual([999]));

it('handles a zero amount', () => expect(splitEqual(0, 3)).toEqual([0, 0, 0]));

it('rejects a negative amount instead of silently splitting it', () =>
  expect(() => splitEqual(-100, 3)).toThrow(RangeError));

it('rejects a fractional paise amount', () =>            // float money bug
  expect(() => splitEqual(100.5, 3)).toThrow(TypeError));

it('does not lose precision at large amounts', () =>
  expect(splitEqual(99_99_99_999, 7).reduce((a, b) => a + b, 0)).toBe(99_99_99_999));
```

Checklist jo main har function par chalaata hoon: **0, 1, 2, N, -1, max, null/undefined, empty string, empty array, duplicate, unicode.** 90% boundary bugs in 11 cases mein aa jaate hain.

### Bucket 2: Error Paths -- Bug `catch` Mein Rehta Hai

Zyadatar production bug happy path mein nahi hote. Wo us `catch` block mein hote hain jise kisi ne chalaaya hi nahi.

```ts
it('does not send a welcome mail when the insert fails', async () => {
  const repo = new InMemoryUserRepo();
  repo.failNextSave(new Error('db down'));
  const mailer = new FakeMailer();

  await expect(new UserService(repo, mailer).addUser(validInput)).rejects.toThrow('db down');
  expect(mailer.sent).toHaveLength(0);          // <- yahi asli bug hota hai
});

it('surfaces a ConflictError, not a raw Postgres error', async () => {
  const repo = new InMemoryUserRepo();
  await repo.save(makeUser({ email: 'a@b.com' }));

  await expect(new UserService(repo, noopMailer).addUser({ ...validInput, email: 'a@b.com' }))
    .rejects.toBeInstanceOf(ConflictError);     // 409, not 500
});
```

Doosra test seedha [[02-debugging-random-500-errors]] se juda hai: "random 500" ka aadha hissa yahi hota hai -- ek expected condition (duplicate email, missing row) jo generic error ban ke 500 bhej rahi hai, jabki 409/404 hona chahiye tha.

**Critical gotcha** -- `rejects` ke saath `await`:

```ts
expect(svc.addUser(x)).rejects.toThrow();          // BUG -- test hamesha pass hoga
await expect(svc.addUser(x)).rejects.toThrow();    // sahi
```

Ye [[163-async-tests-fake-timers-flaky]] ka opening topic hai, aur sabse common galti hai.

### Bucket 3: Regression Test Asli Bug Report Se

Sabse valuable test, kyunki uski value **proven** hai -- wo bug asli mein hua tha.

```
Bug report -> failing test likho jo bug exactly reproduce kare (fix nahi karna)
           -> test RED dekho (confirm hua sahi cheez pakdi)
           -> fix karo -> GREEN -> permanent proof
```

```ts
// BUG-4821: Gurgaon warehouse ke orders ka GST 0 aa raha tha, kyunki state
// code 'HR ' (trailing space) tha aur lookup exact match kar raha tha.
it('matches the GST rate even when the state code has trailing whitespace', () => {
  expect(gstRateFor('HR ')).toBe(0.18);
  expect(gstRateFor(' hr')).toBe(0.18);
});
```

Agar is lesson se ek hi aadat lein, ye lein: **har bug fix ke saath ek test.** Suite automatically wahi cover karega jo aapke system mein genuinely tootta hai -- guesswork khatam.

## 9. `it.each` -- Copy-Paste Ko Maaro

```ts
it.each([
  { attempt: 1, expected: 100 },
  { attempt: 2, expected: 200 },
  { attempt: 99, expected: 10_000 },        // capped
])('attempt $attempt -> $expected ms', ({ attempt, expected }) => {
  expect(backoffDelay(attempt, { baseMs: 100, maxMs: 10_000, jitter: false })).toBe(expected);
});
```

Har row **alag test** banti hai apne naam ke saath -- yaani fail hone par CI batata hai *kaunsa* input toota. Ye `for` loop se fundamentally behtar hai (loop mein pehla assert fail hua to baaki chale hi nahi). Jest mein same: `it.each` / `test.each`. Overuse mat karo -- rows ke liye `if` lagana pad raha hai to wo do alag tests hone chahiye.

## 10. Snapshot Tests Kyun Rot Jaate Hain

`expect(buildInvoice(order)).toMatchSnapshot()` pehle din zabardast lagta hai. 3 mahine baad:

- Koi field add karta hai -> 14 snapshots fail -> `vitest -u` -> **bina padhe accept**
- Us `-u` mein ek asli bug chhup gaya (`totalPaise: 0`) -- diff kisi ne padha hi nahi
- Fail hone par pata hi nahi chalta *kaunsa* behaviour toota -- 200 line ka diff hai
- Snapshot mein `createdAt`/`id` hai -> har run fail -> log ignore karne lagte hain

Core problem: **snapshot assert nahi karta, record karta hai.** Usme "expected" ka intent nahi, bas "pichhli baar aisa tha" hai.

Kab theek hai: genuinely bada, stable output jahan explicit assertion likh hi nahi sakte -- generated SQL, OpenAPI spec. Aur tab `toMatchInlineSnapshot` use karo taaki diff PR review mein dikhe. Kab mat karo: business logic -- `expect(invoice.totalPaise).toBe(11800)` ek line hai, ek reason to fail, aur intent likha hua hai.

## 11. Raat 2 Baje Padhne Layak Test

- **Test khud ko explain kare.** 4 line duplicate karna 4-file-deep helper chain se behtar hai -- test code mein "DRY" readability ka sabse bada dushman hai.
- **Magic values ko naam do**: `makeOrder({ amountPaise: 11800 })  // 10000 + 18% GST`.
- **Factories, bade JSON fixtures nahi.** `makeUser({ email })` -- jo field relevant hai wahi dikhao, baaki 20 chhupa do. Padhne wale ko sirf relevant difference dikhna chahiye.
- **`describe` nesting 2 level se zyada na ho** -- warna setup dhoondhne ke liye scroll karna padta hai.

## 12. Common Galtiyan

- `toBeDefined()` / `toBeTruthy()` ko real assertion samajhna -- `{}` bhi pass hota hai
- `await` bhoolna `expect(...).rejects` par -- test silently pass
- Test mein expected value calculate karna (implementation duplicate ho gayi)
- `beforeAll` mein mutable state banana (`beforeEach` chahiye tha)
- `vi.restoreAllMocks()` / `vi.useRealTimers()` na karna -- agli file ko zeher
- Private method test karna -- refactor jail
- Happy path only -- `catch` untested
- `it('works')` naam -- CI log se zero information
- Snapshot ko `-u` se blindly update karna

## 🧠 Remember

> Achha unit test **ek behaviour** test karta hai, uska **naam wahi behaviour bolta hai** (`returns 422 when email is missing`, na ki `test addUser`), wo **ek hi reason se fail** hota hai, uske andar **koi logic/loop/if nahi** hota (expected value hardcode karo, calculate nahi), wo **deterministic** hai (clock aur random inject karo, real network nahi) aur **independent** hai (akela aur random order mein bhi pass) -- aur likhne layak cases hain boundaries (0/1/N/-1/max), error paths (bug `catch` mein rehta hai), aur **asli bug report se likha regression test**.

## Quick Self-Test

1. `it('test addUser')` vs `it('lowercases the email before saving')` -- CI failure padhte waqt kaunsa behtar hai aur **kyun exactly**?
2. Test ke andar `if/else` khatarnak kyun hai? Ek case batao jahan test aur code dono galat hon par suite green rahe.
3. `expect(svc.pay(x)).rejects.toThrow()` mein ek shabd missing hai. Kaunsa, aur uske bina kya hota hai?
4. Test akela pass, poori file ke saath fail. Pehli teen cheezein jo dekhoge?
5. Snapshot test 3 mahine mein kaise mar jaata hai -- step by step?
6. `it.each` plain `for` loop se behtar kyun hai, jab dono same inputs chala rahe hain?
