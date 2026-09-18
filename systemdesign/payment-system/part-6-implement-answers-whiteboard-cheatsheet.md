# Payment System -- HLD + LLD (Part 6: Implement It -> Interview Answers -> Whiteboard -> Cheat Sheet)

> Is file mein prompt ke **Parts 26-30** hain: coding round mein "Implement an idempotent payment API" kaise solve karein, 30-second answer, 5-minute answer, whiteboard par diagram kis order mein banayein, aur poore Payment System (Parts 1-5) ki final cheat sheet.
> Ye last file hai. Parts 1-5 mein humne design samjha (idempotency keys, atomic phases, state machine, ledger, outbox, reconciliation); yahan hum usko **interview mein bolna, likhna aur draw karna** seekhenge.
> Honest note: Stripe, Razorpay, Adyen jaise real payment systems isse kahin bade hain. Ye woh design hai jo interviewer ek **merchant-side payment service** (ShopKart jo PSP ko call karta hai) ke liye expect karta hai.

---

## PART 26 -- Code Design Question: "Implement an idempotent payment API"

### Pehle samjho: interviewer kya dekh raha hai

Prompt kuch aisa hoga: *"Implement `processPayment(idempotencyKey, request)`. Same key dobara aaye toh customer do baar charge nahi hona chahiye. DB mat use karo, in-memory rakho."*

Yahan Postgres, Kafka, webhooks nahi chahiye. Interviewer ye dekhta hai:

- Tum **clarify** karte ho (key ka scope? same key + alag body? timeout par kya?) ya seedha typing?
- **Decision table** tumhe yaad hai -- new / replay / in-progress / reused / takeover?
- Tum samajhte ho ki **PSP timeout = unknown, failure nahi**?
- **Concurrency**: same key ki do requests ek saath aayi toh?
- Money **integer paise** mein, floats nahi; ledger balanced?

Iska matlab: **ek file, in-memory `Map`, ek fake PSP.** Lekin tum bologe: "production mein yahi logic Postgres ke `INSERT ... ON CONFLICT DO NOTHING` aur transactions mein chalta hai" -- Part 2/3 wala same design.

> Connection: URL Shortener aur Rate Limiter ke Part 26 mein bhi yahi pattern tha -- in-memory class, injectable clock `now`, "production mein storage badlega, logic nahi". Rate Limiter mein humne kaha tha "synchronous function = event loop mein atomic". Yahan wahi trick idempotency claim ko safe banati hai.

### Step 1 -- Clarify (1-2 minute, typing se pehle)

> "Code likhne se pehle kuch cheezein confirm kar leta hoon."

| Question | Mera assumption (agar interviewer bole "you decide") |
|---|---|
| Key kaun banata hai, scope kya hai? | Client UUID v4 banata hai, har retry par reuse. Scope `(customerId, key)` -- do customers same key bhejein toh clash nahi |
| Same key, **alag body**? | **422 `IDEMPOTENCY_KEY_REUSED`** -- request fingerprint (SHA-256 of method + path + canonical JSON) match nahi hua |
| Same key, pehli request abhi chal rahi hai? | **409 `IDEMPOTENCY_IN_PROGRESS`** -- client thodi der baad retry kare |
| Same key, pehli complete ho gayi? | Stored response **replay** (same status code + body), header `Idempotent-Replayed: true` |
| Server beech mein crash ho gaya? | Lock 60 s ka; expire hone par agli request **takeover** karke `recoveryPoint` se resume |
| PSP timeout? | Payment `PROCESSING`, response **202**. Key complete nahi hoti. Retry par PSP se poochho (`getPaymentByIdempotencyKey`). **Kabhi FAILED mark nahi** |
| Amount kahan se? | **Order se**, client body se kabhi nahi (amount tampering) |
| Card decline? | Valid outcome: **201 + `status: FAILED`**, aur woh bhi replay hota hai. Naye attempt ke liye naya key |
| Keys kitni der? | 24 hours, phir cleanup |
| Single process ya distributed? | Single process in-memory. Distributed = Postgres unique constraint (bolunga, likhunga nahi) |

> Interview tip: "timeout par kya karein?" -- ye ek question hi senior aur junior answer ko alag kar deta hai. Junior bolta hai "fail kar do, user retry karega" -> double charge. Senior bolta hai "unknown hai, PSP se poochhenge".

### Step 2 -- Logic pehle bolo (code se pehle, Hinglish mein)

> "Main teen cheezein banaunga. Pehli, ek **idempotency store**: key -> record `{ requestHash, status, recoveryPoint, paymentId, response, lockedUntil }`. Uska `claim()` function **synchronous** hoga -- check aur set ke beech koi `await` nahi -- taaki Node ka event loop do requests ko beech mein interleave na kar sake.
>
> Doosri, ek **fake PSP** jo khud bhi idempotent hai -- same idempotency key par wahi charge lautata hai, naya nahi banata. Real Stripe/Razorpay aise hi kaam karte hain. Isko main bol sakta hoon succeed, decline, 3-D Secure, ya timeout -- aur timeout mein charge PSP par **ho jaata hai**, bas response kho jaata hai. Yahi asli darr hai.
>
> Teesri, **PaymentService** jo spec ke 3 phases chalata hai: Phase 1 -- order load, payment `CREATED`. Phase 2 -- `PROCESSING` mark karke PSP call, PSP ki idempotency key = **hamari payment id**. Phase 3 -- result apply: status, ledger (success par debit `psp_clearing`, credit `sales_revenue`), outbox event, key `COMPLETED` with response.
>
> Har phase ke baad `recoveryPoint` update, taaki crash ke baad koi bhi server wahin se resume kare. Timeout par key `IN_PROGRESS` + `PSP_CALLED` par ruk jaati hai aur lock release -- agla retry seedha PSP se status poochhega."

Ab code.

### Step 3 -- TypeScript code (single file, self-contained)

```ts
import { createHash } from 'node:crypto';

// ---------- Types (same names as the design spec) ----------
export type PaymentStatus =
  | 'CREATED' | 'PROCESSING' | 'REQUIRES_ACTION' | 'SUCCEEDED' | 'FAILED' | 'PARTIALLY_REFUNDED' | 'REFUNDED';
export interface PspChargeInput { idempotencyKey: string; amountMinor: number; currency: string; paymentMethodToken: string }
export interface PspChargeResult {
  outcome: 'succeeded' | 'failed' | 'requires_action' | 'unknown';
  pspPaymentId?: string;
  failureCode?: string;
  nextActionUrl?: string;
}
// Coding round: sirf charge path. refund() yahan omit kiya hai.
export interface PspClient {
  charge(input: PspChargeInput): Promise<PspChargeResult>;
  getPaymentByIdempotencyKey(idempotencyKey: string): Promise<PspChargeResult>;
}
export interface HttpResult { code: number; body: unknown; replayed?: boolean }

type RecoveryPoint = 'STARTED' | 'PAYMENT_CREATED' | 'PSP_CALLED' | 'FINISHED';

export interface IdempotencyRecord {
  requestHash: string;
  status: 'IN_PROGRESS' | 'COMPLETED';
  recoveryPoint: RecoveryPoint;
  paymentId?: string;
  response?: HttpResult;
  lockedUntil: number;
  createdAt: number;
}
export type ClaimResult =
  | { kind: 'owned'; record: IdempotencyRecord }
  | { kind: 'done'; result: HttpResult };

const LOCK_MS = 60_000;
const KEY_TTL_MS = 24 * 60 * 60 * 1000;

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const parts = Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function requestFingerprint(method: string, path: string, body: unknown): string {
  return createHash('sha256').update(`${method} ${path} ${canonicalJson(body)}`).digest('hex');
}

// ---------- 1. Idempotency store ----------
export class InMemoryIdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  constructor(private readonly now: () => number = Date.now) {}

  // SYNCHRONOUS on purpose: check + set ke beech koi await nahi.
  claim(customerId: string, key: string, requestHash: string): ClaimResult {
    const id = JSON.stringify([customerId, key]); // scope = (customer_id, key)
    const nowMs = this.now();
    const existing = this.records.get(id);

    if (!existing || nowMs - existing.createdAt >= KEY_TTL_MS) {
      const record: IdempotencyRecord = {
        requestHash, status: 'IN_PROGRESS', recoveryPoint: 'STARTED',
        lockedUntil: nowMs + LOCK_MS, createdAt: nowMs,
      };
      this.records.set(id, record);
      return { kind: 'owned', record };
    }
    if (existing.requestHash !== requestHash) {
      return { kind: 'done', result: { code: 422, body: { error: 'IDEMPOTENCY_KEY_REUSED' } } };
    }
    if (existing.status === 'COMPLETED' && existing.response) {
      return { kind: 'done', result: { ...existing.response, replayed: true } };
    }
    if (existing.lockedUntil > nowMs) {
      return { kind: 'done', result: { code: 409, body: { error: 'IDEMPOTENCY_IN_PROGRESS' } } };
    }
    existing.lockedUntil = nowMs + LOCK_MS; // lock expired -> take over, resume from recoveryPoint
    return { kind: 'owned', record: existing };
  }

  complete(record: IdempotencyRecord, response: HttpResult): void {
    record.status = 'COMPLETED';
    record.recoveryPoint = 'FINISHED';
    record.response = response;
  }

  release(record: IdempotencyRecord): void {
    record.lockedUntil = this.now(); // IN_PROGRESS rehta hai, bas lock chhod diya
  }

  sweepExpired(): number {
    const nowMs = this.now();
    let removed = 0;
    for (const [id, record] of this.records) {
      if (nowMs - record.createdAt >= KEY_TTL_MS) {
        this.records.delete(id);
        removed++;
      }
    }
    return removed;
  }
}

// ---------- 2. Fake PSP (idempotent by key, like Stripe / Razorpay) ----------
export type PspMode = 'succeed' | 'decline' | 'requires_action' | 'timeout';
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

export class FakePsp implements PspClient {
  mode: PspMode = 'succeed';
  chargesCreated = 0;
  private readonly charges = new Map<string, PspChargeResult>(); // PSP side: idempotencyKey -> charge

  async charge(input: PspChargeInput): Promise<PspChargeResult> {
    await tick();
    let result = this.charges.get(input.idempotencyKey);
    if (!result) {
      result = this.newCharge();
      this.charges.set(input.idempotencyKey, result);
      this.chargesCreated++;
    }
    if (this.mode === 'timeout') throw new Error('ETIMEDOUT'); // paisa kat gaya, response kho gaya
    return result;
  }

  async getPaymentByIdempotencyKey(idempotencyKey: string): Promise<PspChargeResult> {
    await tick();
    if (this.mode === 'timeout') throw new Error('ETIMEDOUT');
    return this.charges.get(idempotencyKey) ?? { outcome: 'unknown' }; // PSP ne ye key dekhi hi nahi
  }

  private newCharge(): PspChargeResult {
    const pspPaymentId = `psp_${this.chargesCreated + 1}`;
    if (this.mode === 'decline') return { outcome: 'failed', pspPaymentId, failureCode: 'card_declined' };
    if (this.mode === 'requires_action') {
      return { outcome: 'requires_action', pspPaymentId, nextActionUrl: `https://psp.example/3ds/${pspPaymentId}` };
    }
    return { outcome: 'succeeded', pspPaymentId }; // 'timeout' mode mein bhi charge PSP par ho jaata hai
  }
}

// ---------- 3. Double-entry ledger ----------
interface LedgerLine { account: string; direction: 'DEBIT' | 'CREDIT'; amountMinor: number }
interface LedgerEntry extends LedgerLine { transactionId: string; paymentId: string; currency: string }

export class InMemoryLedger {
  private readonly entries: LedgerEntry[] = []; // append-only

  post(transactionId: string, paymentId: string, currency: string, lines: LedgerLine[]): void {
    let net = 0;
    for (const line of lines) {
      if (!Number.isSafeInteger(line.amountMinor) || line.amountMinor <= 0) {
        throw new RangeError('amountMinor must be a positive safe integer');
      }
      net += line.direction === 'DEBIT' ? line.amountMinor : -line.amountMinor;
    }
    if (net !== 0) throw new Error(`unbalanced transaction ${transactionId}`);
    for (const line of lines) this.entries.push({ ...line, transactionId, paymentId, currency });
  }

  balance(account: string): number { // DEBIT minus CREDIT
    return this.entries
      .filter((e) => e.account === account)
      .reduce((sum, e) => sum + (e.direction === 'DEBIT' ? e.amountMinor : -e.amountMinor), 0);
  }

  isBalanced(): boolean {
    const net = new Map<string, number>();
    for (const e of this.entries) {
      net.set(e.transactionId, (net.get(e.transactionId) ?? 0) + (e.direction === 'DEBIT' ? e.amountMinor : -e.amountMinor));
    }
    return [...net.values()].every((v) => v === 0);
  }

  get size(): number {
    return this.entries.length;
  }
}

// ---------- 4. Payment service (decision table + atomic phases) ----------
export interface Order { id: string; customerId: string; amountMinor: number; currency: string }
export interface CreatePaymentBody { orderId: string; paymentMethodToken: string }
interface Payment {
  id: string; orderId: string; customerId: string; amountMinor: number; currency: string;
  status: PaymentStatus; pspPaymentId?: string; failureCode?: string; nextActionUrl?: string; version: number;
}

export class PaymentService {
  readonly outbox: { eventId: string; aggregateId: string; eventType: string }[] = [];
  private readonly payments = new Map<string, Payment>();
  private readonly activeByOrder = new Map<string, string>(); // ~ ux_payments_one_active_per_order
  private seq = 0;

  constructor(
    private readonly store: InMemoryIdempotencyStore,
    private readonly psp: PspClient,
    private readonly ledger: InMemoryLedger,
    private readonly orders: Map<string, Order>,
  ) {}

  async createPayment(customerId: string, key: string | undefined, body: CreatePaymentBody): Promise<HttpResult> {
    if (!key) return { code: 400, body: { error: 'IDEMPOTENCY_KEY_REQUIRED' } };
    if (!body.orderId || !body.paymentMethodToken) return { code: 400, body: { error: 'VALIDATION_ERROR' } };

    const claim = this.store.claim(customerId, key, requestFingerprint('POST', '/v1/payments', body));
    if (claim.kind === 'done') return claim.result; // replay / 409 / 422

    try {
      return await this.run(claim.record, customerId, body);
    } catch (err) {
      this.store.release(claim.record); // unexpected bug: lock chhodo, retry resume karega
      throw err;
    }
  }

  getPayment(customerId: string, id: string): HttpResult {
    const p = this.payments.get(id);
    if (!p || p.customerId !== customerId) return { code: 404, body: { error: 'NOT_FOUND' } };
    return { code: 200, body: this.toResponse(p) };
  }

  private async run(rec: IdempotencyRecord, customerId: string, body: CreatePaymentBody): Promise<HttpResult> {
    // Phase 1 (Tx 1): order load + payment row CREATED
    if (rec.recoveryPoint === 'STARTED') {
      const order = this.orders.get(body.orderId);
      if (!order) return this.finish(rec, { code: 404, body: { error: 'ORDER_NOT_FOUND' } });
      if (order.customerId !== customerId) return this.finish(rec, { code: 403, body: { error: 'FORBIDDEN' } });
      if (this.activeByOrder.has(order.id)) return this.finish(rec, { code: 409, body: { error: 'ORDER_ALREADY_PAID' } });
      const payment: Payment = {
        id: `pay_${String(++this.seq).padStart(3, '0')}`, orderId: order.id, customerId,
        amountMinor: order.amountMinor, currency: order.currency, status: 'CREATED', version: 0, // amount from ORDER
      };
      this.payments.set(payment.id, payment);
      this.activeByOrder.set(order.id, payment.id);
      rec.recoveryPoint = 'PAYMENT_CREATED';
      rec.paymentId = payment.id;
    }
    const payment = this.payments.get(rec.paymentId ?? '');
    if (!payment) throw new Error('recovery point without payment');

    // Phase 2 (no transaction): PSP idempotency key = OUR payment id
    const input: PspChargeInput = {
      idempotencyKey: payment.id, amountMinor: payment.amountMinor,
      currency: payment.currency, paymentMethodToken: body.paymentMethodToken,
    };
    let result: PspChargeResult;
    if (rec.recoveryPoint === 'PAYMENT_CREATED') {
      this.transition(payment, 'PROCESSING', ['CREATED']);
      rec.recoveryPoint = 'PSP_CALLED';
      result = await this.callPsp(() => this.psp.charge(input));
    } else {
      // resume (timeout / crash): pehle PSP se poochho, PSP ko pata hi nahi toh SAME key se charge
      result = await this.callPsp(() => this.psp.getPaymentByIdempotencyKey(payment.id));
      if (result.outcome === 'unknown') result = await this.callPsp(() => this.psp.charge(input));
    }

    // Phase 3 (Tx 2): sab synchronous -> ek process mein atomic
    return this.applyResult(rec, payment, result);
  }

  private async callPsp(call: () => Promise<PspChargeResult>): Promise<PspChargeResult> {
    try {
      return await call();
    } catch {
      return { outcome: 'unknown' }; // timeout = UNKNOWN, kabhi FAILED nahi
    }
  }

  private applyResult(rec: IdempotencyRecord, payment: Payment, r: PspChargeResult): HttpResult {
    if (r.outcome === 'unknown') {
      this.store.release(rec); // key IN_PROGRESS @ PSP_CALLED, lock released
      return { code: 202, body: { id: payment.id, status: 'PROCESSING' } };
    }
    const from: PaymentStatus[] = ['PROCESSING', 'REQUIRES_ACTION'];
    if (r.outcome === 'succeeded' && this.transition(payment, 'SUCCEEDED', from, r)) {
      this.ledger.post(`txn_${payment.id}`, payment.id, payment.currency, [
        { account: 'psp_clearing', direction: 'DEBIT', amountMinor: payment.amountMinor },
        { account: 'sales_revenue', direction: 'CREDIT', amountMinor: payment.amountMinor },
      ]);
      this.emit(payment, 'payment.succeeded');
    } else if (r.outcome === 'failed' && this.transition(payment, 'FAILED', from, r)) {
      this.activeByOrder.delete(payment.orderId); // FAILED payment order ko block nahi karta
      this.emit(payment, 'payment.failed');
    } else if (r.outcome === 'requires_action') {
      this.transition(payment, 'REQUIRES_ACTION', ['PROCESSING'], r);
    }
    return this.finish(rec, { code: 201, body: this.toResponse(payment) });
  }

  // Conditional update: galat state se transition = false (koi aur pehle move kar chuka), error nahi
  private transition(p: Payment, to: PaymentStatus, from: PaymentStatus[], r?: PspChargeResult): boolean {
    if (!from.includes(p.status)) return false;
    p.status = to;
    p.version += 1;
    if (r?.pspPaymentId) p.pspPaymentId = r.pspPaymentId;
    if (r?.failureCode) p.failureCode = r.failureCode;
    if (r?.nextActionUrl) p.nextActionUrl = r.nextActionUrl;
    return true;
  }

  private emit(p: Payment, eventType: string): void {
    this.outbox.push({ eventId: `evt_${this.outbox.length + 1}`, aggregateId: p.id, eventType });
  }

  private finish(rec: IdempotencyRecord, response: HttpResult): HttpResult {
    this.store.complete(rec, response);
    return response;
  }

  private toResponse(p: Payment): Record<string, unknown> {
    return {
      id: p.id,
      status: p.status,
      amount: { valueMinor: p.amountMinor, currency: p.currency },
      ...(p.failureCode ? { failureCode: p.failureCode } : {}),
      ...(p.nextActionUrl ? { nextAction: { type: 'redirect', url: p.nextActionUrl } } : {}),
    };
  }
}
```

> Ye code `tsc --strict` (TypeScript 5, target ES2022, `@types/node` for `node:crypto`) se bina error compile hota hai, aur neeche ka output actually run karke nikala gaya hai.

### Step 4 -- Line-by-line explanation

**Code Explanation -- types aur helpers:**

- `PaymentStatus`, `PspChargeInput`, `PspChargeResult` -- **spec ke exact names**. `PspClient` mein sirf `charge` + `getPaymentByIdempotencyKey`; production interface mein `refund()` bhi hai -- coding round mein scope chhota rakho aur bol do.
- `HttpResult { code, body, replayed? }` -- controller bas `res.status(code).json(body)` kare, aur `replayed` true ho toh `Idempotent-Replayed: true` header lagaye.
- `RecoveryPoint` -- `STARTED -> PAYMENT_CREATED -> PSP_CALLED -> FINISHED`, crash ke baad ka "bookmark". `IdempotencyRecord` = Postgres `idempotency_keys` row ka in-memory roop.
- `ClaimResult` -- discriminated union: `owned` (tum kaam karo) ya `done` (replay / 409 / 422 seedha lauta do). `LOCK_MS` 60 s aur `KEY_TTL_MS` 24h -- spec wale numbers.
- `canonicalJson` -- keys **sort** karke JSON. `{a,b}` aur `{b,a}` same request hai, hash bhi same hona chahiye. Warna mobile SDK ka key order badla aur 422 aa gaya.
- `requestFingerprint` -- `sha256("POST /v1/payments " + canonical body)`. Pura body store karne ki jagah 64-char hash: compare O(1), aur token jaisa data key table mein plain nahi padta.

**Code Explanation -- `InMemoryIdempotencyStore.claim` (dil of the pattern):**

- `JSON.stringify([customerId, key])` -- composite key. `${customerId}:${key}` likhte toh `"a:b" + "c"` aur `"a" + "b:c"` collide kar sakte the; JSON array se nahi.
- `const nowMs = this.now()` -- **injectable clock**; demo mein `fakeNow = 61_000` karke lock expiry test karte hain bina 61 second wait kiye.
- `!existing || expired` -> naya record `IN_PROGRESS`, `STARTED`, `lockedUntil = now + 60s` -> `owned`. Ye Postgres ka `INSERT ... ON CONFLICT DO NOTHING RETURNING *` hai jisme row wapas aayi.
- `requestHash !==` -> **422**. Ye check **pehle** hai -- chahe record completed ho ya in-progress, alag body ke saath same key galat use hai (spec ka order bhi yahi).
- `COMPLETED` -> `{ ...existing.response, replayed: true }` -- same code + same body. Decline (201 FAILED) bhi replay hota hai.
- `lockedUntil > nowMs` -> **409** -- koi aur abhi kaam kar raha hai.
- Warna lock expire ho chuka -> `lockedUntil = now + 60s` aur wahi record `owned` -- **takeover**. Service `recoveryPoint` dekh ke resume karegi. SQL mein ye `UPDATE ... WHERE locked_until < now() RETURNING *` hai.
- **Poora function synchronous hai.** Yahi concurrency ki guarantee hai (neeche detail).

**Code Explanation -- `complete`, `release`, `sweepExpired`:**

- `complete` -- status `COMPLETED`, recovery point `FINISHED`, response save. Iske baad har retry replay hai.
- `release` -- `lockedUntil = now`. Status **IN_PROGRESS hi rehta hai**. Timeout case mein yahi chahiye: key complete nahi (outcome pata nahi), lekin agla retry 60 s wait kiye bina turant takeover kar sake.
- `sweepExpired` -- 24h purane records delete. Production mein cleanup job: `DELETE ... WHERE created_at < now() - interval '24 hours'`.

**Code Explanation -- `FakePsp`:**

- `mode` -- test se control: `succeed | decline | requires_action | timeout`. `charges: Map<idempotencyKey, result>` -- **PSP side ki idempotency.** Same key dobara aayi toh purana result, naya charge nahi. `chargesCreated` sirf naye charge par badhta hai -- demo mein yahi counter prove karega ki double charge nahi hua.
- `await tick()` -- 5 ms ka network delay. Isi `await` ki wajah se do parallel requests ka interleaving real jaisa hota hai.
- `timeout` mode: charge **pehle store hota hai, phir `throw ETIMEDOUT`**. Real duniya ka sabse khatarnak case: PSP ne paisa kaat liya, hamein response nahi mila.
- `getPaymentByIdempotencyKey` -- PSP se "is key ka kya hua?". Nahi mila toh `unknown` (real PSP 404 deta; iska matlab charge hua hi nahi, toh same key se charge karna safe hai).
- `newCharge` -- mode ke hisaab se result; `psp_<n>` fake `pspPaymentId`; 3-D Secure ke liye redirect URL.

**Code Explanation -- `InMemoryLedger`:**

- `entries` -- **append-only** array. Koi update/delete method hai hi nahi; production mein DB grants se enforce (corrections = reversing entries).
- `post()` -- pehle validate: har amount `Number.isSafeInteger` aur > 0 (paise, floats nahi). Phir `net` = debits - credits; **0 nahi toh throw** -- unbalanced transaction kabhi likhi hi nahi jaati. Validate pehle, push baad mein -- aadha transaction kabhi nahi bachta.
- `balance(account)` -- DEBIT minus CREDIT. `psp_clearing` positive (PSP ko hamein paisa dena hai), `sales_revenue` negative (credit-normal account) -- accounting mein normal.
- `isBalanced()` -- har `transactionId` ka net 0? Ye `ledger_imbalance_total` metric ka in-memory version hai -- hamesha true hona chahiye.

**Code Explanation -- `PaymentService.createPayment`:**

- `!key` -> **400 `IDEMPOTENCY_KEY_REQUIRED`**. Key optional rakhi toh ek purana client bina key ke retry karega aur double charge -- isliye mandatory.
- Validation **claim se pehle** -- galat body par key "burn" nahi hoti.
- `this.store.claim(...)` -> `done` hai toh seedha return (replay / 409 / 422). PSP ko chhua bhi nahi.
- `try { return await this.run(...) } catch { release; throw }` -- code mein bug aaya toh lock chhod do, taaki retry 60 s wait na kare aur resume kare.
- `getPayment` -- owner check; dusre customer ki payment par **404** (403 nahi -- existence leak nahi karni, IDOR se bachao).

**Code Explanation -- `run` (atomic phases):**

- `if (rec.recoveryPoint === 'STARTED')` -- **Phase 1 (Tx 1)**. Order nahi -> 404, kisi aur ka -> 403, already active payment -> **409 `ORDER_ALREADY_PAID`**. Ye teeno `finish()` se key complete karte hain (deterministic result, replay hoga).
- `activeByOrder` -- partial unique index `ux_payments_one_active_per_order` ki nakal. **Do alag keys** wala double-click isi se rukta hai, idempotency key se nahi.
- `amountMinor: order.amountMinor` -- amount **order se**. Body mein amount hai hi nahi.
- `pay_001` -- demo ke liye counter; production mein `pay_<ULID>`.
- `rec.recoveryPoint = 'PAYMENT_CREATED'; rec.paymentId = ...` -- bookmark. Crash yahan hua toh takeover wala server payment dobara nahi banayega.
- `payments.get(rec.paymentId ?? '')` -- resume par payment record se wapas milta hai.
- `input.idempotencyKey: payment.id` -- **PSP idempotency key = hamari payment id**. Ye poore design ki sabse important line hai: hum PSP ko 10 baar bhi call karein, charge ek hi banega.
- `PAYMENT_CREATED` branch -- `CREATED -> PROCESSING`, bookmark `PSP_CALLED` **call se pehle**, phir `charge`. Pehle bookmark isliye: call ke beech crash hua toh resume wala jaanta hai "PSP ko shayad call gaya tha -- pehle poochho".
- `else` (resume) -- `getPaymentByIdempotencyKey(payment.id)`; `unknown` aaya toh **same key** se `charge`. Dono safe hain kyunki PSP idempotent hai.
- `applyResult` -- **Phase 3 (Tx 2)**. Isme koi `await` nahi, toh ek process mein status + ledger + outbox + key completion ek atomic step hai (Postgres mein ye ek transaction).

**Code Explanation -- `callPsp`, `applyResult`, `transition`:**

- `callPsp` -- koi bhi exception (timeout, network) -> `{ outcome: 'unknown' }`. **Kabhi `failed` nahi.** Failed tabhi jab PSP khud bole "declined".
- `unknown` -> `release(rec)` + **202 `{ id, status: 'PROCESSING' }`**. Key `COMPLETED` nahi hui -- warna har retry 202 replay karta aur payment kabhi resolve na hoti.
- `succeeded && transition(...)` -> ledger + `payment.succeeded`. `&&` ka matlab: ledger **sirf tab** jab humne transition jeeta. Webhook pehle hi SUCCEEDED kar chuka ho toh transition `false` -> ledger dobara nahi likha jaata.
- `failed` -> `FAILED` + `activeByOrder.delete` (partial index mein FAILED shaamil nahi) -> customer naye key se dobara try kar sake.
- `requires_action` -> `REQUIRES_ACTION` + `nextAction` redirect; final result webhook se aayega (Part 2 flow).
- End mein hamesha `finish(rec, 201 + current payment)` -- transition haara ho tab bhi current state lautao; "koi aur pehle move kar chuka" error nahi hai.
- `transition(p, to, from)` -- spec ka conditional update `UPDATE ... WHERE status = ANY($4)` ka in-memory version. `version += 1` optimistic concurrency ke liye.
- `emit` -- outbox mein event. Production mein ye row usi Tx 2 mein likhi jaati hai; relay baad mein Kafka `payments.events` par bhejta hai.
- `toResponse` -- spec ka response shape: `amount: { valueMinor, currency }`, optional `failureCode`, `nextAction`.

### Step 5 -- Chalake dikhao (usage + real output)

```ts
import {
  FakePsp, HttpResult, InMemoryIdempotencyStore, InMemoryLedger, Order, PaymentService, requestFingerprint,
} from './payment-idempotency';

let fakeNow = 0;
const store = new InMemoryIdempotencyStore(() => fakeNow);
const psp = new FakePsp();
const ledger = new InMemoryLedger();
const orders = new Map<string, Order>();
const amounts = [['ord_101', 49900], ['ord_102', 19900], ['ord_103', 49900], ['ord_104', 9900],
  ['ord_105', 9900], ['ord_106', 29900], ['ord_107', 59900]] as const;
for (const [id, amountMinor] of amounts) orders.set(id, { id, customerId: 'cus_priya', amountMinor, currency: 'INR' });
orders.set('ord_900', { id: 'ord_900', customerId: 'cus_rahul', amountMinor: 1000, currency: 'INR' });
const svc = new PaymentService(store, psp, ledger, orders);

const P = 'cus_priya';
const pay = (key: string | undefined, orderId: string, token = 'pm_abc') =>
  svc.createPayment(P, key, { orderId, paymentMethodToken: token });
const show = (label: string, r: HttpResult) =>
  console.log(`${label.padEnd(26)} ${r.code} ${JSON.stringify(r.body)}${r.replayed ? ' [replayed]' : ''} psp=${psp.chargesCreated}`);

async function main(): Promise<void> {
  show('A  new key', await pay('k-101', 'ord_101'));
  show('B  retry same key', await pay('k-101', 'ord_101'));
  show('C  same key, new body', await pay('k-101', 'ord_101', 'pm_other'));

  psp.mode = 'decline';
  show('D  card declined', await pay('k-102a', 'ord_102'));
  psp.mode = 'succeed';
  show('E  new key after decline', await pay('k-102b', 'ord_102'));

  psp.mode = 'timeout';
  const f = await pay('k-103', 'ord_103');
  show('F  PSP timeout', f);
  show('G  GET while unknown', svc.getPayment(P, (f.body as { id: string }).id));
  show('H  retry, PSP still down', await pay('k-103', 'ord_103'));
  psp.mode = 'succeed';
  show('I  retry, PSP back', await pay('k-103', 'ord_103'));

  const [j1, j2] = await Promise.all([pay('k-104', 'ord_104'), pay('k-104', 'ord_104')]);
  show('J1 same key parallel', j1);
  show('J2 same key parallel', j2);
  const [k1, k2] = await Promise.all([pay('k-105a', 'ord_105'), pay('k-105b', 'ord_105')]);
  show('K1 double-click key A', k1);
  show('K2 double-click key B', k2);

  // server A claimed k-106 and crashed before doing anything
  store.claim(P, 'k-106', requestFingerprint('POST', '/v1/payments', { orderId: 'ord_106', paymentMethodToken: 'pm_abc' }));
  fakeNow = 30_000;
  show('L  retry at +30s', await pay('k-106', 'ord_106'));
  fakeNow = 61_000;
  show('M  retry at +61s', await pay('k-106', 'ord_106'));

  psp.mode = 'requires_action';
  show('N  3-D Secure', await pay('k-107', 'ord_107'));
  psp.mode = 'succeed';
  show('O  missing key', await pay(undefined, 'ord_101'));
  show('P  not your order', await pay('k-900', 'ord_900'));
  show('Q  unknown order', await pay('k-999', 'ord_999'));

  console.log(`R  ledger entries=${ledger.size} balanced=${ledger.isBalanced()} psp_clearing=${ledger.balance('psp_clearing')} sales_revenue=${ledger.balance('sales_revenue')}`);
  console.log(`S  outbox=${svc.outbox.map((e) => `${e.aggregateId}:${e.eventType}`).join(', ')}`);
  fakeNow = 61_000 + 24 * 60 * 60 * 1000;
  console.log(`T  after 24h sweepExpired removed=${store.sweepExpired()}`);
  show('U  k-101 reused after 24h', await pay('k-101', 'ord_101', 'pm_other'));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
```

**Actual output:**

```
A  new key                 201 {"id":"pay_001","status":"SUCCEEDED","amount":{"valueMinor":49900,"currency":"INR"}} psp=1
B  retry same key          201 {"id":"pay_001","status":"SUCCEEDED","amount":{"valueMinor":49900,"currency":"INR"}} [replayed] psp=1
C  same key, new body      422 {"error":"IDEMPOTENCY_KEY_REUSED"} psp=1
D  card declined           201 {"id":"pay_002","status":"FAILED","amount":{"valueMinor":19900,"currency":"INR"},"failureCode":"card_declined"} psp=2
E  new key after decline   201 {"id":"pay_003","status":"SUCCEEDED","amount":{"valueMinor":19900,"currency":"INR"}} psp=3
F  PSP timeout             202 {"id":"pay_004","status":"PROCESSING"} psp=4
G  GET while unknown       200 {"id":"pay_004","status":"PROCESSING","amount":{"valueMinor":49900,"currency":"INR"}} psp=4
H  retry, PSP still down   202 {"id":"pay_004","status":"PROCESSING"} psp=4
I  retry, PSP back         201 {"id":"pay_004","status":"SUCCEEDED","amount":{"valueMinor":49900,"currency":"INR"}} psp=4
J1 same key parallel       201 {"id":"pay_005","status":"SUCCEEDED","amount":{"valueMinor":9900,"currency":"INR"}} psp=5
J2 same key parallel       409 {"error":"IDEMPOTENCY_IN_PROGRESS"} psp=5
K1 double-click key A      201 {"id":"pay_006","status":"SUCCEEDED","amount":{"valueMinor":9900,"currency":"INR"}} psp=6
K2 double-click key B      409 {"error":"ORDER_ALREADY_PAID"} psp=6
L  retry at +30s           409 {"error":"IDEMPOTENCY_IN_PROGRESS"} psp=6
M  retry at +61s           201 {"id":"pay_007","status":"SUCCEEDED","amount":{"valueMinor":29900,"currency":"INR"}} psp=7
N  3-D Secure              201 {"id":"pay_008","status":"REQUIRES_ACTION","amount":{"valueMinor":59900,"currency":"INR"},"nextAction":{"type":"redirect","url":"https://psp.example/3ds/psp_8"}} psp=8
O  missing key             400 {"error":"IDEMPOTENCY_KEY_REQUIRED"} psp=8
P  not your order          403 {"error":"FORBIDDEN"} psp=8
Q  unknown order           404 {"error":"ORDER_NOT_FOUND"} psp=8
R  ledger entries=12 balanced=true psp_clearing=169400 sales_revenue=-169400
S  outbox=pay_001:payment.succeeded, pay_002:payment.failed, pay_003:payment.succeeded, pay_004:payment.succeeded, pay_005:payment.succeeded, pay_006:payment.succeeded, pay_007:payment.succeeded
T  after 24h sweepExpired removed=11
U  k-101 reused after 24h  409 {"error":"ORDER_ALREADY_PAID"} psp=8
```

**Code Explanation -- output kya prove karta hai:**

- `fakeNow` + `new InMemoryIdempotencyStore(() => fakeNow)` -- fake clock. `psp=` column = PSP par **asli charges** kitne bane. Yahi double-charge ka sabse seedha proof hai.
- Orders: sab `cus_priya` ke, sirf `ord_900` `cus_rahul` ka. `ord_101` = 49,900 paise (Rs 499) -- spec wala example.
- **A** -- naya key -> 201 SUCCEEDED, `psp=1`.
- **B** -- same key, same body (maano response network mein kho gaya tha) -> **same 201 body, `[replayed]`, `psp=1`**. PSP ko chhua bhi nahi.
- **C** -- same key, alag token -> **422**. Client bug pakda gaya, purana result chupke se nahi lautaya.
- **D** -- decline -> **201 + `FAILED` + `card_declined`**. Error code nahi, valid outcome.
- **E** -- same order, **naya key** -> SUCCEEDED. FAILED payment order ko block nahi karti (`activeByOrder.delete`).
- **F** -- timeout mode: PSP ne charge **bana diya** (`psp=4`) lekin humein response nahi mila -> **202 PROCESSING**. FAILED nahi bola -- warna user dobara pay karta aur double charge.
- **G** -- `GET` bhi `PROCESSING` dikhata hai (read-after-write, sach bolo: pata nahi).
- **H** -- same key retry, PSP abhi bhi down -> resume path: `getPaymentByIdempotencyKey` fail, `charge` (same key) fail -> phir 202. `psp=4` -- koi naya charge nahi.
- **I** -- PSP wapas -> resume: PSP bola "succeeded" -> **201 SUCCEEDED, `psp=4`**. Timeout wala charge hi confirm hua, doosra nahi bana.
- **J1/J2** -- **same key, `Promise.all`** -> ek 201, doosra **409 IN_PROGRESS**. `psp=5` -- sirf ek charge.
- **K1/K2** -- double-click jisme app ne **do alag keys** bheji -> doosra **409 `ORDER_ALREADY_PAID`**. Idempotency key yahan kuch nahi kar sakti; order-level safety net ne bachaya.
- **L/M** -- "server A" ne `k-106` claim kiya aur crash (humne `store.claim` direct call kiya aur kuch nahi kiya). +30 s par retry -> **409** (lock valid). +61 s par -> lock expired -> **takeover**, `STARTED` se resume -> 201.
- **N** -- 3-D Secure -> 201 `REQUIRES_ACTION` + `nextAction.url`. Ledger entry nahi (paisa abhi confirm nahi).
- **O/P/Q** -- 400 missing key, 403 kisi aur ka order, 404 unknown order.
- **R** -- 6 successful payments x 2 lines = **12 entries**, `balanced=true`, `psp_clearing = 169400` = 49900 + 19900 + 49900 + 9900 + 9900 + 29900. `sales_revenue = -169400` (credit side).
- **S** -- outbox: 6 `payment.succeeded` + 1 `payment.failed`. `pay_008` (REQUIRES_ACTION) ka event abhi nahi.
- **T** -- 24h baad `sweepExpired` ne saare **11 keys** hata diye (missing-key wali request ne record banaya hi nahi).
- **U** -- `k-101` ab expire ho chuka, toh 422 nahi aaya -- naya claim hua. Lekin order already paid -> **409**. Isliye 24h expiry safe hai: key ke baad bhi order-level constraint khada hai.

### Step 6 -- Concurrency: `Promise.all` wala case (interviewer yahan dabayega)

J1/J2 kyun safe hai? Timeline dekho (ek hi Node process):

```
t0  call-1: validate -> claim()  [sync: get = empty, set IN_PROGRESS]  -> run -> Phase 1 -> await psp.charge ...
t0  call-2: validate -> claim()  [sync: get = IN_PROGRESS, lock valid]  -> return 409
t5  call-1: PSP result -> applyResult (sync) -> complete -> 201
```

- `async` function pehle `await` tak **synchronously** chalta hai. `claim()` mein koi `await` nahi, toh call-1 ka "check + set" poora ho jaata hai **usse pehle** ki event loop call-2 ko chalaye.
- **Galat version:** agar store async hota (`const r = await store.get(k); if (!r) await store.set(k, ...)`), toh dono calls `await store.get` par ruk jaate, dono ko "empty" milta, dono PSP ko call karte. PSP key = payment id hai aur dono ki payment id alag banti -> **do charges**.
- **Ye guarantee sirf ek process ki hai.** 2 Node instances, PM2 cluster, ya worker threads = alag alag `Map` -> dono "empty" dekhenge.
- **Production fix:** `INSERT INTO idempotency_keys ... ON CONFLICT (customer_id, key) DO NOTHING RETURNING *`. Postgres ka **unique constraint** atomic hai across all instances: do inserts race karein toh ek hi jeetega, doosre ko 0 rows. Wahi decision table, bas "sync function" ki jagah "unique index" guarantee de raha hai.
- Aur Redis `SET NX` kyun nahi? Key **payment ke saath same transaction** mein commit honi chahiye; Redis alag system hai, crash beech mein aaya toh key aur payment out of sync. Isliye spec: "yahan Redis ki zarurat nahi".

> Interview line: "In-memory version single process mein correct hai kyunki claim synchronous hai -- check aur set ke beech event loop switch nahi karta. Multiple instances par main yahi decision table Postgres par le jaunga: `ON CONFLICT DO NOTHING` claim, unique constraint race ko resolve karta hai, aur key + payment + ledger ek hi transaction mein commit hote hain."

### Step 7 -- Edge cases (interviewer zaroor poochega)

| Edge case | Humara code kya karta hai | Production (Parts 2-4) mein |
|---|---|---|
| Same key + alag body | 422 `IDEMPOTENCY_KEY_REUSED` (hash check sabse pehle) | Same; `idempotency_conflicts_total{reason="reused"}` |
| Same key, abhi chal rahi | 409 `IDEMPOTENCY_IN_PROGRESS` | Same; client backoff + jitter se retry |
| Same key, complete | Replay same code + body, `replayed: true` | + header `Idempotent-Replayed: true`; `idempotency_replays_total` |
| PSP timeout | 202 PROCESSING, key IN_PROGRESS @ `PSP_CALLED`, lock released | + recovery worker har 1 min stuck payments resolve karta hai |
| Retry jab PSP abhi bhi down | Phir 202, koi naya charge nahi | Circuit breaker open -> 503 `PSP_UNAVAILABLE` (tab jab PSP ko call gaya hi nahi) |
| Server crash beech mein | Lock 60 s -> takeover, `recoveryPoint` se resume | Same (`UPDATE ... WHERE locked_until < now()`) |
| Slow (not crashed) server ka lock expire | **Do workers** same record par; PSP key = payment id + conditional transition ki wajah se double charge / double ledger nahi | Same; lock time > PSP timeout (10 s) + margin rakho |
| Do alag keys, same order | 409 `ORDER_ALREADY_PAID` (`activeByOrder`) | Partial unique index `ux_payments_one_active_per_order` |
| Decline ke baad retry | Same key -> FAILED replay; naya key -> naya attempt | Same; client UX "try another card" = naya key |
| Webhook pehle aa gaya | `transition` false -> ledger dobara nahi, current state return | Same conditional UPDATE; `webhook_events` PK dedupe |
| REQUIRES_ACTION ke baad replay | Replay purana `REQUIRES_ACTION` dikhata hai | Client latest ke liye `GET /v1/payments/:id` kare -- replay = original response, live state nahi |
| Amount tampering | Amount order se; body mein amount hai hi nahi | Same + order ownership check |
| Unbalanced ledger / float amount | `post()` throw, kuch likha nahi | DB CHECK + `ledger_imbalance_total` alert (must be 0) |
| Key 24h ke baad reuse | Naya claim; order constraint phir bhi rokta hai (U) | Same; cleanup job |
| Multi-instance / cluster mode | **Broken** -- har process ka apna `Map` | Postgres unique constraint + transactions |
| Process restart | Saari keys gayab | Postgres durable hai -- isliye keys DB mein |

### Step 8 -- Complexity

Symbols: **K** = live idempotency keys, **E** = ledger entries, **A** = entries of one account.

| Operation | Time | Kyun |
|---|---|---|
| `claim` | **O(1)** average | Ek `Map` get/set + ek hash compare. SHA-256 body size par linear, body chhoti hai (~100 B) |
| `createPayment` (end to end) | **O(1)** average (+ PSP latency) | Constant number of Map ops + 1-2 PSP calls. Asli time PSP ka hai: 300 ms - 3 s |
| `ledger.post` | O(lines) = O(1) | Payment = 2 lines |
| `sweepExpired` | **O(K)** | Saari keys scan -- background job, request path par nahi |
| `ledger.balance` / `isBalanced` | O(E) | Demo helpers; production mein `(account, created_at)` index + reconciliation job |

| Structure | Space | Kyun |
|---|---|---|
| Idempotency store | **O(K)**, 24h expiry se bounded | Spec numbers: ~1 KB x 5M/day = **~5 GB live** -- ek process ki memory mein nahi, ek aur reason Postgres ka |
| Payments + ledger | O(payments) | Append-only, kabhi delete nahi; ~2 KB/payment -> 10 GB/day |

> Interview line: "Har operation O(1) average hai -- ek hash lookup aur constant writes; latency PSP dominate karta hai, humara code nahi. Space O(K) keys ka hai jo 24 hours ki expiry se bounded hai -- hamare scale par ~5 GB, isliye production mein ye Postgres table hai, process memory nahi."

---

## PART 27 -- 30-Second Answer

> "At a high level, I would use stateless Node.js Payment Service instances ke peeche ek PostgreSQL primary, aur card data kabhi hamare paas nahi aata -- PSP ka SDK usko token bana deta hai. Har write API idempotent hai: client `Idempotency-Key` bhejta hai, hum usko payment ke saath same Postgres mein `ON CONFLICT DO NOTHING` se claim karte hain -- replay, 409 in-progress, ya 422 reused. Payment teen atomic phases mein chalti hai, aur PSP ko hamari payment id idempotency key ki tarah jaati hai, toh retry kabhi double charge nahi karta. PSP timeout ko failure nahi, unknown maante hain -- 202 PROCESSING, phir recovery worker aur webhooks se resolve. Har success double-entry ledger mein, events transactional outbox se Kafka par, aur daily reconciliation PSP ke saath. Correctness over availability -- doubt ho toh fail closed."

(Bolne mein ~40 seconds. Tokenization, idempotency key, PSP key, timeout = unknown, ledger + outbox + reconciliation, fail closed -- bas.)

---

## PART 28 -- 5-Minute Interview Answer (natural Hinglish)

> Ise ratna nahi hai. Har minute ka **goal** yaad rakho; words apne aap aayenge. Beech beech mein check-in: "Is this direction okay?"

### 0:00 - 0:45 -- Requirements clarify karo

"Main pehle requirements clarify karunga. Hum khud bank nahi hain na -- ShopKart ek merchant hai jo Razorpay ya Stripe jaise PSP ko integrate karta hai? ... Theek hai. Toh scope: order ke liye payment create karna, card aur UPI, status dekhna, full aur partial refunds, PSP webhooks, aur baaki services ko 'payment succeeded' batana. Plus ek ledger aur daily reconciliation.

Non-functional mein sabse upar **correctness**: no double charge, no lost payment, ledger hamesha balanced. Uske baad durability -- 7 saal ka audit trail. Security -- PCI scope chhota. Availability 99.95%, lekin doubt ho toh fail closed. Latency PSP dominate karega, p99 2-3 second acceptable hai."

### 0:45 - 1:30 -- Scale estimate

"Maan lete hain 5 million payments per day. 5 million by 86,400 -- roughly 58 per second average. Big sale par 10x, ~580; main **1,000 TPS peak** ke liye plan karunga. Har payment ~3 DB transactions aur ~10 row writes, toh peak par ~10K row writes per second -- ek well-tuned Postgres primary handle kar leta hai. Storage ~2 KB per payment, 10 GB per day, 7 saal mein ~25.5 TB -- monthly partitions.

Yahan asli problem scale nahi, correctness hai. Aur real bottleneck hamara DB nahi, **PSP** hai -- uski latency, uske rate limits, uske outages."

### 1:30 - 2:30 -- Architecture + idempotency

"Initially main simple architecture rakhunga. Client par PSP ka SDK card ko tokenize karta hai -- humein sirf `pm_` token milta hai. Phir LB ya API gateway -- TLS aur `POST /v1/payments` par rate limit. Phir stateless Node.js Payment Service, aur ek PostgreSQL primary with replica -- payments, idempotency keys, ledger, outbox, sab ek hi DB mein.

Network timeout hota hai, user double-click karta hai, mobile app retry karti hai. Isliye har write API idempotent hogi. Client `Idempotency-Key` UUID bhejta hai. Hum `INSERT ... ON CONFLICT DO NOTHING` se key claim karte hain. Row mili toh hum owner hain. Nahi mili toh: body ka hash alag -> 422, completed -> stored response replay, abhi chal rahi -> 409, aur lock expire ho gaya -> takeover karke recovery point se resume.

Redis yahan nahi -- key ko payment ke saath same transaction mein commit hona chahiye. Aur amount hamesha order se, client se kabhi nahi."

### 2:30 - 3:30 -- Atomic phases + PSP timeout

"Payment teen phases mein. Phase 1 transaction: key claim, payment row `CREATED`. Phase 2 transaction ke bahar: `PROCESSING` mark karo aur PSP ko call karo -- **PSP idempotency key = hamari payment id**, toh hum PSP ko 10 baar bhi call karein, charge ek hi banega. Phase 3 transaction: status, ledger entries, outbox event, key completed with response -- ek commit.

However, PSP timeout ka matlab failure nahi, unknown hai. Ho sakta hai paisa kat chuka ho. Toh payment `PROCESSING` rehti hai, client ko 202 milta hai, key complete nahi hoti. Client ka retry ya har minute chalne wala recovery worker PSP se poochta hai `getPaymentByIdempotencyKey`, aur webhook bhi aata hai. State machine conditional updates se chalti hai -- terminal state kabhi peeche nahi jaati, late webhook ignore. Aur do alag keys se double-click ke liye partial unique index: ek order ki ek hi active payment."

### 3:30 - 4:15 -- Ledger, events, reconciliation, security

"Har success par double-entry ledger: debit `psp_clearing`, credit `sales_revenue`, integer paise mein, append-only -- corrections reversing entries se. Order aur Notification service ko events **transactional outbox** se jaate hain: event row Phase 3 wale transaction mein, relay worker usko Kafka `payments.events` par daalta hai, consumers `event_id` par dedupe karte hain. Direct Kafka publish karta toh DB commit aur publish ke beech crash par event kho jaata.

Daily reconciliation PSP ki settlement file ko ledger se match karti hai -- mismatch review queue mein. Security: tokenization se PCI scope chhota, webhooks par HMAC signature `timingSafeEqual` se verify, aur har payment par owner check."

### 4:15 - 5:00 -- Failures, trade-offs, wrap-up

"PSP down ho toh circuit breaker open -- 503 `PSP_UNAVAILABLE`, kuch charge nahi hua, same key se retry safe. DB down ho toh fail closed -- payment nahi lenge. Kafka down ho toh outbox mein events jama hote hain, payment nahi rukta.

One trade-off here is availability vs correctness: hum doubt mein 'try again' dikhana pasand karte hain bajaye double charge ke. Doosra -- idempotency keys Postgres mein rakhne se har request par ek extra write hai, Redis se thoda slow, lekin atomic aur durable. Aur 1,000 TPS par sharding ki zarurat nahi; bade scale par `customer_id` se shard karenge, idempotency keys same shard par.

Summary: tokenization, idempotent APIs Postgres mein, atomic phases with PSP idempotency key, timeout = unknown, ledger, outbox, reconciliation. Kisi part mein deep dive karein?"

---

## PART 29 -- Whiteboard Drawing Order

**Rule:** diagram ek saath mat banao. Har box tab draw karo jab uska **reason** bol rahe ho. Payment system mein ek extra rule: board par **money path** (client -> service -> PSP) aur **truth store** (Postgres) ko sabse bold rakho. Cache, CDN, Redis is path par hain hi nahi -- aur ye bolna answer ka part hai.

### Step 1 -- Client (+ PSP SDK tokenization)

```
[Mobile / Web client]
   PSP SDK: card -> pm_token   (card number kabhi hamare server par nahi)
```

**Ab interviewer ko kya explain karna hai?**

> "Card data PSP ke hosted fields / SDK mein tokenize hota hai, humein sirf `pm_abc` milta hai -- PCI DSS scope chhota. Client har logical payment attempt ke liye ek `Idempotency-Key` UUID banata hai aur har retry par wahi bhejta hai."

**Abhi mat draw karo:** DNS, CDN (koi static content nahi), multi-region.

### Step 2 -- LB / API Gateway (rate limit)

```
[Client] --POST /v1/payments + Idempotency-Key-->
[LB / API Gateway]  TLS, JWT check, rate limit on POST /v1/payments
```

**Ab interviewer ko kya explain karna hai?**

> "Gateway TLS terminate karta hai aur `POST /v1/payments` par rate limit lagata hai -- card testing attacks aur buggy retry loops yahin rukte hain. Ye pichhle system (Rate Limiter) wala component hai; wahan Redis theek tha kyunki woh counter hai, payment state nahi."

**Abhi mat draw karo:** WAF vendor details.

### Step 3 -- Payment Service (stateless Node.js)

```
[Client]
   |
[LB / API Gateway]
   |
   +-------------+-------------+
   v             v             v
[Payment Svc] [Payment Svc] [Payment Svc]   stateless Node.js (Express 5), N instances
   claim key -> Phase 1 -> Phase 2 (PSP) -> Phase 3
```

**Ab interviewer ko kya explain karna hai?**

> "Instances stateless hain -- koi bhi request kisi bhi instance par ja sakti hai, retry bhi. Isliye idempotency state memory mein nahi reh sakti; shared, durable store chahiye. Side mein responses likh do: 201 / 202 / 409 / 422 / 503."

### Step 4 -- Postgres (payments, idempotency_keys, ledger, outbox)

```
[Payment Svc x N]
   |  Tx1: INSERT idempotency_keys ON CONFLICT DO NOTHING + payments CREATED
   |  Tx2: payment status + ledger_entries + outbox + key COMPLETED (one commit)
   v
[PostgreSQL primary] --replica (HA)
   payments | idempotency_keys | ledger_entries | outbox | refunds | webhook_events
```

**Ab interviewer ko kya explain karna hai?**

> "Ye source of truth hai. Sab tables ek DB mein kyunki key, payment, ledger aur outbox **ek hi transaction** mein commit hone chahiye -- ye ACID sirf ek DB de sakta hai. `(customer_id, key)` primary key race resolve karti hai; partial unique index ek order ki ek active payment. 1,000 TPS peak = ~10K row writes/s, ek primary kaafi. GET bhi primary se (read-after-write)."

**Abhi mat draw karo:** Redis. Agar interviewer poochhe: "Yahan Redis ki zarurat nahi -- key payment ke saath same commit mein chahiye, aur Redis source of truth nahi hai." Sharding bhi abhi nahi.

### Step 5 -- PSP (external)

```
[Payment Svc] --HTTPS charge(idempotencyKey = pay_id), 10s timeout, retry w/ backoff + jitter, circuit breaker--> [PSP: Razorpay / Stripe]
```

**Ab interviewer ko kya explain karna hai?**

> "Phase 2 transaction ke **bahar** -- DB transaction PSP ke 3 second ke liye khula nahi rakhte. PSP key = hamari payment id, toh retries safe. Retry sirf network / 5xx / 429 par. Timeout = unknown -> 202 PROCESSING, kabhi FAILED nahi. Real bottleneck yahi box hai."

### Step 6 -- Webhook endpoint

```
[PSP] --POST /webhooks/psp (X-PSP-Signature)--> [Payment Svc]
         verify HMAC(raw body) -> INSERT webhook_events ON CONFLICT DO NOTHING -> conditional transition -> 200
```

**Ab interviewer ko kya explain karna hai?**

> "3-D Secure / UPI ka final result webhook se aata hai. Webhooks late, duplicate, out of order aate hain: signature verify, `(psp, psp_event_id)` se dedupe, aur conditional update -- terminal state peeche nahi jaati. Hamari galti par 500, taaki PSP retry kare."

### Step 7 -- Outbox relay + Kafka -> Order / Notification

```
[Postgres outbox] --relay worker polls--> [Kafka: payments.events, key = payment id]
                                               |                 |
                                        [Order Service]  [Notification Service]
                                         (dedupe on event_id in processed_events)
```

**Ab interviewer ko kya explain karna hai?**

> "Event DB ke saath atomic hai kyunki outbox row Phase 3 wale transaction mein hai. Relay at-least-once bhejta hai, consumers `event_id` par dedupe karte hain -- effectively exactly-once effect. Kafka down ho toh events outbox mein wait karte hain, payments nahi rukte. SQS/RabbitMQ bhi chalega."

### Step 8 -- Recovery worker + reconciliation

```
[Recovery worker, every 1 min] -- stuck IN_PROGRESS keys / PROCESSING payments --> ask PSP --> apply
[Reconciliation job, daily]    -- PSP settlement file vs ledger --> mismatches -> review queue + alert
```

**Ab interviewer ko kya explain karna hai?**

> "Recovery worker woh payments resolve karta hai jinka client kabhi retry nahi karta. Reconciliation last safety net hai: agar sab mechanisms ke baad bhi kuch gadbad hui, toh ek din ke andar pakdi jaayegi. Metrics: `payments_stuck_processing`, `reconciliation_mismatches_total`, `ledger_imbalance_total` (must be 0)."

### Final board (aisa dikhna chahiye)

```
[Client + PSP SDK (pm_token)]
            |  POST /v1/payments + Idempotency-Key
    [LB / API Gateway]  TLS, rate limit
            |
   +--------+--------+
   v        v        v
 [Payment Service x N, stateless Node.js] --charge(key = pay_id)--> [PSP]
   |   Tx1 claim + CREATED | Tx2 status + ledger + outbox + key       |
   v                                                                  |
 [PostgreSQL primary + replica]  <---- POST /webhooks/psp (HMAC) -----+
   payments | idempotency_keys | ledger_entries | outbox | webhook_events
   |                         ^                          ^
   | outbox relay            | recovery worker (1 min)  | reconciliation (daily, PSP file)
   v
 [Kafka payments.events] --> [Order Service] [Notification Service]

 No Redis on the payment path. No cache. No CDN.
```

### Kya **bilkul** draw nahi karna (jab tak pooche nahi)

- Redis / cache on payment path -- source of truth nahi, same transaction mein nahi aa sakta.
- CDN, Elasticsearch -- koi use nahi.
- Sharding, multi-region active-active -- 1,000 TPS par zarurat nahi; V3 discussion (Part 5).
- Microservices ka jungle (ledger service, risk service, ...) -- pehle ek Payment Service.

---

## PART 30 -- Final Cheat Sheet (5 minute revision)

### Problem

ShopKart (merchant) orders ke liye card / UPI payments leta hai via external **PSP**. Paisa **exactly once** move hona chahiye -- jabki network timeout, double-click, mobile retries, server crash, aur late / duplicate / out-of-order webhooks sab hote hain. Core tool: **Idempotent API**. Rule: **correctness over availability -- fail closed.**

### Requirements

| Type | Points |
|---|---|
| Functional | `POST /v1/payments` with required `Idempotency-Key`; charge via PSP (card/UPI, async `REQUIRES_ACTION`); `GET /v1/payments/:id`; full/partial refunds (idempotent); double-entry ledger; verified + deduped webhooks; events to Order/Notification; daily reconciliation |
| NFR | No double charge, no lost payment, ledger always balanced; exactly-once **effect**; strong consistency for payment + ledger + keys; 7-year audit trail; PCI scope reduction; 99.95% but fail closed; p99 create ~2-3 s (PSP-bound) |
| Clarify first | Merchant ya PSP khud? Payment methods? Async flows (3DS/UPI)? Refunds partial? Multi-currency? Scale? Retention? |

### Numbers (yaad rakho)

| Metric | Value | Isse kya decide hua |
|---|---|---|
| Payments | 5M/day -> **~58 TPS** avg -> 10x sale ~580 -> plan **~1,000 TPS peak** | Chhota scale -- problem correctness hai |
| DB writes | ~3 txns, ~10 row writes per payment -> **~10K row writes/s** peak | **Ek Postgres primary** kaafi, no sharding |
| Reads | ~5x writes -> ~300 avg / **~5K peak** reads/s | Primary se (read-after-write); replica HA ke liye |
| Storage | ~2 KB/payment -> **10 GB/day** -> 3.65 TB/yr -> **~25.5 TB / 7 yr** | Monthly partitions, archive old |
| Idempotency keys | ~1 KB x 5M = **~5 GB live**, 24h TTL | Postgres table + cleanup job |
| Webhooks | ~3/payment -> 15M/day -> **~174/s** avg | Dedupe table `webhook_events` |
| PSP | 300 ms - 3 s latency, own rate limits, outages | **Real bottleneck**; 10 s timeout, circuit breaker |
| Locks / timers | Key lock 60 s; recovery worker 1 min; stuck alert 10 min; reconciliation daily | Recovery design |

### Idempotency decision table

| Claim result | Condition | Response |
|---|---|---|
| Row inserted | New key | Proceed (we own it) |
| Existing row | `request_hash` different | **422 `IDEMPOTENCY_KEY_REUSED`** |
| Existing row | `COMPLETED` | **Replay** stored code + body, `Idempotent-Replayed: true` |
| Existing row | `IN_PROGRESS`, `locked_until > now()` | **409 `IDEMPOTENCY_IN_PROGRESS`** |
| Existing row | `IN_PROGRESS`, lock expired | **Take over** (`UPDATE ... WHERE locked_until < now()`), resume from `recovery_point` |
| After PSP timeout | outcome unknown | Payment `PROCESSING`, **202**, key stays `IN_PROGRESS` @ `PSP_CALLED`, lock released |

### APIs

| API | Kya |
|---|---|
| `POST /v1/payments` | `Idempotency-Key` required; body `{ orderId, paymentMethodToken }` (amount server-side from order). **201** SUCCEEDED / FAILED (+`failureCode`) / REQUIRES_ACTION (+`nextAction`); **202** PROCESSING |
| Errors | 400 validation / `IDEMPOTENCY_KEY_REQUIRED`, 401, 403 (not your order), 404, 409 `IDEMPOTENCY_IN_PROGRESS`, 409 `ORDER_ALREADY_PAID`, 422 `IDEMPOTENCY_KEY_REUSED`, 429, 503 `PSP_UNAVAILABLE` (nothing charged, retry same key) |
| `GET /v1/payments/:id` | Owner only, from primary |
| `POST /v1/payments/:id/refunds` | Key required; `{ amountMinor, reason }`; 201; 422 `REFUND_EXCEEDS_AMOUNT` |
| `POST /webhooks/psp` | `X-PSP-Signature` HMAC-SHA256 of raw body, `timingSafeEqual`; dedupe insert; 200 fast; 500 on our failure |

### HLD

```
Client (PSP SDK -> pm_token) -> LB / API Gateway (TLS, rate limit)
  -> N stateless Node.js Payment Service (Express 5)
       -> PostgreSQL primary + replica: payments, refunds, idempotency_keys, ledger_entries, webhook_events, outbox
       -> PSP (HTTPS, PSP idempotency key = payment id)
  PSP -> POST /webhooks/psp
  Outbox relay -> Kafka payments.events -> Order, Notification (idempotent consumers)
  Recovery worker (1 min) | Reconciliation job (daily)
```

### LLD

```
src/routes/{payment,webhook}.routes.ts        src/controllers/{payment,webhook}.controller.ts
src/services/payment.service.ts (phases)      src/services/idempotency.service.ts (claim/replay/complete/release)
src/services/{ledger,refund}.service.ts       src/domain/{payment-state,money}.ts
src/psp/psp-client.ts + razorpay.client.ts    (10s timeout, retry network/5xx/429, backoff + jitter, same key, breaker)
src/repositories/{payment,idempotency,ledger,outbox,webhook-event}.repository.ts
src/workers/{outbox-relay,payment-recovery.worker}.ts   src/jobs/reconciliation.job.ts
src/infra/{postgres (withTransaction), kafka, logger, metrics}.ts   src/app.ts | src/server.ts
```

- `PspClient { charge, getPaymentByIdempotencyKey, refund }`; `PspChargeResult.outcome = succeeded | failed | requires_action | unknown`.
- State machine: `CREATED -> PROCESSING -> SUCCEEDED | REQUIRES_ACTION | FAILED`; `REQUIRES_ACTION -> SUCCEEDED | FAILED`; `SUCCEEDED -> PARTIALLY_REFUNDED -> REFUNDED`; `SUCCEEDED -> REFUNDED`. Conditional `UPDATE ... WHERE status = ANY($4)`; rowCount 0 = someone else moved it, not an error.

### Database

```sql
payments(id 'pay_<ULID>' PK, order_id, customer_id, amount_minor BIGINT > 0, currency CHAR(3), status CHECK,
         refunded_minor <= amount_minor, psp, psp_payment_id, failure_code, version, created_at, updated_at)
  ux_payments_one_active_per_order (order_id) WHERE status IN (every status except 'FAILED')  -- two-keys net
  ux_payments_psp_id (psp, psp_payment_id) | ix_payments_stuck (updated_at) WHERE PROCESSING/REQUIRES_ACTION
idempotency_keys(customer_id, key PK, request_path, request_hash, status IN_PROGRESS|COMPLETED,
                 recovery_point STARTED|PAYMENT_CREATED|PSP_CALLED|FINISHED, payment_id, response_code,
                 response_body JSONB, locked_until, created_at)
ledger_entries(id, transaction_id, account, direction DEBIT|CREDIT, amount_minor > 0, currency, payment_id)  -- append-only
refunds(id 're_<ULID>', payment_id FK, amount_minor, status PENDING|SUCCEEDED|FAILED, psp_refund_id)
webhook_events(psp, psp_event_id PK, type, payload, received_at, processed_at)
outbox(id, event_id UNIQUE 'evt_<ULID>', aggregate_id, event_type, payload, published_at)  -- partial idx unpublished
```

Postgres kyun: payment + ledger + key + outbox **ek commit** (ACID), unique/partial indexes, CHECKs. READ COMMITTED + unique constraints + conditional updates (SERIALIZABLE nahi chahiye). Monthly partitions.

### Redis

**Payment path par nahi.** Idempotency keys aur payment state Redis mein nahi, kyunki: (1) key ko payment ke saath **same transaction** mein commit hona hai; (2) Redis source of truth nahi (eviction, async replication, failover par loss); (3) 58 TPS avg par Postgres ka extra write koi problem nahi. Redis sirf gateway ke **rate limiting** mein (Rate Limiter system). Interview line: "Yahan Redis ki zarurat nahi."

### Queue

**Kafka `payments.events`** (key = payment id -> per-payment ordering), fed by **transactional outbox** (relay worker). Consumers (Order, Notification) dedupe via `processed_events(event_id PK)`. Justification: ek event, multiple consumers, replay. SQS / RabbitMQ bhi chalega (Part 5 trade-off). PSP call queue ke peeche nahi -- user ko sync result chahiye.

### Main Algorithm

**Idempotent API with atomic phases (Stripe-style):**

1. **Tx 1:** claim key (`ON CONFLICT DO NOTHING`); load order (amount from order); insert payment `CREATED` (`pay_<ULID>`); `recovery_point = PAYMENT_CREATED`.
2. **No tx:** mark `PROCESSING`, `recovery_point = PSP_CALLED`; `psp.charge({ idempotencyKey: payment.id, ... })`.
3. **Tx 2:** status + ledger (DEBIT `psp_clearing` / CREDIT `sales_revenue`) + outbox + key `COMPLETED` with response, `FINISHED`.
4. **Timeout:** stay `PROCESSING`, 202, key IN_PROGRESS @ `PSP_CALLED`, lock released -> retry / recovery worker: `getPaymentByIdempotencyKey` (or charge again, same key).

Supporting: double-entry ledger (sum DEBIT = sum CREDIT per `transaction_id`, integer paise); exponential backoff + jitter; conditional state transitions; reconciliation.

### Scaling

| Stage | Change |
|---|---|
| V1 | One Node service + Postgres; idempotency keys table; sync PSP call; ledger |
| V2 -- our numbers (~1,000 TPS peak) | N stateless instances, Postgres primary + replica, outbox + Kafka, recovery worker, reconciliation, circuit breaker, monthly partitions |
| V3 -- bigger | Shard by `customer_id` (keys + payments same shard), multiple PSPs with routing, ledger as its own service, archive to cold storage |

### Consistency

| Where | Level |
|---|---|
| Payment + ledger + idempotency key | **Strong** (one Postgres transaction, primary) |
| `GET /v1/payments/:id` | **Read-after-write** (reads from primary) |
| Order / Notification via Kafka | **Eventual** (outbox, at-least-once + dedupe) |
| Us vs PSP | **Converge** via webhooks + recovery worker + daily reconciliation |

### Failure Handling

| Failure | Behaviour |
|---|---|
| PSP timeout / unknown | `PROCESSING` + 202; retry or recovery worker asks PSP; **never FAILED** |
| PSP down | Circuit breaker open -> 503 `PSP_UNAVAILABLE` (nothing charged, retry same key) |
| Crash between phases | Lock 60 s expires -> takeover from `recovery_point`; recovery worker every 1 min |
| DB down | **Fail closed** -- no payment accepted |
| Kafka down | Outbox rows accumulate; `outbox_oldest_unpublished_age_seconds` alert; payments continue |
| Webhook late / duplicate / out of order | `webhook_events` PK dedupe; conditional transitions; terminal never goes back; 500 -> PSP retries |
| Money mismatch | Daily reconciliation -> review queue + alert |

### Security

- **Tokenization** (PSP SDK / hosted fields) -> raw card kabhi server par nahi -> PCI DSS scope chhota.
- **Webhook HMAC-SHA256** of raw body, `crypto.timingSafeEqual`.
- **IDOR**: payment / order owner check (403 / 404).
- **Amount tampering**: amount order se, client se kabhi nahi.
- Rate limit on `POST /v1/payments` (card testing); idempotency keys scoped per customer.

### Observability

`payments_total{status}`, `payment_success_rate`, `psp_request_duration_seconds{op}`, `psp_errors_total{op,reason}`, `payments_stuck_processing`, `idempotency_replays_total`, `idempotency_conflicts_total{reason="in_progress|reused"}`, `webhook_processing_lag_seconds`, `outbox_oldest_unpublished_age_seconds`, `reconciliation_mismatches_total`, **`ledger_imbalance_total` (must always be 0)**.

### Top 5 Trade-offs

| Decision | Chosen | Kyun | Kab badlega |
|---|---|---|---|
| Idempotency store | Postgres, same DB | Same transaction as payment, durable, unique constraint | Very high scale -> shard with payments; never "Redis only" for money |
| Failure policy | Fail closed | Double charge / lost payment > downtime ka nuksaan | Non-money reads (status page) can degrade gracefully |
| PSP call | Outside transaction, 3 phases | DB locks PSP latency tak nahi pakadte | -- (DB txn ke andar network call = anti-pattern) |
| Events | Transactional outbox + Kafka | DB + event atomic; fan-out; replay | Chhota system -> outbox + simple queue (SQS/RabbitMQ) |
| Timeout handling | Unknown -> 202 + resolve later | Paisa shayad kat chuka hai | Kabhi nahi -- "timeout = failed" hamesha galat |

### Top 10 Follow-up Questions (one-line answers)

| # | Question | One-line answer |
|---|---|---|
| 1 | Same request do baar aaye? | Same `Idempotency-Key` -> stored response replay, PSP ko call hi nahi |
| 2 | Same key, alag body? | Fingerprint mismatch -> 422 `IDEMPOTENCY_KEY_REUSED` |
| 3 | Do requests same key ek saath? | `ON CONFLICT DO NOTHING` -- ek jeetta hai, doosre ko 409 in-progress |
| 4 | PSP timeout ho gaya? | Unknown, failure nahi -> 202 PROCESSING, PSP se `getPaymentByIdempotencyKey` se poochho |
| 5 | Retry se PSP par double charge? | PSP idempotency key = hamari payment id -> PSP same charge lautata hai |
| 6 | Server crash between phases? | Lock expire -> takeover -> `recovery_point` se resume; recovery worker har minute |
| 7 | User ne double-click kiya, app ne 2 keys bheji? | Partial unique index: ek order ki ek active payment -> 409 `ORDER_ALREADY_PAID` |
| 8 | Webhook response se pehle aa gaya? | Conditional update; jo pehle jeete; doosra rowCount 0 dekh ke re-read, error nahi |
| 9 | Order service ko event reliably kaise? | Transactional outbox + relay + Kafka; consumers `event_id` par dedupe |
| 10 | Redis mein keys kyun nahi? | Key payment ke saath same commit mein chahiye; Redis source of truth nahi |

### 30-second answer

PART 27 dekho. Skeleton: **tokenization -> stateless Node + Postgres -> Idempotency-Key claimed in Postgres (replay / 409 / 422) -> 3 atomic phases, PSP key = payment id -> timeout = unknown, 202 -> ledger + outbox + reconciliation -> fail closed.**

### 5-minute answer (skeleton -- full text PART 28 mein)

1. **0:00** Requirements: merchant + PSP, create/status/refund/webhooks/events/ledger/recon; NFR = correctness first, fail closed.
2. **0:45** Numbers: 5M/day -> 58 TPS -> 1,000 peak; ~10K row writes/s = one Postgres; 25.5 TB / 7 yr; "asli problem correctness hai"; PSP = bottleneck.
3. **1:30** HLD (SDK token -> gateway -> Node -> Postgres -> PSP); "har write API idempotent hogi"; decision table; no Redis.
4. **2:30** 3 phases + PSP key = payment id; "PSP timeout ka matlab failure nahi, unknown hai"; state machine; order-level unique index.
5. **3:30** Ledger, outbox + Kafka, reconciliation, security (tokenization, HMAC, owner check).
6. **4:15** Failures (PSP down 503, DB down fail closed, Kafka down outbox); "One trade-off here is..."; "deep dive kahan?"

### MOST IMPORTANT RULE -- 5 sawaal, 3 key decisions par

| Sawaal | Idempotency keys in Postgres | Atomic phases + PSP idempotency key | Transactional outbox |
|---|---|---|---|
| **Hum ye kyun kar rahe hain?** | Retries/double-clicks ko exactly-once effect dena; key + payment ek transaction mein commit; unique constraint saare instances ke beech race resolve karta hai | PSP call ko DB transaction ke bahar rakhna, crash ke baad `recovery_point` se resume, aur PSP par bhi retry safe (key = payment id) | Payment commit aur "payment.succeeded" event dono ho ya dono na ho |
| **Agar ye nahi kiya toh?** | Timeout ke baad retry = **double charge**; in-memory = har instance alag; Redis = crash par key aur payment out of sync | Ek bade txn mein PSP call -> DB locks seconds tak, pool khatam; PSP key na ho -> retry par doosra charge; crash -> kaun sa step hua pata nahi | Direct publish: commit ke baad crash -> event lost (order kabhi confirm nahi); publish pehle -> rollback par jhootha event |
| **Iska alternative kya hai?** | Redis `SET NX`, separate idempotency service, sirf order-level unique constraint, client-side dedupe | Ek hi transaction mein sab; saga / workflow engine (Temporal); queue ke peeche async charge | Direct Kafka publish, CDC (Debezium on WAL), 2PC/XA, polling payments table |
| **Alternative kab choose karenge?** | Non-money idempotency (e.g. "send email once") -> Redis NX chal jaata hai; order-level constraint hamesha **saath** mein | Multi-step long flows (payouts, KYC, multi-PSP) -> workflow engine; fully async checkout -> queue | Bahut high event volume / many tables -> CDC (Debezium); ek hi consumer + chhota system -> seedha job table |
| **Scale badhne par kya change hoga?** | `customer_id` se shard, keys usi shard par jahan payments; cleanup batches; partitions | Same phases; multiple PSPs + routing; recovery worker partitioned by shard; circuit breaker per PSP | Relay parallel (per partition), CDC relay, Kafka partitions badhao (key = payment id se ordering safe) |

### Most Important Things To Remember

1. **Asli problem correctness hai, scale nahi** -- 58 TPS avg / 1,000 peak ek Postgres primary par.
2. **Har write API idempotent** -- `Idempotency-Key`, scope `(customer_id, key)`, fingerprint SHA-256, 24h.
3. **Decision table**: new -> proceed, hash diff -> 422, completed -> replay, in progress -> 409, lock expired -> takeover.
4. **PSP idempotency key = hamari payment id** -- retries PSP par bhi safe.
5. **PSP timeout = unknown, never failed** -- 202 PROCESSING, resolve via PSP lookup / webhook / recovery worker.
6. **3 atomic phases**, PSP call transaction ke bahar, `recovery_point` se resume.
7. **Double-entry ledger**, integer paise, append-only, `ledger_imbalance_total` = 0.
8. **Transactional outbox** -> Kafka; consumers dedupe on `event_id`.
9. **Two safety nets**: idempotency key (same key retries) + partial unique index per order (two keys).
10. **No Redis on the payment path, fail closed**, tokenization + HMAC webhooks + reconciliation daily.

---

## Remember

> **Coding round mein: clarify (key scope? alag body? timeout?) -> logic bolo (sync claim, 3 phases, PSP key = payment id) -> clean code with injectable clock + fake PSP -> `Promise.all` concurrency + "production = Postgres unique constraint" -> edge cases -> complexity. Design round mein: requirements -> numbers ("correctness, not scale") -> simple diagram -> idempotency decision table -> timeout = unknown -> ledger + outbox + reconciliation.** Payment system ka dil ek line hai: "Har retry ko same key do, har PSP call ko same key do, aur jo pata nahi usko kabhi failed mat bolo."

## Quick Self-Test

1. `InMemoryIdempotencyStore.claim()` ke andar agar `await` aa jaaye (e.g. async storage), toh `Promise.all` wale J1/J2 case mein kya hoga aur PSP par kitne charges banenge? Production mein ye race kaunsi cheez resolve karti hai?
2. Output line **F** mein `psp=4` ho gaya lekin response 202 aaya -- kyun? Agar hum timeout par payment ko `FAILED` mark karke key complete kar dete, toh customer ke saath kya hota?
3. PSP ki idempotency key hamari **payment id** kyun hai, client ki `Idempotency-Key` kyun nahi? (Hint: recovery worker ke paas client ki key hoti hai? Client key kis scope mein unique hai, aur kitni der zinda rehti hai?)
4. Line **K2** ko idempotency store ne nahi roka -- kisne roka, aur database mein uska equivalent kya hai? Line **U** isse kaise related hai?
5. Whiteboard par Redis kyun nahi hai, jabki Rate Limiter mein Redis centre mein tha? 5-minute answer mein "PSP timeout ka matlab failure nahi, unknown hai" kis minute mein aata hai aur uske baad teen resolution paths kaunse batane hain?

---

**Payment System complete.** Next system: **File Storage (S3-style)**. "next" bolo.
