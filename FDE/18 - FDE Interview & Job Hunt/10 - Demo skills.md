# FDE Interview & Job Hunt

## Demo skills

> Core | Fast CP8 / Slow CP10 | ~1 h | Builds on: M15-04, M15-05, M16-*

### Kahani
AuditMesh ka demo, hiring panel ke saamne. Aap 4 minute setup explain karte ho, phir terminal kholte ho, `docker compose up`, logs scroll ho rahe hain...
Minute 7 pe pehla output aata hai. Ek panel member already apna email check kar raha hai.
Phir ek tool call fail hota hai aur aap bolte ho "ye pehle chal raha tha". Demo khatam.
Same system, achhe demo mein: 30 second mein problem, 2 minute mein live happy path, jaan-bujh ke ek failure jo gracefully handle hota hai, phir numbers. Panel ko yaad rehta hai.

### What it is
Ek structured 5-minute demo -- live ya recorded -- jo dikhata hai ki system kya problem solve karta hai, kaise kaam karta hai, failure pe kya hota hai, aur kitna accha hai (numbers).
Iska recorded version aapke README, LinkedIn Featured aur applications mein jaata hai.

### Why it matters for an FDE
FDE customer ko har milestone pe demo deta hai. Achha demo trust banata hai aur pilot ko next phase mein le jaata hai; bura demo achhe system ko bhi maar deta hai.

### Key concepts
- **Problem first** -- pehle 30 second mein user aur pain. Architecture baad mein, aur short.
- **Happy path live** -- ek realistic input, end to end, pre-tested.
- **Failure handled** -- jaan-bujh ke ek bad input dikhao (injection, out-of-scope, tool failure) aur system ka safe behaviour.
- **Metrics** -- eval table ya dashboard, 30 second. "It works" ki jagah "it works on <n>/<n>".
- **Next steps + ask** -- kya next hai, aur audience se kya chahiye.

### How to do it
Demo structure:
```text
Problem (30s) -> Live happy path (2m) -> Failure handled (1m) -> Metrics (45s) -> Next steps (30s) -> buffer (15s)
```
Prep rules:
- Environment pehle se running ho. Data pre-loaded. Browser tabs pre-opened in order.
- Font size bada (terminal 18pt+), notifications off.
- Backup: ek recorded video same flow ka, agar live fail ho jaaye.

5-minute script template (English, fill and rehearse):
```text
[0:00 Problem]
"Compliance reviewers at a mid-size bank spend about <baseline minutes> per case doing 5 manual steps across email, spreadsheets and Jira. AuditMesh automates the routine steps and keeps a human in control of every external action."

[0:30 Live happy path]
"Here is a real-looking case. I submit it... the supervisor routes it to the evidence agent, which pulls the documents... the policy agent checks them against the rules...
Now it pauses: a reviewer must approve before anything is written to Jira. I approve... and here is the ticket, with a link back to the full trace."

[2:30 Failure handled]
"Now a bad case: this document contains an instruction trying to make the agent close all open tickets. The policy guard flags it, the Jira tool is scoped so it cannot close tickets anyway, and the run is routed to a human with the reason shown."

[3:30 Metrics]
"On <n> test cases: review time went from <baseline minutes> to <result minutes>, cost is <cost per case> per case, p95 latency <p95 latency>, and zero unapproved writes. Every run has a trace you can open."

[4:15 Next steps]
"Next, I would run it in shadow mode with real reviewers for two weeks and measure how often they change the agent's recommendation. The question for you: <ask>."
```

#### Recording checklist
- [ ] Script rehearsed 3 times, under 5:00
- [ ] 1080p, screen + small webcam (optional), clear mic, quiet room
- [ ] Notifications off; no secrets, tokens or real personal data on screen
- [ ] Zoom in on the important part (output, approval button, metric table)
- [ ] Failure case shown and explained, not hidden
- [ ] Captions or a short text summary under the video
- [ ] Uploaded unlisted (YouTube/Loom), link tested in incognito
- [ ] Linked from README top, LinkedIn Featured, resume project line

### Practice set
1. Write the 5-minute script for OmniGuard and AuditMesh.
2. Record AuditMesh. Watch it at 1x, note 3 problems, re-record.
3. Critique with Claude: paste your transcript (auto-captions are fine) with: "Critique this 5-minute technical demo for an FDE hiring panel. Score structure, clarity, evidence and pacing out of 10 and give 5 concrete fixes with timestamps."
4. Do one live demo for a friend over a video call, including answering 2 questions.
5. Weekly drill tie-in: once a month, explain the current topic to a non-engineer in 5 min and record it.

### Rubric
| Area | Points |
|---|---|
| Problem + user clear in first 30s | 2 |
| Happy path runs live, no dead time > 10s | 2 |
| Failure case shown with safe behaviour | 2 |
| Metrics with numbers + method | 2 |
| Next step + ask, ends on time | 2 |

### Common pitfalls
- Architecture diagram se shuru karna. Audience ko pehle "why should I care" chahiye.
- Live install/build during demo. Sab pehle se running ho.
- API key ya customer-like data screen pe dikh jaana. Recording ke pehle check karo.

### Checklist before moving on
- [ ] Two scripts written
- [ ] AuditMesh demo recorded (second take or better) and linked in README
- [ ] Claude critique done, top fixes applied
- [ ] One live demo with Q&A done

### Self-quiz
1. Why show a failure case in a demo that is meant to impress?
2. What do you do in the first 30 seconds if the live system will not start?
3. Which single metric would you show for OmniGuard, and why that one over others?
