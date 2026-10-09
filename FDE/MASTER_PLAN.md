# FDE MASTER PLAN (v2 -- 2026-10-09, approved)

One goal: get hired as a **Forward Deployed Engineer (AI)**. Nothing in this plan
exists unless it moves you toward that.

This is the single plan. It **replaces ai-switch Track A** (the ai-switch ebook stays as
reading material). curriculum.md / PLAN.md / RESOURCES.md stay as reference.
The portal is built from this file.

---

## 1. What changed vs the original plan (and why)

| # | Original plan | Change | Why |
|---|---|---|---|
| 1 | No interview prep at all | **New Module 18: FDE Interview & Job Hunt** | FDE loops test things the curriculum never practises: practical coding, "decomposition" (vague customer problem -> design), customer role-play, project deep-dive, take-home builds. |
| 2 | Customer/consulting skills only in M15 (month 5) | **Weekly "FDE muscle" drill** (1 hr) | This is what separates an FDE from a backend/AI engineer. Practise it 8-20 times, not once. |
| 3 | Evals live in M14 (month 4) | **Eval basics (M14 #5-8) taught in the RAG checkpoint** | You cannot claim "my RAG works" without numbers. |
| 4 | Capstones start in month 5 | **Capstones are the spine from checkpoint 2.** Every module adds one layer to OmniGuard or AuditMesh | One deep, deployed, measured system beats 20 shallow repos. |
| 5 | Python -> APIs -> Cloud -> Docker -> LLM | **Python/API -> LLM -> RAG -> Docker/Cloud -> Integrations (M11 -> M12) -> Security -> Agents** | Get to AI early. Deploy once there is something worth deploying. |
| 6 | All 230 topics are equal | **Every topic tagged Core / Extended / Diagnostic** (section 3) | You are an experienced full-stack dev. |
| 7 | Apply after month 5 | **Start applying at checkpoint 5 (fast) / month 3 (slow)** | Interviews take weeks to schedule; applying is market feedback. |
| 8 | "20+ GitHub repos" | **2 flagship repos + 1 `fde-exercises` monorepo** | Hiring managers open 1-2 repos. Depth + live URL + eval numbers + demo video. |
| 9 | Fill all 230 stub .md files | **Just-in-time content, one checkpoint ahead** (section 8) | Writing 230 notes upfront is the "3-year trap" on the authoring side. |
| 10 | Budget alarm is M3 #13 | **AWS budget alarm in setup (checkpoint 1)** | Set the cost guardrail before the first resource. |
| 11 | Missing modern agent tooling | M10 gets **NEW: one vendor agent SDK** (Claude Agent SDK or OpenAI Agents SDK) | 2026 FDE JDs ask for MCP + agent SDKs, not only LangGraph. |
| 12 | Missing "demo-ability" | Every capstone milestone ends with **demo video + README (live URL + metrics)** | FDEs present to customers. The demo IS the deliverable. |
| 13 | Dated daily schedule | **Pace-based queue + month milestones** (section 2) | Your available time varies (1 hr one day, 5 hrs the next). |

---

## 2. How the plan works: pace-based queue + month milestones

- The plan is **one ordered queue** of work items. Each item has an hour estimate.
  No item has a date. Whenever you have time, you take the next item.
- The queue is grouped into **checkpoints**. Each checkpoint ends with a **gate**: proof you must
  link (repo, live URL, video, doc) before the next checkpoint unlocks.
- **Months are milestones**, not schedules: "by the end of month 1, checkpoint 4 should be done".
- Time logging: log minutes whenever you work (office PC and home PC both add up).
- **Projected finish** = remaining hours / your average hours per day over the last 14 days.
  The portal shows: "At 2.4 h/day you finish on 18 Dec. Fast target: 7 Dec -> 11 days late."

### The two tracks

| | FAST track | SLOW track |
|---|---|---|
| Length | 2 months (8 checkpoints) | 5 months (10 checkpoints) |
| Pace needed | **~31 hrs/week** (~247 hrs total) | **~16 hrs/week** (~326 hrs total) |
| Study topics | 134 (Core + GraphRAG) | 194 (Core + Extended + M17 picks) |
| Always included | 8 diagnostic, 18 capstone deliverables, 12 M18 items, weekly drill | same |
| Graph | **GraphRAG (M17 #9) only** -- its lesson starts with a 20-min nodes/edges refresher | full M7 + GraphRAG |
| Start applying | Checkpoint 5 | Month 3 |

**Starting track:** start on **SLOW** by default. If the portal measures 25+ hrs/week for 2
consecutive weeks, upgrade to FAST (remaining Extended topics drop out of the queue).
Upgrading from evidence is safer than starting fast and falling behind.

**Switching:** both tracks share topic ids, so switching keeps every tick.
Rule: at a month-end review, if the fast-track projected finish is **more than 14 days late**,
the portal recommends switching to slow. That is the plan working, not failure.

Hour math (fast): 134 topics x 1.2 h (read 15-20 min + build 50 min) = 161 h, + capstones 45 h,
+ M18 20 h, + diagnostic/setup 4 h = ~230 h. The itemized queue in portal/plan.json sums to
**~247 h / 8 weeks = ~31 h/week** (capstone deliverables M15/M16 add ~18 h on top of the builds).
Slow: 194 x 1.2 = 233 h + capstones + M18 + setup = **~326 h (itemized) / 20 weeks = ~16 h/week**.

---

## 3. Topic tiers (numbers = topic numbers in curriculum.md)

**C** = Core (both tracks), **E** = Extended (slow track only), **D** = Diagnostic (self-test, study only what you fail)

| Module | Core | Extended | Count C / E | Note |
|---|---|---|---|---|
| 00 Prerequisites | -- | -- | 8 D | 1 diagnostic sitting |
| 01 Python & Linux | 4, 6, 7, 8, 9, 10, 13, 14, 15 | 1, 2, 3, 5, 11, 12 | 9 / 6 | asyncio is the real gap |
| 02 Modern API | 1, 2, 3, 4, 5, 11, 12, 13 | 6, 7, 8, 9, 10, 14, 16, 17 | 8 / 8 | 15 (IDE extensions) dropped |
| 03 Cloud & Networking | 1-10, 13 | 11, 12 | 11 / 2 | 13 (budget) done in setup |
| 04 Containers & CI/CD | 1-6, 9-13 | 7, 8 | 11 / 2 | |
| 05 LLM & Prompting | 1-3, 5-9, 11-15 | 4, 10 | 13 / 2 | |
| 06 Vector Search & RAG | 1-3, 5-10, 12-16 | 4, 11 | 14 / 2 | taught together with M14 #5-8 |
| 07 Graph | -- | 1-11 | 0 / 11 | fast track: GraphRAG only |
| 08 Multimodal | 1, 2, 10, 11 | 3-9, 12 | 4 / 8 | messy PDFs = day-1 FDE problem |
| 09 Agentic / LangGraph | 1-9, 11 | 10, 12 | 10 / 2 | |
| 10 Agent Orchestration | 1-11 + NEW vendor agent SDK | -- | 12 / 0 | |
| 11 Legacy & Integrations | 1-6, 9-15 | 7, 8 | 13 / 2 | **#5 WSDL + #6 Zeep taught as a pair** |
| 12 IAM | 1, 2, 3, 6, 7, 8, 9, 10 | 4, 5 | 8 / 2 | always queued **after** M11 |
| 13 AI Security | 1-5, 10, 11, 14 | 6-9, 12, 13 | 8 / 6 | |
| 14 Observability & Gateway | 1-8, 10, 11, 15, 16 | 9, 12, 13, 14 | 12 / 4 | #5-8 are taught in the RAG checkpoint |
| 15 OmniGuard | 9 deliverables | -- | (capstone) | built incrementally |
| 16 AuditMesh | 9 deliverables | -- | (capstone) | |
| 17 Emerging | 9 GraphRAG (fast + slow) | 10 A2A, 13 AI FinOps, 14 red teaming | 1 / 3 | rest skipped |
| **18 NEW: Interview & Job Hunt** | 12 items (below) | -- | 12 | |
| **Total study topics** | | | **134 / 60** | fast = 134, slow = 194 (verified by portal/plan.py) |

### Module 18 -- FDE Interview & Job Hunt (new)
1. Study 10 real FDE job posts (OpenAI, Anthropic, Palantir, Scale, Sierra, Decagon, Indian GCCs/startups) -> your own skill-gap table
2. Resume rewritten as "deployments": problem -> what you built -> measured result
3. GitHub profile + 2 pinned flagship repos + LinkedIn headline/About
4. Practical coding drills: 20 Python problems of the "parse this messy data / call this API / fix this bug" kind (not LeetCode-hard)
5. Decomposition interview: 10 prompts ("a hospital wants AI for discharge notes -- go")
6. Customer role-play: 5 mock discovery calls (Claude plays a difficult customer)
7. Project deep-dive: STAR stories for OmniGuard and AuditMesh, including what broke
8. Take-home simulation: a 4-hour timed build from a vague brief
9. Behavioural: ambiguity, pushing back on a customer, owning a production mistake
10. Demo skills: record and critique a 5-min demo
11. Outreach: referrals + applications log (target: 10 applications/week once started)
12. Full mock loop (4 rounds) with Claude, scored

### Weekly "FDE muscle" drill (1 hr, every 7 days, both tracks)
Rotates: 1-page discovery doc for a made-up customer / design doc for the current build /
explain the current topic to a non-engineer in 5 min (record it) / one decomposition prompt /
short LinkedIn post about what you built.

---

## 4. FAST track -- 8 checkpoints (~247 h)

| CP | Queue (in order) | Capstone layer | Gate (proof) | ~Hours |
|---|---|---|---|---|
| 1 | Setup (repos, AWS account + budget alarm, API keys) + Prereq diagnostic + M1 Core | `fde-exercises` monorepo | Monorepo with an async exercise running | 15 |
| 2 | M2 Core -> M5 Core | OmniGuard: FastAPI skeleton + tests, then LLM endpoint with strict JSON + 2 tools + parse-error retry | Coverage report + 50 calls with zero invalid JSON | 30 |
| 3 | M6 Core + M14 #5-8 (evals) + M8 #1, 2, 10, 11 | OmniGuard: Hybrid RAG v1 (BM25 + dense + RRF + reranker) over messy PDFs | Eval report in README (faithfulness, context precision/recall) | 32 |
| 4 | M4 Core -> M3 Core | OmniGuard: Docker + GitHub Actions + AWS deploy | **Live URL** + health check + CI badge | 30 |
| | **Month 1 milestone = CP4 done (~107 h)** | | | |
| 5 | M11 Core -> M12 Core. M18 #1-3 | OmniGuard: secure Text-to-SQL (read-only role, parameterized), OAuth2 + RBAC, data-level permissions | Two-user demo (same question, different allowed answers) + first 10 applications | 31 |
| 6 | M13 Core + GraphRAG (M17 #9) + M15 docs. M18 #4-5 | OmniGuard v1.0: Presidio + NeMo, discovery / data classification / SOW / ROI / UAT | Tag v1.0 + 5-min demo video + docs in repo | 26 |
| 7 | M9 Core -> M10 Core (incl. MCP server + agent SDK). M18 #6-7 | AuditMesh: supervisor graph, Jira MCP server, HITL with checkpointing | Run that pauses for human approval and resumes | 35 |
| 8 | M14 remaining Core + M16. M18 #8-12 | AuditMesh v1.0: traces, token-cost dashboard, approval UI, SLAs, handoff doc | Tag v1.0 + demo video + full mock loop scored | 32 |
| | **Month 2 milestone = CP8 done (~231 h)** | | | |

After CP8: keep applying and interviewing; do M7 and the rest of M8 in the gaps.

---

## 5. SLOW track -- 10 checkpoints (~326 h)

| CP | Queue (in order) | Capstone layer / gate | Month milestone |
|---|---|---|---|
| 1 | Setup + budget alarm + Prereq diagnostic + M1 (all) | monorepo + async worker exercise | |
| 2 | M2 (all) | OmniGuard API skeleton + tests (gate: coverage report) | **Month 1** |
| 3 | M5 (all) | LLM endpoint, strict JSON + tools (gate: 50-call validity test) | |
| 4 | M6 (all) + M14 #5-8 | Hybrid RAG v1 (gate: eval report) | **Month 2** |
| 5 | M8 (all) -> M7 (all) -> GraphRAG. **M18 #1-3 starts** | multimodal ingestion + graph retrieval experiment; first applications | |
| 6 | M4 (all) -> M3 (all) | OmniGuard deployed (gate: **live URL** + CI) | **Month 3** |
| 7 | M11 (all) -> M12 (all) | Text-to-SQL + Jira/Slack + OAuth2/RBAC (gate: two-user demo) | |
| 8 | M13 (all) + M15 | OmniGuard v1.0 (gate: tag + demo video + SOW/ROI/UAT) | **Month 4** |
| 9 | M9 (all) -> M10 (all) | AuditMesh supervisor + MCP + HITL (gate: pause/resume demo) | |
| 10 | M14 (rest) + M16 + M17 picks + M18 #4-12 | AuditMesh v1.0 (gate: tag + demo video + full mock loop) | **Month 5** |

---

## 6. Discipline rules (the portal enforces these)

1. **Track is chosen once** (switching allowed, see rule 6). Work comes from the queue in order.
2. **No zero days.** Minimum 25 minutes logged, otherwise the streak breaks.
3. **Gates need proof.** A gate cannot be ticked without a link.
4. **Weekly review** every 7 days (what did I ship / what is unclear / what changes next).
5. **Month-end review** against the month milestone and projected finish.
6. **Fast track projected > 14 days late at a month-end review -> switch to slow.** Ticks carry over.
7. **Build > read.** A topic is done only when its mini-exercise runs.

---

## 7. The portal (built 2026-10-09)

Two modes, one data file:

| Mode | Where | What it does |
|---|---|---|
| **Local mode** | `FDE/start-portal.bat` -> `FDE/portal/serve.py` (127.0.0.1 only), office or home PC | Tick topics, log minutes, notes, gates with proof links, reviews. Writes `FDE/progress.json`. "Get latest" (git pull) and "Save" (commit + push) buttons. |
| **Public mode** | New **FDE** tab on FullStackInterview (GitHub Pages) | Read-only: roadmap, month milestones, filled lessons, progress %, hours, streak, gates with proof links, capstone status, XP/level/badges |
| **Private (encrypted)** | Same encryption approach as `prep/` | Daily notes, job applications (company names), mock interview scores. Synced between PCs, unreadable on the public site. |

- `FDE/` becomes part of the FullStackInterview repo (no separate repo).
  "Save to GitHub" commits only paths inside `FDE/` (progress, encrypted private file, plan.json,
  new lessons) and then pushes the repo. The page is `FDE/portal/index.html`; public URL `.../FDE/portal/`.
- **Screens (local mode):** Today ("Next up" from the queue, log minutes, note, streak,
  projected finish, XP) / Checkpoint (current gate + proof field + weekly review) /
  Roadmap (modules, C/E tiers, progress) / Capstones / Job hunt / Settings (track, switch).

### Gamification (XP, levels, milestones, streaks)

Modeled on krishnaik.in's tutorial tracker, but stored in `progress.json` (git-synced via
FullStackInterview, survives browser clears, works on both PCs) -- not localStorage.

- **XP:**
  - topic = 20 XP, only when its mini-exercise runs; proof = **commit hash or one line**
    saying what you built (strict URL proof is for gates only -- 134+ URL proofs is too much friction)
  - gate/checkpoint = 50 XP, strict proof link required (repo, live URL, demo video, eval report)
  - application sent = 5 XP, **capped at 10 XP/week** (no spam-applying)
  - mock interview = 30 XP
  - weekly FDE drill = 15 XP
  - self-check quiz = 2 XP per point self-graded; **5 XP per point when Claude grades it**
- **Levels:** thresholds are a **% of your track's total XP** (0 / 10 / 25 / 45 / 70 / 95%):
  Curious builder -> Steady learner -> Practitioner -> Shipping engineer -> Systems architect
  - **FDE level is achievement-only:** both capstones at v1.0 **plus** a scored mock
    interview loop. XP alone never unlocks it.
- **Streak:** consecutive days with >= 25 min (activedays list, keep last 400).
  **1 rest token per week** -- used deliberately via a button, does not break the streak.
- **Badges:** first topic / quarter / half / perfect self-check / three quarters /
  **first live deploy** / **7-day streak** / **30-day streak** / OmniGuard v1.0 /
  AuditMesh v1.0 / first application sent / first interview
- **Render:** XP bar + level name + streak + rest token + badges on the Today screen;
  every tick dispatches a custom `fde-progress` event so all widgets re-render
- **Anti-cheat:** XP only from proof-backed ticks (commit hash/one line for topics,
  URL for gates, Claude-graded for full quiz XP)

---

## 8. Content: who writes what, and when

- **Claude writes the topic lessons, one checkpoint ahead** (you say "generate CP2" before
  you finish CP1). Core topics get the full PLAN.md template + a short story hook;
  Extended topics get a 5-line note + 1 link.
- **Hinglish to learn, English to ship:** lesson notes = Hinglish explanations + English Python code.
  Capstone READMEs, demo videos, briefs meant for GitHub, and everything on the public site = English.
- Code snippets are run locally before they are filed; anything needing an API key is marked.
- **You write the capstone code.** Claude writes the capstone briefs (what to build, acceptance
  checks, gate), reviews your code and debugs with you, but does not hand over the solution.
- ai-switch ebook chapters that already cover M1 / M5 / M6 / M9 are linked, not rewritten.
