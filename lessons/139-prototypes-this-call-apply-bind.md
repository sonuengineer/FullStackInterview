# Prototypes, this, Aur call/apply/bind

> **Connects to**: [[138-closures-and-scope-real-bugs]] (scope lexical hai, par `this` nahi -- yahi confusion ki jad hai) aur [[116-solid-principles-nodejs]] (class, inheritance, composition).

## 1. Kahani: Service Class Jo Express Mein Phat Gayi

Ek payment service, clean OOP style:

```javascript
class PaymentService {
  constructor(gateway) { this.gateway = gateway; }

  async charge(req, res) {
    const result = await this.gateway.charge(req.body);   // <- yahan crash
    res.json(result);
  }
}

const service = new PaymentService(stripe);
app.post('/charge', service.charge);     // dikhne mein bilkul theek
```

Production log:

```
TypeError: Cannot read properties of undefined (reading 'charge')
```

Class, constructor, gateway -- sab theek hai. Fir bhi `this.gateway` `undefined` hai. Kyunki Express ne method ko **object se alag karke** call kiya. JS mein `this` function ke saath attach nahi hota, **call ke tareeke** se decide hota hai.

## 2. Char Binding Rules, Priority Order Mein

Jab bhi `this` ka sawaal aaye, upar se neeche check karo. **Pehla jo match kare, wahi jeetega.**

**Rule 1 -- `new` binding (sabse strong)**

```javascript
function User(name) { this.name = name; }
const u = new User('Sonu');    // this = naya khaali object
u.name;                        // 'Sonu'
```

**Rule 2 -- Explicit binding (`call` / `apply` / `bind`)**

```javascript
function greet(greeting, mark) { return `${greeting}, ${this.name}${mark}`; }
const user = { name: 'Sonu' };

greet.call(user, 'Hi', '!');        // args alag-alag
greet.apply(user, ['Hi', '!']);     // args ek Array mein  (A = Array)
const bound = greet.bind(user);     // naya function, this permanently fix
bound('Hi', '!');
```

`call` vs `apply` ka farak sirf args ka shape hai. `bind` turant call nahi karta -- **naya function** return karta hai.

**Rule 3 -- Implicit binding (dot ke left wala object)**

```javascript
const order = { id: 7, describe() { return `order ${this.id}`; } };
order.describe();                   // 'order 7' -- this = order
```

Sirf **call site** ka dot matter karta hai, declaration ki jagah nahi.

**Rule 4 -- Default binding (kuch nahi mila)**

```javascript
'use strict';
function show() { return this; }
show();            // undefined  (strict mode / ES module / class body)
// non-strict CommonJS script mein: globalThis
```

Modern code mein (ESM, TypeScript, class bodies -- sab strict) default binding `undefined` hai. Isi liye upar wali error `Cannot read properties of undefined` thi, na ki chup-chaap global par kuch likh dena.

## 3. Woh Bug Jo Sabke Saath Hota Hai: Method Nikal Lena

Method ko reference ki tarah pass karte hi Rule 3 toot jaata hai aur Rule 4 lag jaata hai:

```javascript
class Counter {
  constructor() { this.n = 0; }
  inc() { this.n++; return this.n; }
}
const c = new Counter();

c.inc();                 // 1 -- theek (dot hai)

const fn = c.inc;        // sirf function nikala, object chhoda
fn();                    // TypeError: Cannot read properties of undefined

setTimeout(c.inc, 100);  // wahi problem -- setTimeout bina dot call karega
emitter.on('tick', c.inc);   // aur yahan EventEmitter `this` ko emitter bana deta hai!
```

`EventEmitter` wala case extra gandha hai: wo listener ko emitter ke context mein call karta hai, to `this.n` crash nahi karta -- wo **chup-chaap emitter par** `n` bana deta hai. Code chalta hai, counter kabhi nahi badhta. Silent bug, jo crash se bura hai.

### Teen Fix, Teen Trade-off

```javascript
// Fix 1: constructor mein bind -- har instance apna bound copy
class A {
  constructor() { this.inc = this.inc.bind(this); }
  inc() { /* ... */ }
}
// + prototype par method rehta hai, subclass override kar sakta hai
// - per-instance ek extra function object

// Fix 2: arrow property -- sabse common React/handler style
class B {
  n = 0;
  inc = () => { this.n++; };      // arrow ka this = banne ke waqt ka instance
}
// + pass karne par kabhi nahi tootega
// - prototype par nahi, INSTANCE par hai: super.inc() nahi, spy/mock karna mushkil

// Fix 3: wrapper lambda call site par
app.post('/charge', (req, res) => service.charge(req, res));
// + class saaf rehti hai, dot wapas aa jaata hai
// - har call site par yaad rakhna padta hai
```

Mera default: **library/class code mein Fix 1 ya 3**, aur UI-style event handlers mein Fix 2. Express routes ke liye Fix 3 sabse readable hai.

## 4. Arrow Functions: `this` Hi Nahi Hota

Arrow function apna `this` **banata hi nahi**. Wo lexically bahar wale scope se uthata hai -- bilkul normal variable ki tarah ([[138-closures-and-scope-real-bugs]]). Isi se do rules nikalte hain:

**Callbacks ke liye arrow sahi hai:**

```javascript
class Poller {
  constructor() { this.hits = 0; }
  start() {
    setInterval(() => { this.hits++; }, 1000);   // this = Poller instance
    // setInterval(function () { this.hits++; }, 1000) -- yahan this undefined/Timeout
  }
}
```

**Object methods ke liye arrow galat hai:**

```javascript
const bad = {
  id: 7,
  describe: () => `order ${this.id}`,   // this = module scope, NOT bad
};
bad.describe();      // 'order undefined'
```

Aur `obj.method.call(x)` ya `.bind(x)` arrow par **kaam hi nahi karta** -- bind karne ke liye apna `this` hona chahiye, arrow ke paas hai hi nahi. Isliye prototype methods arrow se kabhi mat likho.

## 5. "Yahan this Kya Hai" -- Ek Table

| Call | `this` | Rule |
|---|---|---|
| `new Foo()` | naya object | new |
| `fn.call(o)` / `fn.apply(o)` / `fn.bind(o)()` | `o` | explicit |
| `obj.fn()` | `obj` | implicit |
| `const f = obj.fn; f()` | `undefined` (strict) / global | default |
| `setTimeout(obj.fn)` | `Timeout` object | default-ish, dot kho gaya |
| `emitter.on('x', obj.fn)` | emitter | emitter khud call karta hai |
| `arr.map(obj.fn)` | `undefined` | dot kho gaya |
| `arr.map(obj.fn, obj)` | `obj` | `map` ka 2nd arg thisArg |
| arrow, kahin se bhi | jahan likha gaya wahan ka `this` | arrow ka apna nahi hota |
| class method, strict | call site par depend | class body strict hai |

Interview line: *"`this` function ki property nahi, call site ki property hai. Main char rules priority mein check karta hoon: new, explicit, implicit, default."*

## 6. Prototypes: `class` Actually Kya Hai

`class` JavaScript mein **syntax sugar** hai. Andar ab bhi prototypes hi hain.

```javascript
class Animal {
  constructor(name) { this.name = name; }
  speak() { return `${this.name} makes a sound`; }
}

// lagbhag barabar:
function Animal2(name) { this.name = name; }
Animal2.prototype.speak = function () { return `${this.name} makes a sound`; };
```

Ek important baat: `speak` **har object mein copy nahi** hota. Wo ek hi baar `Animal.prototype` par rehta hai, aur saare instances usi ko share karte hain -- isliye 1 lakh objects banane par memory nahi phatti.

**Lookup chain:**

```
dog.speak()
  -> dog ke own properties mein hai?            nahi
  -> Object.getPrototypeOf(dog) = Dog.prototype?  nahi
  -> Animal.prototype?                          mil gaya -> call, this = dog
  -> Object.prototype?                          (warna yahan tak jaata)
  -> null -> undefined
```

```javascript
class Dog extends Animal {
  speak() { return `${super.speak()} -- woof`; }   // super = Animal.prototype
}
const d = new Dog('Bruno');
Object.getPrototypeOf(d) === Dog.prototype;              // true
Object.getPrototypeOf(Dog.prototype) === Animal.prototype; // true
d.hasOwnProperty('speak');                                // false -- prototype par hai
d.hasOwnProperty('name');                                 // true  -- own property
```

Class aur `function` constructor mein do asli farak: class body **hamesha strict mode** hai, aur class methods **non-enumerable** hain (`for...in` mein nahi aayenge).

## 7. `Array.prototype` Mein Mat Chhedo

```javascript
// kabhi mat karo
Array.prototype.last = function () { return this[this.length - 1]; };

for (const key in [10, 20]) console.log(key);   // '0', '1', 'last'  <- aa gaya
```

Kyun bura hai:
- Built-in prototype par likhi property **enumerable** hoti hai, to `for...in` aur purane library loops usme ghus jaate hain.
- Aapka `last` kal ECMAScript mein aa gaya (jaise `at()` aaya) to aap spec ke behaviour ko overwrite kar rahe honge -- aur **saari** dependencies aapka version dekhengi.
- Debug karna narak hai: bug kisi third-party package mein dikhega, aapke code mein nahi.

Safe alternative: plain helper (`const last = (a) => a.at(-1)`) ya apni subclass. Modern TS/JS mein utility function hi right answer hai.

## 8. Common Galtiyan

- `this` ko closure samajhna. Scope lexical hai, `this` **dynamic** hai -- do alag mechanism.
- `bind` ko mutating samajhna. `fn.bind(o)` original ko nahi badalta, **naya** function deta hai; `fn.bind(a).bind(b)` mein `a` hi jeetega.
- `new (fn.bind(o))()` -- `new` jeet jaata hai, bound `this` ignore ho jaata hai (Rule 1 > Rule 2).
- Prototype methods arrow se likhna -- `super` aur `bind` dono mar jaate hain.
- Render/hot path mein har baar `.bind()` call karna -- naya function object banta hai; constructor mein ek baar bind karo.

## 🧠 Remember

> `this` function ke saath nahi, **call site** ke saath aata hai -- priority: new > call/apply/bind > object ke dot > default (strict mein `undefined`). Arrow ka apna `this` hota hi nahi, aur `class` sirf prototype chain ka sundar naam hai.

## Quick Self-Test

1. `app.post('/x', service.charge)` crash karta hai par `service.charge(req, res)` chalta hai -- exactly kaunsa rule toota?
2. `emitter.on('tick', c.inc)` crash kyun nahi karta, aur ye crash hone se bura kyun hai?
3. Constructor-bind aur arrow-property fix mein testing/inheritance ke hisaab se kya trade-off hai?
4. `new (greet.bind(user))()` mein `this` kaun hoga aur kyun?
5. `d.hasOwnProperty('speak')` `false` kyun hai jabki `d.speak()` chalta hai?
