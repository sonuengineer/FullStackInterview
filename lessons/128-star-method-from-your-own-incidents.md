# STAR Method: Apne Hi Incidents Se Stories Banao

> **Behavioural lesson (Hinglish)** -- technical terms English mein hain.
> **Connects to**: [[93-cpu-spike-every-night-217am]], [[04-handling-traffic-spike-15k-rps]], [[22-nodejs-memory-leak-debugging]], [[02-debugging-random-500-errors]], [[16-synchronized-connection-pool-expiry]], [[97-bulk-price-update-replica-lag]] -- yahi lessons aapki story bank ka raw material hain.
> **Agla step**: [[130-production-incident-story]] (incident wala sawaal), [[129-walk-me-through-your-project]] (project wala sawaal).

## 1. Problem: Backend Engineers Ke Paas Material Hai, Story Nahi

Behavioural round mein ek pattern dikhta hai. Jo banda 40 minute tak query plan aur event loop par shaandaar baat kar raha tha, wahi banda "ek time batao jab aap pressure mein the" par 90 second mein kuch bhi solid nahi bol pata.

Reason simple hai: **aapke paas kahaniyan hain, lekin aapne unko kabhi kahani ki tarah organize nahi kiya.** Aapke dimaag mein wo incident "wo raat jab CPU spike hua tha" ke roop mein stored hai -- ek memory, ek narrative nahi.

STAR bas ek **container** hai jisme aap already-existing incident ko daalte ho taaki wo 2 minute mein deliver ho jaaye.

## 2. STAR, Theek Se

| Letter | Kya hai | Kitna time | Common galti |
|---|---|---|---|
| **S** -- Situation | Context: system, scale, kab, stakes kya the | 15-20 sec | Yahin 90 second kha jaana |
| **T** -- Task | *Aapki* zimmedari us moment par | 10 sec | Team ka goal batana, apna nahi |
| **A** -- Action | Aapne step by step kya kiya, kyun kiya | 60-70 sec | "Humne fix kar diya" -- koi steps nahi |
| **R** -- Result | Measured outcome + jo seekha / permanent bana | 20-30 sec | Number na hona |

Ratio yaad rakho: **S 20% / T 10% / A 50% / R 20%**. Action sabse bada hissa hai, kyunki grading wahin hoti hai.

## 3. Do Failure Modes Jo 90% Answers Maar Dete Hain

### Failure 1: Saara Situation, Action Zero

> "To sir, hamara ek B2B platform hai, usme sellers apna catalog upload karte hain, aur buyers order karte hain. Hamari team 6 logon ki thi, main backend par tha. Us time hum ek migration bhi kar rahe the MongoDB se Postgres par, aur ek naya client onboard ho raha tha jo bahut bada tha, unka volume hamare existing se 3x tha. To pressure already tha. Phir ek din production slow ho gaya. To humne debug kiya aur fix kar diya."

2 minute mein 110 second context, 10 second kaam. Interviewer ko aapke **thinking** ka koi sample nahi mila. Grading sheet par "no technical depth demonstrated" likha jaata hai -- bhale aapme depth ho.

**Fix:** Situation sirf utna jitna Action samajhne ke liye zaroori hai. Scale ka ek number, stakes ki ek line, bas.

### Failure 2: Result Mein Number Nahi

> "...to humne index add kiya aur query fast ho gayi. Client bhi khush tha."

"Fast ho gayi" se interviewer kuch nahi grade kar sakta. 10% fast? 50x? Aur aapne kaise jaana?

| "We fixed it" | Result with measurement |
|---|---|
| "Query fast ho gayi" | "p95 4.2s se 210ms, aur DB CPU 85% se 30%" |
| "Errors band ho gaye" | "5xx rate 3.1% se 0.02%, 20 minute ke andar" |
| "Memory leak fix ho gaya" | "RSS 12 ghante mein 1.8GB tak jaata tha, ab 400MB par flat -- 3 din monitor kiya" |
| "Client khush tha" | "Us client ke orders ka drop-off 11% se 2% aaya" |
| "Humne monitoring add ki" | "Replica lag par alert laga, agle quarter mein 2 baar pehle hi pakad liya" |

**Rule:** Agar aapke Result mein ek bhi number, percentage, ya time-duration nahi hai, to wo Result nahi hai -- wo relief hai.

Number na ho to bhi measurable statement do: *"Us endpoint par support tickets agle do mahine mein zero aaye, pehle hafte mein 3-4 aate the."* Ye bhi measurement hai.

## 4. Story Bank: Sawaal Ka Type -> Kaunsa Incident

Ye sabse useful hissa hai. Behavioural sawaal infinite nahi hain, roughly 10 types hain. Aapko 10 alag kahaniyan nahi chahiye -- **5-6 solid incidents** chahiye, jinhe aap angle badalkar reuse karo.

| Sawaal ka type | Kaunsa engineering incident fit hota hai | Kis angle par zor |
|---|---|---|
| "Pressure mein kaam kiya" | Live incident triage -- production down tha, log dekh rahe the | Mitigation pehle, root cause baad mein ([[130-production-incident-story]]) |
| "Toughest technical problem" | Wo bug jiska **koi error log nahi tha** -- slow, silent, intermittent ([[02-debugging-random-500-errors]], [[22-nodejs-memory-leak-debugging]]) | Hypothesis -> measure -> eliminate |
| "Kuch mushkil seekha / galti ki" | Wo leak ya spike jo aapne pehle **galat diagnose** kiya tha | Aapne apni galti kaise pakdi |
| "Authority ke bina influence kiya" | Team ko ek bekaar index drop karne, ya ek jaldi-wala design rollback karne ke liye convince kiya | Evidence se, opinion se nahi ([[131-disagreement-with-teammate-or-manager]]) |
| "Disagreement" | Senior ne Kafka chaha, aapne data se dikhaya ki ek queue kaafi hai (ya ulta -- aap haar gaye) | Trade-off language |
| "Ownership dikhao / beyond your role" | On-call improvement, runbook likhna, alert noise kam karna ([[65-pagerduty-incident-dedup-paging]]) | Aapse kisi ne nahi kaha tha |
| "Deadline / scope cut" | Jab aapne "simple solution now, scalable later" chuna ([[15-simple-vs-scalable-architecture]], [[42-resilience-vs-overengineering]]) | Conscious trade-off tha, laziness nahi |
| "Failure / kuch galat chala gaya" | Aapka deploy ya migration jo production mein break hua ([[97-bulk-price-update-replica-lag]]) | Blast radius, rollback, prevention |
| "Feedback liya / mila" | Code review jahan aapka design reject hua aur sahi hua | Ego ke bina |
| "Kisi ko sikhaya / mentor kiya" | Junior ko N+1 ya pool exhaustion samjhaya ([[103-n-plus-1-vs-connection-pool-hinglish]]) | Aapne kaise explain kiya, kya unhone solve kiya |
| "Ambiguous requirement" | "System slow hai" wala ticket jisme na endpoint tha na time ([[20-sudden-latency-spike-checklist]]) | Pehle question, phir solution ([[30-workload-before-conclusion]]) |
| "Business impact dikhao" | Cost reduction, conversion, ya bill cut ([[46-build-vs-rent-infrastructure]]) | Rupaye / percent |

### Ek Incident, Teen Sawaal

Ek hi incident -- maan lo raat 2:17 ka CPU spike -- teen jagah fit hota hai:

- **"Pressure"** -> zor: aadhi raat, 15 minute mein mitigate, dimaag thanda.
- **"Toughest problem"** -> zor: koi cron nahi dikh raha tha, aapne kaise sochna shuru kiya.
- **"Galti / seekha"** -> zor: pehle 2 din aapne apne hi code mein dhoonda, nikla DB maintenance ka job tha; sabak: **pattern pehle dekho, code baad mein**.

Isliye 6 incidents = 15+ answers. Mehnat stories banane mein nahi, **angles decide karne** mein hai.

## 5. Ek Incident Ko Poora STAR Banaate Hain (Before / After)

Maan lo aapke paas ye incident hai (apna wala slot kar lena): *raat ko fixed time par CPU 100%, koi cron nahi.* Ye wahi shape hai jo [[93-cpu-spike-every-night-217am]] mein hai.

### BEFORE -- jo log bolte hain

> "Ek baar hamara server raat ko slow ho jaata tha. Bahut din samajh nahi aaya. Phir hum logon ne check kiya to pata chala ek background job tha jo heavy query maar raha tha. Humne usko optimize kar diya aur problem solve ho gayi. Us time bahut pressure tha kyunki client complain kar raha tha."

Problem: kab, kitna, kaise pata laga, aap ne kya kiya vs team ne, kitna improve hua -- kuch nahi. Ye 35 second ka hai aur usme ek bhi technical signal nahi.

### AFTER -- STAR ke saath

**Situation (20 sec)**
> "Hamare order service par -- Node, Postgres, roughly 40k daily users -- raat 2:17 par CPU 100% chala jaata tha, lagbhag 20 minute. Us window mein jo bhi API call aati thi uska p99 15 second+ ho jaata tha. Daily tha, aur hamare repo mein koi cron us time ka nahi tha. Alert ne pakda, customer ne nahi."

**Task (10 sec)**
> "Main us service ka on-call owner tha. Mujhe do cheezein karni thi -- raat mein users ko bachana, aur permanently cause khatam karna."

**Action (70 sec -- ye hissa detail deta hai)**
> "Pehle maine pattern confirm kiya: 7 din ka CPU graph nikala. Har din exactly 2:17, aur **saare hosts par ek saath**. Ye important clue tha -- agar ek host par hota to local timer hota, saare hosts par ek saath matlab kuch shared -- database ya koi bahar ka caller.
>
> Doosra, maine us window mein profile liya -- `node --cpu-prof` nahi chala sakta tha continuously, to maine APM ka profiler us window par schedule kiya. Flame graph mein app ka code top par nahi tha, DB wait top par tha. Matlab CPU app ka nahi, DB ke peeche queueing ka tha.
>
> Teesra, DB side dekhi: `pg_stat_activity` us time par, aur scheduled jobs. Nikla hamara purana archival job -- `setInterval` se chal raha tha ek long-running process ke andar, isliye `crontab` mein kabhi dikha nahi. Wo ek `DELETE` maar raha tha bade table par without batching, aur usi time autovacuum bhi kick ho raha tha.
>
> Mitigation pehle: us job ko raat 3:30 par shift kiya aur 500 rows ki batch + sleep mein tod diya. Ye usi raat ho gaya.
>
> Permanent fix: job ko ek separate worker par bheja, `statement_timeout` lagaya, aur delete ko partition-drop se replace kiya taaki wo ek metadata operation ban jaaye instead of 2 lakh row deletes."

**Result (25 sec)**
> "Agli raat se CPU peak 100% se 46% par aa gaya, aur wo 20-minute ka p99 spike gayab. Archival job ab 90 second mein khatam hota hai, pehle 20 minute lagte the. Aur jo sabse zyada kaam aaya: maine ek alert banaya 'CPU > 80% for 5 min' par, aur ek chhoti si doc likhi ki hamare saare scheduled jobs kahan-kahan define hain -- kyunki asli problem ye thi ki 'cron' naam ki cheez cron mein nahi thi. Agle quarter mein usi doc se team ne do aur hidden timers pakde."

Farak dekho: same incident, lekin **after** version mein interviewer ko mila -- aapka reasoning (ek host vs saare hosts), aapka measurement discipline (profile liya, guess nahi kiya), mitigation aur root cause ka separation, aur ek prevention jo incident se zyada jeeya.

## 6. Prep Format: Ek Page, Chhe Incident

Notebook ya ek file mein ye table banao. Interview se pehle isko padho, rat-to mat:

| Field | Likho |
|---|---|
| Incident ka nickname | "2:17 CPU", "replica lag after price update" |
| Scale (1 number) | 40k DAU / 2k rpm / 500M rows |
| Kaise pata chala | alert / customer / dashboard |
| Mitigation | jo aapne bleeding rokne ko kiya |
| Diagnosis path | 3 steps, order mein |
| Root cause | ek line |
| Numbers (before -> after) | 2-3 numbers |
| Prevention | jo permanent bana |
| Ye kaunse sawaalon ke liye hai | pressure / toughest / galti / ownership |

Chhe aise bharo -- ek performance, ek correctness/data bug, ek outage, ek deployment/migration galti, ek influence/disagreement, ek ownership/on-call improvement. Ye aapka poora behavioural round cover kar dega.

## 7. Jo Galtiyan Interviewer Instantly Pakad Leta Hai

- **"Hum" ka overuse.** Poori story "humne" mein hai to interviewer aapka contribution grade nahi kar sakta. Team ke liye "hum", apne steps ke liye "maine".
- **Narration without reasoning.** "Phir maine logs dekhe" -- kyun logs, aur kya dhoond rahe the? Reasoning hi grading hai.
- **Hero story.** "Main akela 48 ghante jaaga aur sab theek kiya." Ye collaboration ka red flag hai.
- **Rehearsed sound.** Ratna mat, structure yaad rakho. Interviewer rate hua answer sun leta hai.
- **Over-long.** 2 minute ke baad rukho aur pucho: *"Isme kis part par detail chahiye?"* -- wo khud pull karega jo usko interesting lagta hai.

## 🧠 Remember

> STAR naya material nahi maangta, sirf shape maangta hai -- Situation 20%, Action 50%, aur Result mein ek number, kyunki "we fixed it" result nahi hota; aur chhe real incidents ko angle badal-badal kar reuse karna dus nayi kahaniyan gadhne se behtar hai.

## Quick Self-Test

1. Aapka answer 2 minute ka tha aur usme 90 second Situation tha -- interviewer ki grading sheet par kya likha jaayega?
2. Ek hi incident ko "pressure", "toughest problem", aur "galti se seekha" -- teenon mein kaise use karoge? Kya badlega?
3. "Memory leak fix ho gaya" ko measurable Result mein badal kar likho.
4. Story mein "hum" aur "main" ka kya rule hai, aur ye rule kyun exist karta hai?
5. Aapke paas exact before/after number nahi hai -- Result ko bachane ke do tareeke batao.
