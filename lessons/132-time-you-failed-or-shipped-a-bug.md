# "Ek Baar Jab Aap Fail Hue" -- Is Sawaal Ka Jawab

*Behavioural round ka sabse zyada under-prepared sawaal. Technical round ke liye log mahine lagate hain, is sawaal par 5 minute bhi nahi.*

> **Connects to**: [[130-production-incident-story]] (incident answer) | [[128-star-method-from-your-own-incidents]] (STAR structure)

---

## 1. Sawaal Ke Peeche Ka Asli Sawaal

Interviewer ye nahi pooch raha "kya aap perfect ho?". Wo already jaanta hai ki aapne production tod hai -- har engineer ne tod hai. Wo teen cheezein check kar raha hai:

| Wo kya dekh raha hai | Kyun matter karta hai |
|---|---|
| **Ownership** | Senior ko blast radius diya jaata hai. Jo banda galti maanta nahi, usse prod access dena risk hai. |
| **Incident behaviour** | Panic mein aapne kya kiya? Fix-forward thokne lage ya pehle bleeding roki? |
| **Learning loop** | Galti ek baar hui ya system badla taki dobara na ho? |

Aur ek chhupa hua signal: **aapne kabhi kuch real own kiya hai ya nahi.** Agar aapki "biggest failure" ek typo hai jo code review mein pakad gayi, to message ye jaata hai ki aapko kabhi kuch important diya hi nahi gaya.

## 2. Jawaab Ka Arc -- 5 Beats

Ratna nahi hai, structure samajhna hai:

```
1. Setup      -> system kya tha, mera role kya tha (20 sec)
2. "Maine"    -> maine exactly kya galat kiya (active voice, 15 sec)
3. Impact     -> numbers ya user terms mein (20 sec)
4. First hour -> detect, stop, communicate, recover (60 sec)
5. Guardrail  -> aaj wo galti possible hi nahi, kyunki... (30 sec)
```

Sabse zyada time **beat 4 aur 5** par. Log ulta karte hain -- 3 minute story sunate hain ki kaise hua, aur fix par ek line.

## 3. Active Voice Test

Ye sabse quick filter hai jo interviewer lagata hai. Apna jawab bolkar suno:

| Weak (passive / blame) | Strong (owned) |
|---|---|
| "Deployment galat chala gaya" | "Maine production par script bina dry-run chalayi" |
| "Requirement clear nahi thi" | "Maine assume kiya, confirm nahi kiya" |
| "QA ne catch nahi kiya" | "Mere change mein ye case test hi nahi hua tha" |
| "Legacy code aisa hi tha" | "Legacy code tha, par change maine kiya, isliye verify karna mera kaam tha" |

Agar aapke jawab mein koi doosra insaan villain hai, aap fail ho gaye -- chahe sach mein wo galti kisi aur ki bhi thi. Interview mein aap **apna** behaviour bech rahe ho.

## 4. Ek Poora Worked Answer

*(Marketplace backend, Node + MongoDB. Numbers apne system ke daalna, ye template hai.)*

> "Hamare paas ek seller-bulk-update script thi jo seller ke products ki visibility toggle karti thi. Ek seller ne support se bola ki unke 240 products hide ho gaye hain. Maine fix karne ke liye script ka ek patched version likha aur production par chalaya.
>
> Jo maine galat kiya: filter main conditionally bana raha tha, aur us run mein `sellerId` undefined aa gaya. Mongoose default config mein undefined key ko **strip** kar deta hai -- to mera filter `{ sellerId: undefined, status: 'active' }` effectively `{ status: 'active' }` ban gaya. Maine dry-run nahi kiya tha, matched count print nahi kiya tha.
>
> Impact: 18,400 live listings ek saath inactive ho gayi. Search aur category pages par catalog ka bada hissa gayab. Ye peak hours se pehle hua, phir bhi takriban 40 minute tak site par aadha catalog missing tha, aur usme GMV loss hua.
>
> Pehle ek ghante mein: script turant band ki -- fix forward karne ki koshish nahi ki, kyunki mujhe nahi pata tha blast radius kahan rukega. Phir maine on-call channel par khud message kiya, apna naam lekar: 'maine ye chalaya, ye hua, main recover kar raha hoon.' Recovery ke liye lucky tha ki hamare paas product writes ka audit collection tha jisme purana `status` aur `updatedAt` pada tha -- maine us window ke documents ka exact set nikala aur batches mein revert kiya, replica lag dekhte hue. 52 minute mein catalog wapas. Uske baad maine postmortem likha, blameless format mein, par apna naam hataye bina.
>
> Jo system badla: ab repo mein koi bhi bulk write seedha model par allowed nahi hai. Ek `bulkWrite` helper hai jo (a) filter mein koi bhi `undefined` value mile to throw karta hai, (b) pehle `countDocuments` chalakar matched count print karta hai, (c) agar count ek expected ceiling se zyada ho to explicit `--force` ke bina rukta hai. Wo helper maine likha tha aur ESLint rule se enforce kiya. Us din ke baad do baar wo guard trigger hua hai -- dono baar sach mein bug tha."

Dhyan dijiye: galti badi hai, par banda khatarnaak nahi lagta. Ulta **zyada** hireable lagta hai.

## 5. Sabse Strong Move: Guardrail Ko Naam Do

Ye line aapko mid-level se senior dikhane wali line hai:

> "Aaj mere team mein wo galti karna mushkil hai, aur uski wajah main hoon."

Guardrail concrete hona chahiye -- ek linter rule, ek migration checklist, ek dry-run flag, ek alert, ek required reviewer, ek feature flag default. "Ab main zyada careful rehta hoon" guardrail nahi hai, wo ek vaada hai. Careful banda bhi 2 baje raat ko thaka hota hai; system thaka nahi hota.

Bulk/destructive operations par safe method yahan detail mein hai: [[81-delete-150m-rows-safely]]. Aur agar aapki story secret leak wali hai to recovery ka correct order yahan hai: [[72-secret-leaked-to-public-git]].

## 6. Teen Classic Traps

**Trap 1 -- Fake failure.** "Meri weakness ye hai ki main zyada kaam karta hoon", "main team ke liye bahut zyada care karta hoon". Interviewer ne ye 200 baar suna hai. Isse do cheez jaati hai: aap self-aware nahi ho, aur aap sawaal ko manipulate karne ki koshish kar rahe ho.

**Trap 2 -- Blame.** Teammate, QA, manager, process, "startup mein process hi nahi tha". Agar process kharab tha to aapka role kya tha use theek karne mein? Blame ke bajaye wahi bolo.

**Trap 3 -- Too small.** "Ek baar maine variable name galat rakha tha." Ye safe lagta hai par signal ulta jaata hai: aapko kabhi kuch owned nahi mila, ya aap honest nahi ho rahe. Senior role ke liye ye disqualifier hai.

**Bonus trap -- Over-apologising.** 90 second tak "mujhe bahut bura laga, main bahut guilty feel karta hoon" bolna confidence nahi dikhata. Ek line mein maano, phir action par shift karo. Interviewer ko regret nahi, **response** chahiye.

## 7. Agar Aapke Paas Koi Badi Failure Nahi Hai

Honest option: chhoti ghatna lo, par uska **reasoning** poora dikhao -- ek bug jo aapke code se staging se nikal gaya, ek estimate jo aapne 2x miss kiya aur release slip hui, ek API contract jo aapne consumer se confirm nahi kiya aur client app toot gaya ([[68-schema-change-producer-vs-consumer]]). Chhoti ghatna + mature handling > bani hui badi story. Jhooth bolne par follow-up questions mein pakad jaaoge, kyunki interviewer "us din tumne kis dashboard par dekha?" poochega.

## 8. Is Sawaal Ke Sibling Versions

| Sawaal | Aapka same arc, thoda shift |
|---|---|
| "Production incident jo aapne handle kiya" | Beat 4 (first hour) sabse bada hissa |
| "Ek decision jo aapne galat liya" | Beat 2 par reasoning, "us waqt mere paas ye data tha" |
| "Jab aapki team se kuch toota" | "we" use karo par apna hissa clearly naam lo |
| "Aapne kabhi deadline miss ki?" | Impact = business/stakeholder terms, aur early-warning guardrail |

## 9. Teen Line Ki Taiyari

Interview se pehle likh ke rakho -- bolkar practice karo, padhkar nahi:

1. Mera impact statement ek line mein, number ke saath.
2. Mere first hour ke 4 actions, order mein.
3. Guardrail ka naam -- wo file ya rule jo aaj exist karta hai.

## 🧠 Remember

> Galti chhupana ya zyada maafi maangna, dono fail hain -- jeetne wala jawab hai: "maine ye kiya, itna impact hua, pehle ghante mein maine ye kiya, aur aaj wo galti dobara possible nahi hai kyunki maine ye guardrail banaya."

## Quick Self-Test

1. Aapki failure story mein kya active voice mein hai aur kya passive? Bolkar check karo.
2. Aapka impact "kuch users affected hue" hai ya number/user-terms mein hai?
3. Aapka guardrail ek *system* hai ya ek *vaada*? Uska naam kya hai?
4. Interviewer pooche "us din aapko sabse pehle kaise pata chala?" -- aapke paas jawab hai?
