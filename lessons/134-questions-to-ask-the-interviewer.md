# Interviewer Se Kya Poochna Hai (Aur Kya Nahi)

*"Any questions for us?" -- ye interview ka end nahi hai, ye ek **scored round** hai. Aur "no, aapne sab cover kar diya" uska sabse kharab jawab hai.*

---

## 1. Ye Sawaal Kyun Scored Hota Hai

Jab interviewer feedback form bharta hai, usme ek line hoti hai jaisi: *"candidate ki curiosity / engagement"*. Aapke sawaal teen cheezein batate hain:

| Aapka sawaal | Jo signal jaata hai |
|---|---|
| Kuch bhi nahi | Interest nahi hai, ya aapne tayari nahi ki |
| Sirf perks/leave/WFH | Aapko kaam se zyada package interest hai |
| "Code prod tak kaise jaata hai?" | Aap production reality sochte ho -- senior signal |
| "Is team se pichle saal kitne log gaye?" | Aap bhi evaluate kar rahe ho -- confident candidate |

Aur ek practical faayda: **aapke sawaal yaad rehte hain.** Round khatam hone ke 2 minute baad interviewer aapka algorithm bhool jaayega, par "usne poocha tha ki oldest service kaun maintain karta hai" yaad rahega.

## 2. Round Ke Hisaab Se Sawaal

Sabse badi galti: HR wale sawaal engineer se poochna, aur technical sawaal HR se.

| Round | Poochho | Kyun |
|---|---|---|
| **Engineer / peer** | "Ek one-line change mere laptop se prod tak kitne time mein jaata hai?" | CI/CD, review culture, release frequency -- sab ek sawaal mein |
| | "On-call kaisa dikhta hai? Rotation kitne log, raat mein page aata hai, aakhri mahine kitne?" | Burnout ka sabse honest indicator |
| | "Sabse purana service kaunsa hai aur use kaun maintain karta hai?" | Legacy ka weight aur kya wo ek hi banda jaanta hai |
| | "Testing kaise hoti hai -- unit, integration, ya mostly manual QA?" | Aapka roz ka din isi par depend karta hai |
| | "Aap AI tools kaise use karte ho, aur review process kya hai?" | 2026 mein relevant sawaal ([[114-blog-what-engineers-should-do-when-ai-writes-code-hinglish]]) |
| **Hiring manager** | "Pehle 6 mahine mein success kaise measure hoga?" | Expectations likhit mein, aur unhe sochna padega |
| | "Is role mein pehle jo banda tha, wo kya kar raha tha -- aur ab kahan hai?" | Backfill hai ya naya role; attrition ka hint |
| | "Priorities kaise decide hoti hain -- roadmap product deta hai ya engineering ka input hota hai?" | Aap ticket-taker banoge ya partner |
| | "Agle 2 quarter mein team ka sabse bada technical problem kya hai?" | Aapko pata chal jaayega ki aap kya jhelne wale ho |
| | "Team kitni badi hai aur kitne log hire kar rahe ho?" | Fast growth = chaos + opportunity, dono |
| **HR / recruiter** | "Breakup kya hai -- fixed, variable, retention, joining bonus?" | Variable ko salary maan lena classic galti hai ([[135-salary-negotiation-india]]) |
| | "Variable kis cheez par depend karta hai, aur last 2 saal mein kitna percent payout hua?" | 20% variable jo 60% pay hota hai = effectively kam salary |
| | "Appraisal cycle kab hota hai, aur joining ke kitne mahine baad main eligible hoonga?" | March cycle + April joining = 11 mahine wait |
| | "Notice period kitna hai, aur buyout allowed hai?" | Exit cost -- joining se pehle jaanna better hai |
| | "Offer se joining tak ka process kya hai -- BGV, document list?" | Surprises kam honge |

## 3. Teen Sawaal Jo Sabse Zyada Sach Nikalte Hain

Ye chuppe-rupe diagnostic hain. Jawab se zyada, **jawab dene ka tarika** batata hai.

**1. "Ek one-line change prod tak kitne time mein pahunchta hai?"**

- "Same din, PR merge hone par automatic" -> mature CI/CD, aap ship karoge.
- "Hafte mein ek release window hai" -> process hai, thoda slow.
- "Hmm... depends. Release manager se approval, phir DBA, phir change ticket" -> aap 60% time waiting mein bitaoge.
- Interviewer awkward hans de -> jawab mil gaya.

**2. "Aakhri incident kab tha aur uske baad kya badla?"**

Ye best sawaal hai. Teen possible outcomes:
- Specific incident + specific change ("Redis down hua tha, ab circuit breaker hai") -> **learning culture hai** ([[83-redis-down-database-stampede]]).
- "Incidents hote hi nahi" -> ya to traffic nahi hai, ya wo track nahi karte.
- Incident yaad hai par change kuch nahi -> same incident dobara hoga, aur aap on-call honge.

**3. "Pichle saal is team se kitne log gaye?"**

Direct lagta hai, par politely poocha jaaye to bilkul fair hai: *"Team ki stability kaisi rahi hai pichle saal?"* Agar 8 ki team mein 4 gaye, aapko reason jaanna chahiye joining se pehle, baad mein nahi.

**Bonus:** "Aap is role mein kis cheez ke liye 'no' sun chuke ho -- kaise log fit nahi hue?" Manager ko sochna padta hai, aur aapko real bar pata chalta hai.

## 4. Jo Nahi Poochna

| Mat poochho | Kyun |
|---|---|
| Kuch bhi jo careers page / JD par likha hai | Aapne research nahi kiya, ye saaf dikh jaata hai |
| "Company kya karti hai?" | Instant reject-level sawaal |
| Round 1 mein engineer se salary/CTC | Wo decide nahi karta, aur signal galat jaata hai |
| Round 1 mein leave policy, WFH, timings | Offer stage par poochho, tab leverage bhi hai |
| "Mera chance kitna hai?" | Interviewer ko awkward position mein daalta hai |
| "Aapko ye job pasand hai?" ek hostile tone mein | Challenge karna aur curious hona alag hai |
| 10 sawaal ki list | 2-3 achhe sawaal > 10 rapid-fire |

**Timing matter karta hai:** WFH, timings, leave, laptop -- ye sab **valid** sawaal hain, bas unki jagah HR round ya offer discussion hai, technical round nahi.

## 5. Ek Chhota Framework

Agar kuch yaad na aaye, teen bucket se ek-ek sawaal utha lo:

```
WORK    -> main kis cheez par kaam karunga, aur wo kaise ship hoti hai?
TEAM    -> kaun saath hoga, decisions kaise hote hain?
TRUTH   -> aakhri baar kuch toota to kya badla?
```

Aur ek aadat: **jo interview mein hua, usi se sawaal banao.** Agar unhone aapse rate limiting poocha, poochho "aapke yahan rate limiting edge par hai ya app layer par?" ([[106-rate-limiting-at-the-edge-hinglish]]). Ye pre-written list se hazaar guna better lagta hai, kyunki ye genuinely us conversation ka part hai.

## 6. Jab Wo Kahein "Time Nahi Bacha"

Do line mein wrap karo, sawaal chhodo mat:

> "Theek hai -- main do chhote sawaal email par bhej doon? Main specifically ye jaanna chahta tha ki deployment process kaisa hai aur pehle 6 mahine mein success kaise dikhta hai."

Isse do cheez hoti hai: aapka sawaal record ho gaya, aur aapne engaged dikhaya.

## 7. Reframe: Aap Bhi Decide Kar Rahe Ho

Indian interview culture mein ek default assumption hai: company judge karti hai, candidate grateful rehta hai. Ye galat hai, aur ye galti mehengi padti hai.

Aap 2-4 saal apni zindagi ke, apna peak learning time, aur apna career trajectory is jagah daal rahe ho. Ek galat jagah join karne ka cost sirf salary nahi -- 18 mahine aisi tech par jo market mein nahi hai, ya aisi team mein jahan aap kuch own nahi karte, aapka next switch bhi mushkil kar deta hai ([[96-blog-12lpa-to-22lpa-packaging]]).

To sawaal "unko impress karne ke liye" nahi, **apna due diligence** karne ke liye poochho. Mazedaar baat: jo log is tarah poochhte hain, wahi zyada impressive lagte hain. Confidence fake nahi hota, wo evaluation se aata hai.

Aur agar koi company achhe sawaalon par defensive ho jaaye -- wo bhi ek answer hai.

## 🧠 Remember

> "Koi sawaal nahi" ka matlab interviewer ke liye "koi interest nahi" hota hai -- teen sawaal pakke rakho: code prod tak kaise jaata hai, aakhri incident ke baad kya badla, aur pehle 6 mahine mein success kaise measure hoga.

## Quick Self-Test

1. Aapke paas abhi, bina soche, engineer round ke liye do sawaal hain?
2. Aapka sawaal careers page par to nahi likha hua hai?
3. "Aakhri incident ke baad kya badla" ka jawab "kuch nahi" aaya -- aap kya conclude karoge?
4. Variable 20% hai -- aap HR se exactly kya follow-up poochhoge?
