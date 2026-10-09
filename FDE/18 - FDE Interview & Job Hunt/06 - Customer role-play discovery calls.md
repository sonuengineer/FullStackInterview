# FDE Interview & Job Hunt

## Customer role-play discovery calls

> Core | Fast CP7 / Slow CP10 | ~2 h | Builds on: M15-01, M18-05

### Kahani
Interview ka third round. Interviewer bolta hai: "I am now the VP of Operations at a logistics company. You have 30 minutes."
Phir woh character mein aa jaata hai: "Look, we tried a chatbot last year, it was useless. My team has no time. Why should I give you data access?"
Aapke paas na slides hain, na code. Sirf sawal, sunna, aur samjhaana.
Kai engineers yahan defensive ho jaate hain ya features ki list sunaane lagte hain. FDE ka kaam hai customer ki pain samajhna, trust banana, aur call ke end tak ek clear next step lena.

### What it is
Ek mock **discovery call** jahan Claude ek mushkil customer ka role play karta hai, aur aap goal, pain, data, constraints, success metric aur next step nikaalte ho -- jaise M15-01 workshop, par 1:1 aur pressure mein.

### Why it matters for an FDE
Real customers mein skepticism, politics aur vague answers normal hain. Agar aap calm reh ke structure nahi la sakte, to technically perfect solution bhi kabhi sign nahi hota.

### Key concepts
- **Listen > pitch** -- pehle 70% time customer bole. Aap sawal poochho aur summarise karo.
- **Label the objection** -- "It sounds like the last project burned trust." Objection ko ignore ya argue mat karo.
- **Quantify the pain** -- "How many hours a week? What does a delayed shipment cost you?"
- **Mirror + summarise** -- har 8-10 minute mein 3-line summary bolo aur confirm karwao.
- **Clear next step** -- call ka end hamesha ek concrete action: data sample, stakeholder meeting, pilot scope doc.

### How to do it
1. Persona choose karo (neeche 5 hain). Timer 30 minute.
2. Claude ko neeche wala prompt paste karo.
3. Notes template side mein khula rakho, live bharo.
4. Call ke baad Claude se debrief maango (prompt ke andar hi instruction hai).
5. Score log karo: Job hunt -> Mock interviews -> kind "customer role-play".

Paste-ready prompt for Claude (English):
```text
You are role-playing a customer in a discovery call for an AI project. I am the Forward Deployed Engineer.

Persona: <paste one persona below>

Rules:
- Stay fully in character until I type "END CALL".
- Be realistic and moderately difficult: give vague answers at first, raise at least 3 objections
  (trust, security, cost, time, past failures), and only share specific numbers if I ask good follow-up questions.
- Do not volunteer your hidden constraints; reveal them only when my questions get close.
- Keep each reply to 1-4 sentences, like a busy person on a call.

After I type "END CALL", step out of character and give a debrief:
1. Score me out of 10 using: discovery depth (3), objection handling (2), quantified pain/metric (2), summarising (1), clear next step (2).
2. List the hidden constraints I found and the ones I missed.
3. Quote my 2 best and 2 weakest moments and suggest a better line for each.
```

#### Customer personas
1. **Skeptical VP Ops, logistics** -- burned by a chatbot last year; wants delay explanations for ops team. Hidden: data lives in an old Oracle TMS with a vendor who charges for every API change; real pain is penalty fees on late B2B shipments.
2. **Cautious CISO, private bank** -- default answer is "no data leaves". Hidden: open to on-prem or in-region hosting if audit logs + RBAC exist; board deadline in 3 months.
3. **Overloaded Head of Claims, insurance** -- wants "AI to do everything". Hidden: only 2 claim types cause 60% of the backlog; analysts fear job loss.
4. **Hospital IT manager** -- polite, slow, process-heavy. Hidden: clinical safety committee meets monthly; EHR vendor contract forbids direct DB access.
5. **Startup founder, D2C retail** -- impatient, wants a support bot live "next week". Hidden: order data is in Shopify + a messy Google Sheet for returns; budget is very small.

#### Question bank (English)
Goal and pain:
- "What made this a priority now?"
- "Walk me through the last time this went wrong. What happened, step by step?"
- "How many hours or how much money does this cost you per week or month?"
Users and process:
- "Who does this work today, and what tools do they use?"
- "Who would use the new system daily, and who signs off on it?"
Data and systems:
- "Where does this data live? Who can grant read access?"
- "Is there any data we absolutely cannot touch or move?"
Success and risk:
- "If this works perfectly in 6 weeks, what number has changed?"
- "What would make you shut the pilot down?"
Objections:
- "It sounds like the last project hurt trust. What specifically went wrong?"
- "What would you need to see to feel safe giving us read-only access?"
Close:
- "Let me summarise what I heard... did I get that right?"
- "Can we agree on a next step: a 1-hour session with <owner> and a sample of <data> by <date>?"

#### Note-taking template
```text
Call: <persona>   Date: <date>   Duration: <min>
Goal (their words):
Pain (quantified):
Users / decision maker / blocker:
Current process + tools:
Data sources + access owner + PII:
Constraints (security, budget, deadline, vendor):
Objections raised -> how I handled:
Success metric (baseline -> target):
Open questions (owner, due):
Agreed next step:
```

### Practice set
1. Run all 5 personas, 30 min each, one per day max.
2. Re-run your lowest-scoring persona after 1 week.
3. Write a 1-page discovery summary (English) from your notes for one call, as you would email the customer.

### Rubric
Uses the debrief scoring inside the prompt (out of 10). "Good" = 7+, plus: next step agreed, at least 2 of 3 hidden constraints found, pain quantified with a number.

### Common pitfalls
- Objection pe argue karna ("No, our system is secure"). Pehle acknowledge, phir sawal.
- Solution 5 minute mein pitch kar dena. Discovery call mein architecture ka zikr minimum.
- Call bina next step ke khatam. "Thanks, I will get back to you" = fail.

### Checklist before moving on
- [ ] 5 personas done, scores logged in Job hunt -> Mock interviews
- [ ] Average 7+/10 on the last 3
- [ ] One discovery summary email written
- [ ] Question bank memorised enough to not read from it

### Self-quiz
1. Why should you summarise back to the customer every 8-10 minutes instead of only at the end?
2. The CISO says "No data leaves the building." What two questions would you ask next?
3. What is the difference between a customer's stated goal and their quantified pain, and why does the second matter more for a pilot?
