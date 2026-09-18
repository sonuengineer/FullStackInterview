# Blog: The Modular Monolith - 90% of the Microservices Benefits, 0% of the Network Latency

*A single backend codebase with strict, decoupled module boundaries gives you most of the organizational clean-code benefits of microservices, without the distributed-systems tax. Here's what that means in plain terms.*

---

## Why People Reach for Microservices

Usually not for scale. Usually because the codebase became a **big ball of mud**:
- Everything imports everything.
- Changing billing breaks notifications.
- Nobody knows who owns what.
- Every change needs the whole team.

Microservices **force** boundaries: another team's code is behind a network call, so you *can't* reach into it. That's the real benefit - **boundaries** - and you can get it **without the network**.

## What a Modular Monolith Is

One deployable app, split into **modules with hard walls**:

```
src/
  modules/
    orders/
      index.js          <- the PUBLIC API of the module (the only thing others may import)
      service.js
      repository.js     <- only this module touches the orders tables
      events.js
    billing/
      index.js
      ...
    notifications/
      index.js
      ...
  shared/               <- tiny: logger, config, db connection
```

The rules:
1. **Other modules may only import `modules/<name>/index.js`** - never its internal files.
2. **Each module owns its tables.** Billing doesn't `SELECT` from the orders tables; it asks the orders module.
3. **Modules talk through function calls or in-process events**, not by sharing internals.

```javascript
// modules/orders/index.js - the module's public contract
const service = require('./service');
module.exports = {
  placeOrder: service.placeOrder,
  getOrderSummary: service.getOrderSummary,   // returns plain data, not DB models
};

// modules/billing/service.js
const orders = require('../orders');          // allowed: the public API only
// const repo = require('../orders/repository'); // NOT allowed - breaks the boundary
```

**Enforce it with tools, not hope:** ESLint `no-restricted-imports` or `dependency-cruiser` in CI fails the build when someone imports another module's internals.

## What You Get vs Microservices

| Benefit | Microservices | Modular monolith |
|---|---|---|
| Clear ownership and boundaries | ✅ | ✅ (enforced by lint rules) |
| Change one area without breaking others | ✅ | ✅ |
| Function calls instead of network calls | ❌ (ms of latency, can fail) | ✅ (nanoseconds, can't time out) |
| Database transactions across modules | ❌ (sagas, eventual consistency) | ✅ (one DB transaction when you really need it) |
| One deploy, one CI pipeline, simple debugging | ❌ | ✅ |
| Independent scaling of one part | ✅ | ❌ (you scale the whole app) |
| Independent deploys per team | ✅ | ❌ |
| Different languages per service | ✅ | ❌ |

## The Honest "90%"

It gives you the **organizational** benefits. It does **not** give you:
- **independent scaling** (one module needs 50 servers, the rest need 2)
- **fault isolation** (a memory leak in one module crashes the whole process)
- **independent deploys** for many teams shipping all day

When one of those becomes a real, measured problem, a clean module is **easy to extract** into a service - its boundary and public API already exist. That's the path: **start modular, extract when a module earns it** ([[77-blog-microservices-are-a-tax]]).

## Signs Your Monolith Is NOT Modular (Yet)

- A change in one feature regularly breaks another.
- Modules query each other's tables directly.
- There's a `utils/` or `common/` folder that everything depends on and nobody owns.
- You can't answer "which module owns this table?"

## 🧠 Remember

> Most teams want microservices for the boundaries, not the network. A modular monolith gives you enforced boundaries, one deploy and in-process calls - and when a module truly needs to scale or deploy alone, it's already shaped to be extracted.

## Self-Test

1. What are the three rules that make a monolith "modular"?
2. Which microservice benefits does a modular monolith NOT give you?
3. How do you stop engineers from breaking the boundaries?

Related: [[77-blog-microservices-are-a-tax]], [[24-kubernetes-pets-vs-cattle]], [[15-simple-vs-scalable-architecture]]
