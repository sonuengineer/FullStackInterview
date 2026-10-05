# Promises Andar Se Aur async/await Ka Asli Matlab

> **Connects to**: [[137-event-loop-phases-and-microtasks]] (`await` microtask queue mein resume hota hai), [[54-notify-5000-users-10x-faster]] (serial vs parallel fan-out), [[103-n-plus-1-vs-connection-pool-hinglish]] aur [[16-synchronized-connection-pool-expiry]] (pool ko kaise maarte hain).

## 1. Teen States, Aur Ek Niyam

Ek promise sirf teen haalaton mein ho sakta hai:

| State | Matlab |
|---|---|
| **pending** | kaam chal raha hai |
| **fulfilled** | value mil gayi |
| **rejected** | error aa gaya |

Niyam: **pending -> fulfilled** ya **pending -> rejected**, bas. Ek baar **settled** (fulfilled ya rejected) ho gaya, to wo **kabhi** nahi badalta.

```javascript
const p = new Promise((resolve, reject) => {
  resolve('first');
  resolve('second');     // ignore
  reject(new Error('x')); // ignore -- throw bhi nahi hoga
});
p.then(console.log);     // 'first'
```

Isi immutability ki wajah se promise ek **reliable value handle** hai: aap use 10 jagah pass kar sakte hain, 10 baar `.then` laga sakte hain, sabko same result milega. Callback mein ye guarantee nahi thi -- ek buggy library callback do baar call kar deti thi aur aapka order double charge ho jaata tha. Promise spec ne isi class ke bug ko mitaya.

Ek aur cheez jo log bhool jaate hain: **executor function synchronous chalta hai**. `new Promise(...)` likhte hi andar ka code turant chal jaata hai; sirf `.then` wala part baad mein (microtask mein) chalta hai.

## 2. async/await = Wahi Promise, Naya Kapda

Ek hi function, do tareeke:

```javascript
// promise style
function getOrder(id) {
  return db.orders.findById(id)
    .then((order) => api.getUser(order.userId)
      .then((user) => ({ ...order, user })))
    .catch((err) => { logger.error({ err, id }); throw err; });
}

// async/await style -- bilkul same cheez
async function getOrder(id) {
  try {
    const order = await db.orders.findById(id);
    const user = await api.getUser(order.userId);
    return { ...order, user };
  } catch (err) {
    logger.error({ err, id });
    throw err;
  }
}
```

Teen baatein saaf kar lo:

1. **`async` function hamesha promise return karta hai** -- `return 5` likho to caller ko `Promise<5>` milega. Sync return bhi promise hai.
2. **`await` thread block nahi karta.** Wo function ko wahan **pause** karta hai, control event loop ko wapas de deta hai, aur promise settle hone par function ko **microtask queue** mein resume karta hai. Isi dauran doosri 500 requests chalti rehti hain ([[137-event-loop-phases-and-microtasks]]).
3. `await` non-promise par bhi ek microtask tick leta hai -- `await 5` turant aage nahi badhta.

Ye dekho:

```javascript
console.log('A');
(async () => { console.log('B'); await null; console.log('D'); })();
console.log('C');
// A B C D  -- 'D' microtask mein gaya, 'C' sync tha
```

> Mental model: `await` ek bookmark hai. Function ruk jaata hai, kitaab **band nahi** hoti, aur thread doosre kaam par chala jaata hai.

## 3. Galti #1: Loop Mein `await` -- N Serial Round Trips

Sabse mehnga ek-line bug:

```javascript
// SLOW: 200 users x 40 ms = ~8000 ms
const users = [];
for (const id of ids) {
  users.push(await api.getUser(id));   // ek khatam, phir dusra
}

// FAST: ek wave, ~40-60 ms
const users = await Promise.all(ids.map((id) => api.getUser(id)));
```

Farak kyun? Pehle version mein har `await` **next request start hone se pehle** pichhle ka response maangta hai. Doosre mein `.map` pehle **saare** promises bana deta hai (yaani saare requests nikal jaate hain), aur `Promise.all` sirf unke settle hone ka wait karta hai.

Naap lo:

```javascript
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const task = (i) => sleep(100).then(() => i);

console.time('serial');
for (let i = 0; i < 10; i++) await task(i);
console.timeEnd('serial');     // ~1000 ms

console.time('parallel');
await Promise.all(Array.from({ length: 10 }, (_, i) => task(i)));
console.timeEnd('parallel');   // ~100 ms
```

Yahi [[54-notify-5000-users-10x-faster]] ka core hai. **Par**: serial loop kabhi-kabhi sahi hota hai -- jab order matter karta ho, jab rate limit ho, ya jab downstream nazuk ho. Default parallel, lekin soch ke.

## 4. Galti #2: `forEach` Ke Saath `async`

```javascript
// BUG: ye function instantly return ho jaata hai, kaam adhoora chhod ke
async function saveAll(rows) {
  rows.forEach(async (row) => { await db.insert(row); });   // forEach promise ignore karta hai
  console.log('saved');     // jhoot -- ek bhi insert pura nahi hua
}

// FIX
async function saveAll(rows) {
  await Promise.all(rows.map((row) => db.insert(row)));
  console.log('saved');     // ab sach
}
```

`forEach` return value phenk deta hai, to andar ke promises **floating** reh jaate hain. Agar inme se koi reject hua, to niche wala crash wala case ban jaata hai.

## 5. Galti #3: `Promise.all` Ka Fail-Fast vs `allSettled`

```javascript
await Promise.all([a(), b(), c()]);   // ek bhi reject -> poora reject, pehli error ke saath
```

Do important baatein:
- `Promise.all` **short-circuit** karta hai par baaki promises **cancel nahi** hote -- wo background mein chalte rehte hain. Agar unme se koi reject hua aur uska handler nahi bacha, aapko unhandled rejection mil sakta hai.
- Batch kaam mein ye galat semantics hai: 5000 notifications mein 1 fail hua to aap baaki 4999 ka result phenk dete hain.

```javascript
const results = await Promise.allSettled(tasks.map((t) => t()));
const failed = results.filter((r) => r.status === 'rejected');
logger.warn({ ok: results.length - failed.length, failed: failed.length });
```

| Combinator | Kab use karo |
|---|---|
| `Promise.all` | Sab chahiye, ek bhi fail hua to aage badhna bekaar (e.g. page ka core data) |
| `Promise.allSettled` | Batch jobs, notifications, partial success acceptable |
| `Promise.race` | Timeout lagana (`race([work, timeout(2000)])`) |
| `Promise.any` | Kai mirrors/replicas, pehla success chahiye |

## 6. Galti #4: Floating Promise -> Process Crash

```javascript
app.post('/order', async (req, res) => {
  sendEmail(req.body.email);      // await nahi, .catch nahi
  res.json({ ok: true });
});
```

Agar `sendEmail` reject hua: **unhandled rejection**. Node 15 se iska default behaviour `throw` hai -- yaani **poora process gir jaata hai**, aur uske saath wo saari in-flight requests bhi. Ek email failure ne 200 users ka request tod diya.

Teen sahi tareeke, intent ke hisaab se:

```javascript
await sendEmail(req.body.email);                       // user ko result chahiye
// ya
sendEmail(...).catch((err) => logger.error({ err }));  // fire-and-forget, par handled
// ya (best for real work)
await queue.add('send-email', { email });              // background kaam queue mein
```

Safety net rakho, par ise fix mat samjho:

```javascript
process.on('unhandledRejection', (err) => {
  logger.fatal({ err }, 'unhandled rejection');
  process.exit(1);                 // crash karo, par log ke saath
});
```

TypeScript mein `@typescript-eslint/no-floating-promises` lint rule on karo -- ye class of bug compile time par pakda jaa sakta hai.

## 7. Galti #5: `try/catch` Jo Kuch Nahi Pakadta

```javascript
try {
  setTimeout(() => { throw new Error('boom'); }, 10);   // try block kab ka khatam
} catch (err) {
  console.log('never runs');    // uncaughtException -> crash
}

try {
  doAsyncThing();               // await bhool gaye
} catch (err) {
  console.log('never runs');    // rejection try block ke baad aayi
}
```

`try/catch` **synchronous stack** ko pakadta hai. Jab tak `await` nahi hai, callback ka error aapke `try` block se bahar, bilkul alag event loop turn mein phekta hai. Rule: *jo promise aapke `try` mein hai hi nahi, uska error aap catch nahi kar sakte.*

## 8. `Promise.all` Par 10,000 Items = Khud Ka Banaya Outage

```javascript
await Promise.all(tenThousandIds.map((id) => db.getUser(id)));   // mat karo
```

Kya tootega:
- **Connection pool khatam** -- 10,000 queries, pool size 10. Baaki 9,990 queue mein, timeout hona shuru ([[16-synchronized-connection-pool-expiry]], [[103-n-plus-1-vs-connection-pool-hinglish]]).
- **Memory** -- 10,000 pending promises + 10,000 results heap mein, ek saath.
- **Downstream DDoS** -- aapne apni hi API/DB par traffic spike bana diya; wo 429/503 dene lagega.
- **Event loop pressure** -- 10,000 microtask resumes ek saath.

Sahi jawab: **bounded concurrency**. Ek baar mein N, na 1 na 10,000.

```javascript
function pLimit(limit) {
  let active = 0;
  const queue = [];

  const next = () => {
    if (active >= limit || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };

  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}

// use
const limit = pLimit(10);                       // pool size se match karo
const users = await Promise.all(
  tenThousandIds.map((id) => limit(() => db.getUser(id)))
);
```

Dhyan do: `map` ab bhi 10,000 promises banata hai, par **kaam** sirf 10 ek waqt par chalta hai -- baaki queue mein intezaar karte hain. Production mein `p-limit` ya `p-map` package use karna theek hai; concept same hai.

Aur agar ye 10,000 DB rows ek-ek karke laane ki baat hai, to asli fix concurrency nahi -- **ek query** hai (`WHERE id IN (...)` ya join). Ye [[103-n-plus-1-vs-connection-pool-hinglish]] ka point hai: pehle N+1 hatao, phir jo bacha use bounded parallel karo.

## 9. Common Galtiyan (Checklist)

- `new Promise` mein `async` executor dena -- uske andar ki rejection kho jaati hai.
- Promise wapas lapetna: `return new Promise((res) => db.query().then(res))` -- `db.query()` already promise hai, seedha return karo (error path bhi bacha lo).
- `await` ko "blocking" samajh ke CPU-heavy kaam ke aage lagana -- `await` I/O ke liye hai, CPU ke liye `worker_threads` ([[109-cluster-worker-threads-child-process-hinglish]]).
- Timeout na lagana -- `Promise.race` se hamesha upper bound do, warna ek atka downstream aapka pool kha jaayega.
- `.catch` lagane ke baad `throw` na karna -- error nigal gaye, caller ko "success" mil gaya.

## 🧠 Remember

> Promise ek **settle hone ke baad na badalne wala** value handle hai, aur `async/await` usi ka syntax hai -- `await` thread block nahi karta, wo function ko microtask queue tak bookmark kar deta hai. Isliye loop mein `await` serial round trips banata hai, `Promise.all` poore batch ko ek fail par gira deta hai, aur 10,000 par `Promise.all` chalane se behtar hai bounded concurrency.

## Quick Self-Test

1. `for (const id of ids) await get(id)` aur `Promise.all(ids.map(get))` mein latency ka farak **kyun** aata hai -- request kab nikalti hai?
2. `rows.forEach(async r => await save(r))` ke baad `console.log('done')` jhoot kyun bolta hai?
3. Ek un-awaited promise reject ho gaya -- modern Node par kya hota hai, aur usme kitne doosre users affect honge?
4. `Promise.all` first rejection par baaki promises ka kya hota hai?
5. 10,000 IDs ke liye bounded concurrency ka limit aap kis number se match karenge, aur usse bhi pehle kya check karenge?
