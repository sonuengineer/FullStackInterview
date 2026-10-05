# "Aapki Weakness Kya Hai?" Aur Feedback Wale Sawaal

*Ye sawaal trick nahi hai. Ye ek **free chance** hai self-awareness dikhane ka -- aur log use "main perfectionist hoon" bolkar barbaad kar dete hain.*

> **Connects to**: [[131-disagreement-with-teammate-or-manager]] (feedback and conflict)

---

## 1. "Main Perfectionist Hoon" Kyun Fail Hota Hai

Teen wajah:

1. **Wo obvious dodge hai.** Interviewer ne ye 300 baar suna hai. Wo turant samajh jaata hai ki aap sawaal ka jawab nahi de rahe, usse bach rahe ho. Aur jo banda ek simple sawaal par defensive hai, wo code review mein feedback kaise lega?
2. **Wo ek chhupa hua brag hai.** "Main zyada kaam karta hoon", "main detail par bahut dhyan deta hoon" -- ye weakness nahi, repackaged strength hai. Ye manipulation jaisa lagta hai.
3. **Aap ek badiya chance waste kar rahe ho.** Is sawaal ka asli jawab ek **senior signal** hai: "mujhe apni limitation pata hai, aur maine uske liye ek system banaya hai." Ye wahi behaviour hai jo senior engineers production systems ke saath karte hain -- weakness pata karo, guardrail lagao ([[132-time-you-failed-or-shipped-a-bug]]).

Interviewer actually ye check kar raha hai:

| Wo dekh raha hai | Kaise test hota hai |
|---|---|
| Self-awareness | Aap apne bare mein specific ho ya generic? |
| Coachability | Feedback milne par aapne kya kiya? |
| Honesty | Jawab rehearsed lagta hai ya lived? |

## 2. Jo Structure Kaam Karta Hai

```
1. Ek REAL weakness, specifically named
2. BOUNDED -- wo job ke core se door ho
3. MECHANISM -- aapne uske liye kya banaya (habit, tool, checklist, ritual)
4. EVIDENCE -- improve hua, ek chhote proof ke saath
```

Teeno beats zaroori hain. Weakness bina mechanism = aap stuck ho. Mechanism bina evidence = aap keh rahe ho, kar nahi rahe.

**"Bounded" ka matlab:** weakness aisi ho jo aapko disqualify na kare. Senior backend role ke liye "main database design mein weak hoon" bounded nahi hai -- wo **core** hai. "Main public speaking mein weak hoon" bounded hai, par itni bounded ki wo lazy lagti hai. Sweet spot: ek real engineering habit jiska impact chhota aur manageable ho.

## 3. Teen Worked Examples (Backend Engineer)

### Example A: Documentation bahut kam likhna

> "Meri weakness documentation thi. Main code likh deta tha, test likh deta tha, aur move on kar jaata tha. Problem tab dikhi jab maine ek payment retry module banaya aur 4 mahine baad ek naya joinee usme change karne gaya -- usne 2 din mere behind lagaye ye samajhne mein ki retry ka backoff kyun exponential hai aur dead-letter ka decision kya tha. Mera time bhi gaya, uska bhi.
>
> Jo maine kiya: ab main **PR description ko hi document banata hoon** -- 'kya badla, kyun badla, kya consider karke reject kiya'. Aur jo bhi non-obvious decision ho, uske liye ek chhota ADR (ek page ka decision note) repo mein `docs/decisions/` folder mein jaata hai. Ye maine apne liye rule banaya, team ne baad mein adopt kiya.
>
> Evidence: ab wahi module doosre log mere bina touch kar lete hain. Main ab bhi natural documenter nahi hoon -- par mera *process* use force kar deta hai."

Note: "main ab bhi natural documenter nahi hoon" -- ye line honest lagti hai, aur wahi jawab ko believable banati hai.

### Example B: Help maangne se pehle bahut deep chale jaana

> "Mera default hai ki problem khud solve karni hai. Ek baar maine ek intermittent 502 par **do din** nikal diye, jo actually ek known ingress timeout mismatch tha -- hamare senior ko wo 10 minute mein pata tha ([[74-ingress-502-bad-gateway]]). Maine do din team ka throughput kharab kiya kyunki main 'ask' karna haar samajhta tha.
>
> Jo maine banaya: ek simple rule -- **90-minute rule.** Agar 90 minute mein meaningful progress nahi hui, to main ek message likhta hoon jisme: kya try kiya, kya observe hua, meri current hypothesis. Wo message likhna hi aadha debugging kar deta hai, aur na hua to kisi ko 30 second mein context mil jaata hai.
>
> Evidence: ab average time-to-unblock ghanton se minute mein hai, aur ulta faayda ye hua ki main junior logon ko bhi same template se poochhna sikha raha hoon."

Ye example strong hai kyunki weakness ek **overused strength** se aayi hai, par usko brag ki tarah pesh nahi kiya gaya -- cost clearly naam liya gaya hai (do din, team throughput).

### Example C: Frontend/CSS weak hona (full-stack team mein)

> "Main backend-heavy hoon. React ki state, data fetching, error states -- ye main comfortably kar leta hoon. Jahan main slow hoon wo hai pixel-level CSS aur responsive layout debugging -- ek flex/grid issue mein main doosre logon se zyada time leta hoon.
>
> Jo maine kiya: do cheezein. Ek, main design system ke components ke andar reh kar kaam karta hoon -- custom CSS likhne ke bajaye existing tokens aur components use karta hoon, jisse mera output consistent rehta hai. Do, maine React ki **non-visual** side par deliberately depth banayi -- rerender reasons, keys, data fetching ke chaar states, invalid state ko type level par impossible banana ([[100-react-interview-7-points-hinglish]]) -- taki main frontend par meaningful review bhi de sakoon.
>
> Evidence: main features end-to-end ship kar leta hoon. Agar ek screen pixel-perfect chahiye, main design ke saath baith jaata hoon -- ego mein ghante waste nahi karta. Aur ye main openly bolta hoon, taki estimate realistic rahe."

Isme ek bada plus point hai: **honest limitation + estimate par uska effect.** Wo maturity hai.

### Jo bilkul mat bolo

| Weakness | Problem |
|---|---|
| "Main perfectionist hoon" | Dodge, sabse common |
| "Main zyada kaam karta hoon" | Repackaged brag |
| "Mujhe SQL/system design nahi aata" (backend role) | Core skill -- self-disqualify |
| "Main deadlines miss karta hoon" | Reliability par doubt |
| "Mujhe feedback lena pasand nahi" | Instant reject |
| "Koi weakness nahi hai" | Zero self-awareness |
| "Main thoda lazy hoon par kaam ho jaata hai" | Mazaak mein bhi mat bolo |

**Sabse bada trap:** weakness jo exactly us job ka core hai jiske liye aap apply kar rahe ho. Jawab dene se pehle JD dobara padho aur dekho -- aapki weakness JD ki pehli teen lines mein hai? Agar haan, doosri weakness chuno (aur wo core skill par kaam karo, alag se).

## 4. Sibling Sawaal 1: "Sabse Hard Feedback Jo Aapko Mila"

Ye weakness ka sawaal hai, par ek level difficult -- kyunki isme ek **doosra insaan** involved hai, to blame ka risk hai.

Structure: *feedback kya tha (unke words mein) -> pehli reaction honestly -> aapne kya verify kiya -> kya badla.*

> "Mere manager ne review mein bola ki main design discussions mein 'dominating' hoon -- main pehle 2 minute mein apna solution bol deta hoon aur baaki log phir usi ke around baat karte hain. Pehli reaction mein mujhe bura laga, kyunki mujhe lagta tha main contribute kar raha hoon.
>
> Maine verify kiya: do design meetings mein maine note kiya ki kaun kitna bola. Wo sach tha -- ek meeting mein maine 60% time liya.
>
> Jo badla: ab design discussion mein main pehle **problem aur constraints** likhta hoon, solution nahi, aur doosron se poochhta hoon ki wo kaise approach karenge. Ek baar isse hamara approach literally change hua -- ek teammate ne queue ke bajaye ek simpler cron-based solution suggest kiya jo hamare scale par bilkul sufficient tha ([[42-resilience-vs-overengineering]])."

Jo isme kaam kar raha hai: aapne feedback ko **data se verify** kiya. Wo engineer ka behaviour hai, aur wo line yaad reh jaati hai.

**Traps:** "mujhe aisa koi hard feedback nahi mila" (= aapko serious work nahi mila), aur "mere manager ne galat feedback diya tha" (= uncoachable).

## 5. Sibling Sawaal 2: "Aap Learning Kaise Karte Ho?"

"Main YouTube dekhta hoon / courses karta hoon / tech blogs padhta hoon" -- ye **weak** hai, kyunki ye consumption hai, output nahi. Interviewer ko verify karne ka koi tareeka nahi.

Strong version mein ek **artifact** hota hai:

| Weak | Strong |
|---|---|
| "Main Kafka seekh raha hoon" | "Maine ek chhota order-events consumer banaya aur deliberately duplicate events bheje, taki idempotent consumer ka pattern samajh aaye ([[19-idempotent-consumer-duplicate-events]])" |
| "Main system design padhta hoon" | "Main apne hi system par ek exercise karta hoon: 10x traffic par kya saturate hoga -- pichli baar answer connection pool nikla tha ([[103-n-plus-1-vs-connection-pool-hinglish]])" |
| "Main blogs padhta hoon" | "Main har mahine ek debugging incident likhta hoon, internal wiki par. Isse mera reasoning sharp hota hai aur team ko reference milta hai" |
| "Main AI tools use karta hoon" | "Main AI se generate karne se pehle spec aur verification plan likhta hoon, aur usko review karta hoon jaise kisi junior ka PR ([[114-blog-what-engineers-should-do-when-ai-writes-code-hinglish]])" |

**Formula:** ek cheez naam lo jo aapne **banayi** ya **todi** ya **likhi** -- consume nahi ki.

Aur ek honest framing: aapko har hafte 10 ghante seekhne ka natak nahi karna. "Mahine mein ek chhoti cheez, par wo main build karke seekhta hoon" zyada believable aur zyada impressive hai.

## 6. Sibling Sawaal 3: "3 Saal Mein Kahan Dekhte Ho?"

Ye sawaal check karta hai: (a) aapke paas direction hai ya nahi, (b) aapka plan **is role se** match karta hai ya nahi.

| Weak jawab | Kyun |
|---|---|
| "Manager ban jaunga" | Agar role IC hai, to mismatch -- aur 3 saal mein manager banna realistic bhi nahi hota |
| "Apna startup kholunga" | Interviewer sochega aap 1 saal mein nikal jaaoge |
| "Pata nahi, jo mile" | Direction nahi |
| "Aapki company mein VP" | Chaplusi, aur non-credible |

Strong jawab ka shape: **ek technical direction + ek scope upgrade + aur wo is role se kaise banta hai.**

> "Teen saal mein main wo banda banna chahta hoon jo ek pura domain own karta hai -- jaise payments ya catalog -- design se lekar on-call aur cost tak, aur jisko naye log design review ke liye dhoondte hain. Mujhe IC track pasand hai; mentoring karna hai, par full-time management abhi nahi. Is role mein service ownership clearly defined hai, isliye ye us direction mein sahi step lagta hai."

Note: ye jawab [[133-why-leaving-why-this-company]] ke jawab se **consistent** hona chahiye. Agar aapne wahan bola "scale chahiye" aur yahan "manager banna hai", gap dikh jaayega.

## 7. 10-Minute Prep

Interview se pehle likh lo (bolkar practice karo):

1. **Ek weakness** + mechanism + evidence. Ek hi, poori taiyari ke saath -- teen half-baked se better.
2. **Ek hard feedback** + aapne use kaise verify kiya.
3. **Ek cheez jo aapne banayi** seekhne ke liye, pichle 3 mahine mein.
4. **Ek 3-saal direction** jo aapke "why this company" se match kare.

## 🧠 Remember

> Weakness ka sawaal honesty ka test nahi, **self-awareness plus system-building** ka test hai -- ek real aur bounded weakness batao, wo mechanism batao jo aapne usko manage karne ke liye banaya, aur ek chhota proof do ki wo kaam kar raha hai; "main perfectionist hoon" bolkar aap ek free senior signal phenk rahe ho.

## Quick Self-Test

1. Aapki weakness JD ki pehli teen lines mein to nahi hai? Check karo.
2. Aapke weakness jawab mein **mechanism** kya hai -- ek habit, rule, checklist ya tool ka naam lo.
3. "Main YouTube dekhta hoon" ki jagah aap kaunsi ek **banayi hui** cheez naam le sakte ho?
4. Aakhri hard feedback kya tha, aur aapne use data se verify kiya ya bas maan liya?
5. Aapka 3-saal jawab aur aapka "why this company" jawab -- same direction mein hain?
