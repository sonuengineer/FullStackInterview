# CommonJS vs ESM Aur Module Resolution

> **Connects to**: [[109-cluster-worker-threads-child-process-hinglish]] (Node ka runtime model) aur [[02-debugging-random-500-errors]] (jo error startup par aata hai aur stack trace jhooth bolta hai).

## 1. Kahani: `node-fetch` Update Ne Build Toda

Shaam 6 baje ek routine dependency bump. `node-fetch@2` -> `node-fetch@3`. Test pass, deploy, aur production boot hi nahi hua:

```
Error [ERR_REQUIRE_ESM]: require() of ES Module
/app/node_modules/node-fetch/src/index.js from /app/src/http.js not supported.
Instead change the require of index.js to a dynamic import() which is
available in all CommonJS modules.
```

Developer ne Google kiya, Stack Overflow ne kaha `"type": "module"` daal do. Daal diya. Ab:

```
ReferenceError: require is not defined in ES module scope
ReferenceError: __dirname is not defined in ES module scope
```

Ek line ki dependency bump 3 ghante ka migration ban gaya. Ye lesson us 3 ghante ko 10 minute mein badalne ke liye hai.

## 2. Do Module Systems, Ek Runtime

| | CommonJS (CJS) | ES Modules (ESM) |
|---|---|---|
| Syntax | `require` / `module.exports` | `import` / `export` |
| Load time | **runtime**, synchronous | **parse time**, static |
| Load kaise | file padho, wrap karo, chalao | graph banao, phir chalao |
| Order | line par jab pahunche | **hoisted** -- sab imports pehle |
| Dynamic path | `require(varName)` chalega | `import` nahi; `await import(varName)` chalega |
| Top-level await | nahi | **haan** |
| `__dirname` | hai | nahi |
| Cached | haan (singleton) | haan (singleton) |
| File extension | optional (`./util`) | **zaroori** (`./util.js`) |

Dono hi cache karte hain -- ye common misconception hai ki sirf CJS karta hai.

## 3. `require` Synchronous Hai -- Aur Cached

```js
const config = require('./config');   // ye line DISK I/O karti hai, blocking
```

Pehli baar: file padhi, function mein wrap ki, chalai, `module.exports` cache mein daala. Doosri baar: **sirf cache lookup** -- file dobara chalti hi nahi.

Isi cache ki wajah se module **effectively singleton** hai:

```js
// counter.js
let count = 0;
module.exports = { inc: () => ++count, get: () => count };

// a.js -> require('./counter').inc();
// b.js -> require('./counter').inc();
// index.js
require('./a'); require('./b');
console.log(require('./counter').get());   // 2, NOT 1 -- same instance

// isi par DB pool/logger/config bante hain:
// db.js -> module.exports = new Pool({ connectionString: process.env.DATABASE_URL });
```

Ye feature hai, bug nahi. Par do jagah kaat deta hai:
1. **Tests** -- module ki state test ke beech leak hoti hai. Fix: `jest.resetModules()`, ya factory function export karo, instance nahi.
2. **Duplicate copies** -- `node_modules` mein ek hi package ke do versions (nested install) = **do alag singletons**. "Mera `instanceof` check fail kyun ho raha hai" ka 90% yahi hai.

ESM mein bhi exactly yahi behaviour hai -- module **specifier** se cache hota hai.

## 4. `import` Static Aur Hoisted Hai

```js
console.log('start');
import { setup } from './setup.js';    // ye PEHLE chalega
```

Output: pehle `setup.js` ka poora code, phir `'start'`. Kyunki ESM mein engine **chalane se pehle** poora dependency graph parse karta hai -- imports hoist ho jaate hain.

Iska practical natija:

```js
// BUG: process.env load hone se pehle hi module chal gaya
import dotenv from 'dotenv';
dotenv.config();                       // ye line baad mein chalti hai
import { db } from './db.js';          // par db.js PEHLE chal gaya -> env undefined
```

CJS mein ye code sahi kaam karta tha (line order = execution order). ESM mein fix: env ko module graph ke **bahar** load karo -- `node --env-file=.env src/index.js` (Node 20+) ya `node --import ./load-env.js src/index.js`.

Bonus: static hona hi **tree-shaking** possible banata hai -- bundler compile time par dekh sakta hai kya use nahi hua. `require(someVar)` ke saath wo analysis impossible hai.

## 5. `"type": "module"` Kya Flip Karta Hai

package.json mein ek line -- `{ "type": "module" }` -- aur `.js` ka matlab badal jaata hai:

| | `"type"` absent (default `commonjs`) | `"type": "module"` |
|---|---|---|
| `.js` file | CJS | **ESM** |
| `.cjs` | CJS | CJS |
| `.mjs` | ESM | ESM |

To `.cjs`/`.mjs` extension se aap per-file override kar sakte ho. Ye escape hatch migration mein kaam aata hai: poore repo ko `"type": "module"` karo, aur jo ek purani file nahi chal rahi usko `.cjs` kar do.

## 6. Kyun `require()` Se ESM Package Load Nahi Hota

Asli wajah **synchronous vs asynchronous** hai, syntax nahi.

ESM graph resolve karna async hai (loader hooks, network imports, top-level await). `require()` ko ek value **turant, synchronously** return karni hai. Async graph ka wait sync function ke andar possible nahi -- isliye `ERR_REQUIRE_ESM`.

Teen raaste:

```js
// 1. Dynamic import() -- CJS ke andar chalta hai, par function async ban jaata hai
async function getFetch() {
  const { default: fetch } = await import('node-fetch');
  return fetch;
}

// 2. Problem hi hata do -- Node 18+ mein global fetch hai, dependency ki zaroorat nahi
const res = await fetch(url);

// 3. Package ke CJS version par ruk jao -- "node-fetch": "^2.7.0"
```

**Naya (Node 22.12+ / 20.19+)**: `require(esm)` **ab kaam karta hai** -- par sirf tab jab ESM module mein **top-level await na ho**. TLA hai to wahi purana error. To ab bhi aap isko sirf tab assume kar sakte ho jab aapka minimum Node version pata ho.

Ulta case bilkul theek hai: **ESM se CJS import kar sakte ho.**

```js
import express from 'express';         // express CJS hai, chalta hai
import pkg from './legacy.cjs';
const { helper } = pkg;                // CJS se named imports reliably nahi milte
```

Node CJS ke named exports static analysis se guess karta hai aur aksar fail ho jaata hai. Safe pattern: default import karo, phir destructure.

## 7. Top-Level Await Aur `__dirname`

```js
// ESM: top level par await -- CJS mein ye SyntaxError hai
const config = await loadConfigFromVault();
export const db = createPool(config);
```

Useful hai (startup par secrets, migrations), par catch: aapka module ab tab tak **block** karta hai jab tak TLA resolve na ho -- aur usko import karne wala har module bhi. Vault timeout hua to app boot hi nahi hoga, aur error bahut generic aayega.

ESM mein ye CJS globals **exist nahi karte**: `require`, `module`, `exports`, `__dirname`, `__filename`.

```js
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const here = import.meta.dirname;      // Node 20.11+ -- seedha replacement
const file = import.meta.filename;

// CJS ka `require.main === module` check:
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
```

## 8. Dual-Package Hazard (Short Mein)

Ek library dono formats ship karti hai:

```json
{
  "exports": {
    ".": { "import": "./dist/index.mjs", "require": "./dist/index.cjs" }
  }
}
```

Agar app mein ek jagah `import 'lib'` hai aur doosri jagah `require('lib')`, to **dono copies load** hongi -- do alag instances, do alag module-level states. Dikhta aise hai: `instanceof MyError` false aata hai (do alag class objects), library ka internal registry/singleton aadha-aadha bhar jaata hai, aur `Symbol` identity match nahi karti.

Bachne ka tareeka: **ek app mein ek format par raho** -- ya CJS, ya ESM, mix nahi.

## 9. Resolution Order -- Node Module Dhoondta Kaise Hai

`require('lodash')` ya `import 'lodash'` par:

```
1. Node builtin? ('fs', 'node:fs', 'http') -> turant wahi, disk touch nahi
2. './' ya '../' se start? -> relative path, exact file
   (CJS: extension optional -> .js, .json, .node try karta hai
    ESM: extension ZAROORI, warna ERR_MODULE_NOT_FOUND)
3. Warna bare specifier -> node_modules walk UP:
     /app/src/services/node_modules/lodash
     /app/src/node_modules/lodash
     /app/node_modules/lodash         <- aksar yahan milta hai
     /node_modules/lodash
4. Mil gaya -> package.json ka "exports" (modern) ya "main"/"module" dekho
5. Nahi mila -> MODULE_NOT_FOUND
```

Do practical cheezein:
- **Builtin ko `node:` prefix se likho** (`require('node:fs')`). Ye guarantee deta hai ki koi `fs` naam ka npm package hijack na kar le.
- `"exports"` field **encapsulation** deta hai -- jo path listed nahi hai, use import nahi kar sakte. Isliye `require('some-lib/lib/internal/helper')` purane versions mein chalta tha aur upgrade par `ERR_PACKAGE_PATH_NOT_EXPORTED` de deta hai.

## 10. Circular Dependency -- Woh `undefined is not a function`

```js
// user.service.js
const orderService = require('./order.service');
exports.getUser = (id) => ({ id, orders: orderService.listByUser(id) });

// order.service.js
const userService = require('./user.service');
exports.listByUser = (uid) => { userService.getUser(uid); return []; };
```

Startup par:

```
TypeError: userService.getUser is not a function
```

Kyun? CJS cache **module chalne se pehle** entry daalta hai (warna infinite loop):

```
1. index.js -> require('./user.service')
2. user.service cache mein daala: exports = {}   (KHAALI)
3. user.service line 1 -> require('./order.service')
4. order.service cache mein daala, uski line 1 -> require('./user.service')
5. cache mein HAI -> wahi KHAALI {} milta hai -- ADHOORA object
6. order.service ne us adhoore {} ka reference rakh liya
7. order.service poora hua, phir user.service ne getUser add kiya -- bahut late
```

Debug mushkil kyun: error **jo module galat hai usme nahi** aata, usme aata hai jo use call karta hai -- aur sirf **ek** import direction par; files ka order badal do to error gayab.

ESM mein behaviour better hai -- bindings **live** hote hain (hoisted `function` declarations circular case mein bhi mil jaate hain) -- par `const`/`class` par `ReferenceError: Cannot access 'X' before initialization` milega. Dono case mein asli fix **design** hai:

```js
// Fix 1: lazy require -- call ke waqt resolve, tab tak module bhara hua hai
exports.getUser = (id) => {
  const orderService = require('./order.service');
  return { id, orders: orderService.listByUser(id) };
};

// Fix 2 (behtar): cycle hi tod do -- shared logic teesre module mein,
// ya dependency injection: function makeOrderService({ userRepo }) { ... }
```

Cycle dhoondhne ke liye: `npx madge --circular src/`.

## 11. Decision Table

| Situation | Choose | Kyun |
|---|---|---|
| **Naya service** (Node 20+) | **ESM** (`"type": "module"`) | ecosystem idhar ja raha hai, TLA milta hai, `import.meta.dirname` ab hai, naye packages ESM-only ship ho rahe hain |
| **Library jo aap publish karte ho** | TS likho, **dono** ship karo (`"exports"` map), ya sirf ESM agar Node 20+ target hai | consumers dono tarah ke hain; par dual-package hazard ke liye state-less rakho |
| **Existing bada CJS codebase** | **CJS par raho** | migration ka ROI kam hai; ESM-only dependency aaye to usi jagah `await import()` -- poore repo ko chhedna nahi |
| **TypeScript project** | `module: "nodenext"` + jo target chuna | TS ka output `"type"` se match hona zaroori hai, warna runtime par mismatch |
| **CLI tool, scripts** | ESM theek hai | TLA se code saaf hota hai |

Important honesty: **CJS "dead" nahi hai.** npm ka bahut bada hissa aaj bhi CJS hai aur Node use kabhi nahi hatayega. Migration tabhi karo jab koi concrete cheez block kar rahi ho -- bas trend ke liye nahi.

## 12. Common Galtiyan

- `ERR_REQUIRE_ESM` par aankh band kar ke `"type": "module"` daal dena -> aur 10 naye errors.
- ESM mein `import './util'` likhna (extension ke bina) -> `ERR_MODULE_NOT_FOUND`.
- ESM mein `dotenv.config()` import ke baad likhna aur expect karna ki env load ho gaya.
- TS mein `module: "commonjs"` par package.json mein `"type": "module"` -- compile pass, runtime fail.
- Module-level mutable state ko shared cache ki tarah use karna, aur cluster/multiple pods par confuse hona ki sync kyun nahi ho raha ([[109-cluster-worker-threads-child-process-hinglish]]).
- Circular dependency ko `try/catch` se chhupana, design theek karne ke bajay.

## 🧠 Remember

> `require` synchronous aur cached hai -- isliye module ek singleton hai aur isliye wo async ESM graph ko load nahi kar sakta; `import` static aur hoisted hai -- isliye tree-shaking aur top-level await milte hain par `dotenv.config()` apni jagah par nahi chalta; aur circular `require` ka `undefined is not a function` isliye aata hai ki cache mein module **chalne se pehle** aadha-khaali daal diya jaata hai.

## Quick Self-Test

1. Do alag files se `require('./counter')` karne par counter 1 dikhega ya 2 -- aur kyun?
2. `require()` ESM package ko load nahi kar sakta -- asli technical wajah syntax hai ya kuch aur?
3. ESM mein `dotenv.config()` ke baad bhi `process.env` khaali kyun milta hai?
4. `__dirname` ESM mein kaise banate ho, aur Node 20.11+ mein shortcut kya hai?
5. Circular require mein error us module mein kyun nahi aata jisme cycle shuru hui?
6. Ek hi library ke CJS aur ESM dono copies load ho gayi -- symptom kya dikhega?
