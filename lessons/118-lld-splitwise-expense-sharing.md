# LLD: Splitwise Design Karo (Expense Split Aur Settlement)

> **Builds on**: [[115-lld-interview-approach]] ka 7-step order aur [[117-design-patterns-backend-interviews]] ka Strategy. Isko [[71-parking-lot-lld-review]] ka sibling samjho - wahi round, doosra domain.

## 1. Story

Goa trip, 5 log. Rahul ne hotel ka 12,000 diya, Priya ne cab ka 3,500, Aman ne dinner ka 2,400 - par dinner mein sirf 3 log the. Trip khatam, aur WhatsApp par 40 message: *"bhai mera kitna bana?"* Yahi problem Splitwise solve karta hai, aur LLD round mein ye parking lot ke baad sabse common question hai - kyunki isme **money, rounding aur concurrency** teeno natural aa jaate hain.

## 2. Requirements Clarify (board par likho)

- Split types: **equal, exact amount, percentage** (ye teen standard hain)
- Group zaroori hai ya 1-to-1 expense bhi? (dono - group optional)
- Partial settlement allowed? (haan). Multi-currency? **Scope se bahar** - ek currency per group
- Expense edit/delete? (haan, aur ye design par asar daalta hai)
- Simplify debts? (haan, optional group setting)

Scope cut bolo: *"Comments, attachments, recurring expenses aur notifications main nahi kar raha."*

## 3. Entities Aur Relationships

```
User  --<  GroupMember  >--  Group
                               |
                               +--<  Expense  --<  Split
                                        |
User  --<  Balance  >-------------------+   (derived state)
```

| Entity | Ek line mein |
|---|---|
| `User` | identity - id, name, email |
| `Group` | members ka container - "Goa Trip" |
| `Expense` | **immutable fact** - Rahul paid 12,000 for hotel |
| `Split` | us expense ka ek hissa - Priya owes 2,400 of it |
| `Balance` | do logon ke beech ka **net** - Priya -> Rahul: 2,400 |

Ownership: `Group` apne `Expense` ka owner, `Expense` apne `Split` ka owner (split expense ke bina meaningless hai). `Balance` kisi ka owner nahi - **woh derived hai**, aur yahi agla section hai.

## 4. Kyun "Balances" Store Karte Hain, Running Total Nahi

Sabse tempting (aur galat) design: `class User { totalOwed: number }`. Teen jagah ye marta hai:

1. **Information loss** - `totalOwed = 2400` se pata nahi chalta **kisko** dena hai; UI hi nahi ban sakta.
2. **Audit nahi hota** - number galat lage to kaunse expense se aaya, pata nahi. Expense edit/delete par total ko "ulta" karna padta hai, aur ek bug permanent corruption hai.
3. **Race condition** - `totalOwed = totalOwed + x` read-modify-write hai; do simultaneous expense mein ek update kha jaata hai ([[26-duplicate-email-race-condition]]).

Sahi design do layer ka hai:

```
Expense + Split  =  source of truth (append-only, immutable)
      |  derive
      v
Balance(userA, userB, amountPaise)  =  pairwise net, fast read ke liye
```

`Expense`/`Split` **immutable** hain: edit ka matlab reversal entry + naya expense, delete ka matlab `deleted_at` + reversal - history bachi rehti hai. `Balance` pairwise net hai, `(user_a, user_b, amount)` jahan pair **normalized** ho (`user_a < user_b`), warna ek pair ki do rows ban jaayengi; sign direction batata hai aur read O(1) hai. Aur `Balance` kabhi bhi `Split` se **recompute** ho sakta hai - yahi safety net hai, mismatch dikhe to nightly reconciliation theek kar deti hai ([[60-cache-says-100-db-says-20]] wala hi idea).

Interview line: *"Expenses mera ledger hai, balance mera materialized view. Ledger immutable rakhta hoon, view recompute kar sakta hoon."*

## 5. Money Ko Float Mein Kabhi Nahi

```javascript
> 0.1 + 0.2        // 0.30000000000000004
> 1000 / 3         // 333.3333333333333  -> teen baar jodo to 999.9999999999999
```

10 paise gum, aur 500 expenses ke baad balance visibly galat. **Fix: paise mein integer store karo** (`amountPaise: number`, ya DB mein `NUMERIC(12,0)`), aur remainder **deterministically** baanto:

```typescript
/** 100000 paise, 3 log -> [33334, 33333, 33333], total exactly match */
function splitEqual(totalPaise: number, userIds: string[]): Split[] {
  const n = userIds.length;
  const base = Math.floor(totalPaise / n);
  let remainder = totalPaise - base * n;                  // 0 <= remainder < n
  return userIds.map((uid) => {
    const extra = remainder > 0 ? (remainder--, 1) : 0;    // pehle k logon ko 1 paisa extra
    return { userId: uid, amountPaise: base + extra };
  });
}
```

Invariant jo har split type par lagoo ho: **`sum(splits) === expense.amountPaise`, exactly.** Isko code mein assert karo - interviewer ko ye dikhana bada plus hai. Money integer rakhna aur operation exactly-once rakhna ek hi family ke do rules hain; doosra [[32-payment-idempotency-double-click]] mein hai, aur Splitwise mein bhi expense create par idempotency key chahiye (section 8).

## 6. Teen Split Types - Strategy Se

Teen rules hain aur chautha (shares/adjustment) kal aa sakta hai. Yahi Strategy ka asli justification hai, naam nahi.

```typescript
interface SplitStrategy {
  /** total ko baanto; sum === totalPaise guarantee karo */
  split(totalPaise: number, input: SplitInput): Split[];
}

class EqualSplit implements SplitStrategy {
  split(total: number, { userIds }: SplitInput) { return splitEqual(total, userIds); }
}
class ExactSplit implements SplitStrategy {
  split(total: number, { exact }: SplitInput) {
    const sum = exact.reduce((a, s) => a + s.amountPaise, 0);
    if (sum !== total) throw new ValidationError(`splits ${sum} != total ${total}`);
    return exact;                                              // user ne khud diya hai
  }
}
class PercentageSplit implements SplitStrategy {
  split(total: number, { percents }: SplitInput) {             // p.bps = basis points
    if (percents.reduce((a, p) => a + p.bps, 0) !== 10000) throw new ValidationError('must be 100%');
    // floor karo, phir bacha paisa largest-remainder wale ko do - warna 1 paisa gum
    return distributeRemainder(total, percents.map((p) =>
      ({ userId: p.userId, exactPaise: (total * p.bps) / 10000 })));
  }
}
```

Dhyaan do: percentage **basis points (integer)** mein liya, `33.33` float mein nahi. Wahi integer-money rule.

## 7. Class Skeleton (Signatures, Bodies Nahi)

```typescript
interface Split { userId: string; amountPaise: number; }

class Group {
  addMember(userId: string): void;
  removeMember(userId: string): void;          // throws if non-zero balance
  isMember(userId: string): boolean;
}

class Expense {                                // saara state readonly = immutable ledger row
  readonly id: string;
  readonly groupId: string | null;             // null = 1-to-1 expense
  readonly paidBy: string;
  readonly amountPaise: number;
  readonly splits: ReadonlyArray<Split>;
  readonly deletedAt: Date | null;
  shareOf(userId: string): number;
}

class BalanceSheet {
  applyExpense(e: Expense): Promise<void>;
  reverseExpense(e: Expense): Promise<void>;
  balanceBetween(a: string, b: string): Promise<number>;
  balancesFor(userId: string): Promise<Array<{ otherUserId: string; amountPaise: number }>>;
  recomputeFromLedger(groupId: string): Promise<void>;         // reconciliation job
}

class ExpenseService {
  addExpense(cmd: AddExpenseCommand): Promise<Expense>;
  deleteExpense(expenseId: string, by: string): Promise<void>;
}
class SettlementService {
  recordPayment(from: string, to: string, paise: number, key: string): Promise<Settlement>;
  simplify(groupId: string): Promise<Transfer[]>;
}
```

Signatures mein hi design dikh raha hai: `removeMember` balance check karta hai, `Expense` ke field `readonly` hain, `recomputeFromLedger` exist karta hai. Yahi [[115-lld-interview-approach]] ka Step 4 hai.

## 8. `addExpense` - Ek Method Jo Poora Likhna Chahiye

```typescript
async addExpense(cmd: AddExpenseCommand): Promise<Expense> {
  const group = cmd.groupId ? await this.groups.byId(cmd.groupId) : null;
  if (group && !group.isMember(cmd.paidBy)) throw new ForbiddenError('not a member');
  if (!Number.isInteger(cmd.amountPaise) || cmd.amountPaise <= 0)
    throw new ValidationError('amount must be a positive integer (paise)');

  const splits = this.strategies[cmd.splitType].split(cmd.amountPaise, cmd.splitInput);
  const sum = splits.reduce((a, s) => a + s.amountPaise, 0);
  if (sum !== cmd.amountPaise) throw new InvariantError(`splits ${sum} != ${cmd.amountPaise}`);

  // ledger write + balance update EK transaction mein, warna balance drift
  return this.db.tx(async (t) => {
    const expense = await this.expenses.insert(t, {
      id: cmd.clientRequestId,              // idempotency key = client-generated id = PK
      ...cmd, splits, createdAt: new Date(),
    });                                      // PK conflict = duplicate submit

    for (const s of splits) {
      if (s.userId === cmd.paidBy) continue;              // payer khud ko udhaar nahi deta
      // atomic increment DB ke andar - read-modify-write NAHI
      await t.query(
        `INSERT INTO balances (user_a, user_b, amount_paise) VALUES ($1,$2,$3)
         ON CONFLICT (user_a, user_b)
         DO UPDATE SET amount_paise = balances.amount_paise + EXCLUDED.amount_paise`,
        normalizedPair(s.userId, cmd.paidBy, s.amountPaise));
    }
    return expense;
  });
}
```

Teen cheezein interviewer yahan dhoondh raha hai: **splits ka invariant check**, **ek transaction** mein ledger + balance (warna expense insert ho gaya aur balance fail - data permanently galat), aur **`amount = amount + x` DB ke andar** taaki do simultaneous expense mein lost update na ho. `clientRequestId` ko PK banane se duplicate submit par unique violation aata hai aur handler "already created" samajh kar purana expense return karta hai - yahi [[32-payment-idempotency-double-click]] ka pattern hai.

## 9. Settlement Aur "Simplify Debts"

5 log, 8 pairwise balances, aur chains ban jaati hain - A owes B, B owes C, C owes A. Simplify in chains ko kaat deta hai:

```typescript
function simplify(net: Map<string, number>): Transfer[] {
  const debtors   = [...net].filter(([, v]) => v < 0).sort((a, b) => a[1] - b[1]); // most -ve first
  const creditors = [...net].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]); // most +ve first
  const out: Transfer[] = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(-debtors[i][1], creditors[j][1]);
    out.push({ from: debtors[i][0], to: creditors[j][0], amountPaise: amount });
    debtors[i][1] += amount; creditors[j][1] -= amount;
    if (debtors[i][1] === 0) i++;
    if (creditors[j][1] === 0) j++;
  }
  return out;                         // at most n-1 transfers
}
```

Pehle har user ka **net** nikaalo (uske saare pairwise balances ka sum), phir sabse bada debtor sabse bade creditor ko bharta hai. Har step mein kam se kam ek banda zero ho jaata hai, to **max n-1 transfers**; complexity `O(n log n)` (sorting).

**Honest note (ye bolna chahiye):** *minimum* number of transactions nikaalna NP-hard hai - ye subset-sum/partition par reduce hota hai, kyunki optimal ke liye aise subsets dhoondhne padte hain jinka net exactly zero ho. Interview mein optimal ki zaroorat nahi: *"Greedy n-1 transfers deta hai, jo 5-10 logon ke group mein practically optimal hi feel hota hai. Min-cash-flow optimal NP-hard hai, aur us complexity ka product value zero hai."* Ye jawab optimal algorithm rata kar bolne se stronger hai. Doosri honest baat: **simplify by default on mat karo** - *"maine A ke saath kharch kiya, bill C ko dikh raha hai"* users ko confusing lagta hai, isliye asli Splitwise mein ye opt-in setting hai.

## 10. Concurrency Aur Edge Cases

| Situation | Kya galat ho sakta hai | Fix |
|---|---|---|
| Do log ek hi second mein expense add karein | lost update on balance | DB-side atomic increment |
| Client ne "Add" do baar dabaya | duplicate expense | client-generated id = PK |
| Settle aur naya expense ek saath | settle ne stale balance padha | `UPDATE ... WHERE amount_paise = $expected` (optimistic) |
| Member remove hua, balance bacha hai | paisa gayab | `removeMember` non-zero balance par block kare |
| Settle ho chuke expense ka delete | ulta balance | reversal entry; settled par delete block/warning |
| Balance drift (bug ya partial failure) | numbers galat | nightly `recomputeFromLedger` + mismatch alert |

Note: kahin **distributed lock ki zaroorat nahi padi** - atomic/conditional SQL kaafi hai. Redis lock ([[44-distributed-locking-with-redis]]) tab chahiye jab operation DB ke bahar ho. Ye distinction senior signal hai.

## 11. Trade-offs

**Balance table vs on-the-fly compute from splits** - table fast par drift kar sakti hai (isliye reconciliation); on-the-fly always correct par 2,000 expenses wale group mein slow, to hybrid hi asli answer hai. **Immutable ledger vs mutable expense** - storage badhta hai, par audit aur reversal free milte hain, aur paise ke system mein ye trade-off lena hi chahiye. **Simplify default-on vs opt-in** - kam transfers vs user ka confusion.

## 🧠 Remember

> Splitwise ka asli LLD teen rules hain: paisa **integer paise** mein rakho aur remainder deterministically baanto, expenses ko **immutable ledger** maano aur balances ko uska recompute-able view, aur balance ko **DB ke andar atomically increment** karo - kyunki yahan do log ek hi second mein kharcha add karte hain.

## Quick Self-Test

1. `1000` ko 3 logon mein equal split karne par kya bug aata hai, aur aapka fix exactly kya hai?
2. Ek `user.totalOwed` number rakhne se kaunsi **teen** cheezein toot jaati hain?
3. Expense insert aur balance update ek transaction mein kyun? Alag hone par kya hota hai?
4. Minimum settlement transactions NP-hard kyun hai, aur interview mein aap kya implement karoge?
5. Rahul aur Priya ek hi second mein expense add karte hain. `balance = balance + x` JS mein karne par kya hoga?
6. Simplify debts default-on kyun nahi hona chahiye?
