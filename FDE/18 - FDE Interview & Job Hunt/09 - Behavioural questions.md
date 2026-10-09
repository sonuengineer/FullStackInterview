# FDE Interview & Job Hunt

## Behavioural questions

> Core | Fast CP8 / Slow CP10 | ~1 h | Builds on: M18-07

### Kahani
Coding round accha gaya, decomposition bhi. Last round hiring manager ka hai: "Tell me about a time a customer asked for something you thought was wrong."
Aap bolte ho: "I usually just explain to them politely." Koi story nahi, koi detail nahi.
Manager ko ab bhi nahi pata ki pressure mein aap kya karte ho. FDE role mein ye round kai baar decision badal deta hai -- kyunki aap company ka chehra banoge customer ke saamne.

### What it is
Past behaviour ke baare mein sawal ("Tell me about a time...") jo dekhte hain ki ambiguity, conflict, galti aur pressure mein aap kaise act karte ho.
Jawab ek real story ho, STAR+L format mein (M18-07), 2-3 minute.

### Why it matters for an FDE
FDE ke paas aksar manager paas nahi hota -- customer site pe aap akele decide karte ho. Interviewer ko proof chahiye ki aap judgment, ownership aur honesty dikhate ho.

### Key concepts
- **Story bank** -- 6-8 real stories jo 10+ sawalon pe fit ho jaayein. Har sawal ke liye nayi story nahi chahiye.
- **Specific, not general** -- "Once, in March, a client..." beats "I usually...".
- **Ownership language** -- "I decided", "I was wrong about", "I changed".
- **Customer respect** -- pushback stories mein customer ko villain mat banao.
- **Learning close** -- har story ek concrete changed habit pe khatam.

### How to do it
1. Apne career + capstones se 8 stories list karo (old job ki stories bhi valid hain: client escalations, prod bugs, deadline fights).
2. Har story ko neeche ke 10 sawalon pe map karo -- ek story 2-3 sawalon pe chal sakti hai.
3. Har story STAR+L mein likho, 250 words max.
4. Bol ke record karo, 2-3 minute target.

#### The 10 questions and answer frameworks
| # | Question | What they test | Framework |
|---|---|---|---|
| 1 | Tell me about a time the requirements were very unclear. | Ambiguity | Clarified what you could -> wrote assumptions -> built smallest testable thing -> checked back early |
| 2 | Tell me about pushing back on a customer or stakeholder. | Judgment + respect | Understood their real goal -> showed risk with evidence -> offered an alternative -> what was decided |
| 3 | Tell me about a production mistake you made. | Ownership | Detected -> told people fast -> mitigated -> root cause -> prevention |
| 4 | Two stakeholders wanted conflicting things. What did you do? | Navigation | Got both goals explicit -> found shared metric -> escalated with options if needed |
| 5 | Tell me about saying no to scope creep. | Focus | Acknowledged value -> showed cost on timeline -> parked it in a written backlog/phase 2 |
| 6 | Tell me about learning something new very fast for a project. | Learning speed | Why needed -> how you learned (docs, small spikes) -> what you shipped -> time taken |
| 7 | Tell me about a time you disagreed with your team or manager. | Collaboration | Raised it with data -> listened -> disagree-and-commit or changed mind |
| 8 | Describe a time you explained something technical to a non-technical person. | Communication | Their goal -> analogy/visual -> checked understanding -> decision they made |
| 9 | Tell me about a project that failed or was cancelled. | Resilience + honesty | What happened -> your part -> what you would do differently |
| 10 | Why FDE and not a pure engineering role? | Motivation | Specific moments you enjoyed customer + build work -> what you want to own next |

#### Sample answer (question 3, English, about 2 minutes)
```text
Situation: At my previous company I maintained a nightly sync that imported orders from a client's SFTP drop into our SQL database.
Task: I had added a change to handle a new file format the client introduced.

Action: The next morning the client's operations lead called -- their dashboard showed zero orders for the previous day. I checked our job logs and saw the sync had "succeeded" but imported 0 rows. My new parser silently skipped every line because the date format did not match, and I had not added a check for an empty import.
I told my manager and the client within 30 minutes, with what I knew and an ETA. I rolled back to the previous parser, re-ran the import for that day, and confirmed the row counts with the client. Then I fixed the parser to fail loudly on unparseable dates, added an alert when an import is less than 50 percent of the 7-day average, and added a test with the client's real sample file.

Result: Data was restored the same morning. Over the next <n> months that alert caught two more upstream problems before the client noticed.
Learning: "Succeeded with zero rows" is a failure. I now add row-count and freshness checks to every pipeline I build, including the ingestion in my RAG projects.
```
Notice: customer ko blame nahi kiya, speed of communication bataya, aur ek permanent habit pe khatam kiya.

#### Story bank template
Ek table rakho -- interview se pehle 5 minute isi ko revise karo:
```text
| # | Story title (short)                 | Source (job/capstone) | Fits questions | Metric / concrete result     |
|---|-------------------------------------|-----------------------|----------------|------------------------------|
| 1 | Nightly sync imported zero rows     | previous job          | 3, 9           | restored same morning        |
| 2 | Text-to-SQL ignored RBAC in UAT     | OmniGuard             | 3, 6           | <n>/<n> RBAC tests pass      |
| 3 | Client wanted "AI for everything"   | previous job / M15    | 2, 5           | pilot cut to 2 claim types   |
| 4 | Ops vs security on data access      | ...                   | 4, 7           | ...                          |
```
Rule of thumb: har sawal ke liye kam se kam 2 candidate stories ho, taaki ek hi story baar-baar repeat na ho.

### Practice set
1. Build your story bank: 8 stories, each mapped to 1-3 questions.
2. Write full STAR+L answers for questions 2, 3, 5 and 10.
3. Record yourself answering 5 random questions. Check length (2-3 min) and filler words.
4. Ask Claude: "Ask me 5 FDE behavioural questions one at a time. After each answer, tell me what was vague and ask one follow-up." Log as "behavioural".

### Rubric
Per answer, out of 10: specific real story (3), clear own actions (3), measurable or concrete result (2), learning that changed behaviour (2).

### Common pitfalls
- Hypothetical answer ("I would..."). Sawal past ka hai -- real story do.
- Rambling 6 minute ki story. 2-3 minute; interviewer follow-up khud poochega.
- Customer, teammate ya manager ko blame karna. Red flag for a customer-facing role.

### Checklist before moving on
- [ ] 8-story bank written
- [ ] 4 full answers written and recorded
- [ ] All 10 questions answered aloud at least once
- [ ] One behavioural mock logged in the portal

### Self-quiz
1. Why is a story about your own production mistake often stronger than a story where everything went well?
2. How would you reuse one story for both "conflicting stakeholders" and "saying no to scope creep" without it sounding repeated?
3. What makes "I usually explain things politely" a weak answer, and how would you turn it into a STAR+L answer?
