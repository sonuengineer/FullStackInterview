# Blog: AI Ke Daur Mein Software Engineer Relevant Kaise Rahe? (Hinglish)

Har jagah ek hi baat chal rahi hai: "software engineering khatam ho gaya". Par solution kisi ne nahi bataya. Ye post solution wali side par hai.

## 1. Pehle Theek Se Naam Do: Actually Kya Badla?

Ek cheez sasti hui hai -- **code likhna**. Bas.

Jo sasta nahi hua:

- Ye decide karna ki **kya** banana hai
- Likha hua code **padhkar samajhna** ki ye sahi hai ya nahi
- Wo production mein chalne ke baad uski **zimmedari** lena

Yaani generation cheap ho gayi, **verification aur accountability** nahi. Yehi baat [[55-blog-engineering-harder-building-easier]] mein thi: banana aasan hua, engineering mushkil hui. Agar aapki value sirf "main typing karke feature bana deta hoon" thi, to haan, dabaav aayega. Agar aapki value "main decide karta hoon aur jhelta hoon" hai, to wo demand badhi hai.

## 2. Wo Skills Jo Compound Hoti Hain

Ye woh cheezein hain jinme lagaya time saalon tak return deta hai:

**Production debugging.** Live system ka behaviour repo mein likha nahi hota. Latency spike, connection pool exhaustion, ek slow query jo peak par hi dikhti hai -- ye pattern-matching se nahi, hypothesis banake aur measure karke pakde jaate hain ([[30-workload-before-conclusion]]).

**System design aur trade-off reasoning.** AI aapko ek design de dega. Ye nahi bata sakta ki *aapki* team, budget, deadline aur traffic ke hisaab se konsa sacrifice theek hai. Aur chhoti company mein bhi ye seekha ja sakta hai ([[53-blog-senior-system-design-without-big-scale]]).

**Tezi se code padhna.** Ab aap jitna likhte ho usse **kai guna zyada padhte ho**. Reading speed + "ye kahan galat ho sakta hai" ka instinct -- ye naya core skill hai.

**Fundamentals: DB, networking, concurrency.** Fundamentals boring lagte hain, par asli faayda ye hai: **ye AI ki galtiyon ko explain karte hain**. AI ne `LOWER(email)` par query likh di ([[102-lower-email-index-hinglish]]), ya retry lagaya bina idempotency ke -- aap sirf tabhi pakad paoge jab aapko underlying model pata ho.

**Domain knowledge.** Aapka business kaise paisa kamata hai, order flow mein kya invalid state hai, refund rule kya hai -- ye kisi repo mein poora likha nahi hota. Yahi cheez aapko replaceable hone se bachati hai.

## 3. AI Ko *Direct* Karna Bhi Ek Skill Hai

"AI use karta hoon" skill nahi hai. Skill ye hai:

- **Precise spec dena**: inputs, outputs, edge cases, constraints -- pehle likho, phir generate karo
- **Decompose karna**: ek 800-line feature ki jagah 6 chhote, review-able tukde
- **Verification plan**: test, log, metric -- generate karne se *pehle* socho ki "sahi hone ka proof kya hoga"
- **Kab haath se likhna tez hai** ye pehchanna: 15-line tricky concurrency code samjhane-review karne se seedha likh dena sasta padta hai ([[76-blog-when-not-to-use-ai-agents]])

## 4. Ownership -- Jo AI Utha Hi Nahi Sakta

AI on-call nahi jaata. 2 baje raat ko page aane par wo customer ko call nahi karta. Cloud bill dekhkar architecture nahi badalta. Incident ke baad postmortem likhkar team ko convince nahi karta.

Isliye sabse safe position ye hai: **idea se production tak ek feature ko akele le jaa sakna** -- requirement clarify, design, build, rollout, monitor, cost, failure handling ([[42-resilience-vs-overengineering]]).

Accountability transfer nahi hoti. Wahi aapki moat hai.

## 5. Kaam Dikhna Bhi Chahiye

Ek honest baat: achha engineer hona kaafi nahi hai agar kisi ko pata na ho.

Distribution engineering mein bhi lagu hota hai ([[47-technology-vs-distribution]]). Jo log likhte hain, share karte hain, internally demo dete hain, review mein clearly bolte hain -- unko better problems milte hain, aur better problems se better skills. Ye loop hai.

Practical: har mahine ek cheez likho jo aapne debug ki. Chhota post, internal wiki bhi chalega. Yehi cheez interview mein "why you over AI" ka jawab ban jaati hai ([[29-why-hire-you-over-ai]]) aur package negotiation mein bhi kaam aati hai ([[96-blog-12lpa-to-22lpa-packaging]]).

## 6. Honest Section: Kya Genuinely Risk Mein Hai

Hype nahi, seedhi baat:

| Risk mein | Kyun | Relatively safe | Kyun |
|---|---|---|---|
| Pure boilerplate CRUD | Pattern repeat hai, context kam | Production ownership + on-call | Accountability delegate nahi hoti |
| Low-context ticket closing | Spec already likha hua hai, AI wahi kar dega | Ambiguous requirement ko clear karna | Information kisi repo mein nahi hai |
| "Main sirf ek framework jaanta hoon" | Framework AI ka strongest zone hai | Fundamentals + debugging | AI ki galti explain karne ke liye zaroori |
| Manual test case likhna | Generate ho jaata hai | Test *strategy* -- kya test karna hai | Risk judgment hai, typing nahi |
| Copy-paste integration work | Docs se derive ho jaata hai | Domain + data model design | Business context chahiye |

Note: "risk mein" ka matlab job gayab nahi -- matlab wo kaam **aapka differentiator nahi rahega**. Usme hi atke rehna problem hai.

## 7. 90-Din Ka Practical Plan

| Mahina | Focus | Roz/hafte kya karo | Proof kya hoga |
|---|---|---|---|
| Month 1 | Fundamentals jo AI ki galti pakdein | Hafte mein 2 topic: index/query plan, TCP-HTTP timeouts, locks aur transactions -- chhote experiments chalao | Aap `EXPLAIN` padhkar bata sako query kyun slow hai |
| Month 2 | Debugging + reading speed | Apne repo ke 3 purane bugs re-investigate karo; ek open-source PR padhkar summary likho | Ek written incident/RCA note |
| Month 3 | Design + ownership + visibility | Ek chhota feature end-to-end (design doc -> build -> metric -> rollback plan); 2 posts likho | Design doc jisme trade-off section ho |

Ye plan jaan-boojhkar "AI tool seekho" wala nahi hai. Tools 2 hafte mein badal jaate hain; ye layer nahi badlti.

## 8. Kya Karna Band Karein

- **Syntax rattna.** Us waqt ka koi return nahi bacha.
- **Framework version chasing.** Naya minor release seekhne se pehle poocho: ye mera trade-off thinking badal raha hai?
- **AI ka output bina padhe merge karna.** Aapka naam commit par hai, uska nahi.
- **"AI se darr" wale posts padhte rehna.** Wo time ek experiment chalane mein lagao.
- **Sirf tickets band karte rehna** aur ye kabhi na poochhna ki feature kis business problem ko solve kar raha hai.

## 9. Counter-Argument (Ise Bhi Suno)

Ho sakta hai ye baat galat nikle. Agar AI verification bhi bharosemand tarike se karne lage -- apna kaam test kare, apni galti pakde, live system mein hypothesis khud test kare -- to "review karna" bhi sasta ho jaayega, aur mera poora argument kamzor pad jaata hai.

Par tab bhi do cheezein bachengi: **kya banana hai** ye decide karna, aur **galat hone par kaun jawab dega**. Wo technical problem nahi, organisational problem hai. Isliye ownership par bet lagana abhi bhi sabse safe bet lagta hai -- guarantee nahi, bet.

## 🧠 Remember

> Code likhna sasta ho gaya, par decide karna, verify karna aur zimmedari lena sasta nahi hua -- relevant rehne ka rasta yahi hai: fundamentals se AI ki galti pakdo, feature ko production tak akele le jao, aur apna kaam dikhna do.

## Sochne Ke Liye

1. Aapke pichle mahine ke kaam mein kitna hissa aisa tha jo ek achhe spec ke saath AI kar leta? Bacha hua hissa hi aapki asli value hai -- wo kya tha?
2. Agar kal aapko ek 500-line AI-generated PR review karna pade, to aap confidently reject kar sakte ho ya bas "looks good" likhoge? Gap kahan hai?
3. Aapke kaam ke baare mein aapki team ke bahar kitne log jaante hain? Usko badhane ka sabse sasta step kya hai?
