# Blog: AI Code Likh Dega - To Engineers Ka Time Kahan Jaaye? (Hinglish)

Maan lo AI aapka 70% code likhne lagta hai. Aapke din ke 8 ghante kahan jaane chahiye? Candidates: requirements, system design, architecture, security, debugging, users se baat karna, technical decisions. Chalo ek-ek par honest raay -- kahan AI **bahut** help karta hai, kahan **thodi**, kahan **bilkul nahi**, aur har jagah **kyun**.

## 1. Requirements -- Human (AI ki help: kam)

AI ke paas woh information **exist hi nahi karti**. "Refund 7 din mein milega ya 14?" -- ye kisi repo, kisi doc, kisi internet page par nahi likha. Ye aapke finance team ke dimaag mein hai, aur usme bhi aadha decide nahi hua hai.

AI yahan sirf itna kar sakta hai: aapke likhe requirement mein gaps aur contradictions dhoondh de. Par wo **missing information create nahi kar sakta**. Isliye requirements clarify karna sabse high-leverage kaam ban jaata hai -- galat requirement par AI ab **tez** speed se galat cheez bana dega.

## 2. Users Se Baat Karna -- Human (AI ki help: bohot kam)

Same reason, plus ek extra: log apni asli problem bolte nahi, symptom bolte hain. "Export button slow hai" ka matlab shayad "mujhe ye data Excel mein nahi, dashboard mein chahiye" hai. Ye baat sunkar, follow-up poochhkar nikalti hai. AI ka role: notes summarise karna. Conversation karna nahi.

## 3. System Design aur Architecture -- Mostly Human (AI ki help: thodi)

AI aapko 5 standard designs sunaa dega -- queue lagao, cache lagao, read replica lagao. Genuinely useful starting point hai.

Jo wo nahi kar sakta: **aapke constraints ke saath trade-off chunna**. Team 4 log ki hai, budget tight hai, ops maturity kam hai -- ab Kafka sahi hai ya ek DB table + cron kaafi hai? Ye judgment call hai ([[42-resilience-vs-overengineering]]). AI ka default bias over-engineering ki taraf hota hai, kyunki usne internet ke "best practice" posts padhe hain, aapki team ki reality nahi.

## 4. Security -- Split (AI ki help: known patterns mein achhi, threat modelling mein nahi)

Do alag cheezein hain:

- **Known vulnerability patterns**: SQL injection, missing authz check, hardcoded secret, unsafe deserialization -- yahan AI achha scanner hai. Ise seriously use karo.
- **Threat modelling aur blast radius**: "is service ke compromise hone par attacker kahan tak pahunchega?", "kaunsa data leak hone par company band ho jaayegi?" -- ye business impact ke judgment hain. AI advice de sakta hai, decide nahi kar sakta.

Simple rule: **pattern-finding delegate karo, risk-accepting nahi.**

## 5. Debugging -- Split, aur mazedaar split

AI bahut madad karta hai: stack trace padhna, error message ka matlab, log parse karna, "ye exception aata hai jab..." type knowledge. Ye sach mein time bachata hai.

Jo human ke paas rehta hai: **live system mein hypothesis banana aur test karna**. Asli production behaviour repo mein nahi hota -- wo traffic shape, data distribution, neighbour service ki hiccup aur us din ke deploy ka combination hai. Aapko decide karna padta hai: kya measure karein, kaunsa experiment safe hai, aur kab rukna hai ([[30-workload-before-conclusion]]). AI = reading assistant, human = investigator.

## 6. Technical Decisions -- Human (AI: input, vote nahi)

"Postgres ya Mongo", "monolith todein ya nahi", "migration abhi ya Q3" -- AI options aur trade-offs saaf likh dega. Par decision ka matlab hai **consequence accept karna**, aur AI consequence nahi bhugat sakta ([[29-why-hire-you-over-ai]]).

## 7. Ranked Table: Aapke Ghante Kahan Jaayein

High leverage se low leverage:

| Rank | Kaam | AI ki madad | Kyun yahan time lagao |
|---|---|---|---|
| 1 | Requirements clarify karna | Kam | Galat requirement par AI aur tez galti karega |
| 2 | Verification: review + test design | Thodi | Yahi naya bottleneck hai (agla section) |
| 3 | Architecture aur trade-off decisions | Thodi | Galti ki cost girti nahi hai, badhti hai |
| 4 | Production debugging aur observability | Thodi-medium | Live behaviour kisi repo mein likha nahi hai |
| 5 | Users/stakeholders se baat | Bohot kam | Information sirf logon ke paas hai |
| 6 | Threat modelling, blast radius | Kam | Risk accept karna human ka kaam |
| 7 | Known-pattern security scanning | Bohot | Delegate karo, phir confirm karo |
| 8 | Boilerplate, glue, CRUD, scaffolding | Bohot | Yahan apna time bachao |
| 9 | Syntax, config recall, docs dhoondhna | Bohot | Ratne ka return zero |

## 8. Asli Insight: Verification Naya Bottleneck Hai

Pehle pipeline aisa tha: **socho -> likho -> review -> ship**. Likhna sabse slow step tha.

Ab likhna almost free hai. To slowest step ban gaya hai **review aur test**. Aur ek kadwi line:

> Jo code aap review nahi kar sakte, wo aap ship nahi kar sakte -- chahe wo compile ho jaaye.

Iska seedha matlab: reading aur testing skills ki value **badhi** hai, ghati nahi. Practical steps:

- PR chhote rakho -- 200 lines review hote hain, 900 nahi
- Test pehle maango, implementation baad mein: "ye 6 cases fail hone chahiye"
- Generated code mein specifically dekho: error handling, transaction boundary, retry/idempotency, N+1 query, auth check -- AI ka blind spot yahi hota hai
- "Tests pass ho gaye" ko proof na maano jab tests bhi AI ne likhe hon -- kam se kam ek assertion khud likho

## 9. Doosri Insight: Galat Decision Ki Cost Nahi Giri

Code sasta hua. **Galat architecture ki keemat wahi hai.** Aur ek naya khatra: pehle bad design dheere-dheere phailta tha, kyunki likhne mein time lagta tha. Ab aap ek hafte mein 30 files ka consistent-looking mess bana sakte ho. Fast generation ka matlab hai **fast accumulation of wrong decisions**.

Isliye conclusion ulta hai: sasta code architecture ko **zyada** important banata hai, kam nahi ([[55-blog-engineering-harder-building-easier]]). "AI se likha lo" ka sabse bada risk speed nahi, **bina soche direction** hai ([[76-blog-when-not-to-use-ai-agents]]).

## 10. Honest Counterpoint: Juniors Ka Sawaal

Mera argument ek jagah kamzor hai, aur wo maanna zaroori hai. Review karna seekhne ka **koi shortcut nahi hai** -- aap code padhkar galti tabhi pakad paate ho jab aapne khud wo galti ki ho. Jisne kabhi khud deadlock nahi banaya, wo generated code mein deadlock risk nahi dekh paayega.

To "junior log bas AI ko supervise karein" -- ye learning path nahi, dead end hai. Juniors ko abhi bhi kuch cheezein **haath se** likhni chahiye (jaan-boojhkar, bina autocomplete), apne bug khud debug karne chahiye jawab maangne se pehle, aur AI use karte waqt pehle apna answer likhkar phir compare karna chahiye.

Seniors ke liye bhi lesson: team se poori writing chheen lena short term mein productive dikhega, 2 saal mein review karne wala koi nahi bachega.

## 11. Ek Working Backend Engineer Ka Weekly Split (Rough)

Ye gospel nahi, ek starting point hai -- team aur phase ke hisaab se badlega:

| Hissa | Kaam | Rough % |
|---|---|---|
| Sochna | Requirements, design, decisions, design docs | 25-30% |
| Verify karna | PR review, test design, manual verification | 25-30% |
| Banana | Code likhna/guide karna (AI ke saath) | 20-25% |
| Chalana | Debugging, on-call, monitoring, cost dekhna | 15-20% |
| Baantna | Docs, knowledge sharing, mentoring | 5-10% |

Kya measure karein: **change failure rate, rollback count, review turnaround, incident MTTR, production tak pahunchne wale bugs**. Kya *na* measure karein: lines of code, PR count, "AI adoption %", story points.

Agar output badha par change failure rate bhi badha, to aap tez nahi chal rahe -- aap tezi se karz bana rahe ho.

## 🧠 Remember

> AI code likhna sasta kar deta hai, isliye engineer ka time wahan jaana chahiye jahan information hi repo mein maujood nahi -- requirements, live debugging, aur trade-off decisions -- aur verification par, kyunki jo aap review nahi kar sakte wo aap ship nahi kar sakte.

## Sochne Ke Liye

1. Aapke pichle hafte ke ghante in 5 buckets mein baanto (sochna/verify/banana/chalana/baantna). Actual split aur ideal split mein sabse bada gap kahan hai?
2. Kal ek 500-line generated PR aaye -- aapke paas kaunsa checklist hai jisse aap confidently "no" keh sako?
3. Agar aapki team ka aadha code AI likhne lage, to aapka junior review karna kaise seekhega? Uska ek concrete plan likho.
