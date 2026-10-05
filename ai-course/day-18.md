# Day 18 — Build Our AI Research Agent

**Module:** 04 — Frameworks
**Time:** about 1 hour, probably more
**Builds on:** all seventeen days. Especially Day 15 — evals; Day 17 — the three-way comparison

---

## 1. Today in one line

You stop building components and build the **product** — one research agent, assembled from evidence, that produces a cited report you would actually send to someone.

---

## 2. The problem

Look at your `ai/` folder. Twenty-odd files. Three different multi-agent implementations. Five variations of the agent loop. Two virtual environments.

**None of it is a thing.** You have an excellent parts bin and no machine.

And a research agent is more than a question-answering bot. A bot answers from one search. Research means:

- working out what the question actually is
- gathering from **several** sources
- noticing when sources **disagree**
- saying what could not be found
- and attaching a source to every claim, so someone can check

That last one is the difference between a report and a plausible essay. A research output nobody can verify is worse than no output, because it carries authority it has not earned.

Today is less new theory and more **integration** — which sounds easy and is not. You have already met this: memory (Day 2) and documents (Day 5) each worked perfectly alone, and together they caused constant rate limits. Components interact. Today you find out where.

---

## 3. Mental model

**You are assembling, not inventing.**

Every part exists. The work is choosing which parts, connecting them, and measuring the result.

**Where this comparison breaks, and it is the whole risk of today:**

**Integration is not additive.** Two components that each work can produce a system that does not. The token cost of your pipeline is the sum of every stage — retrieval, rewriting, memory extraction, agent steps, critic passes. Each was reasonable alone. Together they can make one report cost more than a hundred chat messages.

So today has a rule:

> Measure the whole thing, not the parts. You already measured the parts.

**What a research agent actually does**, as a shape:

```
question
  -> clarify      is this answerable? what is really being asked?
  -> plan         what sub-questions does this break into?
  -> gather       search each sub-question, in parallel, across sources
  -> cross-check  do the sources agree? what is missing?
  -> synthesise   write it, with a source on every claim
  -> verify       do the cited sources actually exist and say that?
```

Days 10, 12, 14 and 9 respectively. Nothing new. The work is in the joins.

---

## 4. How it really works

**Decision one: single agent or a team?**

Use your Day 17 table. If your numbers said the single agent matched the team at a third of the cost, build the single agent. A "research agent" does not require multiple agents — it requires multiple *searches*, which Day 7's loop already gives you.

The one place a team clearly wins here is **parallel gathering** of independent sub-questions, which is Day 14's one genuine advantage.

**Decision two: framework or not?**

Same answer, same evidence. A sensible middle position, and the one this lesson takes: **your own pipeline code, calling your own components, with LangGraph only if you need persistence and resumable interrupts** — which you will, on Day 20.

**Decision three: where do citations come from?**

This is the one that matters most, and it has a trap in it.

The wrong way: ask the model to cite its sources. It will. It will also invent filenames that look exactly like your real ones.

The right way: **citations come from your retrieval code, not from the model.** You know which chunk came from which file, because you attached that at index time on Day 5. Give each retrieved chunk an id, require the model to reference ids, then **check in code** that every id it used was actually in what you gave it.

A citation the model produced is a claim. A citation your code verified is evidence.

**Decision four: what does "done" mean?**

A research report is done when every sub-question has been attempted, every claim has a verified source, and gaps are stated explicitly. Not when the model says it is finished — Day 9 settled that.

---

## 5. Setup

Time to tidy up. Make one package:

```bash
cd research-assistant/ai
mkdir -p research
touch research/__init__.py research/pipeline.py research/sources.py research/report.py
```

**Optional but worth it: a second source.** A research agent reading only your local files is thin. A free web search, no key required:

```bash
pip install ddgs
```

It is unofficial and gets rate-limited, so treat it as a source that may fail — which is good practice anyway, since every real source does. If it is unreliable for you, skip it; everything below works with documents alone.

---

## 6. Build it

---

### Stage 1 — Write the decisions down

Before code, ten minutes with a text file. `research/DECISIONS.md`:

```markdown
# Architecture decisions

## 1. Single agent with parallel gathering, not a multi-agent crew
Evidence: Day 17 eval, 3 tasks. Multi 73-80% success at 14,200 tokens;
single 80% at 8,400. Keeping parallel fan-out for independent sub-questions,
which was the one place the team genuinely won.

## 2. Own pipeline code, LangGraph only for the outer loop on Day 20
Evidence: Day 16 eval showed equal quality, ~8% more tokens. Adopting it for
checkpointing and resumable interrupts, which deployment needs, not for the
agent logic.

## 3. Citations produced by retrieval code, verified in code
The model never invents a source id, because it only ever sees ids we gave it,
and we check every id it used.

## 4. Two sources: local documents and web search
Web search may fail. The pipeline must produce a report anyway and say which
sources were unavailable.

## 5. Hard budget: 60,000 tokens and 300 seconds per report
Day 9's budget, applied to the whole pipeline rather than one agent.
```

**This file is not ceremony.** In three weeks you will wonder why you did not use CrewAI, and this tells you — with numbers. Every real project has this document, usually written too late.

---

### Stage 2 — Sources with provenance

`research/sources.py`:

```python
import uuid
import tools as my_tools
from retrieval import reranked_search


def search_documents(query, limit=5):
    """Local documents. Returns chunks with a stable citation id."""
    try:
        hits = reranked_search(query, top_n=limit)
    except Exception as error:
        return {"ok": False, "error": str(error)[:150], "chunks": []}

    chunks = []
    for hit in hits:
        chunks.append({
            "id": f"D{uuid.uuid4().hex[:6]}",
            "text": hit["text"],
            "source": hit["source"],
            "kind": "document",
            "score": hit.get("rerank_score", 0),
        })
    return {"ok": True, "chunks": chunks}


def search_web(query, limit=4):
    """Web search. May fail, and that is expected."""
    try:
        from ddgs import DDGS
        results = list(DDGS().text(query, max_results=limit))
    except Exception as error:
        return {"ok": False, "error": str(error)[:150], "chunks": []}

    chunks = []
    for r in results:
        chunks.append({
            "id": f"W{uuid.uuid4().hex[:6]}",
            "text": f"{r.get('title','')}\n{r.get('body','')}",
            "source": r.get("href", "unknown"),
            "kind": "web",
            "score": 0.5,
        })
    return {"ok": True, "chunks": chunks}


def gather(query):
    """Every source, with failures recorded rather than raised."""
    document_result = search_documents(query)
    web_result = search_web(query)

    return {
        "chunks": document_result["chunks"] + web_result["chunks"],
        "failed": [name for name, r in
                   [("documents", document_result), ("web", web_result)]
                   if not r["ok"]],
    }
```

**Three things doing real work.**

**Every chunk gets an id at the moment it is retrieved.** `D4f2a1`, `W9c3e0`. The model will only ever see these ids, so the only ids it can cite are ones you handed it.

**A failing source returns a result, it does not raise.** The report must still be produced, with the failure noted. A research tool that dies because one source was down is not usable.

**`kind` marks provenance.** A claim from your own document is not the same as a claim from a random web page, and the report should say which.

---

### Stage 3 — The pipeline

`research/pipeline.py`:

```python
import os, json, time, asyncio
from openai import OpenAI
from dotenv import load_dotenv
from observability import new_trace, log_call
from research.sources import gather

load_dotenv()
client = OpenAI(api_key=os.environ["GROQ_API_KEY"],
                base_url="https://api.groq.com/openai/v1")
BIG = "llama-3.3-70b-versatile"
SMALL = "llama-3.1-8b-instant"


def ask(messages, model=BIG, component="research", json_mode=False):
    start = time.time()
    kwargs = {"response_format": {"type": "json_object"}} if json_mode else {}
    response = client.chat.completions.create(
        model=model, messages=messages, temperature=0, **kwargs)
    log_call(model, component,
             response.usage.prompt_tokens, response.usage.completion_tokens,
             (time.time() - start) * 1000)
    return response.choices[0].message.content


PLAN_PROMPT = """You break a research question into sub-questions.

Reply with JSON only:
{"answerable": true/false,
 "reason": "if not answerable, why",
 "sub_questions": ["...", "...", "..."]}

RULES
- 2 to 4 sub-questions. Each must be independently searchable.
- Each must stand alone. Do not write "and the other one".
- Set answerable to false if the question is too vague to research, or asks
  for something nobody could know."""


def plan(question):
    raw = ask([{"role": "system", "content": PLAN_PROMPT},
               {"role": "user", "content": question}],
              model=SMALL, component="plan", json_mode=True)
    return json.loads(raw)


def gather_all(sub_questions):
    """Parallel, because sub-questions are independent by construction."""
    async def run():
        loop = asyncio.get_event_loop()
        jobs = [loop.run_in_executor(None, gather, q) for q in sub_questions]
        return await asyncio.gather(*jobs)

    results = asyncio.run(run())

    chunks, failed = [], set()
    for sub_question, result in zip(sub_questions, results):
        for chunk in result["chunks"]:
            chunk["for"] = sub_question
            chunks.append(chunk)
        failed.update(result["failed"])
    return chunks, sorted(failed)
```

**`plan` uses the small model.** Day 15's routing: breaking a question into parts is a narrow structured job. Ten times cheaper, no measurable quality loss. Check that on your own evals rather than taking my word.

**The sub-questions must be independent** — the prompt says so explicitly — because Stage 3 runs them in parallel. Day 14's warning: splitting something that does not split gives you agents working with incomplete information.

---

### Stage 4 — Synthesis with enforced citations

Still in `pipeline.py`:

```python
SYNTHESIS_PROMPT = """You write a research report from numbered sources.

CITATION RULES
- Every factual claim must end with its source id in square brackets, like [D4f2a1].
- Use ONLY ids from the sources given. Never invent an id.
- If sources disagree, say so explicitly and cite both.
- If a sub-question has no supporting source, write it under "Gaps". Do not
  fill the gap from your own knowledge.

FORMAT
## Summary
Two or three sentences answering the main question.

## Findings
One short section per sub-question. Every claim cited.

## Disagreements
Where sources conflict, and what each says. Write "None found" if there are none.

## Gaps
What could not be answered, and why.

Under 500 words. Plain language. Never write a claim you cannot cite."""


def synthesise(question, sub_questions, chunks):
    blocks = []
    for c in chunks:
        blocks.append(f"[{c['id']}] ({c['kind']}: {c['source']})\n{c['text'][:900]}")

    return ask([
        {"role": "system", "content": SYNTHESIS_PROMPT},
        {"role": "user", "content":
         f"MAIN QUESTION: {question}\n\n"
         f"SUB-QUESTIONS:\n" + "\n".join(f"- {q}" for q in sub_questions) +
         "\n\nSOURCES:\n" + "\n\n".join(blocks)}
    ], component="synthesis")
```

Now the part that makes citations mean something:

```python
import re

def verify_citations(report, chunks):
    """Check every cited id was actually given to the model."""
    given = {c["id"] for c in chunks}
    used = set(re.findall(r"\[([DW][0-9a-f]{6})\]", report))

    fabricated = used - given
    unused = given - used

    claim_lines = [line for line in report.split("\n")
                   if line.strip().startswith("-") and len(line) > 40]
    uncited = [line for line in claim_lines if not re.search(r"\[[DW][0-9a-f]{6}\]", line)]

    return {
        "fabricated": sorted(fabricated),
        "uncited_claims": uncited[:5],
        "sources_used": len(used),
        "sources_available": len(given),
        "clean": not fabricated and not uncited,
    }
```

**Run this on every report, and print the result.**

`fabricated` should always be empty. When it is not, the model invented a source id that looks exactly like a real one — and without this check you would never have noticed, because `[D7b3f2]` looks entirely convincing.

**This is the single most valuable function in today's file.** It is the difference between a report you can trust and one that merely looks trustworthy.

---

### Stage 5 — Put it together

```python
def research(question, max_seconds=300):
    trace = new_trace()
    started = time.time()

    plan_result = plan(question)
    if not plan_result.get("answerable"):
        return {"ok": False, "reason": plan_result.get("reason"), "trace": trace}

    sub_questions = plan_result["sub_questions"]
    print(f"[{trace}] {len(sub_questions)} sub-questions")
    for q in sub_questions:
        print(f"  - {q}")

    chunks, failed = gather_all(sub_questions)
    print(f"  gathered {len(chunks)} sources"
          + (f", FAILED: {failed}" if failed else ""))

    if not chunks:
        return {"ok": False, "reason": "No sources returned anything.",
                "failed_sources": failed, "trace": trace}

    report = synthesise(question, sub_questions, chunks)
    check = verify_citations(report, chunks)

    return {
        "ok": True,
        "trace": trace,
        "question": question,
        "sub_questions": sub_questions,
        "report": report,
        "citations": check,
        "failed_sources": failed,
        "seconds": round(time.time() - started, 1),
        "sources": [{"id": c["id"], "source": c["source"], "kind": c["kind"]}
                    for c in chunks],
    }


if __name__ == "__main__":
    result = research("What deadlines and budget constraints do my documents describe, "
                      "and do they conflict with each other?")
    print("\n" + "=" * 70)
    print(result.get("report", result.get("reason")))
    print("=" * 70)
    print(result.get("citations"))
    print(f"{result.get('seconds')}s")
```

Run it. You get a structured report with a Summary, Findings, Disagreements and Gaps, every claim carrying a source id, and a verification result telling you whether those ids were real.

**Save it to `runs/` alongside your agent trajectories.** A report without its trace is not reproducible.

---

### Stage 6 — Measure the whole thing and fix the worst part

Now the rule from section 3.

```python
QUESTIONS = [
    "What deadlines do my documents describe?",
    "Do my documents contradict each other about the budget?",
    "What does my project plan say about risks, and what does it leave out?",
    "What is my manager's home address?",          # unanswerable
    "Tell me everything about everything.",         # too vague to plan
]

for q in QUESTIONS:
    result = research(q)
    print(f"\n{q[:50]}")
    print(f"  ok={result['ok']} {result.get('seconds','')}s")
    if result["ok"]:
        c = result["citations"]
        print(f"  fabricated={c['fabricated']} uncited={len(c['uncited_claims'])} "
              f"sources used {c['sources_used']}/{c['sources_available']}")

report()   # from observability.py — cost per component
```

**Three things to look at, in this order.**

**Cost per report.** Add it up from the log. If one report costs more than a hundred chat messages, that is a product decision, not a bug — but you need the number before you can make it.

**The dominant component.** Almost certainly synthesis, because it carries every chunk. The lever is `text[:900]`: trim it and re-measure quality.

**Run the same question twice and compare the two reports.** They will differ. Day 15 told you to expect this; seeing it in a *deliverable* is a different feeling from seeing it in a test score. A report is something you hand to a person, and it not being reproducible is a real property of the thing you have built. Decide what you will tell users about that.

Then **fix only the worst failure** you found. Not all of them. One. Re-measure. That is what the rest of the work looks like.

---

## 7. Words I heard today

| Word | Plain meaning |
|---|---|
| **Integration** | Joining working parts into a working whole. Not automatic. |
| **ADR** | Architecture decision record. Why you chose what you chose. |
| **Provenance** | Where a piece of information came from. |
| **Citation id** | A stable label attached to a chunk at retrieval time. |
| **Fabricated citation** | A source id the model invented. |
| **Cross-checking** | Comparing what different sources say. |
| **Synthesis** | Writing the report from gathered sources. |
| **Gaps section** | Explicitly stating what could not be found. |
| **Graceful degradation** | Producing a report when a source is down. |
| **Cost per report** | The number that decides whether this is viable. |

---

## 8. Break it on purpose

**1. Remove citation verification.**
Run five reports and read the ids by hand against the source list.
*You will see:* at least one invented id, sooner or later, looking completely real.
*It teaches:* why a model-produced citation is a claim, not evidence.

**2. Contradict yourself on purpose.**
Put "the deadline is 30 November" in one document and "the deadline is 15 December" in another. Ask about the deadline.
*You will see:* whether the Disagreements section actually works.
*It teaches:* noticing conflict is the thing that makes it research rather than lookup.

**3. Kill a source.**
Disconnect the internet, or break `search_web`.
*You will see:* whether you still get a report with a noted failure, or a crash.
*It teaches:* graceful degradation, tested rather than assumed.

**4. Ask something with no answer.**
*You will see:* whether it says so, or writes a confident report from general knowledge.
*It teaches:* the Gaps section is a safety feature, not a formatting choice.

**5. Run the same question twice.**
Compare the two reports properly, line by line.
*You will see:* different sub-questions, different sources, different emphasis.
*It teaches:* what statistical means when the output is a deliverable.

**6. Break independence.**
Make the planner produce sub-questions where the third depends on the first.
*You will see:* the parallel gather returns poor results for the dependent one.
*It teaches:* Day 14's rule, now load-bearing in your product.

---

## 9. Traps

**Trap 1 — fabricated citations**
*Symptom:* a report that looks perfectly sourced and is not.
*Fix:* `verify_citations`, run every time, printed every time.

**Trap 2 — integration cost surprise**
*Symptom:* each component was affordable; the pipeline is not.
*Fix:* measure the whole pipeline. Trim the biggest contributor first.

**Trap 3 — the single-source report**
*Symptom:* every claim cites the same file.
*Fix:* check source diversity in `verify_citations` and say so in the report when it happens.

**Trap 4 — confident emptiness**
*Symptom:* a well-formatted report containing nothing that was actually found.
*Fix:* if `sources_used` is very low relative to claims, say so instead of shipping it.

**Trap 5 — no decision record**
*Symptom:* rebuilding the same comparison in a month.
*Fix:* `DECISIONS.md`, with the numbers.

**Trap 6 — reports that outrun their evidence**
*Symptom:* not a code bug. A report that reads as authoritative on a question it only partly answered.
*Fix:* the Gaps section, and being willing to return "not enough sources" as a result. A tool that sometimes says "I could not answer this" is more useful than one that never does.

---

## 10. Check yourself

1. Why must citation ids be created by your retrieval code and not by the model?
2. Name a component pairing that worked alone and broke together earlier in this course.
3. What makes a research agent different from a question-answering bot?
4. Why must sub-questions be independent in this design?
5. You run the same question twice and get two different reports. Is that a bug? What do you tell users?

---

## 11. Where this goes

- **Day 19 (LangChain)** offers loaders, splitters and retrievers you could swap into `sources.py`. You will judge them by running today's pipeline with each and comparing.
- **Day 20** puts this behind an API and finally builds the Node dashboard in front of it. Today's `research()` returning a structured dict rather than a string is exactly what makes that straightforward.
- **Day 21** turns it into the platform: many users, saved reports, history, and the cost per report you measured today as a real constraint.

---

## 12. PROJECT STATE

```
PROJECT STATE after Day 18:

Folders:
  research-assistant/
    ai/
      research/                 (NEW - the actual product)
        __init__.py
        DECISIONS.md            (architecture decision record, with numbers)
        sources.py              (document + web search, provenance, failures)
        pipeline.py             (plan -> gather -> synthesise -> verify)
      observability.py, evals.py, reliability.py, logs/
      retrieval.py, golden_set.py, vector_store.py, embeddings.py
      documents.py, tools.py, memory.py, security.py
      graph_agent.py, crew_agent.py, multi_agent.py  (kept for comparison)
      chat.py, agent.py, autonomous.py, planner.py
      mcp_agent.py, mcp_client.py, mcp_servers/my_tools.py
      prompts.py, classify.py, test_prompt.py
      runs/, notes/, documents/, chroma_db/
    dashboard/                  (STILL EMPTY - Node arrives on Day 20)

Libraries: ddgs (NEW, optional). Unofficial and rate-limited, treated as a
source that may fail.

ARCHITECTURE DECISIONS (research/DECISIONS.md), all evidence-based:
  1. single agent + parallel gathering, NOT a multi-agent crew
     (Day 17 eval: multi 73-80% at 14,200 tokens, single 80% at 8,400)
  2. own pipeline code; LangGraph adopted only for the outer loop on Day 20,
     for checkpointing and resumable interrupts, not for agent logic
  3. citations produced by retrieval code and verified in code
  4. two sources, and the report must still be produced when one fails
  5. hard budget 60,000 tokens / 300 seconds per report

research/sources.py:
  search_documents(query) -> chunks with id "D" + 6 hex, text, source,
      kind="document", rerank score. Uses Day 12's reranked_search.
  search_web(query)       -> chunks with id "W" + 6 hex, kind="web"
  gather(query)           -> merged chunks + a list of FAILED sources
  every source returns a result on failure instead of raising

research/pipeline.py:
  ask()          - logs every call to observability, temperature 0
  plan()         - SMALL model (Day 15 routing), JSON, returns
                   {answerable, reason, sub_questions}
                   2-4 sub-questions, each INDEPENDENTLY searchable because
                   they are gathered in parallel
  gather_all()   - asyncio parallel fan-out over sub-questions (Day 14's one
                   genuine multi-agent advantage, kept without the agents)
  synthesise()   - BIG model, sections: Summary / Findings / Disagreements /
                   Gaps, every claim must carry a source id in brackets
  verify_citations(report, chunks)  <- THE KEY FUNCTION
                   fabricated = ids used but never given (should ALWAYS be
                   empty; when it is not, the model invented a convincing
                   fake id and nothing else would have caught it)
                   also reports uncited claims and source usage ratio
  research(question) -> structured dict: report, citations check, sources,
                   failed_sources, seconds, trace id

Key decisions made:
  - a model-produced citation is a CLAIM; a code-verified one is EVIDENCE
  - ids are attached at retrieval time, so the model can only cite what it
    was given
  - the report is produced even when a source is down, with the failure named
  - "not enough sources" is a valid result and better than a confident report

Measured:
  cost per report (record your own) - synthesis dominates, because it carries
      every chunk; the lever is the text[:900] truncation
  the SAME question run twice produces DIFFERENT reports - different
      sub-questions, different sources, different emphasis. This is a real
      property of the product, not a bug, and users should be told.

Known problems, left for later:
  - no memory integration yet; the pipeline does not know the user
  - no budget enforcement wired in, only written in DECISIONS.md
  - source diversity is not checked; all claims can cite one file
  - web chunks are search snippets only, not full pages
  - reports are printed, not saved anywhere a user could return to (Day 20)
```

---

## Answers

**1.** Because a model asked to cite sources will produce ids that look exactly like real ones, including for sources it never saw. If your code creates the ids and checks which were used, the only ids it can cite are ones you handed it, and any invention is caught immediately.

**2.** Memory (Day 2) and documents (Day 5). Each worked alone; together, retrieved chunks landed in the conversation history and were re-sent every turn, causing constant rate limits.

**3.** Multiple sources rather than one search, explicit handling of disagreement between them, explicit statement of what could not be found, and a verifiable source attached to every claim. A bot answers; research shows its working.

**4.** Because they are searched in parallel. If one depends on another's answer, the parallel version runs it without the information it needs and returns poor results.

**5.** Not a bug. It is what a statistical system does, and it applies to a deliverable exactly as it applies to a test score. Tell users plainly: reports are generated fresh each time, the citations are verifiable, and re-running may produce different emphasis. That is more honest than implying determinism you do not have.
