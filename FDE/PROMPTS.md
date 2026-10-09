# Ready-to-Use Prompts for the FDE Roadmap

## Prompt 1: Generate content for any subtopic file

```
You are an AI Forward Deployed Engineer course author. Fill in ONE subtopic file for my FDE bootcamp.

TARGET FILE: <paste path, e.g. 06 - Vector Search & Core RAG/13 - Implementing RRF algorithms.md>
MODULE GOAL: <paste module title>

Follow this exact template (from PLAN.md):
# <Module>
## <Subtopic>
- What it is (2-3 lines)
- Why it matters for an FDE (1-2 lines)
- Key concepts (3-5 bullets)
- Code example / config snippet (runnable Python, with dependencies named)
- Mini-exercise (build it in 30-60 min, uses free-tier tools only)
- Common pitfalls (2-3 bullets)
- Checklist before moving on (3-5 items)

Rules:
- Difficulty: beginner-friendly; assume only Python/SQL/API basics
- Code must run as-is; state versions
- Cross-link to related subtopics where relevant
- End with a 3-question self-quiz
Output ONLY the markdown file content.
```

## Prompt 2: Generate the full tracking dashboard (all tracks)

```
Build a study-tracking dashboard in markdown for my AI Forward Deployed Engineer bootcamp.

STRUCTURE (all tracks):
- 00 - Prerequisites (8 topics)
- Modules 1-16 (topic counts: 15,15,13,12,15,16,11,12,12,11,14,10,14,16,9,9)
- 17 - Advanced & Emerging Tech (Optional, 14 topics)
- Projects: OmniGuard (12 deliverables), AuditMesh (8 deliverables)

REQUIREMENTS:
1. Header: overall progress %, topics done/total, current streak, hours logged
2. One section per track with markdown checkboxes (- [ ]) for every subtopic
3. Each item: [status] topic name (estimated hours) — status emoji: ⬜ not started / 🟡 in progress / ✅ done
4. Estimated hours per module based on topic count (45-90 min per topic)
5. Weekly milestones for the 5-month plan (Month 1: Prereqs+M1-2 ... Month 5: M15-16)
6. Capstone tracker with deliverable checkboxes for OmniGuard and AuditMesh
7. Daily log table: date | topics done | hours | notes
8. Summary table: Track | Total | Done | In Progress | Remaining | % 

Output ONLY markdown, ready to paste into DASHBOARD.md. Use placeholders [date] where needed.
```

## Prompt 3 (bonus): Daily task generator

```
I'm following the FDE roadmap in curriculum.md (5-month plan, 5 days learn / 1 day build / 1 day review).
Today is [date]. I've completed: [list done topics].
Give me: (1) today's 2-3 subtopics in order, (2) one 60-min practice task, (3) one 15-min review of yesterday's topics, (4) the single most important thing to build this week. Keep it under 20 lines.
```

## Prompt 4: Learn in Hinglish

Project instructions (paste once):
```
Explain everything in Hinglish (Roman script Hindi + English mix).
- Technical terms stay in English (RAG, embedding, MCP, pipeline)
- Explanations, examples, and analogies in simple Hindi
- Code and commands in English only
- Keep a friendly guru tone, short sentences
- End each topic with 1 line summary in Hinglish
```

Usage:
```
Hinglish me samjhao: <subtopic name> kaise kaam karta hai — ek chhota sa real-life example ke saath.
```

Follow-ups:
- "isse aage badho" — continue to next part
- "yeh doubt clear karo" — clarify a specific doubt
- "Is subtopic ke 10 flashcards Hinglish me banao" — Hinglish flashcards
- "Code aur output English me, explanation Hinglish me rakh" — keep code English only
