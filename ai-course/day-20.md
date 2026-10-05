# Day 20 -- AI Agent Deployment

**Module:** 05 -- Deployment and Capstone
**Time:** about 1 hour, probably more
**Builds on:** Day 18 -- the research pipeline; Day 15 -- observability and limits

---

## 1. Today in one line

Your agent becomes a service other people can use -- and Node finally arrives, nineteen days after you made that empty folder.

---

## 2. The problem

Everything you have built runs in your terminal, on your laptop, when you type `python`.

Nobody else can use it. Close the lid and it stops. Your API key is in a file on your disk. There is no way to see a past report. If you wanted to show someone, you would have to install Python on their machine.

And an agent service has a problem normal web services do not.

**Your research pipeline takes two to four minutes.** A normal HTTP request finishes in milliseconds. If you hold the connection open for four minutes, something in the middle -- a proxy, a load balancer, a browser -- closes it first. The user sees an error and the work is lost.

This is the central design problem of deploying agents, and it has a standard answer: **do not make the user wait on the request.** Start the work, hand back a ticket, let them ask about it.

You will also meet a specific trap today that catches nearly everyone deploying Python AI code: your agent functions are **synchronous**, and putting synchronous code in an async web server freezes the whole server for every other user. It is in the traps section and it is worth reading before you write anything.

---

## 3. Mental model

**A workshop versus a shop.**

The workshop has your tools everywhere and one person who knows how it all works. The shop has a counter, opening hours, prices, and a way to hand someone their order.

Same work. Completely different arrangement, because someone else is now involved.

**Where this comparison breaks, in three ways that shape today:**

**Orders take minutes, not seconds.** So you need a ticket system -- a receipt with a number, and a way to check on it.

**Every order costs you money.** A chat message is a fraction of a rupee. A research report is not. Without per-user limits, one person can spend your entire quota in an afternoon, by accident.

**You cannot watch the counter.** Day 15's logging stops being good practice and becomes the only way you will ever know what happened.

---

## 4. How it really works

**The shape**

```
Browser  ->  Node (dashboard)  ->  Python (FastAPI)  ->  your agent
```

Node serves the pages and talks to the user. Python does the AI. They speak HTTP. Exactly what was described on the day you made those two folders.

**Two kinds of endpoint**

**Fast** -- a chat message, a few seconds. Answer on the request.

**Slow** -- a research report, minutes. Job pattern:

```
POST /research   -> {"job_id": "abc123", "status": "queued"}
GET  /jobs/abc123 -> {"status": "running", "step": "gathering sources"}
GET  /jobs/abc123 -> {"status": "done", "report": {...}}
```

The user gets a ticket immediately. The dashboard polls, or listens to a stream.

**Streaming**

Polling works and feels dead. **Server-Sent Events** keeps one connection open and pushes progress as it happens -- "planning", "3 sub-questions", "gathering", "writing". A four-minute wait with visible progress is tolerable; four minutes of a spinner is not.

**Auth and budget**

An API key per user in a header. From that key you get a user id, and from the user id you get their daily budget. Day 15's cost tracking becomes an enforced limit rather than a report.

**Config**

Everything that differs between your laptop and a server comes from environment variables. No secrets in code, none in the container image.

---

## 5. Setup

```bash
cd research-assistant/ai
source venv/bin/activate

pip install "fastapi[standard]" uvicorn
pip freeze > requirements.txt

touch api.py

cd ../dashboard
npm init -y
npm install express node-fetch
mkdir public
touch server.js public/index.html
```

That is nineteen days of an empty folder, finally used.

---

## 6. Build it

---

### Stage 1 -- The service

`ai/api.py`:

```python
import os, json, uuid, time, threading
from typing import Optional
from fastapi import FastAPI, Header, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from research.pipeline import research
from observability import new_trace, LOG_FILE

app = FastAPI(title="Research Agent")

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("ALLOWED_ORIGINS", "http://localhost:3000").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)

JOBS = {}
JOBS_LOCK = threading.Lock()

API_KEYS = {
    os.environ.get("DEMO_KEY", "demo-key-change-me"): {
        "user": "demo", "daily_usd": 1.00
    }
}
SPEND = {}


def authenticate(x_api_key: Optional[str] = Header(None)):
    if x_api_key not in API_KEYS:
        raise HTTPException(401, "Invalid or missing API key")

    account = API_KEYS[x_api_key]
    today = time.strftime("%Y-%m-%d")
    spent = SPEND.get((account["user"], today), 0)

    if spent >= account["daily_usd"]:
        raise HTTPException(429, f"Daily budget of ${account['daily_usd']} used up")

    return account


class ResearchRequest(BaseModel):
    question: str


@app.get("/health")
def health():
    with JOBS_LOCK:
        active = sum(1 for j in JOBS.values() if j["status"] == "running")
    return {"ok": True, "active_jobs": active}


@app.post("/research")
def start_research(body: ResearchRequest,
                   background: BackgroundTasks,
                   x_api_key: Optional[str] = Header(None)):
    account = authenticate(x_api_key)

    if len(body.question) > 500:
        raise HTTPException(400, "Question too long")

    job_id = uuid.uuid4().hex[:10]
    with JOBS_LOCK:
        JOBS[job_id] = {"status": "queued", "step": "waiting",
                        "user": account["user"], "created": time.time()}

    background.add_task(do_research, job_id, body.question, account["user"])
    return {"job_id": job_id, "status": "queued"}


def estimate_cost(result):
    """What this job cost, in USD: sum the logged cost of its model calls."""
    trace = result.get("trace")
    if not trace:
        return 0.0

    total = 0.0
    try:
        with open(LOG_FILE) as f:
            for line in f:
                row = json.loads(line)
                if row.get("trace") == trace:
                    total += row.get("usd", 0.0)
    except (FileNotFoundError, ValueError):
        return 0.0
    return round(total, 6)


def do_research(job_id, question, user):
    def update(**fields):
        with JOBS_LOCK:
            JOBS[job_id].update(fields)

    update(status="running", step="planning")
    try:
        result = research(question)
        update(status="done", step="finished", result=result)

        today = time.strftime("%Y-%m-%d")
        SPEND[(user, today)] = SPEND.get((user, today), 0) + estimate_cost(result)
    except Exception as error:
        update(status="failed", error=str(error)[:300])


@app.get("/jobs/{job_id}")
def job_status(job_id: str, x_api_key: Optional[str] = Header(None)):
    account = authenticate(x_api_key)

    with JOBS_LOCK:
        job = JOBS.get(job_id)

    if not job:
        raise HTTPException(404, "No such job")
    if job["user"] != account["user"]:
        raise HTTPException(403, "Not your job")

    return {k: v for k, v in job.items() if k != "user"}
```

Run it:

```bash
uvicorn api:app --reload --port 8000
```

Open `http://localhost:8000/docs`. FastAPI generates a full interactive page from your type hints. Try an endpoint from there.

**Five things worth noticing.**

**`def`, not `async def`.** This is the trap from section 2. Your `research()` function is synchronous and takes minutes. In an `async def` endpoint it would block the entire event loop and freeze the server for every other user. Declared as plain `def`, FastAPI runs it in a thread pool automatically. **Get this wrong and your server appears to work perfectly with one user and collapses with two.**

**`JOBS_LOCK`.** Background tasks run in threads, so a plain dict update can race. A lock here costs nothing and prevents a bug that appears only under load.

**The ownership check** on `/jobs/{job_id}`. Without it, anyone with any valid key can read anyone's report by guessing an id. Job ids are not secrets.

**Budget checked before starting, spend recorded after.** Not perfect -- a single very expensive job can overshoot -- but it stops the runaway case.

**`estimate_cost` is Day 15's log, read back.** You are not inventing a new number. Every model call already writes a line to `logs/calls.jsonl` with its `trace` and its `usd`, computed from `PRICING` by `cost_of()`. A job's cost is just the sum of the rows carrying that job's trace id, and `research()` already returns its `trace`. That is the whole function.

Three honest limits, worth saying out loud:

- It only counts what `tracked_call` logged. Embeddings run locally and cost nothing, but a paid embedding API or a reranker you forgot to wrap would be invisible here. **A cost meter is only as complete as your instrumentation.**
- Pricing in `PRICING` is a copy of someone's rate card at a point in time. It drifts. This is an *estimate*, which is why the function is not called `exact_cost`.
- Re-reading the whole JSONL for every job is fine at demo scale and bad later. When the file gets big, either keep a running per-trace total in memory as calls are logged, or put the rows in the SQLite store from Stage 5.

It is also worth checking: run one job, note the number, and compare it against `report()` from Day 15 for the same trace. If they disagree, something is calling the model outside `tracked_call`.

---

### Stage 2 -- Stream the progress

Polling every two seconds works. This feels alive:

```python
import json, asyncio
from fastapi.responses import StreamingResponse


@app.get("/jobs/{job_id}/stream")
async def stream_job(job_id: str, x_api_key: Optional[str] = Header(None)):
    account = authenticate(x_api_key)

    async def events():
        last = None
        for _ in range(300):                     # 5 minute ceiling
            with JOBS_LOCK:
                job = dict(JOBS.get(job_id, {}))

            if not job:
                yield f"data: {json.dumps({'status': 'missing'})}\n\n"
                return
            if job.get("user") != account["user"]:
                yield f"data: {json.dumps({'status': 'forbidden'})}\n\n"
                return

            snapshot = {"status": job["status"], "step": job.get("step")}
            if snapshot != last:
                payload = dict(snapshot)
                if job["status"] == "done":
                    payload["result"] = job["result"]
                if job["status"] == "failed":
                    payload["error"] = job.get("error")
                yield f"data: {json.dumps(payload)}\n\n"
                last = snapshot

            if job["status"] in ("done", "failed"):
                return

            await asyncio.sleep(1)

    return StreamingResponse(events(), media_type="text/event-stream")
```

**The SSE format is exactly this:** `data: ` then JSON then two newlines. That is the whole protocol. Browsers have `EventSource` built in, so the client side is four lines.

**This one IS `async def`**, because it only sleeps and reads a dict. Async is right for waiting; threads are right for work.

Make `do_research` report real progress, so there is something to stream:

```python
    update(status="running", step="planning")
    plan_result = plan(question)
    update(step=f"{len(plan_result['sub_questions'])} sub-questions, gathering")
    ...
    update(step="writing the report")
```

**This is the difference between a usable product and a frustrating one.** The work takes the same four minutes either way.

---

### Stage 3 -- The Node dashboard

`dashboard/server.js`:

```javascript
const express = require("express");
const app = express();

const AI_URL = process.env.AI_URL || "http://localhost:8000";
const AI_KEY = process.env.AI_KEY || "demo-key-change-me";

app.use(express.json());
app.use(express.static("public"));

// Node holds the key. The browser never sees it.
app.post("/api/research", async (req, res) => {
  try {
    const upstream = await fetch(`${AI_URL}/research`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": AI_KEY },
      body: JSON.stringify({ question: req.body.question }),
    });
    res.status(upstream.status).json(await upstream.json());
  } catch (error) {
    res.status(502).json({ error: "The AI service is not reachable." });
  }
});

app.get("/api/jobs/:id", async (req, res) => {
  try {
    const upstream = await fetch(`${AI_URL}/jobs/${req.params.id}`, {
      headers: { "X-API-Key": AI_KEY },
    });
    res.status(upstream.status).json(await upstream.json());
  } catch (error) {
    res.status(502).json({ error: "The AI service is not reachable." });
  }
});

app.listen(3000, () => console.log("Dashboard on http://localhost:3000"));
```

**Node is a proxy, and that is the point.** The API key lives on the server. If the browser called Python directly, the key would be in the page source and anyone could take it.

This also removes the CORS problem entirely -- the browser only ever talks to its own origin.

`dashboard/public/index.html`:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Research Agent</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 750px; margin: 40px auto;
           padding: 0 20px; line-height: 1.6; background: #14181c; color: #e6e9ec; }
    textarea { width: 100%; padding: 12px; font: inherit; background: #1d2329;
               color: inherit; border: 1px solid #2f3942; border-radius: 6px; }
    button { padding: 10px 22px; font: inherit; background: #2f7d5d; color: white;
             border: 0; border-radius: 6px; cursor: pointer; margin-top: 10px; }
    button:disabled { opacity: .5; cursor: default; }
    #status { color: #9aa6b1; margin: 20px 0; }
    #report { white-space: pre-wrap; background: #1d2329; padding: 20px;
              border-radius: 8px; }
    .sources { font-size: .85em; color: #9aa6b1; margin-top: 20px; }
    .warn { color: #d98b4a; }
  </style>
</head>
<body>
  <h1>Research Agent</h1>
  <textarea id="q" rows="3" placeholder="What would you like researched?"></textarea>
  <button id="go">Research</button>
  <div id="status"></div>
  <div id="report"></div>
  <div class="sources" id="sources"></div>

<script>
const go = document.getElementById("go");
const status = document.getElementById("status");
const report = document.getElementById("report");
const sources = document.getElementById("sources");

go.onclick = async () => {
  const question = document.getElementById("q").value.trim();
  if (!question) return;

  go.disabled = true;
  report.textContent = "";
  sources.textContent = "";
  status.textContent = "Starting...";

  const started = await fetch("/api/research", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  }).then(r => r.json());

  if (!started.job_id) {
    status.textContent = "Error: " + (started.detail || started.error);
    go.disabled = false;
    return;
  }

  const poll = setInterval(async () => {
    const job = await fetch("/api/jobs/" + started.job_id).then(r => r.json());
    status.textContent = job.step || job.status;

    if (job.status === "done") {
      clearInterval(poll);
      go.disabled = false;
      const result = job.result;
      status.textContent = `Finished in ${result.seconds}s`;
      report.textContent = result.report;

      const bad = result.citations.fabricated;
      sources.innerHTML =
        `<b>${result.sources.length} sources</b><br>` +
        result.sources.map(s => `[${s.id}] ${s.source}`).join("<br>") +
        (bad.length ? `<br><span class="warn">Unverified citations: ${bad.join(", ")}</span>` : "") +
        (result.failed_sources.length ? `<br><span class="warn">Unavailable: ${result.failed_sources.join(", ")}</span>` : "");
    }

    if (job.status === "failed") {
      clearInterval(poll);
      go.disabled = false;
      status.textContent = "Failed: " + job.error;
    }
  }, 2000);
};
</script>
</body>
</html>
```

Run both:

```bash
# terminal 1
cd ai && uvicorn api:app --port 8000

# terminal 2
cd dashboard && node server.js
```

Open `http://localhost:3000` and research something.

**Look at what the page shows underneath the report:** the source list, any unverified citations, and any source that was unavailable. Day 18's verification, surfaced to the person reading. A product that shows its own uncertainty is a more honest one than a product that does not.

---

### Stage 4 -- Survive a restart

`JOBS` is a dict in memory. Restart and everyone's work vanishes.

```python
import sqlite3, json

DB = "jobs.db"

def init_db():
    with sqlite3.connect(DB) as db:
        db.execute("""CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY, user TEXT, status TEXT, step TEXT,
            question TEXT, result TEXT, error TEXT, created REAL)""")

def save_job(job_id, **fields):
    with sqlite3.connect(DB) as db:
        existing = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if existing:
            sets = ", ".join(f"{k}=?" for k in fields)
            db.execute(f"UPDATE jobs SET {sets} WHERE id=?",
                       (*[json.dumps(v) if k == "result" else v
                          for k, v in fields.items()], job_id))
        else:
            db.execute("INSERT INTO jobs (id, user, status, step, question, created) "
                       "VALUES (?,?,?,?,?,?)",
                       (job_id, fields.get("user"), fields.get("status"),
                        fields.get("step"), fields.get("question"), time.time()))
```

**On startup, mark anything still `running` as `failed`** -- those jobs died with the old process and will never finish:

```python
@app.on_event("startup")
def on_start():
    init_db()
    with sqlite3.connect(DB) as db:
        db.execute("UPDATE jobs SET status='failed', error='Server restarted' "
                   "WHERE status IN ('queued','running')")
```

Without that, a user polls a job that is never going to move, forever.

Now add `/history`, which is what makes it feel like a product rather than a demo:

```python
@app.get("/history")
def history(x_api_key: Optional[str] = Header(None)):
    account = authenticate(x_api_key)
    with sqlite3.connect(DB) as db:
        rows = db.execute(
            "SELECT id, question, status, created FROM jobs WHERE user=? "
            "ORDER BY created DESC LIMIT 20", (account["user"],)).fetchall()
    return [{"id": r[0], "question": r[1], "status": r[2], "created": r[3]} for r in rows]
```

---

### Stage 5 -- Package it

`ai/Dockerfile`:

```dockerfile
FROM python:3.12-slim

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends gcc \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PYTHONUNBUFFERED=1
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"

CMD ["uvicorn", "api:app", "--host", "0.0.0.0", "--port", "8000"]
```

`.dockerignore`:

```
.env
venv/
venv-crew/
chroma_db/
logs/
runs/
__pycache__/
*.db
```

**`.env` in `.dockerignore` is not optional.** Copy your key into an image and it is in the image forever, in every layer, on every registry it is ever pushed to. Keys go in at run time:

```bash
docker run -e GROQ_API_KEY=$GROQ_API_KEY -e DEMO_KEY=$DEMO_KEY -p 8000:8000 research-agent
```

**One thing the embeddings model makes awkward.** `sentence-transformers` downloads its model on first use, so your first container request is slow and needs network access. Either bake the model into the image at build time, or mount a cache volume. Find out which before you deploy, not after.

`PYTHONUNBUFFERED=1` makes your logs appear immediately instead of sitting in a buffer -- the single most annoying container problem to debug without it.

---

### Stage 6 -- The pre-deployment checklist

Go through it honestly. Anything unticked is something you will find out about at a bad time.

**Security**
- [ ] No secrets in code, in git, or in the image
- [ ] Every endpoint authenticated
- [ ] Users can only read their own jobs
- [ ] Input length capped
- [ ] CORS restricted to your own origin, not `*`
- [ ] Day 13: write tools disabled or approval-gated in the service

**Cost**
- [ ] Per-user daily budget enforced
- [ ] A hard token and time budget per job
- [ ] Cost per request logged
- [ ] You know what a busy day costs

**Reliability**
- [ ] `/health` exists and is honest
- [ ] Jobs survive a restart
- [ ] Running jobs are marked failed on startup
- [ ] Day 15's fallback model wired in
- [ ] A hanging job cannot run forever

**Operability**
- [ ] Trace id on every request, returned to the client
- [ ] Logs go to stdout
- [ ] No message contents or document text in logs
- [ ] You can answer "what happened to job abc123" from logs alone

**Test it under real conditions:**

```bash
# two at once -- does the server stay responsive?
curl -X POST localhost:8000/research -H "X-API-Key: demo-key-change-me" \
  -H "Content-Type: application/json" -d '{"question":"test one"}' &
curl localhost:8000/health

# no key
curl -X POST localhost:8000/research -H "Content-Type: application/json" \
  -d '{"question":"test"}'

# someone else's job
curl localhost:8000/jobs/abc123 -H "X-API-Key: demo-key-change-me"
```

**The concurrency test is the one that matters.** If `/health` hangs while a research job runs, you used `async def` where you needed `def`, and you have just found the bug that would have taken your service down on its first real day.

---

## 7. Words I heard today

| Word | Plain meaning |
|---|---|
| **ASGI / uvicorn** | The server that runs FastAPI. |
| **Background task** | Work started by a request but not finished during it. |
| **Job pattern** | Return a ticket, do the work, let them check. |
| **Polling** | Asking repeatedly if it is done. |
| **SSE** | Server-Sent Events. One connection, pushed updates. |
| **CORS** | Browser rule about which origins may call your API. |
| **Proxy** | A server that forwards requests. Your Node layer. |
| **Health check** | An endpoint saying whether the service is alive. |
| **Graceful shutdown** | Finishing or recording in-flight work before exiting. |
| **12-factor** | Config from the environment, logs to stdout, no local state. |
| **Event loop blocking** | Sync work in an async handler, freezing everything. |

---

## 8. Break it on purpose

**1. Block the event loop.**
Change `def start_research` to `async def` and call `research()` directly inside it. Then hit `/health` while a job runs.
*You will see:* `/health` hangs. The whole server is frozen.
*It teaches:* **the most important thing today.** It works perfectly with one user.

**2. Restart mid-job.**
Start a job, kill the server, restart, poll the job.
*You will see:* with SQLite and the startup sweep, `failed: Server restarted`. Without, either nothing or a job stuck at `running` forever.
*It teaches:* in-memory state is not state.

**3. Read someone else's report.**
Remove the ownership check and fetch another user's job.
*It teaches:* ids are not secrets.

**4. Spend the budget.**
Set `daily_usd` to 0.01 and run two reports.
*You will see:* a 429 on the second.
*It teaches:* what stands between one user and your whole quota.

**5. Break CORS on purpose.**
Have the browser call `http://localhost:8000` directly.
*You will see:* a CORS error in the console.
*It teaches:* why Node proxies, and where your key would have ended up.

**6. Kill the AI service.**
Stop uvicorn, leave Node running, click Research.
*You will see:* whether you get a clear message or a broken page.
*It teaches:* the dashboard must handle its backend being down.

---

## 9. Traps

**Trap 1 -- `async def` around sync work**
*Symptom:* fine alone, frozen with two users.
*Fix:* plain `def` for endpoints calling sync code. FastAPI thread-pools them.
*This is the most common serious bug in deployed Python AI services.*

**Trap 2 -- holding the request open for minutes**
*Symptom:* gateway timeouts at 30 or 60 seconds, and lost work.
*Fix:* the job pattern.

**Trap 3 -- secrets in the image**
*Symptom:* silent. Then a leaked key.
*Fix:* `.dockerignore`, and inject at run time.

**Trap 4 -- no per-user budget**
*Symptom:* your quota gone in an afternoon.
*Fix:* enforce before starting work.

**Trap 5 -- state in memory**
*Symptom:* every deployment loses in-flight work.
*Fix:* SQLite at minimum, and sweep stale jobs on startup.

**Trap 6 -- logging everything**
*Symptom:* a permanent, growing file of user questions and document text.
*Fix:* Day 15's rule. Ids and counts, not contents.

---

## 10. Check yourself

1. Why can a research endpoint not just do the work and return the answer?
2. Why `def` rather than `async def`, and what exactly goes wrong?
3. Why does Node proxy to Python instead of the browser calling it directly?
4. What must happen to `running` jobs when the server restarts, and why?
5. Name two things that must never appear in your container image.

---

## 11. Where this goes

- **Day 21** is the capstone. This service becomes the platform: user accounts, saved reports, uploads, and the interface built properly.
- Everything from earlier now has a production home. Day 9's budgets are enforced per user. Day 13's permissions decide what a deployed agent may touch. Day 15's logs are the only window you have.
- Tomorrow is mostly assembly and judgement. The hard engineering is behind you.

---

## 12. PROJECT STATE

```
PROJECT STATE after Day 20:

Folders:
  research-assistant/
    ai/
      api.py               (NEW - FastAPI service)
      Dockerfile           (NEW)
      .dockerignore        (NEW - .env, venv, chroma_db, logs, runs, *.db)
      jobs.db              (NEW - SQLite job persistence)
      research/            (pipeline, sources, DECISIONS.md)
      observability.py, evals.py, reliability.py, logs/
      retrieval.py, golden_set.py, vector_store.py, embeddings.py
      documents.py, tools.py, memory.py, security.py
      graph_agent.py, crew_agent.py, multi_agent.py
      chat.py, agent.py, autonomous.py, planner.py
      mcp_agent.py, mcp_client.py, mcp_servers/my_tools.py
      prompts.py, classify.py, test_prompt.py
      runs/, notes/, documents/, chroma_db/
    dashboard/             (NO LONGER EMPTY - 19 days later)
      server.js            (NEW - Express proxy)
      public/index.html    (NEW - the UI)
      package.json

Libraries: fastapi[standard], uvicorn (Python). express, node-fetch (Node).

ARCHITECTURE:
  Browser -> Node :3000 -> Python :8000 -> the agent
  Node is a PROXY. It holds the API key so the browser never sees it, and
  it removes CORS entirely because the browser only calls its own origin.

api.py endpoints:
  GET  /health                 - liveness + active job count
  POST /research               - returns {job_id, status} immediately
  GET  /jobs/{id}              - status, step, and result when done
  GET  /jobs/{id}/stream       - SSE, pushes progress as it changes
  GET  /history                - the user's last 20 jobs

THE MOST IMPORTANT DETAIL:
  endpoints that call research() are declared `def`, NOT `async def`.
  research() is synchronous and takes minutes. In an async handler it
  blocks the event loop and freezes the ENTIRE server for every other
  user. Declared as plain def, FastAPI runs it in a thread pool.
  This works perfectly with one user and collapses with two, which is
  why it is so commonly shipped.
  The SSE endpoint IS async, because it only sleeps and reads a dict.
  Async is right for waiting; threads are right for work.

Other deployment details that matter:
  JOBS_LOCK around the shared jobs dict - background tasks are threads
  ownership check on /jobs/{id} - job ids are not secrets
  budget checked BEFORE starting, spend recorded after
  estimate_cost(result) sums the "usd" of every logs/calls.jsonl row sharing
    the job's trace id - Day 15's log read back, not a new number. Only as
    complete as the instrumentation, and PRICING drifts, so it is an estimate
  input length capped at 500 chars
  CORS restricted to ALLOWED_ORIGINS, never "*"
  on startup, any job left "running" or "queued" is marked failed with
      "Server restarted" - otherwise a user polls forever
  PYTHONUNBUFFERED=1 so container logs appear immediately
  .env in .dockerignore; keys injected at run time with -e
  sentence-transformers downloads its model on first use, so the first
      container request is slow and needs network - bake it in or mount
      a cache volume

The dashboard surfaces Day 18's verification to the reader:
  the source list, any FABRICATED citations, and any source that was
  unavailable. The product shows its own uncertainty.

Pre-deployment checklist completed across security, cost, reliability
and operability (see Day 20 stage 6).

Key decisions made:
  - the job pattern, because agent work takes minutes and HTTP does not
  - Node proxies rather than the browser calling Python
  - SQLite for jobs; in-memory state is not state
  - per-user daily budget enforced, not just measured
  - logs contain ids and counts, never message contents or document text

Known problems, left for Day 21:
  - API keys are a hardcoded dict; no real user accounts
  - no document upload; documents/ is still a local folder
  - the dashboard polls; the SSE endpoint exists but the UI does not use it
  - no rate limit on requests per minute, only daily spend
  - single process; no queue, so many concurrent jobs will exhaust threads
```

---

## Answers

**1.** Because it takes minutes, and HTTP connections held open that long get closed by proxies, load balancers or the browser. The user sees an error and the completed work is lost. The job pattern returns a ticket immediately and lets them check on it.

**2.** Because `research()` is synchronous. Inside an `async def` handler it blocks the event loop, so the entire server -- every endpoint, every other user -- freezes until it finishes. A plain `def` handler is run in a thread pool by FastAPI, leaving the loop free.

**3.** So the API key stays on the server. If the browser called Python directly, the key would be visible in the page source to anyone who looked. It also means the browser only ever talks to its own origin, which removes CORS.

**4.** They must be marked failed. Those jobs died with the old process and will never progress, so a client polling them would wait forever with no explanation.

**5.** The `.env` file, and anything else containing credentials -- plus large local state like `chroma_db`, `logs` and `runs`, which do not belong in an image either. Secrets are injected at run time, never baked in.
