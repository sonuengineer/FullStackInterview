# Design Patterns Jo Backend Interview Mein Actually Aate Hain

> **Builds on**: [[116-solid-principles-nodejs]] (patterns mostly SOLID lagoo karne ke tareeke hain) aur [[71-parking-lot-lld-review]] (jahan dekha tha ki pattern ka **naam** lena kaam nahi aata).

## 1. Pehle Sach

GoF book mein 23 patterns hain. Backend interview mein practically **6** aate hain - baaki 17 ka naam yaad rakhna time waste hai. Aur isse zyada important: **pattern ka naam bolne ki value zero hai agar aap ye nahi bata sakte ki usne kaunsi problem hataayi.**

Interviewer ka favourite follow-up: *"Theek hai, Strategy. Iske bina kya dikkat hoti?"* Jawab "code clean rehta hai" hai to aap fail ho gaye. Jawab hona chahiye: *"Naya provider add karne ke liye live payment file edit karni padti, jo purane teen providers ko regression risk mein daalta."* Isliye har pattern yahan **"problem jo hat gayi"** ke saath hai.

## 2. Strategy - Ek Kaam, Kai Tareeke

**Problem jo hat gayi**: `if/else` ladder jo har naye variant par edit hota hai.

Jab bhi *"ek hi kaam, algorithm runtime par decide"* ho - payment provider, notification channel, pricing rule, allocation rule - Strategy hai.

```typescript
interface NotificationChannel { send(user: User, body: string): Promise<void>; }

class EmailChannel implements NotificationChannel {
  constructor(private sg: SendGridClient) {}
  async send(u: User, body: string) { await this.sg.send({ to: u.email, html: body }); }
}
class SmsChannel implements NotificationChannel {
  async send(u: User, body: string) { await twilio.messages.create({ to: u.phone, body }); }
}

class Notifier {
  constructor(private channels: Record<string, NotificationChannel>) {}
  async notify(u: User, pref: string, body: string) {
    await this.channels[pref].send(u, body);        // koi if/else nahi
  }
}
```

Node note: TS mein class zaroori nahi - **ek object with one method bhi strategy hai** (dekho [[71-parking-lot-lld-review]] ka `nearestToGate`). Interview mein ye bolna plus point hai: *"JS mein function first-class hai, to strategy aksar ek function hi hota hai."*

**Kab nahi**: do variants, aur dono kabhi badlenge nahi. `if` rakho ([[42-resilience-vs-overengineering]]).

## 3. Factory - Object Banane Ka Decision Ek Jagah

**Problem jo hat gayi**: `new XClient(config.a, config.b)` 14 files mein bikhra, aur config badalne par 14 jagah edit.

Strategy "kaunsa algorithm" decide karta hai; Factory "kaunsa object banega aur kaise". Dono aksar saath aate hain.

```typescript
type Provider = 'razorpay' | 'stripe';

export function createGateway(p: Provider, cfg: Config): PaymentGateway {
  switch (p) {
    case 'razorpay': return new RazorpayGateway(cfg.razorpayKey, cfg.timeoutMs);
    case 'stripe':   return new StripeGateway(cfg.stripeKey, cfg.timeoutMs);
    default: {
      const _never: never = p;         // naya provider bhoole to compile fail
      throw new Error(`unknown provider ${p}`);
    }
  }
}
```

Dhyaan do: **`switch` factory ke andar rehna theek hai** - ek jagah switch hona hi factory ka point hai. Galat baat us switch ko business logic ke beech rakhna thi.

`never` wali line TS ka exhaustiveness check hai: union mein naya provider add kiya aur factory update bhoole to build fail hoga. Ye interview mein bolne layak detail hai.

**Kab nahi**: ek hi type hai aur banane mein ek line lagti hai. `createUser()` jo `new User()` return karta hai, kuch nahi deta.

## 4. Observer - Node Mein Built-In Hai

**Problem jo hat gayi**: `placeOrder()` ko har naye side-effect (mail, analytics, loyalty, warehouse) ke liye edit karna.

Node ka `EventEmitter` iska ready-made implementation hai, isliye ye pattern best demo deta hai.

```typescript
import { EventEmitter } from 'node:events';
export const orderEvents = new EventEmitter();

class OrderService {                                  // publisher apna kaam jaanta hai, bas
  async placeOrder(input: OrderInput) {
    const order = await this.orders.create(toNewOrder(input));
    orderEvents.emit('order.placed', order);          // kaun sun raha hai, isko pata nahi
    return order;
  }
}

// subscribers - alag files, OrderService ko chhue bina add hote hain
orderEvents.on('order.placed', (o) => mailer.send(o.email, 'order-placed', o));
orderEvents.on('order.placed', (o) => analytics.track('order_placed', o));
```

**Production trap - interviewer yahi poochhega.** `EventEmitter` **synchronous** hai: `emit()` saare listeners ko usi call stack mein chalaata hai, to bhaari listener aapki request latency badhaa dega. Listener ka **unhandled rejection** process kill kar sakta hai, isliye har async listener mein `try/catch`. Aur ye **in-process** hai - crash hua to event gaya, na retry na durability; paisa/order ke liye asli queue chahiye ([[86-rest-grpc-kafka-rabbitmq]], [[19-idempotent-consumer-duplicate-events]]).

Interview line: *"EventEmitter decoupling deta hai, delivery guarantee nahi. Guarantee chahiye to pattern wahi rehta hai, transport Kafka/SQS ban jaata hai."*

## 5. Adapter - Third-Party SDK Ko Lapetna

**Problem jo hat gayi**: vendor ka shape poore codebase mein ghus jaana, aur vendor badalne par 40 files badalna.

```typescript
export interface Mailer {                        // mera contract, meri zubaan mein
  send(to: string, template: string, data: object): Promise<void>;
}

export class SendGridMailer implements Mailer {  // SendGrid ki zubaan -> meri zubaan
  constructor(private sg: MailService) {}
  async send(to: string, template: string, data: object) {
    try {
      await this.sg.send({ to, from: 'no-reply@app.com', templateId: template,
                           dynamicTemplateData: data });
    } catch (e: any) {
      // vendor ka error bhi translate karo, warna abstraction leak hai
      throw new MailDeliveryError(e?.response?.body?.errors?.[0]?.message ?? 'send failed');
    }
  }
}
```

Do cheezein jo candidate bhool jaata hai: **error bhi translate karo** (agar caller ko `sg.ResponseError` pakadna pade to adapter adhoora hai), aur **retry/timeout adapter ke andar** rakho, bahar nahi.

Adapter vs Strategy: Strategy mein **aap** multiple implementations chahte ho; Adapter mein ek **begaani** interface ko apni interface se match kara rahe ho. Side-benefit: testing mein usko fake karna aasan ([[116-solid-principles-nodejs]] ka D).

## 6. Decorator - Behaviour Lapetna, Badalna Nahi

**Problem jo hat gayi**: retry/logging/caching ka code har method mein copy-paste hona.

Same interface, andar ek real implementation.

```typescript
class RetryingGateway implements PaymentGateway {
  constructor(private inner: PaymentGateway, private attempts = 3) {}
  readonly id = this.inner.id;

  async charge(order: Order, key: string): Promise<ChargeResult> {
    let lastErr: unknown;
    for (let i = 1; i <= this.attempts; i++) {
      try {
        return await this.inner.charge(order, key);        // same idempotency key - zaroori
      } catch (e) {
        if (!isRetryable(e)) throw e;                      // 4xx ko retry mat karo
        lastErr = e;
        await sleep(100 * 2 ** i + Math.random() * 100);   // backoff + jitter
      }
    }
    throw lastErr;
  }
}

const gateway = new RetryingGateway(new LoggingGateway(new RazorpayGateway(cfg)));
```

Retry **tabhi** safe hai jab idempotency key same ho ([[32-payment-idempotency-double-click]]), aur blind retry outage badhaata hai ([[14-cascading-failure-recovery]]). Ye bolna aapko "pattern bol diya" se "production samajhta hai" mein le jaata hai.

Node mein decorator higher-order function se bhi banta hai: `withRetry(fn)`. Interview mein dono bolo.

## 7. Singleton - Aur Node Mein Ye Already Mojood Hai

**Problem jo hat gayi**: ek shared, mehnga resource (DB pool) ka 50 copies ban jaana.

Baat jo interview mein impress karti hai: **Node mein ek module hi singleton hai.** Module ek hi baar evaluate hota hai aur result cache ho jaata hai.

```typescript
// db.ts - ye already singleton hai, koi pattern code nahi chahiye
import { Pool } from 'pg';
export const pool = new Pool({ max: 10 });
```

To Java-style `getInstance()` Node mein lagbhag kabhi nahi chahiye. (Exception: per-worker scoping - `cluster`/`worker_threads` mein har worker ka apna module instance hota hai, dekho [[109-cluster-worker-threads-child-process-hinglish]].)

**Aur ye tests ko kyun kharab karta hai** - `import { pool } from './db'` seedha service mein likha ho to: (1) test ko asli DB chahiye, ya `jest.mock('./db')` ka jaadu jo path badalne par chup-chaap toot jaata hai; (2) shared mutable state tests ke beech leak karta hai, ek test ne singleton cache mein kuch daala aur doosra random fail hone laga, suite test-order par depend karne lagi; (3) parallel tests ek hi pool par ladte hain.

Fix: singleton rakho, par **inject** karo.

```typescript
export class UserRepository { constructor(private pool: Pool) {} }
// main.ts: new UserRepository(pool)   |   test: new UserRepository(fakePool)
```

Sabse useful line: *"Singleton ek lifecycle decision hai, dependency lookup ka tareeka nahi. Instance ek hi rakho, par usko import mat karo - pass karo."*

## 8. Pattern -> Woh Interview Sawaal Jiska Jawab Hai

| Pattern | Question jiska jawab ye hai | Problem jo hatti hai |
|---|---|---|
| **Strategy** | "Kal 3 naye payment providers aayenge, design kaisa hoga?" | if/else ladder jo har variant par edit hota hai |
| **Factory** | "Config se decide hota hai kaunsa client banega - kahan likhoge?" | `new` ka logic 14 files mein bikhra |
| **Observer** | "Order place hone par mail, analytics, warehouse - sab sync mein?" | publisher ka har naye consumer par badalna |
| **Adapter** | "SendGrid se SES par shift ho to kitni files badlengi?" | vendor ka shape poore codebase mein leak |
| **Decorator** | "Retry aur logging har call par chahiye, duplicate kiye bina" | cross-cutting code ka copy-paste |
| **Singleton** | "DB connection pool kitne banenge aur kahan rakhoge?" | mehnge resource ke multiple copies |

> Pattern ka naam lena **zero marks** hai. Marks us jawab par hain: *"iske bina kaunsi file har baar edit hoti, aur kya toot sakta tha."*

**Common mistakes**: pattern pehle aur requirement baad mein ("Main Strategy, Factory aur Observer use karunga", jab sawaal poora bhi nahi hua); Observer ko queue samajhna (`EventEmitter` mein durability, retry, ordering kuch nahi); Decorator ko inheritance se banana (`class RetryingRazorpay extends RazorpayGateway` matlab retry sirf ek gateway ke liye - composition karo); singleton import karna aur phir test mein rona; aur adapter banakar vendor ka error type bahar leak karna.

## 🧠 Remember

> Backend interview mein 6 patterns kaafi hain - Strategy, Factory, Observer, Adapter, Decorator, Singleton - aur unme naam yaad rakhna sabse kam important hissa hai: asli jawab ye hai ki **pattern ke bina kaunsi file har change par edit hoti thi.**

## Quick Self-Test

1. Node mein `getInstance()` wala singleton kyun lagbhag faaltu hai, aur singleton ka asli dard tests mein kahan dikhta hai?
2. `EventEmitter` se decoupling mil gaya - phir bhi order confirmation mail ke liye queue kyun chahiye?
3. Strategy aur Adapter dono interface + implementation hain. Intent ka farak ek line mein batao.
4. Retry decorator mein idempotency key wahi rakhna kyun zaroori hai?
5. "Factory ka fayda kya?" - "code clean hota hai" ke bina jawab do.
