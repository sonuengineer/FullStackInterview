# FDE Interview & Job Hunt

## Full mock interview loop

> Core | Fast CP8 / Slow CP10 | ~2 h | Builds on: M18-04, M18-05, M18-06, M18-07, M18-09

### Kahani
Real FDE loop mein aksar ek hi din ya ek hafte mein 4-5 rounds hote hain. Har round accha ho sakta hai alag-alag practice mein -- par ek saath, back to back, thakaan ke saath, alag hota hai.
Round 3 tak aapka dimaag thak jaata hai aur aap decomposition ke sawal skip karne lagte ho.
Is lesson mein aap poora loop ek saath simulate karte ho, score karte ho, aur dekhte ho ki "ready" hone mein kya baaki hai. Ye curriculum ka final gate bhi hai: AuditMesh v1.0 + demo video + scored mock loop.

### What it is
4 rounds back to back (25-30 min each, 5 min break) with Claude as interviewer: **coding, decomposition, customer role-play, project deep-dive**. Har round ka score out of 10, total out of 40, portal mein log.

### Why it matters for an FDE
Loop ka result weakest round se decide hota hai, average se nahi. Full mock aapki stamina aur weakest link dono expose karta hai -- real interview se pehle.

### Key concepts
- **Back-to-back** -- breaks sirf 5 minute; real fatigue simulate karo.
- **Fresh prompts** -- jo prompts practice mein kiye, unse alag maango (Claude ko bolo naya banaye).
- **Strict scoring** -- Claude ko strict reviewer bolo; self-score mat karo.
- **Weakest-round rule** -- ready = har round 7+, sirf total nahi.
- **Debrief log** -- har round se 1 "what went wrong" line portal ke note mein.

### How to do it
Setup: 2 hours block, camera on (optional, self-record), a blank doc for notes, timer. New Claude conversation per round so earlier context does not leak hints.

Round 1 -- Coding (30 min), paste-ready:
```text
Act as a strict interviewer for a Forward Deployed Engineer practical coding round.
Give me ONE new Python problem of the "messy data / flaky API / buggy function" kind, solvable in 25 minutes with the standard library. Do not reuse common textbook problems.
Do not give hints unless I ask. I will think aloud and paste my code.
When I type "DONE", score me out of 10: clarify (2), works (3), edge cases (2), readability (1), verification (1), communication (1). List my 3 biggest issues.
```

Round 2 -- Decomposition (30 min), paste-ready:
```text
Act as an interviewer for a Forward Deployed Engineer decomposition round.
Give me a one-line, deliberately vague AI project request from a realistic industry (not healthcare discharge notes).
Answer my clarifying questions briefly and realistically; if I do not ask about data access, security or success metrics, do not volunteer them.
After I type "DONE", score me out of 10: clarifying questions (2), data inventory (1), measurable metric (2), MVP with human review where needed (2), risks (1), phased plan (1), structure (1). Tell me the most important question I failed to ask.
```

Round 3 -- Customer role-play (30 min): use the paste-ready prompt from M18-06 with a persona you have NOT practised, or add this line to it: `Invent a new difficult persona from an industry I have not practised; keep the hidden constraints secret.` The debrief inside that prompt gives the score out of 10.

Round 4 -- Project deep-dive (30 min), paste-ready:
```text
Act as a senior engineer running a project deep-dive for a Forward Deployed Engineer role.
I will give a 2-minute overview of my project <OmniGuard or AuditMesh> and paste its README.
Then grill me: ask "why" at least three levels deep on two design decisions, ask what broke and how I found it, ask what I would change for 10x users, and ask one security question.
Be skeptical of any number I give; ask how it was measured.
When I type "DONE", score me out of 10: overview clarity (2), depth on decisions (3), honest failure story (2), measurement rigour (2), communication (1). Name the answer that would worry a hiring manager most.
```

#### Scoring sheet
```text
Mock loop #<n>   Date: <date>   Track: <fast/slow>

| Round              | Score /10 | Biggest issue (one line)        | Fix before next loop |
|--------------------|-----------|---------------------------------|----------------------|
| 1 Coding           |           |                                 |                      |
| 2 Decomposition    |           |                                 |                      |
| 3 Customer role-play|          |                                 |                      |
| 4 Project deep-dive|           |                                 |                      |
| Total              |     /40   | Weakest round:                  |                      |

Energy level by round 4 (1-5):
One thing I will practise this week:
```

#### What "ready" looks like
- Every round 7+/10 in **two consecutive** loops, at least a week apart.
- Total 30+/40.
- You asked clarifying questions in rounds 1-3 without reminding yourself.
- In round 4 you gave at least one real "what broke" story with numbers.
- Your demo video and READMEs are live (M18-03, M18-10), so the interviewer can verify what you claim.
Agar koi round 5 ya kam aaye, us topic ka lesson (M18-04 / 05 / 06 / 07) dobara karo, 3 targeted drills, phir agla loop.

#### Log it in the portal
Job hunt -> **Mock interviews** -> har round ke liye ek entry: kind = `coding` / `decomposition` / `customer role-play` / `project deep-dive`, score /10, note = biggest issue. Poore loop ke liye ek extra entry kind = `full loop`, score = total/4 rounded, note = "loop #<n>, weakest: <round>". Har mock entry +30 XP deti hai; final gate ke liye scored full loop zaroori hai.

### Practice set
1. Run loop #1 at CP8 (or month 5 on slow track). Do not prepare specific answers the day before -- that is the point.
2. Fill the scoring sheet and log all entries in the portal.
3. Spend the next week on the weakest round only.
4. Run loop #2. Compare the two sheets.
5. Optional: ask a working engineer friend to run round 3 or 4 live instead of Claude.

### Rubric
Ready / not ready decided by the "What ready looks like" section. Partial credit: if 3 of 4 rounds are 7+, you are ready to start real interviews while still drilling the fourth.

### Common pitfalls
- Ek hi Claude chat mein saare rounds -- context leak hota hai aur scoring soft ho jaati hai. Har round naya chat.
- Score kam aaya to dobara usi din retry. Fatigue + same prompt = fake improvement. Ek hafte ka gap rakho.
- Sirf total dekhna. 36/40 with one round at 4 still fails many real loops.

### Checklist before moving on
- [ ] Loop #1 done, 5 entries logged in Job hunt -> Mock interviews
- [ ] Weakest round drilled for a week
- [ ] Loop #2 done with every round 7+
- [ ] Demo video + READMEs live and linked
- [ ] Applications running at 10/week (M18-11)

### Self-quiz
1. Why is "every round 7+" a better readiness rule than "total 30+"?
2. Why start a fresh Claude conversation for each round?
3. Your deep-dive score is low because you could not explain how a metric was measured. What exactly do you fix before the next loop?
