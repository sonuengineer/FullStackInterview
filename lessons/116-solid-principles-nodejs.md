# SOLID Principles, Node.js Wale Real Examples Se

> **Builds on**: [[115-lld-interview-approach]]. Wahan "god class" ko failure bola tha. SOLID basically us failure ke 5 naam hain.

## 1. Pehle Ek Honest Baat

Animal/Dog/Cat example se SOLID kabhi samajh nahi aata, kyunki aapne zindagi mein `Dog` class nahi likhi - aapne **notification service, repository, aur Express handler** likhe hain. To saare example wahi se honge.

Interview reality bhi seedhi hai: **S aur O** har backend interview mein aate hain, **D** aapka code sach mein badalta hai (testability), **L aur I** sabse kam poochhe jaate hain. Isi weight se padho.

## 2. S - Single Responsibility

**Smell:**

```typescript
class NotificationService {
  async notify(userId: string, type: string, data: any) {
    const u = (await db.query('SELECT * FROM users WHERE id=$1', [userId])).rows[0]; // DB
    if (!u.email_verified) return;                                                   // business rule
    const html = `<h1>Hi ${u.name}</h1><p>${data.message}</p>`;                      // templating
    if (type === 'email') await sendgrid.send({ to: u.email, html });                // transport
    if (type === 'sms') await twilio.messages.create({ body: data.message });        // transport
    await db.query('INSERT INTO notification_log ...');                              // audit
  }
}
```

Dard kab hota hai: designer HTML badalna chahta hai -> aapko SendGrid wale code ko chhune ka risk lena padta hai. Test likhna hai -> DB, SendGrid, Twilio teeno mock karo.

> **Principle:** ek class ka **ek reason to change** ho. "Responsibility" ka matlab "ek function" nahi - matlab **ek wajah jiski maang par ye code badlega**.

Yahan 4 wajah hain: product (rule), design (template), vendor (transport), compliance (audit).

**Refactor:**

```typescript
class NotificationService {
  constructor(private users: UserRepository, private templates: TemplateRenderer,
              private channel: NotificationChannel, private log: NotificationLog) {}
  async notify(userId: string, template: string, data: Record<string, unknown>) {
    const user = await this.users.findById(userId);
    if (!user?.emailVerified) return;                      // bas policy yahan
    await this.channel.send(user, this.templates.render(template, { user, ...data }));
    await this.log.record(userId, template);
  }
}
```

Ab `notify` padh kar **policy** samajh aati hai, mechanics nahi. **Kab over-engineering**: jab aap `EmailSubjectLineBuilderFactory` banane lagte ho - ek 30-line function jo ek hi wajah se badalta hai, usko todna nuksan hai. SRP **change ke pressure par** lagao, pehle din se nahi.

## 3. O - Open/Closed

**Smell:**

```typescript
async function charge(order: Order, gateway: string) {
  if (gateway === 'razorpay') { /* 20 lines */ }
  else if (gateway === 'stripe') { /* 25 lines */ }
  else throw new Error('unknown gateway');
}
```

Teesre gateway par aap **live, tested, paisa handle karne wali file** edit karte ho - regression risk purane dono par bhi.

> **Principle:** naya behaviour add karne ke liye nayi file, purani file edit nahi. Extension ke liye open, modification ke liye closed.

```typescript
interface PaymentGateway {
  readonly id: string;
  charge(order: Order, idempotencyKey: string): Promise<ChargeResult>;
}
class PaymentService {
  private gateways = new Map<string, PaymentGateway>();
  register(g: PaymentGateway) { this.gateways.set(g.id, g); }
  async charge(order: Order, gatewayId: string) {
    const g = this.gateways.get(gatewayId);
    if (!g) throw new UnsupportedGatewayError(gatewayId);
    return g.charge(order, order.id);   // key = order id, dekho [[32-payment-idempotency-double-click]]
  }
}
```

Paytm add karna = ek nayi file + ek `register()` line. **Kab over-engineering**: ek hi gateway hai aur dusra aane ka plan nahi? Interface extra indirection hai. Rule of thumb - **do concrete implementations dikhein, tab abstract karo**: pehla `if` likho, doosre par interface nikaalo.

## 4. L - Liskov Substitution

> Interview mein kam poochha jaata hai, par toote to bug **silent** hota hai.

```typescript
interface Storage { put(k: string, b: Buffer): Promise<void>; delete(k: string): Promise<void>; }
class ReadOnlyArchiveStorage implements Storage {
  async put() { throw new Error('archive is read-only'); }     // violation
  async delete() { throw new Error('archive is read-only'); }
}
```

Type-checker khush, runtime phat gaya - jo code `Storage` leta hai woh `put()` kar sakne ki **assumption** rakhta hai.

> **Principle:** child ko parent ki jagah rakho, caller ko kuch toota nahi dikhna chahiye. Signature match kaafi nahi, **behaviour ka contract** bhi match kare: na naya exception, na strict pre-condition, na kamzor guarantee.

**Fix** - hierarchy ki jagah capability se todo: `ReadableStorage { get }`, aur `WritableStorage extends ReadableStorage { put, delete }`. Archive sirf `ReadableStorage` implement karega, galti **compile hi nahi hogi**. **Over-engineering**: LSP ke naam par 6-level inheritance tree - Node/TS mein inheritance kam, composition zyada.

## 5. I - Interface Segregation

> Ye bhi kam aata hai, par repository layer mein roz dikhta hai.

```typescript
interface UserRepository {           // ek fat interface, table ke hisaab se bana
  findById(id): Promise<User|null>;  findByEmail(e): Promise<User|null>;
  save(u): Promise<void>;            delete(id): Promise<void>;
  bulkImport(rows): Promise<void>;   exportToCsv(): Promise<string>;
  runAnalyticsAggregation(): Promise<Report>;
}
```

`LoginService` ko sirf `findByEmail` chahiye, par test mein **saat** methods fake karne padte hain - aur admin-only method ka change login ke test ko tod deta hai.

> **Principle:** client ko woh method dependency mein na mile jo woh use nahi karta. Interface **consumer ke hisaab se** banao, table ke hisaab se nahi.

```typescript
interface UserFinder { findByEmail(e: string): Promise<User | null>; }
class LoginService { constructor(private users: UserFinder) {} }   // ek method ka fake kaafi
```

Ek hi `PgUserRepository` saare chhote interfaces implement kar sakti hai - implementation ek, **views** alag. **Over-engineering**: har method ka apna interface (`IUserById`, `IUserByEmail`...); 2-3 meaningful roles kaafi hain.

## 6. D - Dependency Inversion

> **Ye woh hai jo aapka code sach mein badalta hai.** Baaki 4 ko "nice" bol kar skip kar sakte ho; D skip kiya to code untestable rehta hai.

**Smell:**

```typescript
import { pool } from '../db';              // concrete Postgres
import sgMail from '@sendgrid/mail';       // concrete SendGrid

export async function placeOrder(input: OrderInput) {
  const { rows } = await pool.query('INSERT INTO orders ... RETURNING *', [...]);
  await sgMail.send({ to: input.email, subject: 'Order placed', text: '...' });
  return rows[0];
}
```

Likhne mein sabse aasan, test karne mein sabse mushkil: ek test ke liye **Postgres chalao** aur SendGrid ko module level par mock karo (`jest.mock` ka jaadu, jo refactor par chup-chaap toot jaata hai).

> **Principle:** high-level policy (order kaise place hota hai) low-level detail (Postgres, SendGrid) par depend na kare. Dono ek **abstraction** par depend karein, jo policy ki zubaan mein likha ho.

```
Galat:  OrderService -> pg Pool -> Postgres
Sahi:   OrderService -> OrderRepository (interface) <- PgOrderRepository
```

Dhyaan do: interface **service ke paas** rehta hai, repository ke paas nahi. Yahi direction "inversion" hai.

```typescript
export interface OrderRepository { create(o: NewOrder): Promise<Order>; }      // domain
export interface Mailer { send(to: string, tpl: string, data: object): Promise<void>; }

export class OrderService {
  constructor(private orders: OrderRepository, private mailer: Mailer) {}
  async placeOrder(input: OrderInput): Promise<Order> {
    const order = await this.orders.create(toNewOrder(input));
    await this.mailer.send(input.email, 'order-placed', { id: order.id });
    return order;
  }
}
// infra: class PgOrderRepository implements OrderRepository { constructor(private pool: Pool) {} }
```

**Kyun ye testability hai - asli wajah:**

```typescript
test('order place hone par mail jaata hai', async () => {
  const orders: OrderRepository = { create: async (o) => ({ ...o, id: 'o1' }) };
  const sent: string[] = [];
  const mailer: Mailer = { send: async (to) => { sent.push(to); } };

  await new OrderService(orders, mailer).placeOrder({ email: 'a@b.com', items: [] });
  expect(sent).toEqual(['a@b.com']);
});
```

Na Postgres, na network, na `jest.mock`. 3 millisecond. Interview line: *"Dependency inversion ka asli payoff ye hai ki business logic ka test infra ke bina chalta hai."* Node note: Nest jaisa DI framework zaroori nahi - constructor arguments + ek `main.ts` jo wiring karta hai, kaafi hai.

**Over-engineering**: `crypto.randomUUID()` ke liye `IUuidGenerator`. Interface wahan banao jahan dependency **network, disk, clock, randomness ya paisa** chhuti hai.

## 7. Ek Table Mein Pura SOLID

| | Principle | Node.js smell | Interview weight |
|---|---|---|---|
| **S** | Ek reason to change | 200-line `NotificationService` | High |
| **O** | Extend karo, edit mat karo | gateway ka `if/else` ladder | High |
| **L** | Child parent ki jagah chale | `put()` jo `throw` karta hai | Low |
| **I** | Fat interface mat do | 7-method `UserRepository` | Low |
| **D** | Detail par depend mat karo | service ke andar `import pool` | **Highest payoff** |

**Common mistakes**: SOLID ko pehle din lagana (3 file wale script mein 5 interface); SRP ko "ek class = ek method" samajhna (reason-to-change dekho, line count nahi); D ko "DI framework" samajhna (constructor injection hi D hai); aur interface banakar bhi service ke andar `new PgOrderRepository()` likh dena - abstraction ban gaya, inversion nahi hua.

## 🧠 Remember

> S aur O aapka code badalne layak banate hain, L aur I usko safe rakhte hain, aur **D usko test karne layak banata hai** - isliye agar sirf ek principle seekh sakte ho to Dependency Inversion: business logic ko kabhi `pg` ya `@sendgrid/mail` import nahi karna chahiye.

## Quick Self-Test

1. `OrderService` mein `import { pool } from '../db'` hai. Kaunsa principle toota, aur **test** par kya asar hai?
2. Interface bana diya par constructor ke andar `new PgRepo()` kar diya - kya D follow hua? Kyun nahi?
3. `ReadOnlyStorage.put()` jo `throw` karta hai - compile ho raha hai, to problem kahan hai?
4. Do gateways hain, teesra aane ka plan nahi. Interface nikaalo ya `if` rehne do? Jawab defend karo.
5. SRP mein "responsibility" ka matlab kya hai - ek method, ek layer, ya kuch aur?
