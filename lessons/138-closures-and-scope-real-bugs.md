# Closures Aur Scope: Woh Bugs Jo Production Mein Aate Hain

> **Connects to**: [[22-nodejs-memory-leak-debugging]] (closure ek retainer hai), [[137-event-loop-phases-and-microtasks]] (callback baad mein chalta hai, isliye scope ka sawaal paida hota hai) aur [[16-synchronized-connection-pool-expiry]] (loop mein banaye gaye timers).

## 1. Bug Pehle, Theory Baad Mein

Ek retry utility. Teen attempts, badhte delay ke saath, aur log mein attempt number. Code 100% logical lagta hai:

```javascript
for (var i = 1; i <= 3; i++) {
  setTimeout(() => console.log('attempt', i), i * 100);
}
```

Expected: `attempt 1`, `attempt 2`, `attempt 3`.

Actual:

```
attempt 4
attempt 4
attempt 4
```

Teen alag logs, teeno mein `4`. Ab socho ye `i` attempt number nahi, **array index** hota (`items[i]`) -- teeno callbacks ek hi (ya `undefined`) item process karte, aur production mein ye silently galat data likh deta.

## 2. Hua Kya

`var` ka scope **function** hai, block nahi. Poore loop mein `i` ka **ek hi** binding bana. Teeno arrow functions ne value copy nahi ki -- unhone us **ek variable ka reference** pakda. Callbacks tab chale jab loop khatam ho chuka tha aur `i` already `4` ho gaya tha (isi 4 ne loop todha).

Timing ka point zaroori hai: callback event loop ke timers phase mein chalta hai, yaani sync loop ke **baad** ([[137-event-loop-phases-and-microtasks]]). Isliye wo "current" value dekhta hai, "us waqt ki" value nahi.

`let` ise theek karta hai:

```javascript
for (let i = 1; i <= 3; i++) {
  setTimeout(() => console.log('attempt', i), i * 100);
}
// attempt 1, attempt 2, attempt 3
```

Kyun? `let` loop mein JS **har iteration ke liye naya binding** banata hai. Teen callbacks, teen alag `i`. Ye ES6 ka specific rule hai -- magic nahi, spec mein likha hai.

Pre-ES6 fix (interview mein poochha jaata hai) -- IIFE se apna scope banao:

```javascript
for (var i = 1; i <= 3; i++) {
  (function (n) {                 // n = us iteration ki copy
    setTimeout(() => console.log('attempt', n), n * 100);
  })(i);
}
```

## 3. Woh Definition Jo Yaad Reh Jaati Hai

**Term: Closure** -- ek function apne saath wo scope leke chalta hai **jahan use banaya gaya tha**, us scope ka nahi jahan se use **call kiya jaata hai**.

Yahi ek line poora topic hai. Lexical (likhne ki jagah) scope matter karta hai, dynamic (chalane ki jagah) nahi.

```javascript
const secret = 'outer';
function make() {
  const secret = 'inner';
  return () => secret;            // banne ki jagah se uthayega
}
const fn = make();
fn();                              // 'inner' -- hamesha, kahin se bhi call karo
```

Mental model:

> Closure ek function + uska **backpack** hai. Backpack usi kamre mein pack hota hai jahan function paida hua. Function kahin bhi jaaye, backpack saath jaata hai -- aur jo cheez backpack mein hai wo garbage collect nahi hogi.

Ye last line hi aage ka memory bug hai.

## 4. Char Jagah Jahan Closure Aap Roz Use Karte Hain

**(a) Module-scoped counter / cache -- private state bina class ke**

```javascript
function createIdGenerator(prefix) {
  let n = 0;                            // bahar se touch nahi kar sakte
  return () => `${prefix}-${++n}`;
}
const nextOrderId = createIdGenerator('ORD');
nextOrderId();   // ORD-1
nextOrderId();   // ORD-2
```

`n` par koi bahar se `= 500` nahi kar sakta. Ye asli encapsulation hai, `#private` fields se pehle isi se kaam chalta tha.

**(b) `once()` wrapper -- idempotent cleanup**

```javascript
function once(fn) {
  let called = false, result;
  return (...args) => {
    if (called) return result;
    called = true;
    return (result = fn(...args));
  };
}

const shutdown = once(async () => {
  await server.close();
  await pool.end();
});
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);     // dono aa jaayein to bhi pool ek hi baar band
```

`called` kahin store nahi kiya -- closure mein hai.

**(c) Per-request context -- middleware mein capture**

```javascript
app.use((req, res, next) => {
  const requestId = req.headers['x-request-id'] ?? crypto.randomUUID();
  // ye logger requestId ko capture karta hai -- aage har call mein wahi id
  req.log = (msg, extra = {}) =>
    console.log(JSON.stringify({ requestId, route: req.path, msg, ...extra }));
  next();
});

// handler mein
req.log('charging card', { amount });   // requestId automatically andar hai
```

Correlated logs isi pattern par bante hain ([[02-debugging-random-500-errors]] ka base).

**(d) Factory -- configured functions**

```javascript
const withRetry = (attempts, baseMs) => async (task) => {
  for (let i = 0; i < attempts; i++) {
    try { return await task(); }
    catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise(r => setTimeout(r, baseMs * 2 ** i));   // i capture hua
    }
  }
};

const retryFast = withRetry(3, 50);     // ek hi logic, do config
const retrySlow = withRetry(5, 500);
```

Dono functions **alag** closures hain, alag `attempts` aur `baseMs` ke saath.

## 5. Production Cost Jo Koi Nahi Batata

Interview articles closure ko "powerful" bata ke rok jaate hain. Production ka sach:

> Ek closure apne **poore enclosing scope** ka context zinda rakhta hai, sirf us variable ka nahi jo use chahiye.

Ek scope ke saare inner functions **ek hi context object** share karte hain. Agar unme se **koi ek** bade object ko reference karta hai, to us scope se bana koi bhi long-lived closure us bade object ko bhi zinda rakhta hai.

```javascript
const handlers = [];                    // long-lived -- yahi leak ka anchor hai

function register(req) {
  const body = req.body;                // maan lo 10 MB payload
  const audit = () => body.length;      // sibling closure: body ko reference karta hai
  handlers.push(() => 'ok');            // chhota lagta hai, par wahi context share karta hai
  return audit;
}

// simulate
for (let i = 0; i < 200; i++) register({ body: Buffer.alloc(10 * 1024 * 1024) });
global.gc?.();
console.log((process.memoryUsage().heapUsed / 1e6).toFixed(0), 'MB heapUsed');
// node --expose-gc se chalao: heap chadha rahega, kyunki 200 buffers reachable hain
```

Fix seedha hai -- **capture sirf wo karo jo chahiye**:

```javascript
function register(req) {
  const size = req.body.length;         // number nikal lo, buffer chhod do
  const audit = () => size;
  handlers.push(() => 'ok');
  return audit;
}
```

[[22-nodejs-memory-leak-debugging]] mein jo "retainer chain" dekhte hain, heap snapshot mein ye leak `(closure)` / `system / Context` naam se dikhta hai. Isi liye wahan ka rule tha: leak dhoondho **retainers** se, code padh ke nahi.

Jahan bada data `await` ke aage bhi nahi chahiye, wahan explicitly `body = null` kar dena bilkul valid hai -- hack nahi, intent hai.

## 6. "Output Kya Hoga" -- Teen Snippets

| Snippet | Output | Kyun |
|---|---|---|
| `for (var i=0;i<3;i++) setTimeout(()=>console.log(i))` | `3 3 3` | Ek shared `var` binding, callbacks loop ke baad chale |
| `for (let i=0;i<3;i++) setTimeout(()=>console.log(i))` | `0 1 2` | Per-iteration binding |
| `const fns=[]; for (var i=0;i<3;i++) fns.push(()=>i); fns.map(f=>f())` | `[3,3,3]` | Sync call bhi bachata nahi -- loop pehle hi khatam ho chuka |

Bonus jo log galat karte hain:

```javascript
console.log(x);   // undefined  -- var hoisted, value nahi
var x = 1;

console.log(y);   // ReferenceError: Cannot access 'y' before initialization
let y = 1;        // TDZ (Temporal Dead Zone)
```

**Term: TDZ** -- `let`/`const` hoist hote hain par declaration line tak "uninitialized" rehte hain, isliye `undefined` ke bajaye error milta hai. Ye feature hai: galti jaldi pakad lo.

## 7. Common Galtiyan

- Loop mein `var` ke saath async callback register karna -- 2026 mein bhi legacy code aur `forEach` ke bina likhe loops mein milta hai.
- Closure ko "value copy" samajhna -- wo **reference** rakhta hai, snapshot nahi.
- Request-scoped bada data (body, buffer, DB rows) long-lived callback/cache/emitter mein capture karna.
- `this` ko closure samajhna -- `this` closure se **nahi** aata, wo call-time par decide hota hai ([[139-prototypes-this-call-apply-bind]]).

## 🧠 Remember

> Closure ka matlab: function apne saath wo scope leke chalta hai jahan wo **banaya** gaya tha, jahan se **call** hua wahan ka nahi -- aur wo poora scope zinda rehta hai, isliye closure jitni power deta hai utna hi memory ka bill bhi bana sakta hai.

## Quick Self-Test

1. `var` wale loop ko `let` theek kar deta hai -- exactly kya badal jaata hai, bina "block scope" shabd use kiye?
2. Aapka `once()` wrapper `called` flag kahan store karta hai? Us flag ko bahar se kaise padha ja sakta hai?
3. Ek closure jo sirf `body.length` chahta hai, 10 MB buffer kaise zinda rakh sakta hai -- aur ise heap snapshot mein kis naam se dhoondhenge?
4. `console.log(x); var x = 1;` aur `console.log(y); let y = 1;` ka output alag kyun hai?
