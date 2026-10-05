# Machine Coding Round: 90 Minute Mein Kya Karna Hai

> Ye lesson kisi ek problem ka solution nahi -- ye **round ko kaise chalana hai** uska plan hai. Flipkart, Swiggy, Razorpay, Zeta, PhonePe style companies isi format mein hire karti hain: ek problem statement, 60-120 minute, apna laptop, aur end mein walkthrough. Design-level approach [[115-lld-interview-approach]] mein hai, aur ek asli review [[71-parking-lot-lld-review]] mein.

## 1. Ye Round Kya Test Karta Hai (Aur Kya Nahi)

Ye **DSA round nahi** hai -- koi optimal algorithm nahi chahiye. Ye **system design round bhi nahi** hai -- koi Kafka, koi Redis nahi.

Ye ek hi cheez test karta hai: *"Is bande ko ek ambiguous requirement deke 90 minute chhod do -- kya ye chalta hua, padhne-layak, extend-hone-layak code deta hai?"*

Yaani: **working code > beautiful design.** Ye poore lesson ki pehli line hai.

## 2. Minute-by-Minute Plan

| Minute | Kya karna hai | Kya **nahi** karna hai |
|---|---|---|
| **0-10** | Problem padho, 3-5 clarifying questions poochho, interfaces/method signatures likho (comment ya stub) | Coding shuru |
| **10-20** | Core entities + enums + in-memory repo interface | Database, ORM, framework |
| **20-60** | **Happy path end-to-end chalao** + `main()` demo | Edge cases, validation polish |
| **60-75** | Edge cases: not found, duplicate, invalid state, capacity full | Refactor for beauty |
| **75-85** | **Ek** bonus feature (jo unhone "nice to have" bola) ya 2-3 unit tests | Doosra bonus feature |
| **85-90** | `main()` chalao, output dikhao, extension points bolo | Last-minute code change |

Kuch ghadi par dekhne wale checkpoints: **minute 20 par interfaces likhe hone chahiye**, **minute 60 par kuch chalna chahiye**. Minute 60 par kuch nahi chal raha to naya feature band, jo hai usse chalao.

## 3. Minute 0-10: Clarify, Phir Interface

Problem statements jaanboojh kar adhoore hote hain ("Design a Splitwise", "Design a Snake and Ladder"). 3-5 sawaal poochho -- har sawaal ek design decision khatam karta hai:

- Kitne users/entities? Single process ya multi-user concurrent?
- CLI output chahiye ya sirf test se verify karenge?
- Ye specific case kya behave kare? (ek concrete ambiguous case uthao)
- Konsa feature **must** hai aur konsa nice-to-have? (yahi aapka minute 75-85 decide karta hai)

Phir **code likhne se pehle interfaces** (neeche ka example Splitwise hai -- uska poora design [[118-lld-splitwise-expense-sharing]] mein hai):

```ts
// splitwise.ts -- pehle contract, phir implementation
interface ExpenseSplitStrategy { split(amount: number, participants: User[], meta?: unknown): Map<string, number>; }
interface UserRepository { save(u: User): void; byId(id: string): User | undefined; }

class ExpenseService {
  addExpense(payerId: string, amount: number, participantIds: string[], strategy: ExpenseSplitStrategy): Expense;
  balanceSheet(userId: string): Map<string, number>;
  settle(fromId: string, toId: string, amount: number): void;
}
```

5 minute mein likha ye block interviewer ko bata deta hai ki aapne socha hai. Aur aapko bhi -- aage ka coding sirf "khaali jagah bharna" ban jaata hai.

## 4. Pehla Code: `main()` Likho, Business Logic Nahi

Ye counter-intuitive hai par sabse zyada marks bachata hai.

```ts
// main.ts -- SABSE PEHLE likho, abhi compile nahi hoga, koi baat nahi
function main() {
  const app = new SplitwiseApp();
  const [alice, bob, carol] = ['Alice', 'Bob', 'Carol'].map((n) => app.addUser(n));

  app.addExpense(alice.id, 900, [alice.id, bob.id, carol.id], new EqualSplit());
  console.log('--- balances after equal split ---');
  app.printBalances();

  app.settle(bob.id, alice.id, 300);
  console.log('--- after Bob settles 300 ---');
  app.printBalances();
}
main();
```

Kyun ye pehla?

1. Ye aapki **requirement list** hai -- har line ka ek method chahiye, usse zyada kuch nahi. Scope creep khatam.
2. Minute 85 par aapke paas **dikhane ke liye kuch hai**. "Design poora hai, demo nahi chal rahi" sabse common fail hai.
3. Ye aapka **test harness** hai. Har 10 minute `node main.js` chalao -- aapko turant pata chalta hai kahan toota.

Phir usko chalane bhar ka code likho. Jo `main()` mein nahi hai, wo abhi nahi banega.

## 5. In-Memory Store, Interface Ke Peeche

Database se connect karne mein 20 minute jaate hain aur ek bhi mark nahi milta. Par agar `Map` directly service ke andar hai to interviewer poochhega "DB par kaise jaayega?" -- aur jawab "poora service rewrite" hoga. Beech ka raasta:

```ts
class InMemoryUserRepository implements UserRepository {
  private readonly rows = new Map<string, User>();
  save(u: User) { this.rows.set(u.id, u); }
  byId(id: string) { return this.rows.get(id); }
}

// service ko repo pata hai, Map nahi
const app = new ExpenseService(new InMemoryUserRepository(), new InMemoryExpenseRepository());
```

Ye 6 lines aapko do cheezein deti hain: zero setup time, aur ek line ka jawab -- *"`PostgresUserRepository implements UserRepository` likh doonga, service ka ek line bhi nahi badlega."* Yahi extensibility ka proof hai, dawa nahi.

**Framework bhi nahi.** Express, Nest, docker-compose, migrations -- in sab mein 30 minute jaate hain. Plain `ts-node main.ts` ya `node main.js`. REST chahiye to unse poochho; aksar wo mana kar denge.

## 6. Kya Actually Grade Hota Hai

| Kya | Weight | Kaise hasil karein |
|---|---|---|
| **Compile + run hota hai** | Sabse zyada | `main()` pehle, har 10 min chalao |
| **Core logic sahi hai** | Zyada | 2-3 scenario khud verify karo (settle ke baad balance zero?) |
| **Extensibility** | Medium | Jahan variation hai wahan interface (split strategy, repo) |
| **Naming + structure** | Medium | `ExpenseService`, `EqualSplit` -- `Manager`, `Helper`, `data2` nahi |
| **Basic tests** | Bonus | 2-3 unit tests core logic par, 100% coverage nahi |
| **Edge cases bole/handle kiye** | Bonus | Handle na kar pao to `// TODO: ` likho aur walkthrough mein bolo |

Ulta bhi sach hai: **beautiful 7-interface design jo chalta nahi** aksar `main()` chalane wale simple code se neeche aata hai. Round ka naam hi "machine coding" hai.

## 7. Teen Tarike Jisse Log Fail Karte Hain

**1. 30 minute setup mein.** `npm init`, TypeScript config, ESLint, Express, Postgres container, Prisma migration -- aur minute 40 par business logic ki ek line nahi. **Fix:** ek ready template rakho (ek `package.json`, ek `tsconfig.json`, ek `main.ts`) aur minute 2 par coding mein ho.

**2. Ek feature ko gold-plate karna.** Candidate 35 minute "dynamic pricing" ya "perfect split rounding to paisa" par laga deta hai, aur `settle()` kabhi nahi likhta. Interviewer **breadth** dekhta hai -- 6 features basic chalein, isse behtar hai ki 1 feature perfect ho. **Fix:** ghadi dekho. Ek feature par 15 minute se zyada = `// TODO` likho aur aage badho.

**3. End mein demo nahi.** Minute 88 par "ek choti si cheez fix kar raha hoon" -- aur round khatam, kuch chala nahi. **Fix:** minute 80 par **code freeze**. Jo chal raha hai usko commit karo, baaki comment out kar do. Chalta hua 70% > toota hua 100%.

Chautha, kam-common par fatal: **jo likha wo samjha nahi**. Walkthrough mein interviewer kuch bhi poochh sakta hai ("ye `Map<string, Map<string, number>>` kya hai?"). Clever one-liner ya copy-paste kiya pattern jo aap defend nahi kar sakte -- usse simple, explainable code behtar hai.

## 8. Last 5 Minute: Walkthrough Ka Script

Ye 5 minute aapke 85 minute ki marketing hai. Isi order mein bolo:

1. **Chalao.** `node main.js`, output dikhao, 20 second mein bolo ki kya hua.
2. **Structure.** "Entities yahan, service yahan, repos interface ke peeche, split strategies yahan."
3. **Ek design decision defend karo.** "Split ko strategy banaya kyunki problem mein hi 3 tarah ke split the -- percentage split ek nayi class hogi."
4. **Jo nahi kiya wo khud bolo.** "Concurrency handle nahi ki -- do simultaneous expenses balance par race karenge, isliye production mein per-group lock ya DB transaction chahiye." Ye **weakness nahi**, awareness hai -- aur aksar yahi aapko agle round mein le jaata hai.
5. **Extension point.** "`PostgresRepository` daalne par service nahi badlega; REST layer service ke upar patla wrapper hoga."

## 🧠 Remember

> Machine coding round design competition nahi hai -- **chalta hua subset har baar us complete design ko haraata hai jo run nahi karta.** Isliye: `main()` sabse pehle likho, in-memory store interface ke peeche rakho, framework aur DB ko haath na lagao, minute 60 par happy path chale, minute 80 par code freeze, aur aakhri 5 minute demo + jo nahi kiya uska imaandar zikr.

## Quick Self-Test

1. Business logic se pehle `main()` likhne se exactly kya 3 faayde milte hain?
2. In-memory `Map` ko repository interface ke peeche rakhne se kya milta hai jo seedha `Map` use karne se nahi milta?
3. Minute 60 par happy path nahi chal raha -- aapka agla kadam kya hai?
4. "Complete par toota" design "70% par chalta" design se kyun haarta hai?
5. Walkthrough mein jo feature nahi banaya usko khud bolna kyun faydemand hai?
