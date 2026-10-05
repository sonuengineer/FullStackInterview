# CI, Coverage Aur Coverage % Ka Asli Matlab

> **Connects to**: [[02-debugging-random-500-errors]] (jo branch kabhi nahi chali, wahi raat 2 baje chalti hai), [[32-payment-idempotency-double-click]] (paisa wale code par floor rakho) aur [[103-n-plus-1-vs-connection-pool-hinglish]] (regression guard CI mein hi kaam deta hai).

## 1. Pipeline Ka Order Random Nahi Hai

CI ka ek hi kaam hai: **galat code ko main tak pahunchne se rokna, jitni jaldi ho sake.** Isliye stages ko cost ke order mein lagao -- sasta aur jaldi fail hone wala pehle.

```yaml
# .github/workflows/ci.yml -- shape, exact syntax nahi
on: pull_request            # merge ke baad nahi -- PR par

jobs:
  checks:                   # ~60-90 s : typecheck + lint + format
    steps: [checkout, setup-node-with-cache, npm ci, tsc --noEmit, eslint ., prettier --check]

  unit:                     # ~1-2 min : no DB, no network
    needs: checks
    steps: [..., vitest run --coverage]

  integration:              # ~3-5 min : asli Postgres (Testcontainers)
    needs: checks
    steps: [..., vitest run --config vitest.integration.ts]

  e2e:                      # ~8-15 min : sirf main par ya nightly
    if: github.ref == 'refs/heads/main' || github.event_name == 'schedule'
    steps: [..., playwright test]
```

Kyun yahi order:

- **`tsc --noEmit` pehle** -- 40 second mein ek type error pakadna, 12 minute ka e2e chalaane se behtar. Aur type error ke saath 200 test fail hone ka output padhna kisi kaam ka nahi hota.
- **Unit DB se pehle** -- unit test ko kuch chahiye nahi, wo 90 second mein 80% bugs par feedback de deta hai.
- **E2E last aur sirf main/nightly par** -- e2e sabse slow aur sabse flaky hai (asli browser, asli network, timing). Use har PR par lagana = poori team ka din dusre ka flaky retry dabaane mein jaayega.

Aur sabse important: **test PR par chalein, merge ke baad nahi.** "Merge ke baad main par chalta hai" ka matlab hai broken main, aur phir dus log ek saath guess kar rahe hain ki kis PR ne toda. PR par chalne wala test ek banda, ek diff, ek fix.

## 2. 10 Minute Ki Deewar

Ye engineering baat nahi, insaani baat hai -- par isko ignore karna sabse mehnga padta hai.

| Pipeline time | Developer kya karta hai |
|---|---|
| < 5 min | PR ke saath wait karta hai, result dekh kar merge karta hai |
| 5-10 min | Tab switch karta hai, 10 min baad wapas aata hai -- theek hai |
| 10-20 min | Dusra kaam shuru, context switch, PR do din lambi |
| > 20 min | **Bypass shuru**: `--no-verify`, "sirf ek typo hai, admin merge kar do", flaky test `skip` |

Yaani slow pipeline apne aap ko useless bana leta hai. Jab pipeline bypass hone lagta hai, aapke paas test to hain par safety net nahi.

Tez karne ke practical lever:

- **Dependency cache.** `actions/setup-node` ke saath `cache: npm` -- `npm ci` 90 s se 15 s. Lockfile hash key hoti hai.
- **Parallel jobs.** `checks`, `unit`, `integration` ko independent rakho jahan ho sake; CI unko ek saath chalaayega.
- **Test sharding.** Bada suite 4 shards mein (`--shard=1/4`) -- 12 min se 3 min.
- **Affected-only tests.** Monorepo mein sirf badle hue package ke test (Nx/Turbo). Chhote repo mein ye over-engineering hai.
- **Build artifact reuse.** Ek baar build karo, e2e job usi artifact ko download kare -- dobara build nahi.
- **Fail fast.** `--bail=1` PR feedback par; nightly full run par nahi.

## 3. Coverage: Jo Number Aap Samajh Rahe Ho, Wo Nahi Hai

Ab asli baat. Ye test dekho:

```ts
// src/pricing.ts
export function finalAmountPaise(items: Item[], coupon?: Coupon) {
  let total = 0;
  for (const i of items) total += i.pricePaise * i.qty;
  if (coupon?.type === 'percent') total -= Math.round(total * coupon.value / 100);
  if (coupon?.type === 'flat') total -= coupon.value;
  if (total < 0) total = 0;
  return total;
}
```

```ts
// pricing.test.ts
it('chalta hai', () => {
  finalAmountPaise([{ pricePaise: 100, qty: 2 }], { type: 'percent', value: 10 });
  finalAmountPaise([], { type: 'flat', value: 50 });
  finalAmountPaise([{ pricePaise: 10, qty: 1 }], { type: 'flat', value: 9999 });
});
```

Is test mein **ek bhi `expect` nahi hai.** Ye kuch verify nahi karta -- function `NaN` return kare, `-500` return kare, rupees-paise ulta kar de, test green rahega. Lekin coverage report?

```
File          | % Stmts | % Branch | % Funcs | % Lines
pricing.ts    |     100 |      100 |     100 |     100
```

**100%.** Kyunki coverage tool sirf ek cheez measure karta hai: **kaunsi line execute hui.** Usko nahi pata ki kuch assert hua ya nahi. Isliye:

> Coverage % batata hai ki **kitna code chala**, ye nahi ki **kitna code verify hua.**

Yahi ek line interview mein aur apni team mein baar-baar bolni padti hai. 85% coverage wali codebase mein zero-assertion test ka bada hissa ho sakta hai, aur aksar hota hai -- khaaskar jab gate 80% ka ho.

Dusri taraf iska ulta bhi sach hai, aur yahi coverage ko **useful** banata hai: **0% coverage ek pakka signal hai.** Jo line kabhi chali hi nahi, wo definitely untested hai. Yaani coverage ek **achha negative signal** hai aur ek **bekaar positive signal**. Usko bug-detector ki tarah nahi, **gap-finder** ki tarah use karo: report kholo, uncovered lines par jaao, aur poochho "ye branch kab chalti hai? kya mujhe parwah hai?"

## 4. Chaar Tarah Ki Coverage, Aur Sirf Ek Dekhne Layak

| Type | Kya ginti hai | Kitna useful |
|---|---|---|
| **Line** | Kitni lines chalin | Kam -- `a && b` ek line hai, aadha hi chala to bhi covered |
| **Statement** | Kitne statements chale | Line jaisa hi, thoda precise |
| **Function** | Kitne functions ek baar call hue | Bahut kam -- "function call hua" se kuch sabit nahi |
| **Branch** | Har `if`/`else`, `? :`, `&&`, `??`, `switch case`, `catch` -- dono raaste | **Sabse useful** |

Branch coverage hi matter karta hai, kyunki **bug `else` mein rehta hai.** Example:

```ts
if (order.status === 'paid') return refund(order);
// implicit else: status 'pending' hua to? -- yahan se undefined return hoke caller crash karta hai
```

Line coverage ke hisaab se wo `if` wali line 100% covered hai. Branch coverage bolegi 50% -- aur wahi aadha hissa aapka production 500 hai ([[02-debugging-random-500-errors]]).

Sabse mehnge uncovered branches aksar yahi hote hain:

- `catch` block -- error path par aapka error handling khud crash karta hai (`err.response.data` jab `err.response` hi nahi hai).
- `??` aur `?.` ke fallback -- `user.address?.city ?? 'N/A'` ka `null` wala side.
- Retry / timeout ka failure path.
- Permission check ka `deny` side -- yaani IDOR wala branch.

Config mein `branch` dekho, aur `all: true` zaroor rakho -- warna jo file kisi test ne import hi nahi ki, wo report mein aati hi nahi aur 0% chup-chaap chhup jaata hai:

```ts
// vitest.config.ts  (Jest mein coverageThreshold/collectCoverageFrom -- bilkul same idea)
coverage: {
  provider: 'v8',
  all: true,                             // untested files bhi report mein -- warna 0% chhup jaata hai
  exclude: ['**/*.d.ts', 'src/migrations/**', 'src/generated/**', '**/*.config.ts'],
  thresholds: {
    branches: 50,                        // global floor -- jaan-boojh kar kam
    'src/payments/**': { branches: 85, lines: 90 },   // paisa
    'src/auth/**':     { branches: 85, lines: 90 },   // permission
  },
}
```

## 5. Gate Ki Policy: 80% Kyun Ulta Padta Hai

Management ka classic order: "coverage 80% se neeche PR merge nahi hoga."

Kya hota hai, predictably:

1. Developer ka PR 78% par fail hota hai.
2. Deadline aaj hai. Asli test likhna = 2 ghante soch kar edge cases nikalna.
3. Isliye wo **sabse saste** test likhta hai -- bina assertion wale, ya `expect(fn).toBeDefined()` wale, getters ko loop mein call karke.
4. Number 81% ho jaata hai. PR merge. **Suite bhaari ho gaya, safety utni hi.**

Gate ne ek kaam kiya: usne galat cheez measure ki, to team ne wahi galat cheez optimize kar di. Ye Goodhart's law hai, aur ye har jagah hota hai -- isme developer bura nahi hai, incentive bura hai.

Practical policy jo sach mein kaam karti hai, teen hisson mein:

**A) "Coverage is PR mein girni nahi chahiye" (ratchet)**

```yaml
# PR par base branch se compare -- 0.5% ka tolerance flakiness ke liye
- run: npx vitest run --coverage --reporter=json --outputFile=cov.json
- uses: <coverage-diff-action>
  with: { base: ${{ github.event.pull_request.base.sha }}, min-delta: -0.5 }
```

Isse legacy code ka 40% aapko block nahi karta, par **naya code untested nahi jaa sakta.** Direction control mein hai, absolute number nahi. Aur ye 40% wali legacy codebase mein hi sabse zyada kaam ka hai -- 80% gate wahan din 1 par hi bypass ho jaata hai.

**B) Risk wale folders par asli floor**

Paisa aur permission -- yahan 85-90% **branch** floor rakho, aur wo gate nahi hatega. `src/payments/**` par idempotency ka `else` untested jaana wahi bug hai jo [[32-payment-idempotency-double-click]] mein double charge banta hai. `src/auth/**` par `deny` branch untested jaana [[110-idor-broken-object-level-authorization-hinglish]] hai.

**C) Patch coverage, total coverage nahi**

"Is PR mein jo lines aap chhoo rahe ho, unka 80% covered hona chahiye" -- ye total se bahut behtar signal hai, kyunki bug naye/badle code mein aata hai.

Aur ek honest baat jo zor se bolni chahiye: **assertion-free test coverage se zyada khatarnaak hai.** 0% par aapko pata hai ki ye code untested hai. 95% assertion-free par aap sochte ho ki ye code safe hai, aur usi bharose par Friday deploy karte ho.

## 6. Flaky Test: Quarantine, Warna Poora Suite Mar Jaata Hai

Flaky test = same code, same commit, kabhi pass kabhi fail. Wajah aksar yahi: `sleep`-based wait, test order dependency (ek test ka data dusre ke liye bacha), shared DB row, timezone/`Date.now()`, parallel workers ka port/connection clash.

Asli nuksaan **mental** hai: ek baar team ne "red CI ko dobara chalao" seekh liya, to **saari** redness ignore hone lagti hai. Ab ek asli bug bhi "arre ye flaky hai, retry karo" mein dab jaata hai. Ek flaky test poore suite ki credibility kha jaata hai.

Policy jo chalti hai:

1. **Detect** -- CI mein pass/fail history store karo (ya flaky-detector reporter). Jo test 100 run mein 3 baar bhi fail hua, wo flaky list mein.
2. **Quarantine** -- usko blocking suite se nikaalo (`skip` + ek ticket, ya alag "quarantined" job jo pipeline red nahi karti). Deadline ke saath -- "2 hafte, warna delete".
3. **Fix ya delete** -- dono acceptable hain. Flaky test jo permanently skip pada hai, wo sirf jhoothi tasalli hai.
4. **Retry ko fix na samjho.** `retries: 1` sirf tab, jab aap flaky test ko quarantine karne tak jee rahe ho -- blanket retry ne aaj tak kisi team ki madad nahi ki, usne sirf flakiness chhupaayi hai.

Jo nahi karna: "poora suite 2 retry ke saath chalao". Wo flakiness ko invisible bana deta hai, aur aapki real race condition -- jaise [[26-duplicate-email-race-condition]] -- bhi "flaky" label mein dab jaati hai, jabki wo asli bug hai jo test theek pakad raha hai.

## 7. Required Checks: Policy Jo CI Ko Danth Deti Hai

Pipeline jo PR ko block nahi karta, wo sirf ek dashboard hai.

Branch protection par ye rakho:

- `checks`, `unit`, `integration` = **required status checks**. Red hai to merge button hi disabled.
- `e2e` = required **nahi** (flaky hai), par main par fail hone par alert.
- "Require branches to be up to date before merging" -- semantic conflict se bachaata hai (do PR alag-alag green, merge ke baad main red).
- Admin bypass audit ho -- bypass ho jaana theek hai (production down ho to), par silently roz hona nahi.

Aur yahi jagah hai jahan aapke regression guard sach mein kaam karte hain: [[103-n-plus-1-vs-connection-pool-hinglish]] wala query-count assertion CI mein required hone par hi value deta hai. Local par chalne wala test = optional. Required check = enforced.

## 8. Green Pipeline Kya Prove Karta Hai, Aur Kya Nahi

| Green pipeline prove karta hai | Prove nahi karta |
|---|---|
| Jo cases aapne socha, wo abhi bhi chalte hain | Jo cases aapne nahi socha |
| Types consistent hain | Runtime data aapke types jaisa hai ([[147-typescript-at-the-runtime-boundary]]) |
| Koi purana behaviour accidentally nahi toota | Naya feature sahi hai (test aapki samajh ke mutabik likha gaya) |
| Code build/import hota hai | Production load par chalega -- performance, memory, pool |
| Migration khaali DB par chalti hai | 500M rows par lock liye baithi nahi rahegi ([[50-slow-query-500m-rows]]) |
| App ke andar ka wiring theek hai | Config, secrets, DNS, CORS, IAM -- environment ka kuch bhi ([[07-cors-error-fix]]) |

Isliye CI ke baad bhi ye chahiye: staging par smoke test, canary/gradual rollout, aur alerts. **Test deploy ke pehle ka confidence hai; observability deploy ke baad ka.** Dono ka kaam alag hai aur ek dusre ka substitute nahi.

## 9. Poore Testing Track Ka Honest Closing

Chalo poori baat ek jagah rakhte hain:

- **Mocked DB ka repository test** aapka mock test karta hai, aapka SQL nahi -- asli Postgres uthao.
- **API test** sabse zyada return deta hai: ek test mein route, validation, auth, SQL, error handler -- aur 403 wala case IDOR pakadta hai.
- **React test** user ka behaviour dekhe, component ka state nahi.
- **CI** tez ho, PR par chale, aur merge block kare.
- **Coverage** gap-finder hai, score nahi -- aur branch coverage hi dekhne layak hai.

Aur jo asli wajah hai, jo har "testing discipline" wali baat se zyada honest hai:

> Test aapko bug se bachaane se zyada, **baad mein code tezi se badalne** ke liye chahiye.

Jis codebase mein test nahi hai, usme refactor "risky" ho jaata hai. Risky refactor nahi hote. Na hone wale refactor se code sadta hai. Sadta code mein naya feature mahino leta hai, aur phir log kehte hain "ye legacy hai, isko chhoona mat". Test ki asli currency **speed** hai, virtue nahi.

Isliye sawaal kabhi ye nahi hona chahiye ki *"hum kaafi test kar rahe hain ya nahi"* -- us sawaal ka koi jawab nahi hai aur wo guilt paida karta hai. Sawaal ye hona chahiye:

> **"Kya hum Friday 4 baje deploy kar sakte hain?"**

Agar jawab "haan, pipeline green hai, roll back ek command hai" -- aapka testing kaafi hai, coverage 55% ho tab bhi. Agar jawab "nahi, Monday karte hain" -- to aapko exactly pata hai ki kaunse hisse par aapko bharosa nahi. **Wahi likhne waale agle test hain.**

## 🧠 Remember

> Pipeline mein sasta pehle (typecheck -> lint -> unit -> integration -> e2e sirf main par), PR par chale, 10 minute ke andar rahe -- warna log use bypass karenge. Coverage % batata hai kitna code **chala**, kitna **verify** hua ye nahi (zero-assertion test bhi 100% deta hai), isliye sirf **branch** coverage dekho, hard 80% gate ki jagah "PR par girni nahi chahiye" + paisa/auth par asli floor rakho. Aur final sawaal "kaafi test hai?" nahi, **"Friday ko deploy kar sakte hain?"** hai.

## Quick Self-Test

1. Ek test jisme ek bhi `expect` nahi hai, coverage report mein 100% kaise de sakta hai? Tool actually kya measure karta hai?
2. Chaar coverage types mein se branch kyun sabse useful hai? Ek `if` jiska `else` nahi likha -- line coverage kya kehti hai, branch kya?
3. Hard 80% gate lagane par team predictably kya likhne lagti hai, aur uski jagah kaunsi do policies behtar hain?
4. E2E ko har PR par required check banane se kya nuksaan hai?
5. Blanket `retries: 2` flakiness ka fix kyun nahi hai? Ek asli race-condition test ke saath kya ho jaayega?
6. Green pipeline ke baad bhi production mein kya-kya toot sakta hai -- teen cheezein batao jo CI chhoo bhi nahi sakti.
