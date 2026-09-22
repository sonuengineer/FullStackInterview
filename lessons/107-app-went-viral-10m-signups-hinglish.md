# App Viral Ho Gaya, 10M Signups - Sabse Pehle Kya Karoge? (Hinglish)

> **Similar-question flag**: Triage ka tareeka wahi hai jo [[04-handling-traffic-spike-15k-rps]] aur [[38-first-thing-to-scale]] mein aa chuka hai (pehle measure, phir bleeding roko, phir scale). Naya yahan do cheezein hain: ye traffic **write-heavy** hai (har user ek naya row bana raha hai, sirf read nahi), aur **cost control** - viral traffic ka bill bhi viral hota hai.

## 1. Pehle Dekho Kya Sach Mein Toot Raha Hai

Panic mein sabse badi galti: bina dekhe servers double kar dena. Pehle 5 minute sirf *dekhne* mein lagao. Teen alag failure hain aur teenon ka ilaaj alag hai:

| Kya dikh raha hai | Asli problem |
|---|---|
| Homepage/images slow, API theek | Static assets ka bandwidth -- CDN hit ratio dekho |
| API 500/timeout, DB CPU 100% | DB overloaded -- slow query log, lock waits |
| API timeout par DB CPU low | Connection pool exhausted -- pool wait time dekho |
| Signup hi fail, baaki theek | Write path: insert + email + SMS inline chal rahe hain |

Do metric sabse zyada bolte hain: **signup endpoint ka p99 latency** aur **DB active connections vs pool max**. Agar connections ceiling par chipke hain aur DB CPU low hai, to problem DB nahi - aapka pool hai.

## 2. Stop The Bleeding (Pehle 30 Minute)

Is phase mein goal "sabko serve karna" nahi hai. Goal hai **system ko zinda rakhna** aur users ko error ke bajaye kuch izzatdaar dikhana.

1. **Static ko CDN par daalo.** Images, JS, CSS, landing page - sab CloudFront/Cloudflare ke peeche. Ye 10 minute ka kaam hai aur aksar 60-80% requests origin se hata deta hai.
2. **Signup par rate limit + queue.** Endpoint ko synchronous "sab kuch abhi" se badal kar "request accept, kaam baad mein" bana do.
3. **Mehnga non-critical feature band karo - feature flags se.** Recommendations, analytics dashboard, "people you may know", heavy search - flag off. Ye deploy ke bina band hone chahiye; agar aapke paas flag nahi hai to yahi pehla permanent TODO hai.
4. **Error ke bajaye waitlist page.** Capacity se upar aane wale users ko "Aap line mein ho, position 84,231" dikhao. Ye technically load shedding hai, par user ke liye ye exclusivity lagta hai - error page lagta hai "app toota hua hai".

> Sochne ka tareeka: 10M mein se 200k ko aaj achha experience dena, 10M ko toota hua experience dene se behtar hai.

## 3. Database Ko Bachao (Yahi Asli Bottleneck Hai)

Signup write-heavy hai, isliye read replica se koi khaas madad nahi milegi - writes to primary par hi jaayenge.

- **Connection pool ceiling lagao.** Postgres 500 concurrent connections handle nahi karta; wo thrash karne lagta hai. Har app instance ka pool chhota rakho aur PgBouncer jaisa pooler bich mein daalo. Yaad rakho: `app_instances x pool_size` kabhi DB ke `max_connections` se upar nahi jaana chahiye.
- **Signup ko ek single insert bana do.** Welcome email, SMS OTP, analytics event, referral credit, CRM sync - ye sab queue par.
- **Batch karo jo batch ho sakta hai.** Analytics/audit writes ko 100-100 ke batch mein flush karo, har request par ek insert mat maaro.
- **Mehnge queries turn off.** Signup ke waqt "kitne users hain" wala `COUNT(*)` chalana viral traffic mein aatm-hatya hai.

## 4. Stateless Ko Scale Karo - Par Dhyaan Se

App servers stateless hain, to ASG/replicas badhana aasan hai. **Lekin**: agar bottleneck DB hai, to zyada app servers matlab zyada connections, zyada queries, aur DB aur tez girega. Ye [[39-autoscaling-amplifies-outage]] wali baat hai - autoscaling problem ko amplify kar deta hai.

Rule: **app servers tabhi badhao jab DB ke paas headroom ho.** Warna aap sirf queue ko tezi se bhar rahe ho.

## 5. Cost Guardrails (Ye Log Bhool Jaate Hain)

Viral traffic ka ek shaant side-effect hai: bill. CDN egress, autoscaled instances, SMS/OTP per-message charges, aur transactional email - ye sab per-user cost hain aur 10M x kuch paise bhi bada number hai.

- Billing alarm lagao (daily spend threshold, sirf monthly nahi).
- Autoscaling par **max limit** rakho. "Unlimited scale" ka matlab "unlimited bill" hai.
- SMS/OTP par per-IP aur global daily cap - ye fraud/bot abuse ka favourite target hai.
- Log volume dekho: 100x traffic matlab 100x logs, aur log ingestion ka bill kabhi-kabhi compute se bada nikal jaata hai.

Ye aag ke waqt bore lagta hai, par agla hafta aata hai jab bill dikhta hai.

## 6. Ek Chhota Node.js Snippet - Signup Ko Patla Karo

Pehle signup mein 4 third-party calls inline the - insert, welcome email (300ms), OTP SMS (400ms), CRM sync (200ms). Har request DB connection ko ~900ms tak pakde rakhti thi. Fix: ek insert + ek enqueue.

```js
// signup = 1 insert + 1 enqueue, ~15ms; connection turant free
app.post('/signup', async (req, res) => {
  const user = await db.users.insert({ email, passwordHash, status: 'pending' });

  // idempotency key se retry par duplicate email nahi jaayega
  await queue.add('post-signup', { userId: user.id }, {
    jobId: `post-signup:${user.id}`,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 },
  });

  res.status(202).json({ ok: true, message: 'Account ban raha hai' });
});
```

Do cheezein yahan zaroori hain: `jobId` (idempotency - wahi user do baar process na ho) aur `backoff` (third-party API bhi to down ho sakta hai). Queue ab lamba ho jaayega - wo theek hai, par uspar nazar rakhni hogi ([[23-queue-backlog-after-spike]]: backlog 2 ghante ka ho gaya to welcome email bhejne ka koi matlab nahi bachta, aur worker autoscaling ki zaroorat padegi).

## 7. Pehle 30 Minute Ka Checklist

1. Dashboard kholo: signup p99, DB CPU, DB active connections, error rate, queue depth. (2 min)
2. Decide karo: bottleneck static / DB / pool / third-party - kaunsa? (3 min)
3. Static ko CDN ke peeche daalo. (10 min)
4. Signup par rate limit lagao; capacity se upar wale users ko waitlist page. (5 min)
5. Non-critical mehnge features flag se off. (2 min)
6. Post-signup kaam queue par shift; signup ko ek insert bana do. (agar code ready nahi hai to kam se kam email/SMS band karke "verify later" flow) (10 min)
7. Billing alarm + autoscale max limit set karo. (3 min)
8. Ek status page/tweet: "Hum expected se zyada signups handle kar rahe hain, aap line mein ho." Silence sabse mehngi cheez hai.

## 8. Aag Bujhne Ke Baad - Permanent Fix

| Temporary fix (aaj) | Permanent fix (is hafte) |
|---|---|
| Manual CDN setup | Sab static by default CDN se, build pipeline mein |
| Ad-hoc rate limit | Har public endpoint par rate limit, config se tunable |
| Feature code comment out | Proper feature flag system (kill switch) |
| Inline email/SMS hatana | Har slow third-party call queue ke peeche, by default |
| Pool size guess karna | PgBouncer + load test se nikala hua sahi pool number |

Aur sabse zaroori: **load test likho jo aaj ka traffic replay kare.** Agar aapko pata nahi ki signup path kitne RPS par tootta hai, to agli baar phir yahi din dohraayega.

## 🧠 Remember

> Viral spike mein pehla kaam scale karna nahi, **measure karke bleeding rokna** hai - static CDN par, signup ek insert par, baaki sab queue par; aur autoscale ki max limit lagao warna DB ke saath aapka bill bhi phategaa.

## Quick Self-Test

1. DB CPU 20% hai par API timeout kar rahi hai - kya toota hua hai aur app servers badhane se kya hoga?
2. Signup ko synchronous rakhne ke bajaye 202 + queue karne par user experience mein kya badalta hai, aur kya naya risk aata hai?
3. Autoscaling par max limit lagana "scale karne" ke khilaaf lagta hai - phir bhi kyun zaroori hai?
