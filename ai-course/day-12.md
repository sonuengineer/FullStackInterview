# Day 12 -- Advanced RAG

**Module:** 03 -- Advanced Agent Systems
**Time:** about 1 hour
**Builds on:** Day 5 -- chunking; Day 6 -- embeddings and the four failures you wrote down

---

## 1. Today in one line

You fix the four failures from Day 6 -- and more importantly, you start **measuring** retrieval instead of guessing at it.

---

## 2. The problem

Open the list you wrote at the end of Day 6:

1. **Exact codes** -- `INV-2024-8871` finds the wrong invoice, because it looks nearly identical to `-8872`.
2. **Negation** -- "which projects are *not* delayed" retrieves chunks about delayed projects.
3. **Counting** -- "how many times is the budget mentioned" only ever sees three chunks.
4. **Cross-document** -- "compare the plan with the report" returns three chunks, all from one file.

There is a fifth problem you have been carrying since Day 6 without admitting it: **that `0.25` threshold is a guess.** So is `top_n=3`. So is `chunk_size=1000`. You have four numbers controlling the quality of every answer your system gives, and no idea whether any of them is right.

And underneath all of that sits the real issue. **You have never measured retrieval.** You have looked at a few results and thought "that seems reasonable". That is not evidence, and it means you cannot tell whether a change made things better or worse.

So today has an order to it, and the order matters more than the techniques:

> Measure first. Then improve. Then measure again.

If you only take one thing from Day 12, take that. Every technique below is standard and you will meet them all again inside Day 16's frameworks. But a person who measures their retrieval with a crude method beats a person who applies every advanced technique blind.

---

## 3. Mental model

**Day 6 gave you one librarian who understands topics.**

She is good. Ask for "something about company earnings" and she finds the revenue report. Ask for catalogue number `QA-8871` and she shrugs, because numbers are not topics.

**Advanced RAG is a small team at the front desk:**

- **The cataloguer** matches exact strings -- codes, names, part numbers. Dumb and precise.
- **The topic librarian** is your Day 6 embeddings. Understands meaning, bad at exact.
- **The reader** takes the shortlist of twenty and actually reads each one against your question, then re-orders them. Slow, so only ever used on a shortlist.
- **The receptionist** turns your vague question into a good one before anyone starts looking.

Each is weak alone. Together they are much stronger than any one.

**Where this comparison breaks:**

Every person you add costs time and money. A four-stage pipeline is slower and more expensive than a single vector search, and **each stage can be wrong** -- a bad query rewrite poisons everything downstream.

So the real skill is not knowing the four techniques. It is knowing which two your actual documents need. That is what measuring tells you, and nothing else will.

---

## 4. How it really works

**The pipeline**

```
question
  -> [rewrite]        make the question better for searching
  -> [retrieve]       vector search AND keyword search
  -> [fuse]           merge the two ranked lists into one
  -> [rerank]         read the top ~20 properly, keep the best 3-5
  -> [assemble]       dedupe, order, and hand to the model
```

Day 6 was the middle box only.

**Sparse and dense**

Your embeddings are **dense**: every text becomes 384 numbers, all of them meaningful. Good at meaning, bad at exact strings.

**BM25** is **sparse**: it scores on shared words, weighted so rare words count more than common ones. It is what search engines used before neural networks, it is decades old, and it is excellent at exactly what embeddings are bad at.

They fail in opposite directions. That is why you run both. That is **hybrid search**.

**Fusion, without the maths**

You now have two ranked lists and the scores are not comparable -- a BM25 score of 12.4 means nothing next to a cosine similarity of 0.71.

So ignore the scores and use only the **positions**. This is **Reciprocal Rank Fusion**:

```
score for a chunk = sum over both lists of  1 / (60 + its position in that list)
```

A chunk ranked 1st in either list scores well. A chunk ranked 5th in *both* also scores well, because it gets two contributions. The 60 is a constant that stops first place dominating everything.

That is the whole algorithm. Five lines of code, no tuning, and it works remarkably well.

**Reranking, and the real distinction**

Your embedding model is a **bi-encoder**: it looks at the question and the chunk *separately* and compares two positions. Fast -- chunks can be embedded once, in advance.

A **cross-encoder** reads the question and the chunk *together* and scores how well one answers the other. Far more accurate, because it can see the interaction between them. Also far slower, because nothing can be precomputed -- every pair must be run through the model.

So you use both: cheap search to get 20 candidates, expensive reader to pick the best 3. This is usually the single biggest quality win available, and it is what improves the negation problem -- a cross-encoder can actually notice the word "not".

**Lost in the middle**

Models attend most to the beginning and end of their context, least to the middle. Day 3 taught you this about prompts; it applies to retrieved chunks too. If you send five chunks, put the best one first and the second-best last.

**How to measure**

You need a **golden set**: questions paired with the chunk that should be found.

- **Recall@k** -- in what fraction of questions is the right chunk in the top k? This is the number that matters most.
- **MRR** -- Mean Reciprocal Rank. If the right chunk is at position 1 you score 1.0, position 2 scores 0.5, position 4 scores 0.25. Rewards being right *and* being first.

Fifteen questions is enough to see real differences. It is not a research benchmark. It is a smoke alarm.

---

## 5. Setup

```bash
cd research-assistant/ai
source venv/bin/activate

pip install rank-bm25
pip freeze > requirements.txt

touch retrieval.py golden_set.py
```

`rank-bm25` is tiny and pure Python. The cross-encoder comes from `sentence-transformers`, which you already have.

---

## 6. Build it

---

### Stage 1 -- Measure what you already have

**Do not skip this and do not do it second.** If you improve first and measure afterwards, you will never know which change helped.

`golden_set.py`:

```python
GOLDEN = [
    {"question": "what were the earnings last quarter",
     "must_contain": "revenue"},
    {"question": "when is the project due",
     "must_contain": "30 November"},
    {"question": "who is responsible for the budget",
     "must_contain": "Sharma"},
    # ... write 15 total, from your own documents
]
```

Write fifteen, from your real files. Rules that make the difference between a useful set and a useless one:

- **Use words the document does not use.** If every question shares vocabulary with its chunk, the set proves nothing and everything scores 100%.
- **Include the hard cases** -- the exact code, the negation, the cross-document comparison.
- **`must_contain` should be a distinctive string** that appears in the right chunk and nowhere else.
- **Include three questions with no answer in your documents.** A system that always returns something is not working; it is guessing.

Now the scorer, in `retrieval.py`:

```python
from golden_set import GOLDEN


def evaluate(search_function, name, k=5):
    hits = 0
    reciprocal_total = 0.0

    for case in GOLDEN:
        results = search_function(case["question"], top_n=k)
        texts = [r["text"] if isinstance(r, dict) else r for r in results]

        position = None
        for index, text in enumerate(texts):
            if case["must_contain"].lower() in text.lower():
                position = index + 1
                break

        if position:
            hits += 1
            reciprocal_total += 1 / position

    total = len(GOLDEN)
    print(f"{name:30s} recall@{k}: {hits}/{total} ({hits/total:.0%})   "
          f"MRR: {reciprocal_total/total:.3f}")
    return hits / total
```

Run your Day 6 search through it:

```python
from vector_store import search as vector_only

evaluate(lambda q, top_n: vector_only(q, top_n), "vector only (Day 6)")
```

You will get something like:

```
vector only (Day 6)            recall@5: 9/15 (60%)   MRR: 0.412
```

**That number is the most useful thing you have produced this week.** Write it down. Everything today gets compared against it.

---

### Stage 2 -- Add keyword search

```python
import re
from rank_bm25 import BM25Okapi
from documents import load_all_documents, chunk_text

_chunks = []
_bm25 = None


def tokenise(text):
    return re.findall(r"\w+", text.lower())


def build_keyword_index():
    global _chunks, _bm25
    _chunks = []
    for name, text in load_all_documents().items():
        for chunk in chunk_text(text):
            _chunks.append({"text": chunk, "source": name})

    _bm25 = BM25Okapi([tokenise(c["text"]) for c in _chunks])
    print(f"BM25 index: {len(_chunks)} chunks")


def keyword_search(query, top_n=5):
    if _bm25 is None:
        build_keyword_index()

    scores = _bm25.get_scores(tokenise(query))
    best = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)[:top_n]
    return [{"text": _chunks[i]["text"], "source": _chunks[i]["source"],
             "score": float(scores[i])} for i in best if scores[i] > 0]
```

Measure it on its own:

```python
evaluate(keyword_search, "keyword only (BM25)")
```

It will probably score *worse* overall than vector search. **Look at which questions it gets right, though.** Almost certainly the exact-code one, which vector search failed. Different failures, which is exactly why combining them works.

---

### Stage 3 -- Hybrid, with RRF

```python
from vector_store import search as vector_search


def hybrid_search(query, top_n=5, pool=20):
    vector_hits = vector_search(query, top_n=pool)
    keyword_hits = keyword_search(query, top_n=pool)

    scores, texts = {}, {}

    for rank, hit in enumerate(vector_hits, start=1):
        key = hit["text"][:200]
        scores[key] = scores.get(key, 0) + 1 / (60 + rank)
        texts[key] = hit

    for rank, hit in enumerate(keyword_hits, start=1):
        key = hit["text"][:200]
        scores[key] = scores.get(key, 0) + 1 / (60 + rank)
        texts.setdefault(key, hit)

    ordered = sorted(scores, key=scores.get, reverse=True)[:top_n]
    return [{**texts[k], "score": scores[k]} for k in ordered]
```

Measure:

```
vector only (Day 6)            recall@5: 9/15 (60%)   MRR: 0.412
keyword only (BM25)            recall@5: 7/15 (47%)   MRR: 0.351
hybrid (RRF)                   recall@5: 12/15 (80%)  MRR: 0.556
```

**The combination beats both parts.** Not by a little. This is usually the cheapest improvement available in RAG -- no extra model, no meaningful extra latency, just running two searches and merging by position.

The `text[:200]` key is a crude way to spot the same chunk appearing in both lists. Fine here; a real system would carry stable chunk ids.

---

### Stage 4 -- Rerank the shortlist

```python
from sentence_transformers import CrossEncoder

_reranker = None


def get_reranker():
    global _reranker
    if _reranker is None:
        _reranker = CrossEncoder("cross-encoder/ms-marco-MiniLM-L-6-v2")
    return _reranker


def reranked_search(query, top_n=5, pool=20):
    candidates = hybrid_search(query, top_n=pool)
    if not candidates:
        return []

    pairs = [(query, c["text"]) for c in candidates]
    scores = get_reranker().predict(pairs)

    for candidate, score in zip(candidates, scores):
        candidate["rerank_score"] = float(score)

    candidates.sort(key=lambda c: c["rerank_score"], reverse=True)
    return candidates[:top_n]
```

First run downloads about 90 MB. Then measure:

```
hybrid + rerank                recall@5: 13/15 (87%)  MRR: 0.781
```

**Look at what moved.** Recall barely changed -- the right chunk was already in the pool. **MRR jumped**, because the right chunk moved to position 1 instead of sitting at position 4.

That matters more than it sounds. The model reads the first chunk most carefully. Being right *and first* produces noticeably better answers than being right and fourth.

**Now re-test your Day 6 negation failure.** "Which projects are not delayed." The cross-encoder reads the question and the chunk together, so it can actually notice the "not". It will not be perfect, but it will be better.

**The cost is real, so time it:**

```python
import time
for name, fn in [("hybrid", hybrid_search), ("reranked", reranked_search)]:
    start = time.time()
    fn("what were the earnings")
    print(f"{name}: {(time.time()-start)*1000:.0f}ms")
```

Reranking typically adds 200-500ms on CPU. That is why you only ever run it on a shortlist of 20. Reranking 500 chunks would take half a minute.

---

### Stage 5 -- Fix the question before searching

Vague questions retrieve vaguely. Rewrite them first:

```python
import os, json
from openai import OpenAI

client = OpenAI(api_key=os.environ["GROQ_API_KEY"],
                base_url="https://api.groq.com/openai/v1")

REWRITE_PROMPT = """You rewrite questions to work better in a document search.

Produce 3 different search queries for the user's question:
1. the question rewritten clearly, as a statement
2. a version using likely document vocabulary (formal, business or technical words)
3. a version focused on key entities and exact terms only

Reply with JSON only: {"queries": ["...", "...", "..."]}"""


def multi_query_search(query, top_n=5):
    response = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[{"role": "system", "content": REWRITE_PROMPT},
                  {"role": "user", "content": query}],
        temperature=0,
        response_format={"type": "json_object"}
    )
    queries = json.loads(response.choices[0].message.content)["queries"]
    queries.append(query)

    scores, texts = {}, {}
    for q in queries:
        for rank, hit in enumerate(hybrid_search(q, top_n=10), start=1):
            key = hit["text"][:200]
            scores[key] = scores.get(key, 0) + 1 / (60 + rank)
            texts.setdefault(key, hit)

    ordered = sorted(scores, key=scores.get, reverse=True)[:20]
    candidates = [{**texts[k], "score": scores[k]} for k in ordered]

    pairs = [(query, c["text"]) for c in candidates]
    for c, s in zip(candidates, get_reranker().predict(pairs)):
        c["rerank_score"] = float(s)
    candidates.sort(key=lambda c: c["rerank_score"], reverse=True)
    return candidates[:top_n]
```

**Note the last part carefully.** Multiple queries are used for *searching*, but reranking scores against the **original** question. The rewrites help you find candidates; the user's real question decides which ones are best.

Measure:

```
multi-query + hybrid + rerank  recall@5: 14/15 (93%)  MRR: 0.812
```

**And now the honest accounting.** This version costs one extra model call and four searches per question. On the free tier that is significant. Look at your own table: if multi-query bought you one question out of fifteen, it may not be worth the call for your documents. **That decision is now yours to make with evidence**, which is the entire point of having built the golden set first.

---

### Stage 6 -- Assemble the context properly

Retrieval is done. One last thing that costs nothing:

```python
def build_context(hits, max_chars=4000):
    seen, unique = set(), []
    for hit in hits:
        fingerprint = hit["text"][:100]
        if fingerprint not in seen:
            seen.add(fingerprint)
            unique.append(hit)

    # best first, second-best last: models attend least to the middle
    ordered = ([unique[0]] + unique[2:] + [unique[1]]) if len(unique) > 2 else unique

    parts, total = [], 0
    for hit in ordered:
        block = f"[Source: {hit['source']}]\n{hit['text']}"
        if total + len(block) > max_chars:
            break
        parts.append(block)
        total += len(block)

    return "\n\n---\n\n".join(parts)
```

Then point `tools.py` at the new pipeline:

```python
from retrieval import reranked_search, build_context

def search_documents(query):
    hits = reranked_search(query, top_n=5)
    if not hits or hits[0].get("rerank_score", 0) < 0:
        return "Nothing in the user's documents is relevant to that."
    return build_context(hits)
```

**That threshold is now measurable rather than guessed.** Print `rerank_score` for your three unanswerable golden questions and for your twelve answerable ones. The gap between them is where the line goes. Cross-encoder scores are logits, so negative usually means "not relevant" -- but check on your own data rather than trusting that.

**Your final table:**

```
vector only (Day 6)            60%   MRR 0.412
keyword only (BM25)            47%   MRR 0.351
hybrid (RRF)                   80%   MRR 0.556
hybrid + rerank                87%   MRR 0.781
multi-query + hybrid + rerank  93%   MRR 0.812
```

**One last caution, and it is important.** You measured *retrieval*, not *answers*. Better chunks usually mean better answers, but not always -- the model can still misread a perfect chunk. The complete version of this measurement checks the final answer too, which is Day 15.

---

## 7. Words I heard today

| Word | Plain meaning |
|---|---|
| **Dense retrieval** | Embeddings. Meaning-based. Day 6. |
| **Sparse retrieval** | Word-based scoring like BM25. |
| **BM25** | The standard keyword ranking formula. Rare words count more. |
| **Hybrid search** | Running both and merging. |
| **RRF** | Merging by position rather than by score. |
| **Bi-encoder** | Encodes question and chunk separately. Fast. |
| **Cross-encoder** | Reads them together. Accurate, slow. |
| **Reranking** | Re-ordering a shortlist with a cross-encoder. |
| **Multi-query** | Searching with several rewordings of one question. |
| **HyDE** | Writing a fake ideal answer and searching with that. |
| **Recall@k** | How often the right chunk is in the top k. |
| **MRR** | Rewards being right and being first. |
| **Golden set** | Your fixed question-to-expected-chunk test set. |
| **Lost in the middle** | Models attend least to the middle of their context. |
| **Parent-child** | Retrieve a small chunk, send its larger parent. |

---

## 8. Break it on purpose

**1. Re-run all four Day 6 failures.**
Exact code, negation, counting, cross-document.
*You will see:* exact codes fixed by BM25. Negation improved by reranking. Counting still broken. Cross-document partly helped by multi-query.
*It teaches:* which problems are retrieval problems and which are not. Counting is an agent problem -- it needs several searches, which is Day 7's loop, not a better ranker.

**2. Make your golden set too easy.**
Write five questions using the document's exact words. Measure.
*You will see:* nearly 100% on every method, and no way to tell them apart.
*It teaches:* an easy test set is worse than none, because it gives false confidence.

**3. Shrink the pool.**
Set `pool=5` before reranking instead of 20.
*You will see:* reranking stops helping.
*It teaches:* a reranker can only re-order what it is given. Recall happens before it; precision happens in it.

**4. Time everything.**
Measure latency for vector, hybrid, reranked, multi-query.
*You will see:* roughly 30ms, 40ms, 400ms, 1,500ms.
*It teaches:* a 40x latency increase for 33 percentage points of recall. Whether that trade is right depends entirely on what you are building.

**5. Test lost-in-the-middle directly.**
Take a question you know the answer to. Send the right chunk first, then again with it buried third of five. Compare the answers.
*You will see:* a real difference in answer quality from position alone.
*It teaches:* the ordering in `build_context` is not fussiness.

**6. Break the rewriter.**
Change the rewrite prompt to produce deliberately odd rewordings. Measure.
*You will see:* scores drop below plain hybrid.
*It teaches:* every stage can make things worse. More pipeline is not more quality -- which is why you measure each stage separately.

---

## 9. Traps

**Trap 1 -- improving without measuring**
*Symptom:* four techniques added, no idea whether anything helped.
*Fix:* golden set first. Always. Twenty minutes, and it is the whole day.

**Trap 2 -- a golden set that is too easy or too small**
*Symptom:* everything scores 95% and nothing distinguishes methods.
*Fix:* different vocabulary from the documents, the known-hard cases included, and some unanswerable questions.

**Trap 3 -- reranking everything**
*Symptom:* searches that take fifteen seconds.
*Cause:* a cross-encoder run over every chunk.
*Fix:* shortlist of 20 to 50, never more.

**Trap 4 -- changing chunking without re-indexing**
*Symptom:* results suddenly get much worse for no obvious reason.
*Cause:* the BM25 index and the Chroma collection were built from different chunkings and no longer line up.
*Fix:* rebuild both together. Consider one `index.py` that does everything, so this cannot happen.

**Trap 5 -- tuning RRF weights**
*Symptom:* hours spent adjusting the 60, with no consistent gain.
*Fix:* leave it at 60. The constant does very little. Effort belongs in reranking and in your golden set.

**Trap 6 -- measuring retrieval and calling it done**
*Symptom:* retrieval scores 93% and answers are still poor.
*Cause:* the model was given the right chunk and misread it.
*Fix:* Day 15 measures the final answer. Retrieval quality is necessary, not sufficient.

---

## 10. Check yourself

1. Why do BM25 and embeddings work well together? Name a question each one wins.
2. What is the difference between a bi-encoder and a cross-encoder, and why is only one used on a shortlist?
3. Your recall stayed flat but MRR jumped after reranking. What changed, and why does it matter?
4. Name three properties of a golden set that make it useful rather than reassuring.
5. Which of the Day 6 four failures is *not* a retrieval problem, and what actually fixes it?

---

## 11. Where this goes

- **Day 13** points out that everything you retrieve is untrusted text that ends up inside your prompt. Better retrieval means more of it.
- **Day 14** can give each agent its own retrieval settings -- a research agent with a wide pool, a fact-checker with a strict threshold.
- **Day 15** extends today's measurement from retrieval to answers, and turns your golden set into a proper evaluation run.
- **Day 18 and 21** are built on this pipeline. A research agent is only as good as what it can find.
- **Day 16 (LangGraph)** ships retrievers and rerankers as components. You will know exactly what each one does and -- more usefully -- whether it is worth its latency.

---

## 12. PROJECT STATE

```
PROJECT STATE after Day 12:

Folders:
  research-assistant/
    ai/
      venv/, .env, .gitignore, requirements.txt
      chat.py, agent.py, autonomous.py, planner.py, memory.py
      retrieval.py          (NEW - the full pipeline + evaluate())
      golden_set.py         (NEW - 15 test questions)
      vector_store.py, embeddings.py, documents.py, chroma_db/
      tools.py              (search_documents now uses reranked_search)
      mcp_agent.py, mcp_client.py, mcp_servers/my_tools.py
      prompts.py, classify.py, test_prompt.py
      runs/, notes/, documents/, conversation.json
    dashboard/              (still empty)

Libraries: rank-bm25 (NEW). CrossEncoder comes from sentence-transformers,
           already installed on Day 6.

golden_set.py:
  15 cases of {question, must_contain}
  written with DIFFERENT vocabulary from the documents on purpose
  includes the 4 known-hard cases from Day 6
  includes 3 questions with NO answer in the documents

retrieval.py contains:
  evaluate(search_fn, name, k)   - recall@k and MRR against the golden set
  tokenise(), build_keyword_index(), keyword_search()   - BM25Okapi
  hybrid_search(query, top_n, pool=20)  - RRF over vector + BM25 ranks,
      score = sum of 1/(60+rank) across both lists; the raw scores are
      ignored because they are not comparable
  get_reranker()                 - cross-encoder/ms-marco-MiniLM-L-6-v2
  reranked_search()              - hybrid pool of 20, cross-encoder scores
      (query, chunk) pairs together, keep top 5
  multi_query_search()           - model rewrites the question 3 ways,
      searches with all 4, fuses, then reranks against the ORIGINAL question
  build_context(hits, max_chars) - dedupe, then order best-first and
      second-best-LAST to avoid lost-in-the-middle, then cap by characters

Measured on the golden set (replace with your own numbers):
  vector only (Day 6)             60%   MRR 0.412
  keyword only (BM25)             47%   MRR 0.351
  hybrid (RRF)                    80%   MRR 0.556
  hybrid + rerank                 87%   MRR 0.781
  multi-query + hybrid + rerank   93%   MRR 0.812
  latency: ~30ms / ~40ms / ~400ms / ~1500ms

Day 6 failures, re-tested:
  exact codes      FIXED by BM25
  negation         IMPROVED by the cross-encoder (it reads query+chunk
                   together so it can see "not")
  counting         STILL BROKEN - not a retrieval problem, it needs
                   multiple searches, i.e. the agent loop
  cross-document   PARTLY helped by multi-query

Key decisions made:
  - golden set built BEFORE any improvement, so every change is measured
  - RRF constant left at 60; tuning it is not worth the time
  - reranking only ever runs on a shortlist of 20, never the whole corpus
  - multi-query searches with rewrites but reranks against the original
    question
  - the relevance threshold is now set from the measured rerank_score gap
    between answerable and unanswerable golden questions, not guessed
  - tools.py uses reranked_search; multi-query is available but costs an
    extra model call per question

Known problems, left for later:
  - the BM25 index and the Chroma collection are built separately; changing
    chunking requires rebuilding BOTH or results silently degrade
  - only RETRIEVAL is measured, not final answer quality (Day 15)
  - no parent-child chunking yet (retrieve small, send large)
  - no metadata filtering by date or document type
```

---

## Answers

**1.** They fail in opposite directions. BM25 matches exact strings, so it wins on `INV-2024-8871` and on rare proper nouns. Embeddings match meaning, so they win on "what were the earnings" against a document that says "revenue". Merging covers both.

**2.** A bi-encoder encodes the question and the chunk separately and compares positions, so chunks can be embedded in advance and search is fast. A cross-encoder reads both together and scores the interaction, which is far more accurate but cannot be precomputed. Only the shortlist gets the expensive treatment, because reranking every chunk would take tens of seconds.

**3.** The right chunk was already in the top 5 -- reranking moved it to position 1. It matters because models attend most to the first chunk, so being right *and first* produces better answers than being right and fourth.

**4.** It uses different vocabulary from the documents, it includes the cases you already know are hard, and it includes questions with no answer at all. Without the third, you cannot tell a working system from one that always returns something.

**5.** Counting. "How many times is X mentioned" cannot be answered by any ranker, because the system only ever sees the top few chunks. It needs the agent to search repeatedly and accumulate -- the Day 7 loop, not a better retriever.
