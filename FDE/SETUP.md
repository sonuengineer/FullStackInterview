# SETUP -- everything you install before (and while) studying

Covers syllabus steps **001-004** (CP1 setup) plus what comes later.
Time: ~2 hours once. Back to [START_HERE.md](START_HERE.md) | [SYLLABUS.md](SYLLABUS.md#cp1).

---

## 1. What you need, and when

| Thing | Needed from | Cost |
|---|---|---|
| Python 3.12+, Git, VS Code, GitHub account | CP1 (now) | free |
| 3 GitHub repos: `fde-exercises`, `omniguard`, `auditmesh` | CP1 (now) | free |
| AWS account + **budget alarm** | CP1 (now -- the alarm comes before any resource) | free tier |
| LLM API key (Anthropic or OpenAI) | **CP3** (Module 05) | pay-as-you-go, a few dollars for the whole course if you are careful |
| Reranker key (Cohere or Voyage) | CP4, one lesson (M06-16) | free tier |
| Docker Desktop | CP6 (Module 04) | free |
| Graph DB (Neo4j AuraDB free) | CP5, slow track only | free |

You do **not** need any API key to run lesson code: every `# runnable` block uses a fake LLM.
Keys are only for each lesson's optional "real version".

---

## 2. Python

- Lesson code is tested with the packages in
  [starter/fde-exercises/requirements-lessons.txt](starter/fde-exercises/requirements-lessons.txt):
  **160 of 161 runnable blocks pass on Python 3.14** (the last one was a flaky timing check, now fixed).
- **Recommended: Python 3.12** for the course venvs. Heavy AI libraries used later
  (NeMo Guardrails, Presidio/spaCy) usually take a while to support the newest Python.
  With [uv](https://docs.astral.sh/uv/): `uv python install 3.12`, then `uv venv --python 3.12`.
  Without uv: install 3.12 from python.org next to your current Python.

---

## 3. Step 001 -- create the 3 repos (~30 min)

Starter files are in [starter/](starter/README.md). **Copy them out of this course folder** -- each repo
lives on its own, not inside FullStackInterview.

```bash
mkdir -p /h/code && cd /h/code                      # any folder outside FDE/
cp -r "/h/New folder (2)/FDE/starter/fde-exercises" .
cp -r "/h/New folder (2)/FDE/starter/omniguard" .
mkdir auditmesh && echo "# AuditMesh -- built in CP9" > auditmesh/README.md

for r in fde-exercises omniguard auditmesh; do
  (cd $r && git init -q && git add . && git commit -qm "Initial commit from starter" && \
   gh repo create $r --public --source . --push)
done
```

- Public is better for the portfolio (OmniGuard and AuditMesh are what hiring managers open).
  No `gh` CLI? Create the repos on github.com and `git remote add origin ... && git push -u origin main`.
- How lesson paths like `omniguard/sql/guard.py` map to files: see the table in
  [starter/README.md](starter/README.md). Short version: Python code goes in the `omniguard/` package,
  everything else (docs, tests, config, infra) at the repo root.

**Mark complete with:** the 3 repo URLs.

---

## 4. Step 002 -- venv + pytest + ruff (~30 min)

```bash
cd /h/code/fde-exercises
python -m venv .venv
source .venv/Scripts/activate          # Git Bash.  PowerShell: .venv\Scripts\Activate.ps1
pip install -r requirements-lessons.txt
pytest                                 # 1 passed
ruff check .                           # All checks passed!
```

OmniGuard has its own venv (you start using it in CP2):

```bash
cd /h/code/omniguard
python -m venv .venv && source .venv/Scripts/activate
pip install -e ".[dev]"
pytest                                 # 1 passed, coverage 100%
uvicorn omniguard.main:app --reload    # open http://127.0.0.1:8000/health
```

**Mark complete with:** commit hash of the green test run (or "1 passed").

---

## 5. Step 003 -- API keys in a gitignored `.env` (~15 min)

```bash
cd /h/code/fde-exercises
cp .env.example .env                   # then paste your key(s) into .env
git status                             # .env must NOT appear -- .gitignore already lists it
```

If you don't have a key yet: still create `.env` (empty values) and do the `git status` check.
You need a real key at CP3. Which lessons use one:

| Key | Lessons (slow-track checkpoint) |
|---|---|
| `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` | CP3: all of M05 (13 lessons). CP4: M06-10, M14-05..08. CP5: M17-09. CP7: M11-14. CP8: M13-02, M15-08. CP9: M09-01..04, M09-07, M10-05, M10-06, M10-08, M10-12 |
| `OPENAI_API_KEY` (embeddings) -- or the free local sentence-transformers model | CP4: M06-03 |
| `COHERE_API_KEY` or `VOYAGE_API_KEY` | CP4: M06-16 (reranker) |

Rules: never paste a key into code, a notebook, a commit or a chat. Rotate it if it ever shows in `git status`.
Set a monthly spend limit in the provider console on day 1.

**Mark complete with:** "`.env` created, git status clean".

---

## 6. Step 004 -- AWS budget alarm (~1.2 h)

This one is a real lesson: [Setting automated budget thresholds](<03 - Cloud Fundamentals & Networking/13 - Setting automated budget thresholds.md>).
Create the AWS account, turn on MFA for the root user, and set a budget alarm (for example $5/month)
**before** you create any resource.

---

## 7. How to run a lesson's code

1. Every lesson has one block that starts with `# runnable`. Copy it into a file in `fde-exercises`,
   named after the lesson, e.g. `m01_event_loop/demo.py`.
2. Run it with the venv active: `python m01_event_loop/demo.py`. All asserts pass and it prints an OK line.
3. Then do the lesson's **Mini-exercise** in the same folder -- that is the real work.
4. A grey line "Needs API key for the real version" means: the block runs without a key (fake LLM);
   the key is only for trying the real provider afterwards.

---

## 8. Troubleshooting

| Problem | Fix |
|---|---|
| `ModuleNotFoundError: No module named 'fastapi'` (or yaml, sqlalchemy...) | venv not active, or `pip install -r requirements-lessons.txt` not run |
| `StarletteDeprecationWarning: Using httpx with starlette.testclient is deprecated` | harmless warning from the newest FastAPI; tests still pass |
| A timing assert fails once (async lessons) | your PC was busy; run it again. If it fails every time, ask Claude |
| Portal: "Port 8766 is busy" | the portal is already running -- it just opens the browser |
| A lesson needs a library not in requirements (langgraph, mcp, presidio, neo4j...) | install it then: `pip install <name>` -- those are added just in time on purpose |
