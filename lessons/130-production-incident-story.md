# "Ek Production Incident Batao Jo Aapne Handle Kiya"

> **Behavioural lesson (Hinglish)** -- technical terms English mein hain.
> **Connects to**: [[02-debugging-random-500-errors]], [[14-cascading-failure-recovery]], [[20-sudden-latency-spike-checklist]], [[65-pagerduty-incident-dedup-paging]], [[93-cpu-spike-every-night-217am]], [[16-synchronized-connection-pool-expiry]], [[83-redis-down-database-stampede]].
> **Structure ke liye**: [[128-star-method-from-your-own-incidents]].

## 1. Ye Wo Sawaal Hai Jahan Backend Engineer Jeet Sakta Hai

Frontend candidate ke paas iska jawab mushkil se hota hai, fresher ke paas hota hi nahi, DSA-heavy candidate ke paas bilkul nahi. Aapke paas hota hai -- aur aapko pata bhi nahi hota ki ye kitna bada advantage hai. Production incident wo ek cheez hai jo **fake nahi ki ja sakti**: interviewer 3 follow-up mein pakad leta hai ki banda us room mein tha ya nahi.

Isliye ye sawaal aapko *dhoondhna* chahiye, darna nahi. Agar interviewer na puche, to [[127-tell-me-about-yourself]] mein khud ek incident ka naam daal do -- wo pakka pull karega.

## 2. Jo Interviewer Actually Sun Raha Hai

Ye wo ek baat hai jo is poore lesson ka core hai:

> **Interviewer check karta hai ki aapne mitigation aur root cause ko alag rakha ya nahi.**

Jo candidate kehta hai *"maine logs dekhne shuru kiye, phir code padha, phir samajh aaya ki..."* -- usne 40 minute production jalne diya jab tak wo samajh raha tha. Ye down-mark hota hai, bhale diagnosis brilliant ho.

Jo candidate kehta hai *"pehle maine traffic purane version par shift kiya -- 4 minute mein errors normal -- uske baad maine root cause dhoondhna shuru kiya"* -- ye instantly senior sunta hai.

| Candidate A (down-marked) | Candidate B (hired) |
|---|---|
| "Logs dekhe, debug kiya, 2 ghante mein cause mila, fix deploy kiya" | "Rollback kiya (4 min), users theek. Phir 2 ghante shaanti se root cause nikala" |
| Users 2 ghante down | Users 4 minute down |
| Debugging = heroism | Debugging = baad ka kaam |

Yaad rakho: **production mein pehla kaam bleeding rokna hai, samajhna nahi.** Samajhna important hai, lekin wo step 3 hai, step 1 nahi.

## 3. Answer Ka Arc: Paanch Steps

| # | Step | Kya batana hai | Time |
|---|---|---|---|
| 1 | **Kaise pata chala** | alert / dashboard / customer -- aur kitni der mein | 15 sec |
| 2 | **Bleeding rokna (mitigation)** | root cause se **pehle** kya kiya | 25 sec |
| 3 | **Diagnosis path** | hypothesis -> measure -> eliminate, order mein | 60 sec |
| 4 | **Fix** | asli fix, aur uska blast radius | 20 sec |
| 5 | **Prevention jo incident se zyada jeeyi** | alert, runbook, test, guardrail | 25 sec |

### Step 1 -- "Customer ne bataya" bolna allowed hai

Log yahan jhooth bolte hain kyunki unko lagta hai "customer ne bataya" kamzori hai. Nahi hai -- wo **honest** hai, aur ye ek achha follow-up kholta hai.

Honest version:

> "Hamein customer support se pata chala, ticket ke through -- matlab lagbhag 25 minute late. Hamare paas us endpoint par latency alert nahi tha, sirf 5xx par alert tha, aur ye failure 200 return kar rahi thi lekin khaali data ke saath. Yahi is incident ka sabse bada sabak tha."

Interviewer pakka puchega: *"To aapne monitoring mein kya badla?"* -- aur ye sawaal aapke liye tohfa hai:

> "Teen cheezein: ek alert business metric par -- orders per minute ek threshold se neeche gire to page -- kyunki technical metric green tha aur business metric red; doosra, us endpoint par empty-result rate ka metric; teesra, hum `200 with empty payload` ko ab explicitly error case treat karte hain."

Ye jawab "hamare paas perfect monitoring thi" se **zyada** impressive hai, kyunki ye dikhata hai ki aapne gap pakda aur band kiya ([[65-pagerduty-incident-dedup-paging]]).

| Kaise pata chala | Follow-up jiske liye ready raho |
|---|---|
| Alert ne pakda | "Alert kis metric par tha? Noisy tha?" |
| Dashboard dekhte hue dikha | "Alert kyun nahi tha?" |
| Customer / support ne bataya | "Aapne monitoring mein kya add kiya?" -- yahi real question hai |
| Doosri team ne bataya | "Ownership kaise clear kiya?" |

### Step 2 -- Mitigation Pehle

Mitigation ka matlab: user ka dard kam karo, chahe cause pata na ho. Toolbox:

| Mitigation | Kab |
|---|---|
| **Rollback / previous version** | Haal mein deploy hua tha -- pehla shak yahi |
| **Feature flag off** | Naya code path on tha |
| **Traffic shed / rate limit** | Overload hai, origin bach nahi raha ([[04-handling-traffic-spike-15k-rps]], [[106-rate-limiting-at-the-edge-hinglish]]) |
| **Scale out (temporarily)** | Capacity ka issue, aur scaling safe hai ([[39-autoscaling-amplifies-outage]] dekho -- hamesha safe nahi) |
| **Heavy job / consumer pause** | Koi background cheez DB kha rahi hai |
| **Serve stale from cache** | Downstream down hai, stale data acceptable hai |
| **Circuit breaker on dependency** | Ek slow dependency poore system ko kha rahi hai ([[14-cascading-failure-recovery]]) |
| **Degrade a feature** | Recommendations band, checkout zinda |

Aur ek line jo bahut strong lagti hai: *"Maine mitigation lagane se pehle 30 second mein ek quick snapshot le liya -- heap dump aur `pg_stat_activity` ka output -- kyunki rollback ke baad evidence gayab ho jaata hai."* Ye dikhata hai ki aap dono soch rahe ho: users aur post-mortem.

### Step 3 -- Diagnosis: Hypothesis, Guess Nahi

Format jo use karo: *"Mujhe laga X ho sakta hai, isliye maine Y dekha, usme Z mila, to maine X ko rule out/in kiya."* Ye structure interviewer ko aapka thinking dikhata hai; "phir maine logs dekhe" se kuch nahi dikhta. Checklist jo mental model banata hai: [[20-sudden-latency-spike-checklist]].

### Step 4 -- Fix, Blast Radius Ke Saath

Fix bolte waqt ye bhi bolo ki fix **kaise safely** gaya: *"Index `CONCURRENTLY` banaya taaki table lock na ho"*, ya *"migration ko do deploy mein toda -- pehle column add kiya nullable, phir backfill batches mein, phir constraint"*. Ye wo detail hai jo sirf unke paas hoti hai jinhone kiya hai.

### Step 5 -- Prevention Jo Incident Se Zyada Jeeyi

Ye sabse under-used step hai aur hiring manager ke liye sabse valuable. Ek **alert** jo isko next time 25 minute pehle pakde; ek **runbook** ki 10 line taaki agli baar koi bhi on-call kar sake; ek **test** ya load test jo condition reproduce kare; ek **guardrail** (`statement_timeout`, max payload size, batch cap, max retry + dead-letter queue); ya ek **process** change (migration review checklist, "bulk update business hours mein nahi").

## 4. Ek Poora Worked Answer

Ye illustrative hai -- apna incident slot karo. Maan lo aapke paas ye hai: *bulk price update ke baad buyers ko purani prices dikhne lagi* (shape [[97-bulk-price-update-replica-lag]] se).

**Detection (15 sec)**
> "Shaam 4:10 par support ne bataya ki do dealers ko product page par purani price dikh rahi hai. Alert kuch nahi bola -- error rate 0.01%, latency normal, CPU normal. System ke hisaab se sab healthy tha. Issue correctness ka tha, availability ka nahi, aur hamare paas correctness ka koi alert nahi tha."

**Mitigation (25 sec)**
> "Mujhe root cause nahi pata tha, lekin impact pata tha: galat price par order aa sakta tha, jo direct margin loss hai. To maine do cheezein turant ki. Ek, price read karne wale path ko primary par force kar diya -- ek config flag se, 3 minute mein, thoda extra load lekin correct data. Do, pichhle 40 minute ke orders ko flag karwa diya ops team se review ke liye. Us ke baad main cause dhoondhne baitha."

**Diagnosis (60 sec)**
> "Mera pehla hypothesis cache tha -- Redis mein stale price. Maine ek product ki key direct check ki, usme nayi price thi. To cache rule out.
>
> Doosra hypothesis replica lag. Maine replication lag ka metric dekha: normally 200 millisecond, us waqt **42 second**. Mil gaya. Lekin asli sawaal ye tha ki lag kyun aaya.
>
> Teesra step: us time par kya chala. Pata chala 2:00 baje category manager ne bulk price update kiya -- 2.1 lakh rows, ek single transaction, ek `UPDATE` statement. Wo transaction primary par 90 second mein commit hua, lekin replica usko **single-threaded** apply karta hai, aur usne usko 40+ second lagaya, aur us doubt window mein usne naye changes bhi pichhe push kar diye.
>
> Ek chauthi cheez bhi mili: hamara code 'read from replica' har read ke liye use kar raha tha, bina ye pooche ki ye read stale-tolerant hai ya nahi. Product listing ke liye 2 second stale theek tha; checkout ke price validation ke liye bilkul nahi."

**Fix (20 sec)**
> "Do fix. Pehla, bulk updates ko 2,000 rows ki batch mein toda, har batch ke beech 200ms sleep, aur replica lag ko check karke pause karne wala loop -- lag 1 second se zyada hua to ruk jao. Doosra, aur ye zyada important tha: read path ko do hisson mein baanta -- `readStale()` aur `readFresh()` -- aur price validation, inventory check, aur payment path ko `readFresh()` par move kiya."

**Result + Prevention (25 sec)**
> "Us ke baad bulk update ke dauraan max replica lag 42 second se 900 millisecond par aa gaya, aur stale-price ka koi ticket agle 6 mahine mein nahi aaya. Prevention mein teen cheezein: replica lag par alert 2 second par, ek runbook 'stale data dikh raha hai' ke liye jisme pehla step hi primary-read flag hai, aur code review ka ek rule -- naya read `readStale` ya `readFresh` explicitly choose karega, default nahi milega."

**Ye answer kyun kaam karta hai:** honest detection gap, mitigation root cause se pehle, hypothesis-driven diagnosis jisme do cheezein rule out hui, fix jo symptom aur design dono ko chhuta hai, aur prevention jisme ek alert, ek runbook, aur ek process change hai.

```javascript
// Prevention ka wo hissa jo interview mein bolne layak hai:
// bulk update ko replica lag par lagaam deke chalana.
async function bulkUpdateWithLagGuard(rows, { batchSize = 2000, maxLagMs = 1000 }) {
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    await db.query('UPDATE prices SET amount = v.amount FROM ... ', [batch]);

    // lag ko DB se poochho, guess mat karo
    let lagMs = await getReplicaLagMs();
    while (lagMs > maxLagMs) {
      await sleep(500);                 // replica ko saans lene do
      lagMs = await getReplicaLagMs();
    }
  }
}
```

Code chhota hai, lekin iska point bada hai: *"writer ne replica ki health par backpressure liya"* -- yahi sentence interviewer ko yaad rehti hai.

## 5. "Mere Paas Koi Bada Incident Nahi Hai"

Ye genuinely ho sakta hai -- 1-2 saal experience, chhota traffic, ya aap on-call mein nahi the. **Jhooth mat bolo**, incident fake karna sabse aasani se pakda jaata hai (interviewer sirf poochega "us waqt replication lag kaise measure kiya tha?" aur khel khatam).

Honest aur strong alternatives:

| Aapke paas ye hai | Kaise frame karo |
|---|---|
| **Near-miss** | "Outage nahi hua, lekin hum 10 minute door the. Maine notice kiya ki connection pool 95% par chal raha hai aur..." |
| **Staging mein pakda bug** | "Ye production tak pahuncha hi nahi, aur usi wajah se main ise apna best catch maanta hoon. Load test mein maine dekha ki..." |
| **Chhota incident** | 50 user ka incident bhi incident hai. Scale chhota, **method** wahi. Isko chhota bolkar hi batao, badhao mat |
| **On-call / ops improvement** | "Bada incident mere time par nahi hua, lekin maine alert noise 40 se 9 per week par laaya aur runbook likhi" |
| **Doosre ka incident jisme aap the** | "Lead drive kar raha tha, mera hissa ye tha -- maine wo query profile ki aur ye mila. Aur jo maine observe kiya wo ye tha..." |
| **Khud ka banaya hua incident** | "Maine apne side project par ek load test se khud ko break kiya -- 500 concurrent par kya tootta hai dekhne ke liye" |

Opening line jo credible lagti hai: *"Mere scale par 'outage' type incident kam hue hain -- hamara traffic itna bada nahi tha. Lekin ek data correctness wala issue tha jo mujhe aaj tak yaad hai, aur usme method wahi tha..."*

Ye line aapko chhota nahi dikhati, **honest aur self-aware** dikhati hai -- aur interviewer ko usse zyada pasand aata hai jo 10 lakh users ka jhootha incident sunaata hai.

## 6. Galtiyan Jo Score Girati Hain

- **Debug karte-karte production jalne dena** (sabse badi).
- **Blame** -- "DevOps team ne galat config daali thi". Chahe sach ho, bolne ka tareeka badlo: "config ek jagah se missing thi, aur hamare paas uska validation nahi tha".
- **Prevention na batana** -- interviewer sochta hai ye dobara hoga. **Sirf "humne" bolna** -- aapka hissa clearly naam lo ([[128-star-method-from-your-own-incidents]]).
- **Over-dramatise** -- "48 ghante jaaga". Sustainable on-call ek signal hai, heroism nahi.
- **Numbers na dena.** "Kitne users affected the?", "kitni der down tha?" -- ye aane hi hain.

## 🧠 Remember

> Incident wale sawaal mein interviewer sabse pehle ye sunta hai ki aapne **bleeding pehle roki aur root cause baad mein dhoonda** -- rollback ya flag-off 4 minute mein, diagnosis 2 ghante mein shaanti se; aur "customer ne bataya" ek valid jawab hai, bas uske saath wo alert batana jo aapne baad mein banaya.

## Quick Self-Test

1. Aapne 2 ghante debug karke perfect root cause nikala aur fix kiya. Interviewer phir bhi down-mark kyun kar sakta hai?
2. "Hamein customer se pata chala" -- ye kyun kamzori nahi hai, aur iske saath kaunsa follow-up aapko ready rakhna hai?
3. Mitigation ke chaar tareeke batao aur har ek kab use karoge.
4. Rollback karne se pehle 30 second kya karna chahiye, aur kyun?
5. Aapke paas koi bada outage nahi hai -- teen honest alternatives batao jo aap use kar sakte ho.
