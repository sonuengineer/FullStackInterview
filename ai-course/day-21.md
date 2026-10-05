# Day 21 -- Capstone: Build the Research AI Agent Platform

**Module:** 05 -- Deployment and Capstone
**Time:** longer than an hour. Give it a weekend if you can.
**Builds on:** all twenty days

---

## 1. Today in one line

You turn yesterday's service into something another person could sign into, upload their own documents to, and get a cited report out of -- and then you hand it to someone and watch.

---

## 2. The problem

Yesterday's service works. Here is why it is a demo and not a platform.

**There is one user.** API keys are a dict in the source. Everyone shares one `documents/` folder and one Chroma collection. If two people used it, each would search the other's files.

**Documents arrive by you copying them into a folder.** A user cannot add anything.

**Reports vanish.** You can run one and read it. You cannot come back tomorrow and find it.

**Nothing says what it cannot do.** Someone using this would not know that reports vary between runs, that web search sometimes fails, or that a citation can occasionally be unverified.

That last one matters more than it sounds. A research tool that quietly hides its limits is worse than one that states them, because the user trusts it exactly as much as a tool that deserves trust.

**And there is a trap in today specifically.** The word "platform" invites feature-building. You will want accounts with passwords, teams, sharing, exports, a settings page. Resist it.

> A capstone is judged on being finished, not on being large.

A narrow thing that works completely, with its limits written down, is a far better piece of work -- and a far better thing to show someone -- than a broad thing with six half-features.

---

## 3. Mental model

**A demo is a thing you drive. A product is a thing you hand over.**

When you drive it, you steer around the rough parts without noticing. You know which questions work. You know not to upload a scanned PDF. You know to restart it when it gets stuck.

Hand it to someone else and every one of those becomes a bug report.

**Where this comparison breaks, and it is the useful part:**

A normal product either works or it does not. **Yours is statistical and you cannot make it deterministic.** So "finished" cannot mean "always right". It has to mean:

- it does the narrow thing it claims, most of the time
- when it fails, it fails visibly rather than confidently
- the user can check its working
- and the limits are written down where they will be read

That is a reachable definition of done. "Never wrong" is not, and chasing it is how capstones stay unfinished.

---

## 4. How it really works

**Scope: three versions. Pick the middle one.**

**Minimum (a weekend).** One user, upload documents, run research, see cited reports, keep history. Everything from Day 20 plus upload and persistence.

**The real one (a week).** Multiple users with isolated documents, upload and ingest, streaming progress, saved report history, a visible limitations page, deployed somewhere with a URL.

**Do not attempt.** Real accounts with password reset, teams and sharing, billing, a mobile app, real-time collaboration, fine-tuning. Every one is weeks and none of them demonstrates anything you learned in this course.

**Isolation is the one genuinely new piece of engineering**

Multiple users means every store needs a user boundary:

| Store | How it separates |
|---|---|
| Documents | `uploads/{user_id}/` |
| Vector index | one Chroma collection per user, or a `user` metadata filter |
| Memory | the `user` field you added on Day 11 |
| Jobs | the ownership check from Day 20 |

**The Day 11 decision pays off here.** You put `user` into memory metadata when you had exactly one user, because adding it later means migrating everything. Today it is free.

**Ingestion is a pipeline, not a copy**

```
upload -> validate -> extract text -> chunk -> embed -> index -> confirm
```

Validation is not optional: file type, size cap, and Day 13's content scan. Someone else's document is untrusted input by definition.

**Make it idempotent.** Upload the same file twice and you should get one copy, not two -- Day 6's stable ids, `{user}::{filename}::{chunk}`.

---

## 5. Setup

```bash
cd research-assistant/ai
source venv/bin/activate
pip install python-multipart

mkdir -p uploads
touch users.py ingest.py LIMITATIONS.md README.md
```

`python-multipart` is what lets FastAPI accept file uploads.

---

## 6. Build it

---

### Stage 1 -- Scope it in writing, including what is out

Before any code. `README.md`:

```markdown
# Research Agent Platform

Upload your documents. Ask a research question. Get a report where every
claim carries a source you can check.

## What it does
- Upload PDF, TXT, MD, DOCX (up to 10 MB each, 50 files per user)
- Breaks a question into sub-questions and searches each one
- Searches your documents and the web
- Produces a report with Summary, Findings, Disagreements and Gaps
- Every claim cites a source id, and every id is verified against what was
  actually retrieved
- Keeps your last 50 reports

## What it does NOT do
- No accounts with passwords (API key per user)
- No sharing between users
- No scanned PDFs (no OCR, so image-only PDFs produce nothing)
- No documents in languages other than English (the embedding model)
- No editing or re-running a report
- Reports are not reproducible: the same question twice gives different
  emphasis

## Known limits
See LIMITATIONS.md.

## Why it is built this way
See research/DECISIONS.md.
```

**Write the "does NOT" section before you build.** It is what stops the scope creeping, and it is the section someone reading your work will respect most.

---

### Stage 2 -- Users and isolation

`ai/users.py`:

```python
import os, json, secrets, hashlib

USERS_FILE = "users.json"
DEFAULT_BUDGET = 1.00


def _load():
    return json.load(open(USERS_FILE)) if os.path.exists(USERS_FILE) else {}


def _save(users):
    with open(USERS_FILE, "w") as f:
        json.dump(users, f, indent=2)


def create_user(name):
    users = _load()
    key = "ra_" + secrets.token_urlsafe(24)
    user_id = hashlib.sha256(key.encode()).hexdigest()[:12]

    users[key] = {"user_id": user_id, "name": name, "daily_usd": DEFAULT_BUDGET}
    _save(users)

    os.makedirs(f"uploads/{user_id}", exist_ok=True)
    return key, user_id


def lookup(key):
    return _load().get(key)


def user_paths(user_id):
    return {
        "uploads": f"uploads/{user_id}",
        "collection": f"docs_{user_id}",
    }
```

Then make retrieval user-aware. In `vector_store.py`:

```python
def get_collection(user_id):
    return chroma.get_or_create_collection(
        name=f"docs_{user_id}",
        embedding_function=embedder
    )


def search(question, user_id, top_n=3):
    collection = get_collection(user_id)
    if collection.count() == 0:
        return []
    ...
```

**Then thread `user_id` all the way down** -- `sources.py`, `pipeline.py`, `research()`. It is tedious, mechanical, and the single most important correctness change in the whole capstone.

**Test it immediately and properly:**

```python
key_a, user_a = create_user("Alice")
key_b, user_b = create_user("Bob")
# upload a document containing "PINEAPPLE" as Alice only
# search for "pineapple" as Bob -> must return nothing
```

**If Bob can see Alice's documents, nothing else you build today matters.** Do this test before moving on, and do it again at the end.

**Note what `create_user` does with the key.** It stores the key as the lookup and derives the user id from a hash of it. That is simple and it works; it is not how a real system stores credentials, and your README already says there are no real accounts. Being clear about that is better than pretending.

---

### Stage 3 -- Upload and ingest

`ai/ingest.py`:

```python
import os, hashlib
from langchain_community.document_loaders import PyPDFLoader, TextLoader, Docx2txtLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from vector_store import get_collection
from security import scan

MAX_BYTES = 10 * 1024 * 1024
MAX_FILES = 50
ALLOWED = {".pdf", ".txt", ".md", ".docx"}

splitter = RecursiveCharacterTextSplitter(
    chunk_size=1000, chunk_overlap=150,
    separators=["\n\n", "\n", ". ", " ", ""])


def validate(filename, size, user_id):
    extension = os.path.splitext(filename)[1].lower()
    if extension not in ALLOWED:
        return f"Cannot read {extension} files."
    if size > MAX_BYTES:
        return f"Too large. Limit is {MAX_BYTES // 1024 // 1024} MB."

    folder = f"uploads/{user_id}"
    if os.path.isdir(folder) and len(os.listdir(folder)) >= MAX_FILES:
        return f"You have reached the limit of {MAX_FILES} files."
    return None


def ingest(path, filename, user_id):
    extension = os.path.splitext(filename)[1].lower()

    if extension == ".pdf":
        documents = PyPDFLoader(path).load()
    elif extension == ".docx":
        documents = Docx2txtLoader(path).load()
    else:
        documents = TextLoader(path, encoding="utf-8").load()

    text = "\n".join(d.page_content for d in documents)
    if len(text.strip()) < 50:
        return {"ok": False, "error":
                "No readable text found. Scanned PDFs are not supported."}

    flags = scan(text)

    chunks = splitter.split_documents(documents)
    collection = get_collection(user_id)

    ids, texts, metadatas = [], [], []
    for index, chunk in enumerate(chunks):
        ids.append(f"{filename}::{index}")
        texts.append(chunk.page_content)
        metadatas.append({
            "source": filename,
            "page": chunk.metadata.get("page", 0),
            "flagged": bool(flags),
        })

    collection.upsert(ids=ids, documents=texts, metadatas=metadatas)

    return {"ok": True, "chunks": len(chunks),
            "flagged": flags[:3] if flags else None}
```

The endpoint, in `api.py`:

```python
from fastapi import UploadFile, File

@app.post("/documents")
def upload(file: UploadFile = File(...), x_api_key: str = Header(None)):
    account = authenticate(x_api_key)
    user_id = account["user_id"]

    contents = file.file.read()
    problem = validate(file.filename, len(contents), user_id)
    if problem:
        raise HTTPException(400, problem)

    safe_name = os.path.basename(file.filename)
    path = os.path.join("uploads", user_id, safe_name)
    with open(path, "wb") as f:
        f.write(contents)

    result = ingest(path, safe_name, user_id)
    if not result["ok"]:
        os.remove(path)
        raise HTTPException(400, result["error"])

    return {"filename": safe_name, "chunks": result["chunks"],
            "flagged": result["flagged"]}


@app.get("/documents")
def list_documents(x_api_key: str = Header(None)):
    account = authenticate(x_api_key)
    folder = f"uploads/{account['user_id']}"
    if not os.path.isdir(folder):
        return []
    return [{"filename": n, "bytes": os.path.getsize(os.path.join(folder, n))}
            for n in sorted(os.listdir(folder))]


@app.delete("/documents/{filename}")
def delete_document(filename: str, x_api_key: str = Header(None)):
    account = authenticate(x_api_key)
    safe = os.path.basename(filename)
    path = os.path.join("uploads", account["user_id"], safe)

    if os.path.exists(path):
        os.remove(path)

    collection = get_collection(account["user_id"])
    existing = collection.get(where={"source": safe})
    if existing["ids"]:
        collection.delete(ids=existing["ids"])

    return {"deleted": safe}
```

**Four things worth noting.**

**`os.path.basename` on the filename.** Day 13. An upload named `../../../etc/passwd` is a request, not an accident.

**Ids are `filename::index`**, so re-uploading replaces rather than duplicates. Idempotent ingest.

**Delete removes the chunks too.** A user deleting a document and still getting it in results is a real failure -- and an important one, because it is also the mechanism by which someone can withdraw data they did not mean to share.

**Flagged content is recorded, not blocked.** Day 13's scanner catches lazy injections. Blocking on it would reject legitimate documents that happen to discuss prompt injection. Recording lets you show the user a warning.

---

### Stage 4 -- The dashboard, properly

Extend `dashboard/public/index.html` to three panels: documents, ask, history. The key part is switching from polling to the SSE endpoint you built yesterday and never used:

```javascript
function runResearch(question) {
  fetch("/api/research", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  })
  .then(r => r.json())
  .then(started => {
    if (!started.job_id) { showError(started.detail); return; }

    const stream = new EventSource("/api/jobs/" + started.job_id + "/stream");

    stream.onmessage = (event) => {
      const update = JSON.parse(event.data);
      setStatus(update.step || update.status);

      if (update.status === "done") {
        stream.close();
        renderReport(update.result);
        loadHistory();
      }
      if (update.status === "failed") {
        stream.close();
        showError(update.error);
      }
    };

    stream.onerror = () => {
      stream.close();
      setStatus("Connection lost. Checking...");
      pollOnce(started.job_id);       // fall back to polling
    };
  });
}
```

Add the SSE proxy in `server.js`:

```javascript
app.get("/api/jobs/:id/stream", async (req, res) => {
  const upstream = await fetch(`${AI_URL}/jobs/${req.params.id}/stream`, {
    headers: { "X-API-Key": AI_KEY },
  });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");

  upstream.body.pipe(res);
});
```

**`X-Accel-Buffering: no` is a small line that saves an afternoon.** Some proxies buffer responses, so your events all arrive at once at the end -- which looks exactly like SSE not working at all.

**And `stream.onerror` falling back to polling.** SSE connections drop. A product that breaks permanently on one dropped connection is not finished.

**Render the report with its uncertainty visible:**

```javascript
function renderReport(result) {
  document.getElementById("report").textContent = result.report;

  const warnings = [];
  if (result.citations.fabricated.length)
    warnings.push(`${result.citations.fabricated.length} citations could not be verified`);
  if (result.failed_sources.length)
    warnings.push(`Unavailable sources: ${result.failed_sources.join(", ")}`);
  if (result.citations.sources_used < 2)
    warnings.push("This report relies on very few sources");

  document.getElementById("warnings").innerHTML =
    warnings.map(w => `<div class="warn">${w}</div>`).join("");
}
```

**That third warning is the one to be proud of.** A report citing one source looks exactly as confident as a report citing twelve. Saying so is the whole difference between a research tool and a generator of plausible text.

---

### Stage 5 -- Measure the finished thing

Run the whole system end to end, as a user would.

```python
# evals.py, extended to hit the HTTP API
import requests

def eval_via_api(key, questions):
    results = []
    for q in questions:
        started = requests.post("http://localhost:8000/research",
                                json={"question": q},
                                headers={"X-API-Key": key}).json()
        # poll until done, then check
        ...
    return results
```

Then produce the numbers that describe your product:

```
Reports run:            20
Completed:              18/20   (90%)
Failed:                  2/20   (both: web search unavailable)
Fabricated citations:    0/18
Single-source reports:   3/18   (flagged in the UI)
Median cost per report:  $0.021
Median time:             94s
p95 time:                186s
```

**This table is the most professional artefact you will produce in the whole course.** Almost nobody who builds an AI project can tell you what theirs costs or how often it works. You can, because you built the eval set on Day 15 and the cost tracking on the same day.

Put it in `LIMITATIONS.md`, with the honest text around it:

```markdown
# Limitations

## Reports are not reproducible
The same question run twice produces different sub-questions and different
emphasis. Measured: 20 runs, no two identical. Citations are always
verifiable, but the shape of the report varies.

## Citations are verified, claims are not
Every source id is checked against what was actually retrieved, so a cited
source always exists. Whether the source truly supports the claim is not
checked. Open the source.

## Retrieval misses things
Measured recall@5 is 87% on a 15-question test set over the author's own
documents. Roughly one question in eight will miss relevant material.

## Web search is unreliable
It uses an unofficial endpoint and fails under rate limiting. The report is
still produced, and unavailable sources are named.

## Not supported
Scanned PDFs (no OCR). Non-English documents. Files over 10 MB. More than
50 files per user.

## Cost
Median $0.021 per report at current rates. The daily cap is $1.00 per user.
```

**Writing your own limitations honestly is a skill**, and it is rarer than the engineering. Anyone can demo the good case.

---

### Stage 6 -- Hand it to someone

The last stage, and the most useful one.

Create a key for a friend. Send them the URL. Then **watch them use it and say nothing.**

Do not explain. Do not steer them away from the thing you know is broken. Write down every moment they hesitate.

You will learn things no test told you:

- they upload a photo of a document, because to them that is a document
- they ask a one-word question
- they ask something your documents cannot possibly answer
- they wait fifteen seconds and click Research again
- they do not notice the source list at all
- they ask "is this true?" -- which is the correct question and the one your interface should answer better

**Fix the top two things. Write the rest in a "next" list and stop.**

Then finish the README with a short demo script -- three questions that show it working, taken from your eval set -- and a note saying what you would build next and why.

**That is the capstone.** Not the largest thing you could build. The thing that works, whose limits you know and have written down, that someone else has actually used.

---

## 7. Words I heard today

| Word | Plain meaning |
|---|---|
| **Multi-tenancy** | Several users on one system, isolated from each other. |
| **Isolation** | User A cannot reach user B's data. |
| **Ingestion** | Upload, validate, extract, chunk, embed, index. |
| **Idempotent ingest** | Uploading twice gives one copy. |
| **Scope** | What is in, and explicitly what is out. |
| **MVP** | The smallest version that is genuinely useful. |
| **Limitations document** | Written honest account of what it cannot do. |
| **Demo script** | A short path through the product that shows it working. |
| **Dogfooding** | Using your own product for real work. |

---

## 8. Break it on purpose

**1. Two users, one secret word.**
Upload a document containing a unique word as Alice, search for it as Bob.
*You must see:* nothing.
*It teaches:* the only test in this course that must pass. Run it twice -- once now and once when you think you are finished.

**2. Upload something horrible.**
A scanned PDF. A 40 MB file. A `.exe` renamed to `.pdf`. A file called `../../etc/passwd`.
*You will see:* whether validation actually holds.
*It teaches:* every upload is untrusted input.

**3. Delete and search.**
Delete a document, then search for something only it contained.
*You will see:* whether the chunks really went.
*It teaches:* deletion has to reach every store, and this is also how a user withdraws data.

**4. Plant an injection, as a user.**
Day 13's attack, uploaded through the interface.
*You will see:* whether it is flagged, and whether least privilege still holds in the deployed path.
*It teaches:* your defences must survive the real entry point, not just the test one.

**5. Kill the internet.**
Run a report with web search unreachable.
*You will see:* whether you get a report with a named failure or a broken page.
*It teaches:* graceful degradation, in the finished product.

**6. Watch someone use it.**
Say nothing for ten minutes.
*You will see:* more than every other experiment combined.
*It teaches:* the gap between a thing you drive and a thing you hand over.

---

## 9. Traps

**Trap 1 -- scope creep**
*Symptom:* day four of the capstone, building a settings page, core still rough.
*Fix:* the "does NOT do" list, written first, defended.

**Trap 2 -- no isolation**
*Symptom:* one user sees another's documents.
*Cause:* a `user_id` not threaded all the way down to the Chroma collection.
*Fix:* experiment 1, run twice. This is the one genuinely serious bug available today.

**Trap 3 -- duplicate ingest**
*Symptom:* re-uploading a file makes every search return it twice.
*Fix:* stable `filename::index` ids and `upsert`.

**Trap 4 -- the invisible warning**
*Symptom:* users trust a one-source report as much as a twelve-source one.
*Fix:* show the uncertainty in the interface, not just in the JSON.

**Trap 5 -- a demo pretending to be a product**
*Symptom:* it only works on your three questions.
*Fix:* stage 5's numbers, and stage 6's stranger.

**Trap 6 -- no limitations document**
*Symptom:* the work looks naive rather than finished.
*Fix:* `LIMITATIONS.md`. Knowing what your system cannot do is evidence that you understand it.

---

## 10. Check yourself

1. Name every store that needs a user boundary, and how each one gets it.
2. What makes ingest idempotent, and what happens without it?
3. Why record flagged content instead of blocking it?
4. Why is "the same question gives different reports" a limitation to publish rather than a bug to fix?
5. What is the single test that must pass before anything else matters?

---

## 11. Where this goes

You have finished the twenty-one days.

- Use it yourself, on real work, for two weeks. You will find things no test did.
- Fix the top two things your friend hit. Ignore the rest for now.
- Keep the eval set running. Every change gets measured -- that habit is the most transferable thing you learned.

The next file has a longer answer about what to do from here.

---

## 12. PROJECT STATE

```
PROJECT STATE after Day 21 -- COURSE COMPLETE

Folders:
  research-assistant/
    ai/
      api.py               (upload, documents, research, jobs, stream, history)
      users.py             (NEW - key creation, lookup, per-user paths)
      ingest.py            (NEW - validate, extract, chunk, embed, index)
      README.md            (NEW - what it does, and what it does NOT do)
      LIMITATIONS.md       (NEW - honest, with measured numbers)
      research/            (pipeline, sources, DECISIONS.md)
      observability.py, evals.py, reliability.py, security.py
      retrieval.py, golden_set.py, vector_store.py (now per-user collections)
      embeddings.py, documents.py, tools.py, memory.py
      graph_agent.py, crew_agent.py, multi_agent.py
      chat.py, agent.py, autonomous.py, planner.py
      mcp_agent.py, mcp_client.py, mcp_servers/my_tools.py
      prompts.py, classify.py, test_prompt.py
      uploads/{user_id}/   (NEW - per-user document storage)
      jobs.db, users.json, chroma_db/, logs/, runs/, notes/
      Dockerfile, .dockerignore, requirements.txt
    dashboard/
      server.js            (proxy: research, jobs, SSE stream, documents)
      public/index.html    (documents panel, ask panel, history panel)

Libraries added: python-multipart

ISOLATION - the one thing that must be right:
  documents   -> uploads/{user_id}/
  vectors     -> one Chroma collection per user, "docs_{user_id}"
  memory      -> the "user" metadata field added on Day 11 (which is why it
                 was added on Day 11, with one user, when it was free)
  jobs        -> ownership check from Day 20
  user_id threaded all the way down through sources.py and pipeline.py
  TEST: upload a doc with a unique word as user A, search as user B,
  must return nothing. Run this test twice - now and at the end.

Ingestion:
  validate: extension allowlist, 10 MB cap, 50 file cap
  os.path.basename on every filename (Day 13, path traversal)
  ids are "filename::index" so re-upload REPLACES, never duplicates
  delete removes the file AND the chunks from the collection
  scan() flags suspicious content but does NOT block, because blocking
    would reject legitimate documents that discuss injection; the flag is
    surfaced to the user instead

Dashboard:
  switched from polling to the SSE endpoint built on Day 20
  X-Accel-Buffering: no on the proxy, or events arrive all at once at the end
  onerror falls back to polling, because SSE connections drop
  report renders WITH its uncertainty: unverified citations, unavailable
  sources, and a warning when fewer than 2 sources were used

MEASURED (the product's own numbers, in LIMITATIONS.md):
  20 reports: 18 completed, 2 failed (web search unavailable)
  0 fabricated citations
  3 single-source reports, all flagged in the UI
  median $0.021 and 94s per report, p95 186s
  recall@5 87% on the Day 12 golden set

Scope discipline:
  README's "What it does NOT do" written BEFORE building
  explicitly out of scope: passwords, sharing, teams, billing, OCR,
  non-English documents, editing reports

Stage 6: handed to another person, watched without helping. Top two
observed problems fixed; the rest written into a "next" list.

WHAT WAS KEPT AS OURS THROUGHOUT, and no framework provides:
  verify_citations, the budget system (steps/tokens/wall clock), the
  permission model, the eval set, and every prompt.
```

---

## Answers

**1.** Documents (`uploads/{user_id}/`), the vector index (a per-user Chroma collection or a metadata filter), memory (the `user` field from Day 11), and jobs (the ownership check from Day 20). Each needs `user_id` threaded down to it, which is mechanical and easy to miss in one place.

**2.** Stable ids of the form `filename::index` with `upsert`. Without it, re-uploading a file adds a second copy of every chunk, so searches return the same passage twice and crowd out other material.

**3.** Because the scanner matches patterns that appear legitimately in documents about prompt injection, security, or AI itself. Blocking would reject real documents. Recording it lets you warn the user while still ingesting, and the real defence is least privilege anyway.

**4.** Because it cannot be fixed. It is a property of how the system works, not a defect in your code. Publishing it means users calibrate their trust correctly; hiding it means they trust it as though it were deterministic, which it is not.

**5.** Upload a document containing a unique word as one user, then search for that word as a different user. It must return nothing. If isolation fails, nothing else about the product matters.
