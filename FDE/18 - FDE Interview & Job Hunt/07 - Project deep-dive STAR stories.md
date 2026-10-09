# FDE Interview & Job Hunt

## Project deep-dive STAR stories

> Core | Fast CP7 / Slow CP10 | ~1.5 h | Builds on: M15-*, M16-*, M18-02

### Kahani
Interviewer: "Tell me about OmniGuard." Aap 6 minute bolte ho -- FastAPI, Presidio, hybrid retrieval, Docker, sab kuch.
Phir woh poochta hai: "What was the hardest bug?" Aap: "Umm... sab theek chal gaya mostly."
Us ek jawab ne 6 minute ki achhi baat ko halka kar diya. Interviewer ko lagta hai ya to project shallow tha, ya aap honest nahi ho.
Deep-dive round mein jo cheez sabse zyada score karti hai woh hai: **kya toota, aapne kaise pata kiya, aur kya badla.**

### What it is
Har flagship project ke liye 2-3 tayyar stories, **STAR + L** format mein: Situation, Task, Action, Result, Learning -- jismein ek "what broke and what I changed" story zaroor ho.
Saath mein ek 2-minute project overview jo deep-dive ka starting point bane.

### Why it matters for an FDE
FDE ko customer ke saamne apne system ke failures explain karne padte hain. Interviewer dekhta hai ki aap failure ko clearly, bina blame ke, data ke saath bata sakte ho ya nahi.

### Key concepts
- **2-minute overview** -- problem, users, architecture in one breath, one metric, your role. Phir ruk jao, interviewer ko chunne do.
- **STAR+L** -- Situation (1-2 lines), Task (your responsibility), Action (60% of time, "I" not "we"), Result (number), Learning (what you do differently now).
- **Broke-story** -- symptom -> how you detected -> root cause -> fix -> how you prevent it now.
- **Trade-off ownership** -- "I chose X over Y because Z; the cost was W." Har decision ka downside bhi bolo.
- **Depth ladder** -- har claim ke neeche 3 "why" tak jaane ki tayyari (e.g. why RRF -> why k=60 -> what happened when you changed it).

### How to do it
1. Har capstone ke liye 2-minute overview likho aur 3 baar bol ke record karo.
2. Har capstone ke liye 3 stories: (a) a key design decision, (b) what broke, (c) a customer/stakeholder moment (scope, security review, UAT).
3. Har story mein ek number ya `<placeholder>` jo aapke eval/trace se aaye.
4. Claude se grill karwao (prompt M18-12 Round 4).

STAR+L template (English):
```text
Title: <short name, e.g. "Text-to-SQL returned other teams' rows">
Situation: <project, phase, what was at stake -- 1-2 lines>
Task: <what I specifically owned>
Action:
  - Symptom: <what I saw, where (eval, trace, UAT feedback)>
  - Investigation: <how I narrowed it down>
  - Root cause: <the actual reason>
  - Fix: <what I changed, and why this fix over alternatives>
Result: <metric before -> after, e.g. <n>/<n> RBAC tests passing, <p95 latency> unchanged>
Learning: <what I do by default now>
Follow-ups I expect: <2-3 likely "why" questions + one-line answers>
```

#### Sample stories (English, adapt with your real details)
OmniGuard -- what broke:
```text
Situation: OmniGuard answers insurance analysts' questions over MS SQL and policy documents. During my own UAT run, one test user saw claim rows from a region they were not allowed to access.
Task: I owned the Text-to-SQL path and its access control.
Action: The trace showed the LLM-generated SQL had no region filter. I had been relying on the prompt to "only query allowed regions", which is not a security control. I moved enforcement out of the model: the API now runs queries through a read-only DB role and wraps every generated query with a row-level filter built from the user's RBAC claims, and a SQL parser rejects anything that is not a single SELECT.
Result: All <n> RBAC test cases now pass, including 10 adversarial prompts that previously leaked rows. p95 latency moved from <p95 before> to <p95 after>.
Learning: Never use the prompt as an access-control layer. Enforce permissions in code and the database, and test them like any other security boundary.
```

AuditMesh -- design decision (outline only, write yours):
- Situation: 5-step manual compliance review, reviewers spend <baseline> per case.
- Decision: supervisor graph with a mandatory human approval node before any Jira write, instead of a fully autonomous agent.
- Trade-off: slower per case than full automation, but every external action is approved and logged; checkpointing lets a paused run resume after hours.
- Result: <baseline> -> <result> minutes per case, <n> approvals, zero unapproved writes.

AuditMesh -- what broke (ideas to check in your own build): agent loop retrying a failing tool until token budget blew up; MCP tool allowed a broader Jira action than intended; resumed run lost state because the checkpoint key was not stable.

### Practice set
1. Write the 2-minute overview for OmniGuard and AuditMesh. Record both. Cut until under 2:15.
2. Write 3 STAR+L stories per capstone (6 total).
3. For each story, write 3 follow-up questions and short answers.
4. Run a 30-minute Claude grilling on one capstone (M18-12, Round 4 prompt).
5. Ask a non-AI friend to listen to the overview and repeat it back. Fix whatever they got wrong.

### Rubric
| Check | Points |
|---|---|
| Overview under 2:15, includes problem, architecture, 1 metric, your role | 2 |
| Each story has a number or measured placeholder | 2 |
| "Action" uses "I", explains why, not just what | 2 |
| Broke-story has detection + root cause + prevention | 2 |
| Survives 3 levels of "why" without hand-waving | 2 |

### Common pitfalls
- "We" everywhere. Solo capstone mein bhi "we" bolne se lagta hai aap apna kaam chhupa rahe ho.
- Fake failure ("my weakness is I work too hard" type). Real bug batao -- interviewers can tell.
- Story mein tool names zyada, reasoning kam. "Why" interviewer ka favourite sawal hai.

### Checklist before moving on
- [ ] 2 recorded overviews under 2:15
- [ ] 6 STAR+L stories written, each with a metric
- [ ] At least 1 "what broke" story per capstone
- [ ] One full deep-dive mock logged in Job hunt -> Mock interviews

### Self-quiz
1. Why is "I relied on the prompt for access control" a strong thing to admit in a deep-dive, not a weak one?
2. What is the difference between the Result and the Learning in STAR+L, and why does an FDE interviewer care about the Learning?
3. An interviewer asks "Why not just use a bigger model?" about one of your decisions. How do you structure a 30-second answer?
