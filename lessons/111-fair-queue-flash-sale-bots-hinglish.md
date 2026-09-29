# Flash Sale Mein Bots Ne Sab Le Liya - Fair Queue Kaise Design Karein? (Hinglish)

> **Similar-question flag**: [[79-blog-rate-limiting]] aur [[106-rate-limiting-at-the-edge-hinglish]] mein "traffic kaise limit karein" aa chuka hai. Naya yahan ye hai: **fairness** ek business decision hai, aur usko enforce karne ke liye queue + inventory + bot defence teeno chahiye.

## 1. Pehla Sawaal: "Fair" Ka Matlab Kya Hai?

Iska jawaab design se pehle aana chahiye, kyunki teen bilkul alag systems ban te hain:

| Model | Rule | Bots ke against |
|---|---|---|
| **FIFO by arrival** | jo pehle aaya, usko pehle | **Kamzor** -- bot insaan se 200 ms pehle aata hai, hamesha |
| **Random lottery** | registered users mein se random winners | **Sabse strong** -- speed ka koi faida nahi bachta |
| **Weighted** | loyalty / past orders / account age se weight | Strong, par "fair" ki definition explain karni padegi |

Note karo: **FIFO ka matlab hi hai ki fastest network jeetega** -- aur wo insaan kabhi nahi hota. Isliye jab business "fair" bolta hai aur matlab "bots na jeeten" hota hai, to **lottery** hi sabse honest jawaab hai. Business kya chahta hai, wo decide karega -- engineering uske baad aati hai.

## 2. Best Fix: Pre-Sale Registration + Lottery

12:00:00 ki race ko **khatam** kar do:

1. **Registration window** -- 3 din tak users "interested" mark karte hain. Yahan koi hurry nahi, isliye koi stampede nahi.
2. **Eligibility filter** -- account age, verified phone, ek account per phone.
3. **Draw** -- 10,000 units ke liye offline random selection (seed log karo, audit ke liye).
4. **Winners ko time-boxed purchase token** -- "aapka 20-minute window 2 PM se". Token signed hai aur stock usi ke naam reserved hai.

Ab checkout par ek time par 500 log hain, 5 lakh nahi. Load problem **hi gayab** ho gayi -- ye scaling se sasta hai.

## 3. Jab Live Sale Chahiye: Virtual Waiting Room

Marketing ko "12 baje live drop" chahiye, to queue **app ke bahar** rakho. Ek edge service (CloudFront + Lambda@Edge, ya koi managed waiting-room product) user ko ek **signed position token** deta hai -- cookie mein position, issue time aur signature.

Sirf **N tokens per second** ko checkout mein admit karo. Baaki ko live position dikhao ("aap 84,201 number par, approx 6 min").

**Ye edge par kyun hona chahiye, app ke andar kyun nahi?** Kyunki app ke andar waiting room ka matlab hai ki 5 lakh requests ne pehle aapka load balancer, TLS, app server, session lookup aur DB connection pool chhua -- "please wait" likhne ke liye. Queue ka poora point hi ye hai ki **origin ko traffic dikhe hi na**. Edge CDN POPs par distributed hai aur position issue karne ke liye aapke DB ki zaroorat nahi. App ke andar queue = queue ka page hi pehle girega.

## 4. Inventory Correctness -- Yahan Overselling Hota Hai

Queue fairness deti hai; **stock ki sahi ginti alag problem hai**. `SELECT stock` phir `UPDATE stock = stock - 1` classic race condition hai ([[60-cache-says-100-db-says-20]] wali soch).

**Conditional SQL update** -- DB khud guard karta hai:

```sql
UPDATE products SET stock = stock - 1
WHERE id = $1 AND stock > 0
RETURNING stock;
```

Zero rows affected = sold out. Koi lock manually lena hi nahi pada.

**Ya Redis atomic decrement** -- `DECR` atomic hai, par -1 tak chala jaayega, isliye Lua se guard karo:

```javascript
// stock 0 se neeche na jaaye -- pura script atomically chalta hai
const DECR_IF_AVAILABLE = `
  local left = tonumber(redis.call('GET', KEYS[1]) or '0')
  if left <= 0 then return -1 end
  return redis.call('DECR', KEYS[1])
`;

async function reserve(productId, userId) {
  const left = await redis.eval(DECR_IF_AVAILABLE, 1, `stock:${productId}`);
  if (left < 0) return { ok: false, reason: 'sold_out' };

  // reservation TTL: 10 min mein payment nahi hua to stock wapas
  await redis.set(`resv:${productId}:${userId}`, '1', 'EX', 600, 'NX');
  return { ok: true, left };
}

// payment fail / cart abandon -> stock release
async function release(productId, userId) {
  const existed = await redis.del(`resv:${productId}:${userId}`);
  if (existed) await redis.incr(`stock:${productId}`); // sirf tab jab reservation asli thi
}
```

Teen cheezein yahan zaroori hain:

- **Short-lived reservations with TTL** -- warna abandoned carts stock ko hamesha ke liye lock kar dete hain. TTL expire hua to sweeper stock wapas kar deta hai.
- **Release idempotent** -- `DEL` ka return check karo, warna double release stock badha dega.
- **Purchase idempotent** -- user do baar "Buy" dabata hai. Client-generated `Idempotency-Key` par unique constraint lagao ([[32-payment-idempotency-double-click]]), warna retry do orders bana dega.

Distributed lock (`SET NX` + TTL, [[44-distributed-locking-with-redis]]) yahan **zaroori nahi** hai -- atomic counter kaafi hai aur bahut sasta hai. Lock tab chahiye jab ek se zyada resources ko ek saath badalna ho.

## 5. Bot Defence -- CAPTCHA Se Aage

CAPTCHA jawaab nahi hai: solver services paisa lekar isko todte hain. Layers lagao:

| Control | Kya rokta hai |
|---|---|
| **Account age + verified phone** | fresh throwaway accounts |
| **Per-account limit, per-IP nahi** | bot residential proxies se IP badalta rehta hai; account nahi |
| **Device fingerprinting** | ek device par 200 accounts |
| **WAF bot rules + edge rate limit** | naive scripts, known bot signatures |
| **Honeypot field** | form auto-fill karne wale simple bots |
| **Purchase velocity checks** | "10 second mein checkout complete" wale patterns |
| **Manual review / reseller flags** | ek address par 40 orders |

**Per-IP limit kaafi nahi hai** -- ye sabse common galti hai. Ek office ya mobile carrier NAT ke peeche 5,000 genuine users ho sakte hain, aur bot ke paas 50,000 residential IPs. Limit **account** par lagao.

Honest baat: **koi bhi single control determined bots ko nahi rokta.** Goal unhe impossible banana nahi hai -- unhe **mehnga** banana hai, aur unka speed advantage hatana hai. Lottery isiliye jeet ti hai: fast hone ka koi reward hi nahi bachta.

## 6. Load Par Kya Todta Hai

- **Queue depth** -- 5 lakh entries ka sorted set fine hai, par position calculate karne ke liye har request par `ZRANK` mehnga hai. Position periodically batch mein compute karke cache karo.
- **Hot row contention** -- sabhi 5 lakh updates **ek hi product row** par ja rahe hain. Us row par lock queue ban jaati hai aur throughput gir jaata hai, chahe server kitne bhi ho. **Advanced trick: stock ko N counters mein shard karo** -- `stock:P1:0 .. stock:P1:9`, har user ek random shard hit kare. 10x contention kam. Cost: ek shard khali ho gaya aur dusre mein stock bacha ho to "sold out" galat dikh sakta hai, isliye shard khali milne par doosra shard try karo, phir sold out bolo.
- **Notification fan-out** -- 5 lakh "sold out" / "you won" emails+SMS ek saath. Isko queue mein daalo aur workers se drain karo, warna provider throttle karega aur backlog banega ([[23-queue-backlog-after-spike]]).

## 7. Admitting Users -- Fixed Rate Par

```javascript
// queue: Redis sorted set, score = arrival timestamp (FIFO model)
// har second sirf `rate` users ko checkout token dete hain
async function admitBatch(saleId, rate) {
  const ids = await redis.zrange(`queue:${saleId}`, 0, rate - 1);
  if (ids.length === 0) return 0;

  const tx = redis.multi();
  for (const userId of ids) {
    // checkout window: 5 min. Iske baad token dead, seat wapas.
    tx.set(`admit:${saleId}:${userId}`, '1', 'EX', 300);
  }
  tx.zrem(`queue:${saleId}`, ...ids);
  await tx.exec();
  return ids.length;
}
// setInterval(() => admitBatch('sale-42', 200), 1000);
```

`rate` ko checkout ki **asli capacity** se tie karo (p99 latency aur DB connections dekhkar), marketing ki umeed se nahi. Ye poora point hai: queue ka kaam origin ko uski capacity par chalaye rakhna hai, usse zyada nahi.

## 🧠 Remember

> FIFO queue "fair" nahi hoti -- wo sabse tez network ko inaam deti hai, aur wo insaan nahi hota; asli fairness pre-registration + lottery se aati hai, queue sirf origin ko uski capacity par chalaye rakhne ka tool hai, aur stock ki sacchai ek atomic conditional decrement + TTL reservation se aati hai.

## Quick Self-Test

1. Waiting room app ke andar banane se kya fayda nahi milta, jo edge par banane se milta hai?
2. Reservations par TTL kyun zaroori hai, aur TTL na ho to kya galat dikhega?
3. Ek product ka stock 10 counters mein shard karne se kya milta hai, aur iski kya keemat hai?
