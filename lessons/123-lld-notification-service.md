# LLD: Notification Service Class Design

> **Scope note:** ye **class-level design** hai -- interfaces, classes, responsibilities. **Distributed system design NAHI.** Queues, fan-out to millions, delivery tracking, per-provider rate limits -- wo System Design tab ke **Notification / Paging** walkthrough mein hai, short version [[17-notification-system-design]] mein, aur bulk fan-out ki speed [[54-notify-5000-users-10x-faster]] mein. Interview mein pehla sawaal yahi poochho: *"class design chahiye ya distributed architecture?"* -- dono ke jawab bilkul alag hain.

## 1. Kahani: Ek `sendEmail()` Se Shuru Hua Tha

Din 1 par code: `await sendgrid.send({ to: user.email, subject, html })`.

Din 200 par wahi file: email, SMS (Twilio), push (FCM), Slack webhook -- aur beech mein 14 `if (channel === 'sms')` branches, har provider ka apna retry, apna error shape. WhatsApp add karne ke liye 600-line file kholni padti hai. Test chalao to **asli Twilio** par SMS chala jaata hai.

LLD ka asli sawaal yahi hai: **variation kahan hai, aur usse kaise isolate karein?**

## 2. Variation Kahan Hai?

| Cheez | Badalti hai? | Design ka jawab |
|---|---|---|
| Channel (email/SMS/push/Slack/WhatsApp) | Haan, naye aate rehte hain | **Strategy**: ek interface, kai implementations |
| Kis user ko kaunsa channel | Haan, per-user preferences | **Registry + preference resolver** |
| Retry policy | Kabhi-kabhi | Ek jagah: `Notifier` |
| Provider down hona | Haan, hamesha | **Decorator**: circuit breaker wrapper |
| Message ka text | Bahut | **Template store**, channel ke bahar |

Jo badalta hai usko interface ke peeche daalo, jo nahi badalta usko ek jagah rakho. Bas, yahi poora design hai.

## 3. Core Interface

```ts
export type Channel = 'EMAIL' | 'SMS' | 'PUSH' | 'SLACK';

export interface NotificationRequest {
  readonly idempotencyKey: string;         // caller deta hai -- Section 6
  readonly userId: string;
  readonly templateId: string;             // 'order.shipped', raw text nahi
  readonly data: Record<string, unknown>;  // template variables
}

export interface RenderedMessage {
  readonly title?: string;
  readonly body: string;
  readonly to: string;                     // email / phone / device token / webhook url
}

export interface NotificationChannel {
  readonly name: Channel;
  /** Fail par throw. Retry ho sakta ho to `retryable: true`. */
  send(msg: RenderedMessage): Promise<{ providerMessageId?: string }>;
}

export class ChannelError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}
```

`send()` ko `userId` nahi milta -- sirf **rendered message**. Channel ka kaam "bhejna" hai, "decide karna" nahi.

```ts
export class SmsChannel implements NotificationChannel {
  readonly name = 'SMS' as const;
  constructor(private readonly twilio: TwilioLike, private readonly from: string) {}

  async send(msg: RenderedMessage) {
    try {
      const res = await this.twilio.messages.create({ to: msg.to, from: this.from, body: msg.body });
      return { providerMessageId: res.sid };
    } catch (err: any) {
      // 4xx = hamara data galat, retry bekaar. 5xx / network = retry karo.
      const retryable = !err.status || err.status >= 500 || err.code === 'ETIMEDOUT';
      throw new ChannelError(`twilio: ${err.message}`, retryable);
    }
  }
}
```

Provider SDK **constructor mein inject** hua hai -- isi ek line se class testable ban gayi (Section 8).

## 4. Registry + Preferences

```ts
export class ChannelRegistry {
  private readonly channels = new Map<Channel, NotificationChannel>();
  register(ch: NotificationChannel) { this.channels.set(ch.name, ch); return this; }
  get(name: Channel) {
    const ch = this.channels.get(name);
    if (!ch) throw new Error(`channel not registered: ${name}`);
    return ch;
  }
}

export class PreferenceResolver {              // opt-out, quiet hours, per-template list
  constructor(private readonly prefs: PreferenceRepo) {}
  async channelsFor(userId: string, templateId: string): Promise<Channel[]> {
    const p = await this.prefs.find(userId);
    if (p.globalOptOut) return [];
    return (p.perTemplate[templateId] ?? p.default).filter((c) => !p.mutedChannels.includes(c));
  }
}
```

**WhatsApp add karna hai?** `class WhatsAppChannel implements NotificationChannel` likho, `registry.register(...)` karo, preferences mein allow karo. **Ek bhi purani class touch nahi hui** -- yahi open/closed ka asli matlab hai, pattern ka naam ratna nahi (wahi seekh [[71-parking-lot-lld-review]] se).

## 5. Notifier: Retry + Backoff + Jitter

Retry **channel ke andar nahi** -- warna har provider apna adhoora retry likhega.

```ts
export interface RetryPolicy { maxAttempts: number; baseMs: number; maxMs: number; }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function withRetry<T>(fn: () => Promise<T>, p: RetryPolicy, log: Logger): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= p.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable = err instanceof ChannelError ? err.retryable : false;
      if (!retryable || attempt === p.maxAttempts) break;
      const cap = Math.min(p.maxMs, p.baseMs * 2 ** (attempt - 1));  // exponential, capped
      const delay = Math.random() * cap;                             // FULL JITTER: 0..cap
      log.warn({ attempt, delay, err: String(err) }, 'notify retry');
      await sleep(delay);
    }
  }
  throw lastErr;
}
```

**Jitter kyun?** 5000 notifications ek saath fail hue aur sabne exactly 1s, 2s, 4s par retry kiya -- aapne provider par **synchronized thundering herd** bana diya. Random delay usko spread karta hai; wahi problem connection pool ke saath [[16-synchronized-connection-pool-expiry]] mein dikhti hai.

```ts
export class Notifier {
  constructor(
    private readonly registry: ChannelRegistry,
    private readonly prefs: PreferenceResolver,
    private readonly templates: TemplateRenderer,
    private readonly dedupe: DedupeStore,
    private readonly policy: RetryPolicy,
    private readonly log: Logger,
  ) {}

  async notify(req: NotificationRequest): Promise<void> {
    for (const name of await this.prefs.channelsFor(req.userId, req.templateId)) {
      const key = `${req.idempotencyKey}:${name}`;        // per-channel key
      if (!(await this.dedupe.claim(key))) continue;       // pehle hi bhej diya
      const msg = await this.templates.render(req.templateId, name, req.userId, req.data);
      try {
        await withRetry(() => this.registry.get(name).send(msg), this.policy, this.log);
      } catch (err) {
        await this.dedupe.release(key);                    // claim wapas, dobara try ho sake
        this.log.error({ userId: req.userId, name, err: String(err) }, 'notify failed');
        // production: dead-letter queue mein daalo -- chupchap swallow mat karo
      }
    }
  }
}
```

## 6. Idempotency: Same Cheez Do Baar Na Jaye

Duplicate teen jagah se aate hain: user ka double-click, aapka retry, aur queue ka at-least-once delivery. Jawab ek hi hai -- caller **idempotency key** bhejta hai (`order-9912:shipped`), aur `claim()` ek **atomic `SET NX`** hai:

```ts
class RedisDedupeStore implements DedupeStore {
  constructor(private readonly redis: RedisLike, private readonly ttlSec = 86_400) {}
  claim(key: string) { return this.redis.set(key, '1', 'EX', this.ttlSec, 'NX').then((r) => r === 'OK'); }
  release(key: string) { return this.redis.del(key).then(() => undefined); }
}
```

Key **per channel** honi chahiye, warna email bhejne ke baad SMS skip ho jaayega. Mechanism bilkul wahi hai jo payments mein ([[32-payment-idempotency-double-click]]) aur queue consumers mein ([[19-idempotent-consumer-duplicate-events]]) use hota hai.

## 7. Circuit Breaker as a Decorator

Twilio down hai. Har notification 3 retries x 10s timeout karega -- worker pool choke, aur **email bhi ruk gaya**. Fail fast chahiye.

```ts
export class CircuitBreakerChannel implements NotificationChannel {
  private failures = 0;
  private openUntil = 0;
  constructor(private readonly inner: NotificationChannel,
              private readonly threshold = 5, private readonly cooldownMs = 30_000) {}
  get name() { return this.inner.name; }

  async send(msg: RenderedMessage) {
    if (Date.now() < this.openUntil) throw new ChannelError(`${this.name} circuit open`, true);
    try {
      const res = await this.inner.send(msg);
      this.failures = 0;                                   // half-open pass -> close
      return res;
    } catch (err) {
      if (++this.failures >= this.threshold) this.openUntil = Date.now() + this.cooldownMs;
      throw err;
    }
  }
}

registry.register(new CircuitBreakerChannel(new SmsChannel(twilio, FROM)));
```

Decorator ka poora point: **same interface implement karta hai**, isliye `Notifier` ko pata hi nahi chalta. Metrics logger, per-provider rate limiter -- sab isi tarah wrap honge. Theory [[14-cascading-failure-recovery]] mein; kab iski zaroorat *nahi* hai wo [[42-resilience-vs-overengineering]] mein.

## 8. Templates Kahan? Aur Testable Kaise?

Template channel ke andar **kabhi nahi** -- ek hi event ka text har channel par alag hota hai (SMS 160 chars, email HTML, push title + chhota body):

```ts
interface TemplateRenderer {
  render(templateId: string, channel: Channel, userId: string, data: Record<string, unknown>)
    : Promise<RenderedMessage>;
}
```

Store `(templateId, channel, locale)` par keyed hai -- non-engineers copy edit kar sakte hain, localization almost free, aur text badalne ke liye **deploy nahi chahiye**.

```ts
class FakeChannel implements NotificationChannel {
  readonly name = 'SMS' as const;
  sent: RenderedMessage[] = [];
  failTimes = 2;
  async send(msg: RenderedMessage) {
    if (this.failTimes-- > 0) throw new ChannelError('boom', true);
    this.sent.push(msg); return {};
  }
}
// "2 baar fail, teesri baar pass" -- Twilio ko chhue bina retry logic verify ho gaya
await new Notifier(registryWith(fake), prefs, templates, dedupe,
  { maxAttempts: 3, baseMs: 1, maxMs: 2 }, log).notify(req);
expect(fake.sent).toHaveLength(1);
```

Interview line: *"Channel ek interface hai aur provider inject hota hai, isliye mere tests network touch nahi karte -- fake channel se retry, breaker aur dedupe teeno verify ho jaate hain."*

## 9. Trade-offs Aur Galtiyan

- **Zyada files.** Sirf email hai to ek function kaafi hai; ye structure **doosre channel par** justify hota hai, pehle par nahi.
- `Notifier` channels par **sequentially** loop karta hai -- latency add hogi. Caller wait kar raha ho to `Promise.allSettled`, warna poora `notify` queue ke peeche.
- In-memory breaker **per process** hai: 10 pods = 10 breakers. Aksar thik, shared state chahiye to Redis.
- Retry ka matlab **at-least-once** -- isliye dedupe optional nahi.

Galtiyan: `if (channel === 'sms')` switch (Strategy ka ulta); retry channel ke andar (4 adhoore versions, jitter kahin nahi); ready-made text request mein bhejna (caller formatting ka owner ban gaya); retry ke saath idempotency na rakhna (user ko 3 SMS); failure ko `catch {}` mein nigal jaana (silent data loss).

## 🧠 Remember

> Notification LLD mein ek hi soch hai: **channel ko interface ke peeche daalo (Strategy), selection preferences par chhodo, retry + backoff + jitter ek `Notifier` mein rakho, resilience ko same-interface decorator se wrap karo, aur har retry ke peeche idempotency key lagao** -- tabhi "WhatsApp add karo" ek nayi file banti hai, purani file ka edit nahi.

## Quick Self-Test

1. WhatsApp add karna hai -- kaunsi existing classes change hongi, aur kyun nahi hongi?
2. Jitter ke bina exponential backoff provider ke liye khatarnak kyun hai?
3. Idempotency key per-user ke bajaye per-(request, channel) kyun honi chahiye?
4. Circuit breaker ko `Notifier` ke andar `if` lagane ke bajaye decorator banane se kya milta hai?
5. Template rendering channel ke andar kyun nahi rakhte?
