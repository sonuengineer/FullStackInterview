# LLD: Logging Library Design Karo

> Ye sawaal dhokha deta hai. Logger **sabne use kiya** hai (`winston`, `pino`, `console.log`), par **kisi ne design nahi kiya**. Isliye interviewer ko turant pata chal jaata hai ki aapne iske baare mein kabhi socha hai ya nahi.

## 1. Kahani: 3 AM Ka Debugging

Production par orders fail ho rahe hain. Logs aise dikhte hain:

```
Error processing order
undefined
done
```

Kaunsa order? Kaunsa user? Kaunsi request? Kis service ne likha? 40 minute grep mein nikal jaate hain. Agle din aap har line par `console.log(orderId, 'blah')` daal dete hain -- ab logs 20 GB/day hain, bill badh gaya, aur signal pehle se bhi kam hai. Poore debugging workflow ka case study [[02-debugging-random-500-errors]] hai; yahan hum uska **tool** design kar rahe hain.

## 2. Requirements (LLD mein bhi pehle)

1. **Levels** -- production dev se quiet chale.
2. **Pluggable output** -- console (dev), stdout/file (prod), HTTP (Datadog/Loki).
3. **Structured** output -- machine query kar sake.
4. **Context** (request id) jo har line mein apne aap aaye.
5. Logging hot path ko **block na kare**.
6. Exit par logs **na khoye**.
7. Secrets **kabhi na** nikle.

Har requirement neeche ek design decision banti hai.

## 3. Levels: Ordered Enum, Equality Nahi

```ts
export const Level = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
export type LevelName = keyof typeof Level;

const enabled = Level[msgLevel] >= this.min;   // comparison
// NOT: msgLevel === this.minLevel             // yahi classic bug hai
```

Levels **numbers** hain kyunki filtering ka matlab hai *"isse important sab dikhao"*, "exactly ye dikhao" nahi. Equality use karoge to `minLevel: 'info'` par `error` aur `fatal` **gayab** -- yaani exactly wahi lines jinke liye logging banayi thi. Gaps (10, 20, 30...) beech mein custom level add karne ki jagah dete hain.

Check **sabse pehle** hona chahiye, string banane se pehle:

```ts
debug(obj: object, msg?: string) {
  if (Level.debug < this.min) return;   // early return -- koi serialize nahi hua
  this.write('debug', obj, msg);
}
```

## 4. Transport Interface: Output Pluggable

```ts
export interface LogRecord {
  readonly level: LevelName;
  readonly time: string;                 // ISO
  readonly msg: string;
  readonly [key: string]: unknown;
}

export interface Transport {
  write(record: LogRecord): void;        // sync signature, andar buffer kar sakta hai
  flush(): Promise<void>;                // pending sab nikal do
}

export class ConsoleTransport implements Transport {
  write(r: LogRecord) { process.stdout.write(JSON.stringify(r) + '\n'); }
  async flush() {}
}

export class HttpTransport implements Transport {
  private buf: LogRecord[] = [];
  private timer = setInterval(() => void this.flush(), 2000).unref();
  constructor(private readonly url: string, private readonly max = 100) {}
  write(r: LogRecord) { this.buf.push(r); if (this.buf.length >= this.max) void this.flush(); }
  async flush() {
    if (!this.buf.length) return;
    const batch = this.buf; this.buf = [];               // pehle swap, phir await
    try {
      await fetch(this.url, { method: 'POST', body: JSON.stringify(batch),
        signal: AbortSignal.timeout(3000) });
    } catch { /* log shipping kabhi app ko na girae -- drop karo, counter badhao */ }
  }
}
```

`HttpTransport` **batch** karta hai: per-line HTTP call matlab per-log-line network round trip -- logger khud aapki API ka bottleneck ban jaayega. Aur wo khaali `catch {}` jaanboojh kar hai -- log shipping ki failure request fail nahi kar sakti. (Baaki har jagah khaali catch galat hai.)

## 5. Logger Class

```ts
export class Logger {
  constructor(
    private readonly transports: Transport[],
    private readonly min: number = Level.info,
    private readonly bindings: Record<string, unknown> = {},
    private readonly redactKeys = new Set(['password', 'token', 'authorization', 'otp', 'card']),
  ) {}

  /** Child logger -- parent ka context inherit, extra add. */
  child(bindings: Record<string, unknown>): Logger {
    return new Logger(this.transports, this.min, { ...this.bindings, ...bindings }, this.redactKeys);
  }

  private write(level: LevelName, obj: object, msg: string) {
    const record: LogRecord = {
      level, time: new Date().toISOString(), msg,
      ...this.bindings,
      ...store.getStore(),              // AsyncLocalStorage -- Section 7
      ...this.redact(obj as Record<string, unknown>),
    };
    for (const t of this.transports) t.write(record);
  }

  private redact(obj: Record<string, unknown>) {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) =>
      [k, this.redactKeys.has(k.toLowerCase()) ? '[REDACTED]' : v]));
  }

  info(obj: object, msg = '') { if (Level.info >= this.min) this.write('info', obj, msg); }
  warn(obj: object, msg = '') { if (Level.warn >= this.min) this.write('warn', obj, msg); }
  error(obj: object, msg = '') { if (Level.error >= this.min) this.write('error', obj, msg); }

  flush() { return Promise.all(this.transports.map((t) => t.flush())); }
}
```

## 6. Structured > String Concat

```ts
log.info(`Order ${id} failed for user ${userId} after ${ms}ms`);     // string
log.info({ orderId: id, userId, durationMs: ms }, 'order failed');  // structured
```

Pehle par aap sirf **grep** kar sakte hain, doosre par **query**: `level >= error AND durationMs > 2000 AND userId = "u_91"`, group by orderId. Aggregator (Loki, CloudWatch Insights, Datadog) ko **fields** milte hain, prose nahi -- `durationMs: 2400` ek number hai jis par alert laga sakte hain, "after 2400ms" ek sentence ka hissa hai. Bonus: message string constant rehti hai, isliye "same error x 1200" group ho jaata hai.

## 7. Child Loggers Aur Request ID (AsyncLocalStorage)

Problem: `OrderService` ko request id kaise mile? `logger` ko 8 layers neeche parameter bana ke pass karna ugly hai. Node ka jawab `AsyncLocalStorage` hai -- store jo poore async chain (await, callback, timer ke paar) bana rehta hai:

```ts
import { AsyncLocalStorage } from 'node:async_hooks';
export const store = new AsyncLocalStorage<Record<string, unknown>>();

app.use((req, res, next) => {                    // ek hi jagah
  const requestId = req.header('x-request-id') ?? crypto.randomUUID();
  res.setHeader('x-request-id', requestId);
  store.run({ requestId, path: req.path }, next);
});
```

Ab kisi bhi depth par `log.info({ orderId }, 'saved')` likhiye -- `requestId` apne aap output mein. 3 AM debugging ek query ban gayi: `requestId = "a3f..."` -> us ek request ki saari 40 lines, sahi order mein.

Farak yaad rakho: `child()` **explicit** hai (`base.child({ module: 'billing' })`, long-lived), ALS **ambient** hai (per-request, apne aap flow hota hai). Dono rakho.

## 8. Async Writes Aur Flush-on-Exit Bug

Sync disk write hot path ko disk latency se bandh deti hai, isliye real loggers **buffer** karte hain. Aur yahin classic bug aata hai:

```ts
log.error({ err }, 'fatal, shutting down');
process.exit(1);          // BUG: buffer flush hi nahi hua -- wahi line gayab
```

`process.exit()` process ko **turant** maarta hai: pending interval, pending `fetch`, buffered stdout -- sab chhoot jaata hai. Jo line sabse zyada chahiye thi (crash ka reason) wohi kho gayi.

```ts
async function shutdown(code: number) {
  await logger.flush();                            // transports ko nikalne do
  process.exit(code);
}
process.on('SIGTERM', () => void shutdown(0));
process.on('uncaughtException', (err) => {
  logger.error({ err: err.stack }, 'uncaughtException');
  void shutdown(1);
});
```

Container world ki practice: transport ko **stdout** rakho, shipping sidecar/agent par chhodo -- buffer chhota, risk kam. Seedha HTTP par bhej rahe ho to `flush()` + SIGTERM handling optional nahi hai.

## 9. High Volume Par Sampling

10,000 rps par `info` logs = 10,000 lines/sec x ~400 bytes = **~350 GB/day**. Ye ab cost aur storage problem hai.

```ts
const sampled = (rate: number) => Math.random() < rate;
if (res.statusCode < 400) { if (sampled(0.01)) log.info({ route, ms }, 'req'); }
else log.warn({ route, ms, status: res.statusCode }, 'req failed');     // errors: 100%
```

Rules jo kaam karte hain: **errors kabhi sample na karo**, success ko aggressively sample karo, counters ke liye logs ke bajaye **metrics** (1 counter vs 10,000 lines), aur level ko **runtime knob** banao taaki incident ke waqt `debug` on ho jaaye -- redeploy ke bina.

## 10. Jo Kabhi Log Nahi Hoga

| Kabhi nahi | Kyun |
|---|---|
| Password, OTP | Plaintext credential disk par, backups mein, Datadog mein |
| JWT / API key / `Authorization` | Log padhne wala ab user ban sakta hai ([[94-jwt-auth-safely-in-production]]) |
| Card number, CVV | PCI violation |
| Aadhaar, PAN, phone, email (bina zaroorat) | PII, aur logs ka retention lamba hota hai |
| Poora request body blindly | Usi mein upar ki saari cheezein chhupi hoti hain |

Isliye redaction **library ke andar** hai, developer ki discipline par nahi -- `log.info({ user })` likhna natural hai, aur `user.password` tab bhi leak nahi hona chahiye. Aur: `err.stack` log karo, `err` object ko `JSON.stringify` mat karo (`Error` ke fields non-enumerable hote hain, stack chupchap gayab ho jaata hai).

## 11. Trade-off Jo Poore Design Ko Samjhata Hai

Har log line muft nahi hai: **object allocate hua, JSON serialize hua, bytes disk/network par gaye, storage ka paisa laga, retention tak baitha raha.** Dev machine par ye invisible hai (10 rps); 10,000 rps par yahi CPU aur bill hai. Isi liye levels exist karte hain -- **same code** dev mein baatuni, production mein khamosh:

```ts
new Logger([transport], Level[process.env.LOG_LEVEL as LevelName] ?? Level.info);
// dev: debug   prod: info   incident: debug, temporarily
```

## 12. Common Galtiyan

1. Level ko `===` se compare karna -- errors gayab.
2. Level check se pehle hi string bana dena (template literal mein `JSON.stringify(huge)`) -- cost lag gayi, line phenk di gayi. Object pass karo, logger ko decide karne do.
3. `process.exit()` bina flush -- crash ka reason kho gaya.
4. Per-line HTTP call -- logger aapki API ka naya bottleneck.
5. Poora request body log karna -- secrets + PII leak.
6. Transport interface na rakhna -- `console.log` hard-coded, prod mein output badalne ke liye poora code touch karo.

## 🧠 Remember

> Logger = **ordered numeric levels** (comparison se filter, equality se nahi) + **pluggable Transport** + **structured JSON** + **child/ALS context** + **buffered writes with flush-on-exit** + **built-in redaction**. Aur poora design ek trade-off par khada hai: har log line CPU, disk aur paisa kharch karti hai -- isliye levels hain, taaki same code dev mein baatuni ho aur production mein khamosh.

## Quick Self-Test

1. Levels ko equality se compare karne par exactly kya toot jaata hai?
2. `child()` aur `AsyncLocalStorage` mein farak kya hai, aur dono kab chahiye?
3. `logger.error(...)` ke turant baad `process.exit(1)` kyun ek bug hai?
4. `log.info({ orderId, ms }, 'failed')` template string se behtar kyun hai?
5. Sampling mein error logs ko kyun chhodna chahiye?
6. Redaction logger ke andar kyun, developer ki discipline par kyun nahi?
