# "Why Are You Leaving?" Aur "Why This Company?"

*Do sawaal, ek hi trap. Dono mein interviewer check kar raha hai ki aap kisi cheez se **bhaag** rahe ho ya kisi cheez ki **taraf** jaa rahe ho.*

---

## 1. Ek Rule Jo Dono Sawaalon Par Lagta Hai

**Pull, not push.**

- *Push* = main yahan se nikalna chahta hoon (manager, pressure, politics, paisa).
- *Pull* = main wahan jaana chahta hoon (scale, ownership, domain, product).

Push reasons sach ho sakte hain -- par unka signal yahi jaata hai: "ye banda 18 mahine baad hamare bare mein bhi yahi bolega."

Aur ek practical baat: aap jo complaint karte ho, interviewer usme apni company ko dekhta hai. Agar aapne "process nahi tha" bola, aur unki company bhi fast-moving startup hai, to aapne khud ko hi reject kar liya.

## 2. Teen Honest Situations, Rewritten

Jhooth bolne ki zaroorat nahi hai. **Same sach, forward-looking framing.**

### Situation A: Growth ruk gayi

| Kaise sochte ho | Kaise bolna hai |
|---|---|
| "3 saal se wahi CRUD APIs, kuch naya nahi" | "Last 3 saal mein maine apne module par depth bana li -- ab main us jagah hoon jahan next learning curve team ke bahar se aayegi. Aapke yahan event-driven side par kaam hai, wo mere liye natural next step hai." |

### Situation B: Scale hi nahi hai

| Kaise sochte ho | Kaise bolna hai |
|---|---|
| "Humare paas 2000 users hain, kuch interesting nahi hota" | "Main jo problems solve kar sakta hoon, wo hamare traffic par aati hi nahi -- caching, sharding, replica lag sab theory reh gaya. Mujhe aisi jagah chahiye jahan ye decisions roz lene padte hain." |

Note: chhoti scale par bhi senior banna possible hai ([[53-blog-senior-system-design-without-big-scale]]) -- par "mujhe bade load wale system par kaam karna hai" bilkul legit reason hai.

### Situation C: Company ki direction badal gayi

| Kaise sochte ho | Kaise bolna hai |
|---|---|
| "Product band kar diya, ab sab client projects par hain, layoff ka dar hai" | "Company ne product se services ki taraf shift kiya. Main product engineering mein rehna chahta hoon -- ek hi system ko long term own karna, metrics dekhna, iterate karna. Isliye main product company dekh raha hoon." |

Service -> product switch ka ye sabse clean framing hai, aur ye **sach** hai, defensive nahi.

## 3. Jo Bilkul Nahi Bolna

| Mat bolo | Kyun galat hai | Kya bolo instead |
|---|---|---|
| "Paisa kam hai, bas yahi reason hai" | Sirf-paisa candidate ko counter-offer par chala jaane wala maana jaata hai | Role/scope baat karo, compensation HR round mein ([[135-salary-negotiation-india]]) |
| "Mera manager bahut kharab hai" | Aap gossip karte ho, ye signal | "Main aise team mein kaam karna chahta hoon jahan technical decisions engineers ke saath hote hain" |
| "Work pressure bahut hai / work-life balance nahi" | Sunne wale ko lagta hai aap load nahi le sakte | "Main sustainable delivery wali team dhoond raha hoon jahan planning hoti hai" -- aur ye sawaal aap *unse* poochho ([[134-questions-to-ask-the-interviewer]]) |
| "Appraisal mein dhokha hua" | Bitterness dikhti hai | "Mere contribution aur role ke beech gap ban gaya tha" |
| "Company politics" | Unverifiable + red flag | Skip. Ek specific, non-personal reason do |

Rule of thumb: **ek hi reason do, 30-40 second mein, aur usko aage ki taraf mod do.** Teen complaints ek saath dena venting lagta hai.

## 4. Jab Asli Reason Paisa Hi Hai

Ye common hai aur isme kuch sharam ki baat nahi. Par poora jawab "paisa" mat banao. Honest + professional version:

> "Seedhi baat -- compensation ek factor hai. Mere last do appraisal cycle mein hike 8-10% rahi, jabki mera scope badha -- ab main deployment aur on-call bhi own karta hoon. Market rate aur mere current package ka gap internally band hone wala nahi hai, ye maine manager se discuss bhi kiya. Par agar sirf paisa hota to main kai jagah apply kar leta; main specifically aisi jagah dhoond raha hoon jahan [X] type ka kaam hai, kyunki yahi wo skill hai jo main agle 3 saal banana chahta hoon."

Isme teen cheezein kaam kar rahi hain:
1. Aap **jhooth nahi bol rahe** -- bluff pakda jaata hai.
2. Aapne dikhaya ki aapne pehle **internally try** kiya (mature signal).
3. Aapne paise ko ek factor banaya, **the** factor nahi.

Aur kabhi "mera current CTC X hai, mujhe Y chahiye" ko *why leaving* ka jawab na banao. Wo compensation discussion hai, motivation nahi.

## 5. "Why This Company?" -- Ek Hard Test

Is jawab mein kam se kam **ek line aisi honi chahiye jo sirf is company ke liye sach ho.** Agar aapka jawab copy-paste karke doosri company ke naam ke saath chal jaata hai, wo jawab zero hai.

Ye fail karte hain:
- "Aapki company market leader hai" (sabke liye koi na koi leader hai)
- "Mujhe growth chahiye aur yahan achhe log hain"
- "Aapka culture bahut achha suna hai"
- "Main top product company join karna chahta hoon"

Ye kaam karte hain:
- "Aapke engineering blog mein jo Kafka consumer lag wala post tha -- maine wahi problem chhote scale par dekhi hai, aur wo exactly wo cheez hai jo main deeply karna chahta hoon."
- "Aap tier-2 cities mein cash-on-delivery handle karte ho -- uska reconciliation aur idempotency problem mere last system se milta hai, par 50x scale par."
- "Aapke app par Diwali sale ke time jo spike aata hai, wo ek saal mein 2 din ka problem hai -- us tarah ka flash-sale fairness design mujhe interesting lagta hai ([[111-fair-queue-flash-sale-bots-hinglish]])."

Pattern: **unka product/scale/problem + aapka relevant experience + aap kya seekhna chahte ho.**

## 6. 20-Minute Research Routine

Wo "only-true-for-this-company" line banane ke liye 20 minute kaafi hai:

| Min | Kya karna hai | Kya nikalega |
|---|---|---|
| 0-4 | Unka product khud use karo. App install karo, ek order/signup karo | Ek real observation ("aapka search typo-tolerant hai") |
| 4-9 | Engineering blog / Medium / tech talks. Latest 2-3 posts | Unka actual tech stack aur current pain |
| 9-13 | LinkedIn par unke engineers -- aap jis role par ho, usme log kya likhte hain | Team structure, kya own karte hain |
| 13-17 | News: funding, naya market, naya product line | Business context ("aap ab B2B side khol rahe ho") |
| 17-20 | Glassdoor/Blind/AmbitionBox skim, aur JD dobara padho | Interview process + JD ke keywords |

Ab ek line likho: **"Aapke paas ___ problem hai, maine ___ kiya hai, aur main ___ seekhna chahta hoon."** Ye ek line poora "why this company" ka jawab ban jaati hai.

Agar company ka blog nahi hai (bahut Indian companies ka nahi hai), to JD + product observation se kaam chalao: "JD mein multi-tenant billing likha hai -- mere current system mein tenant isolation hi sabse painful part tha, isliye ye role interesting hai."

## 7. Service Company Se Product Company Jaate Waqt

Ye India mein sabse common switch hai, aur interviewer ko ek doubt hota hai: "ye banda ticket-based kaam ka aadi hai, ownership le payega?"

Us doubt ko pehle hi address karo:

> "Service setup mein scope client define karta tha. Par maine [X] project par khud monitoring add ki thi, aur ek slow query ko 9s se 400ms laaya tha -- wo kisi ne nahi maanga tha. Mujhe aisi jagah chahiye jahan ye default expectation ho, exception nahi."

Ek **unasked** initiative ka example is doubt ko sabse tez marta hai.

## 8. Dono Jawaab Ek Saath -- Consistency Check

Interviewer dono jawaab jodta hai. Ye consistent hone chahiye:

```
Why leaving: "mujhe X chahiye"
Why this co: "aapke yahan X hai, kyunki <specific proof>"
Where in 3 yrs: "X ke upar built hua Y"
```

Agar aapne bola "scale chahiye" aur phir company ke bare mein sirf "culture achha hai" bola, gap dikh gaya. Ek hi `X` teeno jawabon mein chalna chahiye.

## 🧠 Remember

> "Why leaving" ka jawab wo cheez honi chahiye jo aap chahte ho, wo nahi jisse aap tang ho -- aur "why this company" ka jawab aisa hona chahiye jo kisi doosri company ke naam ke saath bolne par jhooth ban jaaye.

## Quick Self-Test

1. Apna "why leaving" jawab bolo -- usme koi insaan ya process villain hai?
2. Apne "why this company" jawab mein company ka naam badal kar bolo. Kya wo ab bhi sach lagta hai? Agar haan, wo jawab bekaar hai.
3. Agar asli reason paisa hai, aap kaise dikhaoge ki aapne internally try kiya tha?
4. Aapka "why leaving" aur "3 saal mein kahan" -- dono mein same `X` hai?
