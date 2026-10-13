# START HERE -- AI Forward Deployed Engineer course

This is the only page you need to begin. Everything else is linked from here.

> Picking up unfinished work? See [RESUME_HERE.md](RESUME_HERE.md).

**Your study order, step by step: [SYLLABUS.md](SYLLABUS.md)** (slow track, 256 numbered steps).

---

## 1. What this course gets you

**Goal:** get hired as an AI Forward Deployed Engineer (FDE).

**FDE in one line:** an engineer who goes into a customer's messy real world (old databases,
PDFs, SSO, security rules) and ships a working AI system there -- then explains it to
their CISO and executives.

**At the end you will have:**

| You will have | Why it matters in an interview |
|---|---|
| **OmniGuard** -- secure enterprise AI: hybrid RAG + safe Text-to-SQL + SSO/RBAC + PII guardrails, live on AWS | "Show me something you deployed" |
| **AuditMesh** -- multi-agent compliance system: LangGraph supervisor + MCP server + human approval + cost dashboards | "Show me agents in production" |
| SOW, ROI deck, UAT runbook, demo videos | "How do you handle a customer?" |
| Resume, mocks, applications (Module 18) | the actual job hunt |

---

## 2. How long

You are on the **SLOW track**: 5 months, about **16 hours/week** (~326 h total).
Your time can vary day to day -- there are no dates, just an ordered list. Take the next item whenever you have time.
If you do 25+ h/week for 2 weeks in a row, you can switch to the FAST track (2 months); your ticks carry over.

| Month | Checkpoints | What you finish | Gate (proof to move on) |
|---|---|---|---|
| 1 | CP1 -- CP2 | Python/async, APIs, OmniGuard skeleton | async exercise repo; tests + coverage |
| 2 | CP3 -- CP4 | LLMs, prompting, RAG + evals | 50 calls with 0 invalid JSON; eval report |
| 3 | CP5 -- CP6 | multimodal, graphs, Docker, AWS. **Start applying** | OmniGuard **live URL** |
| 4 | CP7 -- CP8 | integrations, IAM, security | OmniGuard **v1.0** + demo video |
| 5 | CP9 -- CP10 | agents, MCP, observability, interviews | AuditMesh **v1.0** + mock interview loop |

---

## 3. How to study one lesson (the loop)

Every lesson is ~1.2 hours. Same loop every time:

```
1. READ     the story + "What it is" + "Key concepts"        (15-20 min)
2. RUN      the code block marked  # runnable                 (5 min)
            -> copy it into a .py file, run it, all asserts must pass
3. BUILD    the "Mini-exercise" in your own repo              (30-60 min)
4. CHECK    tick the "Checklist before moving on" honestly
            + answer the "Self-quiz" without looking
5. TICK     mark it done in the portal (proof = commit hash or one line)
```

**Rule:** a lesson is done only when its mini-exercise runs. Reading is not done.

---

## 4. The 4 kinds of file you will meet

The grey box at the top of each lesson tells you its kind:

| Label at the top | What it is | What you do |
|---|---|---|
| **Diagnostic** | self-test only (folder `00`) | answer + run code. Pass = skip. Fail = do its 30-min plan |
| **Core** | full lesson (both tracks) | the full 5-step loop above |
| **Extended (slow track only)** | short 5-line note + one exercise + one link | read, do the "Try this", move on |
| **Deliverable NN of NN** (in `Projects/`) | a **BUILD brief** for a capstone | build it in your own repo, pass the acceptance checks |

"Fast CPx / Slow CPy" in that box = which checkpoint the lesson belongs to. You are on **Slow**.
"Builds on: M06-12" = module 06, file 12.

---

## 5. Where things are

```
FDE/
  START_HERE.md          <- you are here
  SYLLABUS.md            every step in study order, clickable (slow track)
  SYLLABUS-fast.md       same for the fast track
  SETUP.md               install + repos + API keys + how to run lesson code
  starter/               copy-out starter repos: fde-exercises, omniguard
  MASTER_PLAN.md         the "why": decisions, both tracks, discipline rules, XP rules
  AUDIT_AND_PLAN.md      known usability problems + the fix plan (in progress)
  start-portal.bat       opens the progress portal (tick lessons, log time)

  00 ... 14              LESSONS by module (folder number = module, NOT study order)
  15 OmniGuard, 16 AuditMesh   capstone LESSONS (LEARN the consulting skill)
  Projects/              capstone BUILD briefs (what you ship + acceptance checks)
  17 Optional            only #9, 10, 13, 14 are in the plan; the rest say "skip"
  18 Interview & Job Hunt
  _reference/            old docs + data files for the portal. Not a starting point.
```

**Important:** folders are numbered by module, but you do **not** study them 00 -> 18.
The study order is mixed (e.g. LLMs before Docker). Always follow [SYLLABUS.md](SYLLABUS.md)
(or the portal's **Next up**, which uses the same order).

---

## 6. Your first checkpoint (CP1, ~25 h) -- do these in order

Same as steps 001-029 in [SYLLABUS.md](SYLLABUS.md#cp1).

**Setup (~2 h)** -- exact commands in [SETUP.md](SETUP.md); starter repos in [starter/](starter/README.md)
- [ ] Create 3 GitHub repos: `fde-exercises`, `omniguard`, `auditmesh` (each with a README)
- [ ] Python 3.12+ env (uv or venv) + pytest + ruff; one "hello" test passing in `fde-exercises`
- [ ] LLM API keys in a `.env` that is gitignored (check `git status` never shows it)
- [ ] AWS budget alarm: [Setting automated budget thresholds](<03 - Cloud Fundamentals & Networking/13 - Setting automated budget thresholds.md>)

**Diagnostic (~2 h)** -- all 8 files in [00 - Prerequisites](<00 - Prerequisites/>), in order:
- [ ] [01 Python basics](<00 - Prerequisites/01 - Python basics (variables, loops, functions).md>)
- [ ] [02 Python data types](<00 - Prerequisites/02 - Python data types and structures.md>)
- [ ] [03 SQL fundamentals](<00 - Prerequisites/03 - SQL fundamentals (queries, joins).md>)
- [ ] [04 Database basics](<00 - Prerequisites/04 - Database basics (tables, keys, normalization).md>)
- [ ] [05 REST API fundamentals](<00 - Prerequisites/05 - REST API fundamentals.md>)
- [ ] [06 HTTP methods and status codes](<00 - Prerequisites/06 - HTTP methods and status codes.md>)
- [ ] [07 Git basics](<00 - Prerequisites/07 - Git basics (clone, commit, push, pull).md>)
- [ ] [08 Git branching and merging](<00 - Prerequisites/08 - Git branching and merging.md>)

**Module 01 (~18 h)** -- [01 - Python & Linux Foundations](<01 - Python & Linux Foundations/>), files 01 -> 15 in order.
The real gap for a full-stack dev is **06-10 (asyncio, concurrency)** -- go slow there.

**Build + gate**
- [ ] `fde-exercises`: one async worker exercise (asyncio + ThreadPoolExecutor) (~3 h)
- [ ] **Gate:** link the repo with the async exercise running -> CP2 unlocks

---

## 7. The portal (recommended way to study)

Double-click `start-portal.bat` (needs Python). It opens in your browser on the **Learn** tab:

- left: the syllabus in study order (dot = done), right: the current lesson as a page
- **Continue** button at the top always jumps to your next step
- **Prev / Next** at the top and bottom of every lesson; links inside lessons open in place
- **Mark complete** at the end of the lesson -> it moves you to the next step
- XP, streak, badges and month milestone live in the **Progress** tab; ignore them on day 1

It syncs through git (Get latest / Save to GitHub), so office and home PC both count.

## 8. When you are stuck

- Concept unclear -> ask Claude: "explain <lesson name> with a different example / a diagram".
- Code fails -> paste the error; get cause + smallest fix.
- Lost in the plan -> open [SYLLABUS.md](SYLLABUS.md) and find your step number.
