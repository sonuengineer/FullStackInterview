# Day 19 — LangChain for Agent Engineers

**Module:** 04 — Frameworks
**Time:** about 1 hour
**Builds on:** Day 5, 6, 12 — the things you built by hand; Day 16 — LangGraph

---

## 1. Today in one line

You look at the toolbox you have been ignoring, work out which parts are worth taking, and — more usefully — build a rule for deciding that yourself.

---

## 2. The problem

On Day 5 you wrote a PDF reader and a text splitter. On Day 6 you wrote cosine similarity. On Day 12 you wrote hybrid search and reranking.

LangChain has all of it. Document loaders for a hundred formats. A splitter better than yours. `EnsembleRetriever`, which is your RRF. `ContextualCompressionRetriever`, which is your cross-encoder.

**Did you waste two weeks?**

No, and it is worth being clear why. If you had started with LangChain, you would now be someone who can call `EnsembleRetriever` and has no idea what it does, cannot tell when it is the wrong tool, and cannot debug it when the results are strange. You built the thing; the library is now a labour saving, not a black box.

But that leaves a real question, and it is today's actual subject:

**Which parts should you adopt, and which should you leave?**

LangChain is huge, it changes fast, and it has a reputation for wrapping simple things in complicated ones. "Use it" and "avoid it" are both bad advice. What you need is a rule you can apply yourself, and a habit of measuring before you swap.

One clarification, because it confuses people constantly: **LangChain and LangGraph are different things.** LangGraph (Day 16) is control flow — nodes, edges, state. LangChain is components — loaders, splitters, retrievers, output parsers. You can use either without the other.

---

## 3. Mental model

**A hardware shop.**

Some tools save you a day: a pipe threader you would never make yourself. Some are a plastic handle around a screwdriver you already own, sold at four times the price.

The shop does not distinguish. You have to.

**Where this comparison breaks, and this is the part that matters:**

A bad hand tool sits in a drawer. **A bad abstraction sits between you and your prompt.** Every wrapper is a layer, and layers are where debugging goes to die. When your retrieval returns nonsense, the question is always "what did it actually send" — and each layer makes that harder to answer.

So the cost of a LangChain component is not just tokens. It is **visibility**.

**The rule, and it is the deliverable of today:**

> Adopt it if it connects to something external, or performs a well-defined transformation you would have written identically.
>
> Skip it if it contains a prompt, or controls flow you care about.

Loaders connect to external formats — adopt. Splitters transform text deterministically — adopt if measured better. Retrievers are borderline: measure. Anything with a hidden prompt inside it — write your own, because that prompt is your product.

---

## 4. How it really works

**The components, and the verdict on each:**

| Component | What it is | Verdict |
|---|---|---|
| **Document loaders** | Readers for 100+ formats | **Adopt.** Clear win. |
| **Text splitters** | Chunking strategies | **Measure.** Often better than yours. |
| **Embeddings** | Wrappers over models | Neutral. You already have this. |
| **Vector stores** | Wrappers over Chroma etc. | Neutral. Adds a layer. |
| **Retrievers** | Ensemble, compression, multi-query | **Measure.** These are your Day 12. |
| **Output parsers** | Structured output with retry | **Adopt.** Solid, no hidden prompt. |
| **LCEL / Runnables** | The pipe composition syntax | **Selectively.** |
| **Agents (legacy)** | The old agent abstractions | **Skip.** Use LangGraph. |
| **Memory (legacy)** | Old conversation memory | **Skip.** Day 11 is better. |
| **Callbacks** | Hooks on every call | **Adopt.** This is your Day 15. |

**LCEL, briefly**

The pipe syntax:

```python
chain = prompt | model | parser
result = chain.invoke({"question": "..."})
```

What it buys you: `.stream()`, `.batch()` and `.ainvoke()` for free on anything you compose. Batching thirty questions asynchronously is genuinely useful and you would otherwise write it yourself.

What it costs: the pipeline becomes an object rather than code you can step through. Put a `print` in the middle of a pipe and you cannot.

**The deprecation problem, said plainly**

LangChain has moved fast and broken things repeatedly. Tutorials six months old often do not run. Agent abstractions were superseded by LangGraph. Memory classes were deprecated.

That is a real cost of adoption, not a complaint. **Pin your versions**, prefer the current official docs over blog posts, and when something does not exist any more, check the current API rather than assuming you made a mistake.

---

## 5. Setup

```bash
cd research-assistant/ai
source venv/bin/activate

pip install langchain-community langchain-text-splitters pypdf
pip freeze > requirements.txt

touch lc_compare.py
```

You already have `langchain-openai` from Day 16. Install the pieces you are testing, not the whole ecosystem.

---

## 6. Build it

---

### Stage 1 — Loaders: adopt without hesitation

Your `read_any` handles `.txt` and `.pdf`. LangChain handles a hundred formats:

```python
from langchain_community.document_loaders import (
    PyPDFLoader, TextLoader, Docx2txtLoader, UnstructuredMarkdownLoader,
    CSVLoader, DirectoryLoader
)

loader = DirectoryLoader("documents", glob="**/*.pdf", loader_cls=PyPDFLoader)
docs = loader.load()

print(f"{len(docs)} pages")
print(docs[0].metadata)      # {'source': 'documents/plan.pdf', 'page': 0}
print(docs[0].page_content[:200])
```

**This is a clear adopt**, and the reason is in the second print. `PyPDFLoader` returns one `Document` per page with `source` and `page` already in the metadata.

You built that by hand on Day 5 — remember inserting `[Page N]` markers into the text so citations could work? This gives you the same thing as structured data instead of a string you have to parse back out.

**Why this fits the rule:** a loader is a connector to an external format. No prompt, no flow control, and you would have written it the same way. Take it.

One caution: metadata keys differ between loaders. `CSVLoader` gives you `row`, `PyPDFLoader` gives you `page`. Normalise to your own shape at the boundary rather than letting loader-specific keys spread through your code.

---

### Stage 2 — Splitters: measure, do not assume

Your `chunk_text` looks for paragraph breaks, then sentence breaks. `RecursiveCharacterTextSplitter` does the same idea with a priority list:

```python
from langchain_text_splitters import RecursiveCharacterTextSplitter

splitter = RecursiveCharacterTextSplitter(
    chunk_size=1000,
    chunk_overlap=150,
    separators=["\n\n", "\n", ". ", " ", ""],
)
chunks = splitter.split_documents(docs)
```

It tries each separator in order, falling back to the next when a chunk is still too large. Yours tried two levels; this tries five.

**Now the important part — measure it**, using Day 12's golden set:

```python
# lc_compare.py
from golden_set import GOLDEN
from retrieval import evaluate
from documents import chunk_text as my_splitter

# index your documents twice, once with each splitter,
# into two separate Chroma collections, then:

evaluate(search_with_my_chunks,        "my splitter")
evaluate(search_with_langchain_chunks, "RecursiveCharacterTextSplitter")
```

You will get something like:

```
my splitter                      recall@5: 12/15 (80%)  MRR: 0.556
RecursiveCharacterTextSplitter   recall@5: 13/15 (87%)  MRR: 0.601
```

**A real improvement, measured.** Adopt it — and notice that you could only make that call because you built the golden set on Day 12.

Also try `MarkdownHeaderTextSplitter`, which splits on headings and keeps the heading in the metadata. If your documents have structure, that is often a bigger win than any retrieval tuning, because chunks stop straddling section boundaries.

---

### Stage 3 — Retrievers: your Day 12, as objects

```python
from langchain_community.retrievers import BM25Retriever
from langchain.retrievers import EnsembleRetriever, ContextualCompressionRetriever
from langchain.retrievers.document_compressors import CrossEncoderReranker
from langchain_community.cross_encoders import HuggingFaceCrossEncoder

bm25 = BM25Retriever.from_documents(chunks)
bm25.k = 20

vector = chroma_store.as_retriever(search_kwargs={"k": 20})

ensemble = EnsembleRetriever(retrievers=[bm25, vector], weights=[0.4, 0.6])

reranker = CrossEncoderReranker(
    model=HuggingFaceCrossEncoder(model_name="cross-encoder/ms-marco-MiniLM-L-6-v2"),
    top_n=5
)

pipeline = ContextualCompressionRetriever(
    base_compressor=reranker,
    base_retriever=ensemble
)

results = pipeline.invoke("what were the earnings last quarter")
```

**Nine lines replacing about eighty of yours.** And you understand every one, because you wrote the eighty.

`EnsembleRetriever` is your RRF. `CrossEncoderReranker` is your cross-encoder stage. Same models, same algorithms.

**One real difference:** `weights=[0.4, 0.6]` lets you favour one retriever. Your RRF weighted both equally. Try it — on documents heavy with codes and part numbers, pushing BM25 up often helps.

**Measure it against yours** before switching. Same golden set, same numbers. You will probably find them equal, which makes it a maintenance decision rather than a quality one: nine lines you did not write versus eighty you fully control.

**Where I would land:** adopt the retrievers, keep your own `verify_citations` and provenance handling around them. The retrievers are a well-defined transformation. The citation logic is your product.

---

### Stage 4 — Output parsers: a quiet adopt

```python
from langchain_core.output_parsers import PydanticOutputParser
from langchain_core.prompts import ChatPromptTemplate
from pydantic import BaseModel, Field


class ResearchPlan(BaseModel):
    answerable: bool = Field(description="Whether this can be researched")
    reason: str = Field(description="If not answerable, why")
    sub_questions: list[str] = Field(description="2-4 independently searchable questions")


parser = PydanticOutputParser(pydantic_object=ResearchPlan)

prompt = ChatPromptTemplate.from_messages([
    ("system", "Break the question into sub-questions.\n{format_instructions}"),
    ("user", "{question}")
]).partial(format_instructions=parser.get_format_instructions())

chain = prompt | llm | parser

plan = chain.invoke({"question": "What do my documents say about deadlines?"})
print(plan.sub_questions)     # a real list, on a typed object
```

**This is better than your Day 18 version**, and the reason is types. You get a validated object, not a dict you hope has the right keys. A missing field is an error at parse time rather than a `KeyError` three functions later.

Wrap it in `OutputFixingParser` and a malformed response gets one automatic repair attempt — your Day 15 `json_with_repair`, already built.

**Why it fits the rule:** the format instructions are generated from your schema, and you can print them. No hidden prompt, and the transformation is well-defined.

---

### Stage 5 — LCEL, and what it hides

Build the same thing three ways, then look at all three:

```python
# 1. Yours
raw = client.chat.completions.create(model=..., messages=[...])
result = json.loads(raw.choices[0].message.content)

# 2. LCEL
chain = prompt | llm | parser
result = chain.invoke({"question": q})

# 3. LCEL with batching
results = chain.batch([{"question": q} for q in twenty_questions])
```

**Version 3 is the argument for LCEL.** Twenty questions run concurrently, one line. You would write that yourself with asyncio, as you did on Day 14.

**Now open the box:**

```python
import langchain
langchain.debug = True
chain.invoke({"question": "test"})
```

Read the actual prompt. The format instructions are there — fine, you generated those. **Look for anything else you did not write.**

Then try to debug it. Put a print between `prompt` and `llm`. You cannot, not directly — you need `RunnableLambda`:

```python
from langchain_core.runnables import RunnableLambda

def peek(x):
    print("SENDING:", x)
    return x

chain = prompt | RunnableLambda(peek) | llm | parser
```

**That extra step is the tax.** In your own code you write `print()`. Here you wrap a function in a class to inspect your own data.

**So use LCEL where composition is the point** — batching, streaming, parallel branches. Write plain code where the logic is the point.

---

### Stage 6 — Write your own adoption table

The deliverable. Go through your project and decide, with evidence. `research/DECISIONS.md`:

```markdown
## LangChain adoption (Day 19)

ADOPTED
- DirectoryLoader + PyPDFLoader: replaces documents.py readers.
  Gives per-page Documents with source/page metadata for free.
  Was: hand-inserted [Page N] markers parsed back out of a string.

- RecursiveCharacterTextSplitter: replaces chunk_text.
  Measured: 80% -> 87% recall@5 on the golden set. Real improvement.

- EnsembleRetriever + CrossEncoderReranker: replaces hybrid_search
  and reranked_search. Measured equal. Adopted for maintenance, not
  quality. Weights [0.4, 0.6] favour vector slightly; retest on new docs.

- PydanticOutputParser: replaces hand-rolled JSON parsing in pipeline.py.
  Typed and validated, fails at the right place.

- Callbacks: wired into observability.py logging.

NOT ADOPTED
- LangChain agents: superseded by LangGraph, which we already use.
- LangChain memory classes: our Day 11 memory does relevance-based recall
  with fact extraction and conflict resolution. Theirs does not.
- Vector store wrapper: we use Chroma directly. The wrapper adds a layer
  and no capability.
- LCEL for the research pipeline: the flow is the product and we want to
  read it as ordinary code. Using LCEL only for batch evaluation runs.

KEPT AS OURS, DELIBERATELY
- verify_citations: this is the product. No library version exists.
- Day 9 budgets (steps, tokens, wall clock) and Day 13 permission tiers.
  No framework provides these.
- The prompts. Every one.

VERSIONS PINNED: see requirements.txt. LangChain moves fast.
```

**That last section matters most.** Notice what you kept: the citation verification, the budgets, the permission model, the prompts. Those are the things nobody can give you, because they are specific to what you are building.

**Frameworks give you plumbing. They cannot give you the product.**

---

## 7. Words I heard today

| Word | Plain meaning |
|---|---|
| **LangChain vs LangGraph** | Components versus control flow. Different things. |
| **Document loader** | A reader for a file format. |
| **Document** | LangChain's object: `page_content` plus `metadata`. |
| **Text splitter** | A chunking strategy. |
| **Retriever** | Anything with `.invoke(query)` returning documents. |
| **EnsembleRetriever** | Your hybrid RRF search. |
| **ContextualCompressionRetriever** | Filter or rerank after retrieval. |
| **LCEL** | The pipe composition syntax. |
| **Runnable** | Anything composable with `|`. |
| **Output parser** | Turns model text into a validated object. |
| **Callbacks** | Hooks on every call. Your observability. |
| **Deprecation churn** | The cost of adopting a fast-moving library. |

---

## 8. Break it on purpose

**1. Splitter shoot-out.**
Your `chunk_text` versus `RecursiveCharacterTextSplitter`, on the golden set.
*You will see:* a measurable difference.
*It teaches:* adoption decisions can be evidence-based. Most people's are not.

**2. Print inside a chain.**
Try to inspect what goes into `llm` in a `prompt | llm | parser` chain.
*You will see:* you need `RunnableLambda`.
*It teaches:* the visibility cost of abstraction, felt directly.

**3. Batch versus loop.**
Twenty questions through `chain.batch()` and through your own for-loop.
*You will see:* a large time difference.
*It teaches:* the real argument for LCEL.

**4. Weight the ensemble.**
`[0.9, 0.1]` then `[0.1, 0.9]`. Measure both.
*You will see:* different failures — exact codes versus paraphrases.
*It teaches:* Day 12's sparse-dense trade, now as a dial.

**5. Follow a stale tutorial.**
Find a LangChain agent tutorial from a year ago and run it.
*You will see:* imports that no longer exist.
*It teaches:* deprecation churn is a real adoption cost, not a grumble.

**6. Count the wrapper tokens.**
`langchain.debug = True` on an output-parser chain. Count the format instructions.
*You will see:* a few hundred tokens per call.
*It teaches:* convenience has a token price. Sometimes worth it.

---

## 9. Traps

**Trap 1 — adopting wholesale**
*Symptom:* your whole system is framework objects and you cannot find your own logic.
*Fix:* the rule in section 3. Component by component, with measurements.

**Trap 2 — deprecated imports**
*Symptom:* tutorials that do not run.
*Fix:* pin versions, use current docs, check the API before assuming you made a mistake.

**Trap 3 — hidden prompts**
*Symptom:* strange output from a component you did not write a prompt for.
*Fix:* `langchain.debug = True` before adopting anything. If it contains a prompt you did not write, think hard.

**Trap 4 — debugging through layers**
*Symptom:* an hour spent finding where a value became wrong.
*Fix:* keep the parts you debug most as plain code.

**Trap 5 — confusing LangChain with LangGraph**
*Symptom:* looking for agent loops in the wrong library.
*Fix:* components versus control flow. Different tools.

**Trap 6 — metadata that leaks**
*Symptom:* code full of `doc.metadata.get("page") or doc.metadata.get("row")`.
*Cause:* different loaders use different keys.
*Fix:* normalise to your own shape at the boundary, once.

---

## 10. Check yourself

1. State the adopt-or-skip rule in one sentence, and give an example of each.
2. What is the difference between LangChain and LangGraph?
3. What does LCEL buy, and what does it cost?
4. You are considering a splitter swap. What do you do before deciding?
5. Name three things you deliberately kept as your own, and why no framework provides them.

---

## 11. Where this goes

- **Day 20** deploys it. Fewer hand-written components means less to maintain in production — and the loaders make ingesting user-uploaded files far simpler.
- **Day 21** is the platform. Today's adoption table is part of the story you tell about why it is built the way it is.
- **Beyond:** the rule from section 3 outlives LangChain. Every framework you meet gets the same two questions — does it contain a prompt, and does it control flow you care about.

---

## 12. PROJECT STATE

```
PROJECT STATE after Day 19:

Folders:
  research-assistant/
    ai/
      lc_compare.py        (NEW - splitter and retriever comparisons)
      research/
        DECISIONS.md       (NOW includes the LangChain adoption table)
        sources.py         (retrievers swapped to LangChain equivalents)
        pipeline.py        (plan() now uses PydanticOutputParser)
      documents.py         (loaders replaced with LangChain loaders)
      retrieval.py         (own implementations KEPT alongside, for reference
                            and because evaluate() still uses them)
      observability.py     (now also receives LangChain callbacks)
      evals.py, reliability.py, golden_set.py, logs/
      vector_store.py, embeddings.py, tools.py, memory.py, security.py
      graph_agent.py, crew_agent.py, multi_agent.py
      chat.py, agent.py, autonomous.py, planner.py
      mcp_agent.py, mcp_client.py, mcp_servers/my_tools.py
      prompts.py, classify.py, test_prompt.py
      runs/, notes/, documents/, chroma_db/
    dashboard/             (STILL EMPTY - Node arrives tomorrow)

Libraries: langchain-community, langchain-text-splitters (NEW).
langchain-openai already present from Day 16. Versions PINNED - LangChain
moves fast and breaks tutorials.

THE RULE (the real deliverable of Day 19):
  ADOPT if it connects to something external, or performs a well-defined
       transformation you would have written identically.
  SKIP  if it contains a prompt, or controls flow you care about.

ADOPTED, with reasons:
  DirectoryLoader + PyPDFLoader
      per-page Documents with source/page metadata as structured data,
      replacing hand-inserted [Page N] markers parsed back out of a string
  RecursiveCharacterTextSplitter
      MEASURED on the Day 12 golden set: 80% -> 87% recall@5. Real gain.
      (MarkdownHeaderTextSplitter worth trying on structured documents)
  EnsembleRetriever + CrossEncoderReranker + ContextualCompressionRetriever
      9 lines replacing ~80 of ours. Measured EQUAL, so adopted for
      maintenance rather than quality. weights=[0.4, 0.6] is a dial our
      RRF did not have; raise BM25 for code-heavy documents.
  PydanticOutputParser (+ OutputFixingParser)
      typed validated objects instead of dicts we hope have the right keys;
      failures surface at parse time, not three functions later
  Callbacks -> wired into observability.py

NOT ADOPTED:
  LangChain agents      - superseded by LangGraph, already in use
  LangChain memory      - our Day 11 memory does relevance recall, fact
                          extraction and conflict resolution; theirs does not
  vector store wrapper  - Chroma used directly; the wrapper adds a layer
                          and no capability
  LCEL for the pipeline - the flow IS the product and we want to read it as
                          ordinary code. LCEL used only for batch eval runs,
                          where .batch() over 20 questions is a genuine win.

KEPT AS OURS, DELIBERATELY:
  verify_citations      - this is the product; no library version exists
  Day 9 budgets (steps / tokens / wall clock)
  Day 13 permission tiers and least privilege
  every prompt

LangChain vs LangGraph: components vs control flow. Different libraries,
constantly confused.

Visibility cost measured:
  a print between prompt and llm in an LCEL chain requires RunnableLambda;
  in plain code it is print(). Every layer makes "what did it actually
  send" harder to answer, which is the question that matters most in
  debugging.

Known problems, left for later:
  - two implementations of retrieval now exist (ours and LangChain's);
    evaluate() still points at ours, which could drift from production
  - loader metadata keys differ per loader (page vs row); normalised at the
    boundary but easy to leak
  - framework format instructions add a few hundred tokens per call
```

---

## Answers

**1.** Adopt it if it connects to something external or performs a well-defined transformation you would have written identically; skip it if it contains a prompt or controls flow you care about. Adopt: `PyPDFLoader`. Skip: LangChain's agent abstractions.

**2.** LangChain is components — loaders, splitters, retrievers, parsers. LangGraph is control flow — nodes, edges, state, checkpointing. Either can be used without the other.

**3.** It buys `.stream()`, `.batch()` and `.ainvoke()` for free on anything you compose, which makes concurrent batch runs one line. It costs visibility: inspecting a value mid-chain needs a `RunnableLambda` where plain code needs a `print`.

**4.** Index your documents both ways and run the golden set against each. Adopt only if the numbers improve, or if they are equal and the maintenance saving is worth it.

**5.** Citation verification, the budget system, and the permission model — plus the prompts. No framework provides them because they are specific to what you are building and what you consider unacceptable. Frameworks give plumbing; the product is yours.
