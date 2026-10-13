# FDE Course -- Audit + Fix Plan (2026-10-12)

Goal of this doc: find out why the FDE folder feels hard to use, compare it with how real
learning platforms (LMS) are organised, and plan the fix. Nothing has been changed yet.

---

## 1. Short verdict

**The content is good. The packaging is broken.**

- 243 lesson files, 164 of them follow the same template (story -> what -> why -> code ->
  exercise -> pitfalls -> checklist -> quiz). 161 code blocks run. That part is solid.
- The problem is **wayfinding**: there is no front door, the folders are not in study order,
  six root documents disagree with each other, and the portal shows XP before it shows
  "what do I read now".

In LMS terms: we built the lessons but never built the **course**.

---

## 2. Audit findings (ranked by how much they hurt)

### A. No front door -- "where do I start?" (CRITICAL)

- Root has 6 docs: `MASTER_PLAN.md`, `PLAN.md`, `curriculum.md`, `RESOURCES.md`,
  `PROMPTS.md`, `USING_CLAUDE_MAX.md`. None is called README or START HERE.
- **They contradict each other:**

| Doc | Says | Current truth (MASTER_PLAN v2) |
|---|---|---|
| PLAN.md | 5 months, Month 1 = Prereqs + M1-M2 in folder order | 10 checkpoints in a different order |
| RESOURCES.md | 230 topics, 290 hrs | slow = 194 topics, ~326 h |
| USING_CLAUDE_MAX.md | "fill the 230 subtopic files" | already written |
| PROMPTS.md | prompt to generate a markdown DASHBOARD.md | portal replaced it |

- A new reader opening the folder cannot tell which doc is current.

### B. Folder order != study order (CRITICAL)

Folders are numbered 00 -> 18, but the real slow-track path is:

```
CP1  Setup + 00 Prereqs + 01 Python        CP6  04 Docker -> 03 Cloud
CP2  02 APIs                               CP7  11 Integrations -> 12 IAM
CP3  05 LLM                                CP8  13 Security + 15 OmniGuard
CP4  06 RAG + 4 lessons from 14            CP9  09 Agents -> 10 Orchestration
CP5  08 Multimodal -> 07 Graph -> 17#9     CP10 rest of 14 + 16 + 17 + 18
```

This order exists **only** inside `portal/plan.py` / `plan.json`. Browsing the folders
(VS Code, GitHub, Explorer) leads you the wrong way (03 Cloud comes after 02 in the folder
list but you do it in week ~12).

### C. Lessons don't link to each other (HIGH)

- Lessons say "Builds on: M06-05, M06-12" and "Related: M14-07" -- **0 clickable links**
  in all 243 files. You must translate `M06-12` -> folder 06 -> file 12 by hand.
- The header line `Core | Fast CP3 / Slow CP4 | ~1.2 h` uses CP numbers that mean
  nothing outside the portal.
- No "Next lesson ->" at the bottom of any lesson.

### D. Duplicate / confusing capstone material (HIGH)

| Folder | Files | What it is |
|---|---|---|
| `15 - OmniGuard .../` | 9 | lessons (SOW, ROI, UAT, harness...) |
| `Projects/Project 1 - OmniGuard .../` | 12 + README | build briefs with acceptance checks |
| `16 - AuditMesh .../` | 9 | lessons |
| `Projects/Project 2 - AuditMesh .../` | 8 + README | build briefs |

Same names, different counts, two places. It is not obvious that one is "learn" and the
other is "build".

### E. Portal is a tracker, not a classroom (HIGH)

- Today tab order: XP tiles -> streak -> log minutes -> rest token -> daily note ->
  *then* "Next up". The study action is below the bookkeeping.
- Lessons open in a **modal popup**: no sidebar, no prev/next, no syntax highlighting,
  no "mark complete" at the end of the lesson. Ticking needs a proof string in a different place.
- Needs `start-portal.bat` + Python server + git for local mode. Fine, but the first-run
  experience is not explained anywhere in the repo root.
- 6 tabs + encryption password + XP + rest tokens + quiz logging on day 1 = too much surface.

### F. Lesson format: strong but heavy, and not visual (MEDIUM)

- Core lessons: consistent sections (good). But the code block often comes with 10-20
  asserts before the concept has sunk in (RRF lesson = ~60 lines of code).
- **0 diagrams** in 243 files (no Mermaid, a few ASCII). Your own learning rule is
  visual-first.
- No "By the end you can..." learning objectives at the top -- the checklist at the bottom
  has them, but you only see it after reading.
- 4 different lesson formats (Diagnostic, Core, Extended 5-line note, Capstone brief)
  with no legend explaining them.
- 11 empty stubs in `17 - Advanced & Emerging Tech (Optional)/` (out of plan, but they look
  like missing content).

### G. No environment / exercise scaffolding (MEDIUM)

- 0 `requirements.txt` / `pyproject.toml`. Exercises say "build in `omniguard/rag/fusion.py`"
  but there is no starter repo or folder layout to begin from.
- 32 lessons need an API key; that is noted per lesson but there is no one-page setup guide.

---

## 3. Comparison with industry LMS

What every serious platform has (Coursera, Udemy, Boot.dev, Frontend Masters, Educative,
roadmap.sh, freeCodeCamp) vs FDE today:

| LMS feature | Typical example | FDE today | Gap |
|---|---|---|---|
| Course home / "Start here" | Coursera course landing page | none, 6 root docs | **missing** |
| Syllabus in study order (weeks / chapters) | Coursera "Week 1..5", Boot.dev chapters | only inside plan.json | **missing** |
| Clear outcomes per module and per lesson | Coursera "What you'll learn" | checklist at the bottom only | partial |
| Lesson player: sidebar + prev/next + mark complete | Udemy, Educative, Boot.dev | modal popup | **missing** |
| "Continue where you left off" button | every LMS | "Next up" list, below the fold | partial |
| Consistent lesson template | all | yes for 164 Core lessons | **good** |
| Runnable code / in-browser exercises | Boot.dev, Educative | 161 runnable blocks (local) | **good** |
| Quizzes / self-checks | Coursera, freeCodeCamp | self-quiz in every lesson | **good** |
| Projects with rubric | Coursera guided projects, Boot.dev projects | capstone briefs + acceptance checks | good, but duplicated |
| Progress per module + overall | all | portal has it | good |
| Interlinked concepts / visual map | roadmap.sh | IDs only, no links, no map | **missing** |
| Environment setup guide | Frontend Masters "course setup" | none | **missing** |
| Gamification (XP, streak, badges) | Duolingo, Boot.dev | yes, a lot | over-built for day 1 |

**Takeaway:** we score well on the hard part (content, exercises, quizzes, projects) and
badly on the cheap part (front door, syllabus, navigation). The fix is mostly structure,
not rewriting lessons.

---

## 4. Target experience (what "easy to use" means)

From a cold start, in under 2 minutes, you should be able to:

1. Open **one** file (`START_HERE.md`) or the portal and see: what this course is,
   how long, what you'll have at the end, and a big **"Start Week 1"** link.
2. See the **syllabus in study order** (Week/Checkpoint -> lessons), each a clickable link.
3. Open a lesson and see at the top: *you'll learn / before this / time / type*,
   and at the bottom: **Next lesson ->**.
4. In the portal: **Continue** -> lesson page with sidebar + prev/next + "Mark complete"
   at the end. XP/streak exist but stay out of the way.

---

## 5. The plan (recommended approach)

**Approach: keep every lesson and every folder name; add a navigation layer on top,
generated by `plan.py`.** Renaming folders into study order would break the topic ids
(`M06-13`), progress.json, and the portal -- and the fast and slow tracks use different
orders anyway, so no single folder order can be right. A generated syllabus can.

Each phase is small and usable on its own. One phase per session.

### Phase 1 -- Front door + cleanup (~1 session) [DONE 2026-10-12]

Done: `START_HERE.md` added; 5 old docs moved to `_reference/` with banners (plan.py paths
updated, plan.json verified unchanged); 11 out-of-plan stubs marked "skip"; every M15/M16
lesson and every `Projects/` brief got a LEARN/BUILD line linking to its partner; both
project READMEs got a "Learn vs build" table. 121 relative links checked, 0 broken.
Known gap: links inside a lesson do not work in the portal's popup reader yet (Phase 4).

- `START_HERE.md` (new, the ONLY entry point): what an FDE is in 5 lines, what you build
  (OmniGuard, AuditMesh), time (slow 5 months ~16 h/wk), how a study session works
  (read -> run code -> do exercise -> tick checklist -> next), lesson-type legend
  (Diagnostic / Core / Extended / Capstone brief), and "Week 1 starts here ->".
- Move outdated docs into `_reference/`: `PLAN.md`, `PROMPTS.md`, `USING_CLAUDE_MAX.md`,
  `curriculum.md`, `RESOURCES.md` -- each gets a one-line banner "superseded by MASTER_PLAN".
- `MASTER_PLAN.md` stays as "the why" (decisions, tracks, rules), not the starting point.
- M17 stubs: mark "not in plan -- skip" in their header (or remove; your call).
- Clarify capstones: rename sense, not paths -- add a line on top of each
  `15/` and `16/` lesson ("LEARN: the consulting skill") and each `Projects/` brief
  ("BUILD: what to ship, acceptance checks"), plus a mapping table in both READMEs.

### Phase 2 -- Generated syllabus (~1 session) [DONE 2026-10-12]

Done: `plan.py` `build()` now also writes `SYLLABUS.md` (slow, 256 steps) and `SYLLABUS-fast.md`
(193 steps): overview table with weeks + gates, then every step numbered and linked, grouped by
checkpoint and module; BUILD steps link to their `Projects/` briefs. Regenerates on portal start
and on "Get latest". plan.json verified unchanged.

- Extend `plan.py` to also write `SYLLABUS.md` (slow track) and `SYLLABUS-fast.md`:
  Month -> Checkpoint -> ordered list of clickable lesson links, with type, hours, and the
  gate at the end of each checkpoint.
- Regenerated whenever the plan changes, so it can never drift from the portal.

### Phase 3 -- Connect the lessons (~1 session, scripted) [DONE 2026-10-12]

Done: `portal/lessonnav.py` (run by plan.build()) updated 252 files: header now reads
`> **Core** | ~1.2 h | Slow: step 077/256, CP4 | Fast: CP3` + `> Before this: [M06-12 title](...)`;
every M06-12 id outside code is a link; slow-track Prev/Next footer under a NAV marker; briefs get
README/Syllabus links. Idempotent (2nd run changes 0 files), 0 code blocks changed, 3600 links, 0 broken.
Skipped on purpose: "By the end you can" -- it would duplicate the checklist already in every lesson.

A script (not hand edits) over all 243 files:
- Replace `M06-12` style ids with real relative markdown links.
- Replace the header line with a readable block:
  `Core lesson | Slow: Week 7 (CP4) | ~1.2 h | Before this: [RRF basics](...)`.
- Add a footer: `<- Previous | Syllabus | Next ->` in study order (slow track).
- Add "By the end you can:" at the top, lifted from the existing checklist.
- `python plan.py --check` verifies every link resolves.

### Phase 4 -- Portal becomes a lesson player (~2 sessions) [DONE 2026-10-12]

Done: new default **Learn** tab (sticky syllabus sidebar, lesson page, Prev/Next, Mark complete
that advances, in-place links, highlight.js + Copy); Continue strip on every tab; tiles + badges
moved to Progress (old Roadmap); popup reader removed; build steps list their briefs (new
`briefs` field in plan.json). Tested in headless Chrome: local + public read-only mode, all tabs,
390px mobile (no horizontal scroll), 0 console errors; progress.json untouched by the test.

- New default tab **Learn**: left sidebar = syllabus in study order with ticks; main area =
  the lesson rendered as a page (not a popup), syntax highlighting + copy button,
  prev/next, and **"Mark complete"** at the end of the lesson (proof field inline).
- Top of every screen: one **Continue: <next lesson>** button.
- Move XP / badges / rest token / quiz log into a **Progress** tab. Today becomes
  "Continue + this week's target + log time".
- Keep data format (`progress.json`) unchanged so nothing already ticked is lost.

### Phase 5 -- Setup + starter repos (~1 session) [DONE 2026-10-13]

Done: `SETUP.md` (steps 001-004 with commands, API-key table by lesson, how to run lesson code,
troubleshooting); `starter/fde-exercises` + `starter/omniguard` (pytest + ruff green, harness-compatible
`omniguard.main:create_app`/`app`); `requirements-lessons.txt` verified: 160/161 runnable blocks pass on
Python 3.14, the 1 failure (M01-06 flaky timing assert) fixed and stress-tested. Standardized the
OmniGuard layout: 15 references to `app/` in M02/M03/M04 now say `omniguard/` (no runnable code touched).
`portal/checklinks.py` added (link checker).

- `SETUP.md`: Python 3.12 + uv/venv, which API keys (and which lessons need them),
  AWS budget alarm, how to run a lesson's code block.
- `starter/` templates: `fde-exercises/` and `omniguard/` skeleton with `pyproject.toml`,
  folder layout the exercises refer to, and one passing test. You still write the real code.

### Phase 6 -- Visual pass, just-in-time (ongoing, one checkpoint ahead) [CP1 + CP2 DONE 2026-10-13]

Done: portal renders Mermaid (mermaid 10.9.1, light/dark); 18 "### Picture it" diagrams (all CP1 + CP2 Core
lessons), each built from that lesson's own story. Headless-Chrome check: all 18 render, 0 errors, scale >= 0.75.
Next: CP3 (M05, 13 Core) when you start CP2. Decided NOT to trim asserts: they are each block's proof that
it works, and editing runnable code for looks is risk without learning value.

- Add one Mermaid diagram per Core lesson (flow / architecture / sequence), for the next
  checkpoint only -- not all 164 at once. The portal reader renders Mermaid.
- Trim code blocks where asserts pile up: keep 3-5 key asserts in the lesson, move the rest
  to a `tests` block you can expand.

### Out of scope (deliberately)

- Rewriting lesson content. It is good; the problem is navigation.
- New gamification features.
- Changing the curriculum / tracks / topic tiers.

---

## 6. While the fix is being built: what to do TODAY

Your start date is today (2026-10-12), slow track, Checkpoint 1 (~25 h):

1. **Setup (1.25 h):** SET-1 create GitHub repos `fde-exercises`, `omniguard`, `auditmesh`;
   SET-2 Python 3.12 env + pytest + one passing test; SET-3 API keys in a gitignored `.env`;
   M03-13 AWS budget alarm (`03 - Cloud Fundamentals & Networking/13 - ...`).
2. **Diagnostic (2 h):** the 8 files in `00 - Prerequisites/`. Answer the self-test,
   run the code. Pass = move on; fail = do the 30-min plan in that file.
3. **Then `01 - Python & Linux Foundations/` in file order 01 -> 15** (this module IS in order).

Phases 1-2 will be done long before you finish Module 01.
