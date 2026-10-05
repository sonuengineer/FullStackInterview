# LLD Interview Ka Approach: Requirements Se Code Tak

> **Builds on**: [[71-parking-lot-lld-review]] - wahan dekha tha ki ek *technically theek* LLD answer bhi reject ho jaata hai. Ye lesson us review ka ulta side hai: **karna kya hai, kis order mein**.

## 1. Story

Interviewer bolta hai: *"Design a parking lot."* Candidate 40 second soch kar board par likhna shuru karta hai - `class ParkingLot`, `class Floor`, `class Vehicle`.

Minute 3 par 7 classes ban gayi. Minute 15 par interviewer poochta hai *"bike car wali spot mein park kar sakti hai?"* - aur 4 classes badalni padti hain. Minute 30 par woh `getVehicleById` likh raha hai, aur asli allocation logic abhi tak nahi aaya.

Feedback: *"good coding, weak design."*

## 2. Problem

Classes se shuru karna **answer se shuru karna** hai, sawaal samajhne se pehle.

Interviewer ye nahi dekh raha ki aap `class` keyword jaante ho. Woh dekh raha hai: ambiguity mein kaam kar paate ho ya assume kar lete ho? Responsibility kahan rakhte ho? Requirement badalne par design jhelta hai ya tootta hai?

**Code last 15 minute ka kaam hai. Pehle 10 minute soch ka kaam hai.**

## 3. The Ordered Method

```
Requirements -> Entities -> Relationships -> Public API
                                                 |
                                                 v
  At-scale notes <- Concurrency/Edges <- Data Structures
```

### Step 1 - Requirements clarify karo, zor se bol kar

5-7 sawaal poochho aur **board par likho**: kitne floors/spots (100 vs 10,000 - data structure badal jaayega)? Spot types kaunse, bike car-spot use kar sakti hai? Allocation rule - nearest gate, lowest floor? Payment exit par ya prepaid, lost ticket ka kya?

Bolna seekho: *"Main assume kar raha hoon ek lot, 4 spot types, payment at exit - theek hai?"* Interviewer correct kar dega, aur aapko free information milegi.

**Out of scope bhi bolo**: *"Number plate OCR aur reporting main scope se bahar rakh raha hoon."* Scope cut karna seniority ka signal hai.

### Step 2 - Nouns nikaalo -> candidate entities

Requirement padho, noun underline karo:

> "A **vehicle** enters through a **gate**, gets a **ticket**, parks in a **spot** on a **floor**, and pays a **fee** at exit."

Candidates: `Vehicle`, `Gate`, `Ticket`, `ParkingSpot`, `Floor`, `ParkingLot`, `Payment`. Ab **prune** karo - har noun class nahi banti, `Fee` ek `number` hai. Ye 2 minute ka step hai, par god class yahin rukti hai.

### Step 3 - Relationships aur ownership

Arrows lagao, aur ek sawaal poochho: **kiske paas kiska lifecycle hai?**

| Relation | Type | Owner |
|---|---|---|
| `ParkingLot` - `Floor` | composition 1:N | Lot (floor ke bina lot nahi) |
| `Floor` - `ParkingSpot` | composition 1:N | Floor |
| `Ticket` - `ParkingSpot` | association | koi nahi, reference hai |
| `Vehicle` - `Ticket` | association | Vehicle lot ke bahar bhi exist karti hai |

Ownership decide hone par method ki jagah automatic mil jaati hai: `release(spot)` Floor par jaayega, kyunki free-pool Floor maintain karta hai.

### Step 4 - Public API pehle, field baad mein

**Ye step 90% candidates skip karte hain.** Field likhne se pehle method signatures:

```typescript
class ParkingLot {
  enter(vehicle: Vehicle, gate: Gate): Ticket;             // throws LotFullError
  exit(ticketId: string, payment: PaymentMethod): Receipt;
  availability(): Record<SpotType, number>;
}
class Floor {
  reserve(vehicleType: VehicleType): ParkingSpot | null;   // atomic: check + mark
  release(spot: ParkingSpot): void;
}
```

Kyun pehle? **Signature hi contract hai.** Isko `findFreeSpot()` naam dete to woh sirf dhoondta, mark nahi karta - aur design minute 1 se race-prone ho jaata ([[26-duplicate-email-race-condition]]). Signature se galti turant dikhti hai; fields se nahi.

### Step 5 - Ab data structures

Methods fix hone ke baad choice obvious ho jaati hai. `reserve(type)` ko O(1) chahiye, to flat array nahi - **type ke hisaab se free pool**:

```typescript
private freeSpots: Map<SpotType, ParkingSpot[]>;   // reserve = pop, release = push
```

Pehle fields likhte to `spots: ParkingSpot[]` likh dete aur `reserve` poora floor scan karta. Order ulta karne se performance free mein mil gayi.

### Step 6 - Concurrency aur edge cases

Do gates, do car, ek hi second. Dono ko `F2-17` mila. **Yahi sawaal LLD round decide karta hai.**

- Ek process: `reserve()` ke andar `await` mat rakho - check aur mark ek hi tick mein.
- Kai servers: DB mein atomic claim - `UPDATE spots SET status='OCCUPIED' WHERE id=$1 AND status='FREE'`; `rowCount === 0` matlab koi aur le gaya. Redis lock bhi option hai ([[44-distributed-locking-with-redis]]), par conditional update sasta aur safe hai.

Edge cases bol kar list karo: lot full, lost ticket, exit par payment fail, bina pay kiye nikal gaya, spot maintenance mein, gate ka network gaya.

### Step 7 - "Scale par main kya badalta"

Last 2 minute, aur yahi senior signal hai: *"Abhi state in-memory hai, ek lot ke liye theek. 500 lots aur multiple servers par spot state Postgres mein, availability count Redis mein cache, gate events async queue par - tab ye LLD se HLD ban jaata hai."*

## 4. 45-Minute Round, Timeline

| Time | Kya kar rahe ho | Interviewer kya dekh raha hai |
|---|---|---|
| 0-5 | Requirements, scope cut, assumptions board par | Ambiguity handling |
| 5-8 | Nouns -> entities, extra nouns prune | Abstraction sense |
| 8-13 | Relationships, ownership, class diagram | Modeling |
| 13-18 | Main flow walk-through + method signatures | API design |
| 18-33 | Core classes ka code, data structures | Coding |
| 33-40 | Concurrency, states, edge cases | Production thinking |
| 40-45 | Trade-offs, scale par kya badalta | Seniority |

Minute 2 par code likh rahe ho? 0-13 ka poora signal aapne khud delete kar diya.

## 5. Do Sabse Common Failures

### Failure #1 - Object model ki jagah database schema

Sabse common galti:

```typescript
// ye LLD nahi, ye table dump hai
class Ticket { id; vehicleId; spotId; floorId; entryTime; exitTime; amount; status; }
class TicketService { createTicket(){} getTicket(){} updateTicket(){} calculateFee(){} }
```

Saari classes **sirf data** (anemic), saara **behavior** ek Service mein. Ye relational thinking hai, object thinking nahi. Object model mein behavior data ke saath rehta hai:

```typescript
class Ticket {
  constructor(private readonly spot: ParkingSpot, private readonly enteredAt: Date) {}
  durationMinutes(now: Date): number;
  close(paid: Money): Receipt;          // state transition yahan
  isActive(): boolean;
}
```

**Test**: agar saari classes mein sirf getters/setters hain, aapne schema design kiya hai, LLD nahi.

### Failure #2 - Ek god class

```typescript
class ParkingLotManager {
  findSpot(){} allocateSpot(){} generateTicket(){} calculatePrice(){}
  processPayment(){} sendSMS(){} generateReport(){} addFloor(){}
}
```

Allocation, pricing, payment, notification, reporting - ek jagah. Iske 5 reasons-to-change hain, to ye 5 baar badlegi, aur pricing ka change payment ko risk mein daalega. One-line test: **"ye class ek line mein kya karti hai?"** Jawab mein "aur" aaya to do classes hain ([[116-solid-principles-nodejs]] mein ye SRP hai).

## 6. LLD vs HLD - Difference Clear Karo

| | **LLD** | **HLD** |
|---|---|---|
| Unit of thought | Class, method, interface | Service, DB, queue, cache |
| Deliverable | Class diagram + chalne jaisa code | Architecture diagram + data flow |
| Typical question | "Design parking lot / Splitwise / elevator" | "Design Instagram / Uber" |
| Concurrency | Lock, atomic method, state machine | Replication, partitioning, consensus |
| Scale talk | Ek process, ek machine | Millions of users, multi-region |
| Fail mode | Anemic classes, god class | Over-engineering, Kafka everywhere |

**LLD mein HLD ghusaana** = *"Yahan Kafka aur Redis cluster lagaunga"*, jab interviewer `reserve()` dekhna chahta tha. **HLD mein LLD ghusaana** = Instagram design mein 20 minute class diagram, jab sawaal feed fan-out tha.

Ek line: **HLD boxes ke beech ka design hai, LLD ek box ke andar ka design hai.**

## 7. Trade-offs Jo Bolna Chahiye

- **In-memory free-pool vs DB query** - pool fast, par restart par state gayi aur multi-server mein share nahi hoti.
- **Strategy vs if/else** - do pricing rules ke liye `if` theek hai; interface tab jab teesri rule aaye ya runtime switch chahiye ([[42-resilience-vs-overengineering]]).
- **Enum state vs boolean flags** - `isFree/isReserved/isBroken` = 8 combinations jinme 4 illegal; ek enum = 4 legal states.

## 🧠 Remember

> LLD mein class pehli cheez nahi, chauthi hai: requirements -> entities -> relationships -> **method signatures** -> data structures -> concurrency -> scale. Jo minute 1 par `class` likhta hai, woh sawaal samajhne se pehle jawab de raha hai.

## Quick Self-Test

1. 8 classes likhi aur sabme sirf getters/setters hain, logic ek `Service` mein - kya galti hui, fix kya hai?
2. Data structure se **pehle** method signature kyun likhna chahiye? Ek concrete example do.
3. "Design an elevator system" - aapke pehle 5 clarifying questions?
4. LLD round mein "main yahan Kafka use karunga" bolna kyun galat signal hai?
5. God class pakadne ka one-line test kya hai?
