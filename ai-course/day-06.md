# Day 6 — Build Your First RAG System

**Module:** 02 — AI Agents
**Time:** about 1 hour, plus a slow first install
**Builds on:** Day 5 — chunking, grounding, `search_documents`

---

## 1. Today in one line

You replace one function from yesterday, and your assistant starts finding things by **meaning** instead of by spelling.

---

## 2. The problem

Open the list of synonym failures you wrote down yesterday. If you skipped that, do it now — ask five questions using different words from the ones in your documents. You need these, because today is only satisfying if you watch them flip.

```
Document says: "revenue"        You asked: "earnings"       -> nothing found
Document says: "car"            You asked: "vehicle"        -> nothing found
Document says: "30 November"    You asked: "when is it due" -> nothing found
```

Yesterday's search compares letters. `revenue` and `earnings` share no words, so the score is zero, so the chunk is never sent, so the model never sees it. **The failure happens before the model is involved.** No prompt can rescue it.

What you need is a way to measure whether two pieces of text *mean* the same thing, without caring which words were used. That sounds like it should be hard. It turns out to be about thirty lines of code, and it is the single highest-value technique in this entire course.

It is called **RAG** — Retrieval Augmented Generation. A long name for a simple idea: find the right text, then hand it to the model.

---

## 3. Mental model

**Imagine a huge map, where every sentence ever written has a position on it.**

Sentences about money sit in one region. Sentences about cooking sit far away. And crucially, "our revenue grew 12%" and "our earnings rose 12%" sit almost on top of each other — because the map is organised by meaning, not by spelling.

To search, you put your **question** on the same map and look at what is nearby.

That is the entire idea. An **embedding** is just the coordinates of a piece of text on that map. Instead of two numbers like latitude and longitude, it uses a few hundred — but it is the same kind of thing: a position, where closeness means similarity.

**Where this comparison breaks, and it matters:**

**Close does not mean correct.** "I love this product" and "I hate this product" sit surprisingly close together, because they are about the same thing in the same shape. The map measures *aboutness* more than agreement. You will see this yourself in experiment 1, and it will change how much you trust retrieval.

**The map was drawn by someone else.** The positions come from a model trained on a big pile of internet text. Your company's internal jargon may sit in a strange place. A product code means nothing to it.

**Exact things get worse, not better.** Invoice number `INV-2024-8871` has a meaning-position, but so does `INV-2024-8872`, and they are nearly identical. Yesterday's keyword search finds an exact code perfectly. Today's cannot. This is why serious systems run both — which is Day 12.

---

## 4. How it really works

Four steps. Only step 3 is new; the rest you built yesterday.

**Step 1 — Turn text into numbers (embedding).**

You run each chunk through an **embedding model**. It gives back a list of numbers:

```
"our revenue grew 12%"  ->  [0.021, -0.118, 0.334, ... ]   384 numbers
```

This is a different model from your chat model. It does not talk. It only converts text into a position. It is small, so it runs on your own laptop, free, with no rate limits at all. That matters: you may need to embed thousands of chunks, and doing that through an API would eat your whole free tier.

The size — 384 numbers — is the **dimensions**. Think of it as a map with 384 directions instead of two. You cannot picture it, and you do not need to. The maths works the same.

**Step 2 — Store the numbers.**

Embedding is slow-ish. You do it once and save the result. That store is a **vector store**.

**Step 3 — Measure closeness (cosine similarity).**

Given two lists of numbers, how close are they? The standard measure is **cosine similarity**, which gives a number from -1 to 1:

```
1.0   identical meaning
0.7   strongly related
0.3   loosely related
0.0   unrelated
```

Here is what it does, in plain words: it ignores how *long* the two lists are and only asks whether they **point in the same direction**. That is why a one-line note and a whole paragraph about the same topic still score as similar — length does not distort it.

**Step 4 — Send the closest chunks to the model.**

Exactly like yesterday. Same grounding prompt, same citations, same `I don't know.` rule. Nothing there changes.

**The one rule you must not break:** the query and the documents have to be embedded by **the same model**. Two different models draw two different maps, and comparing a position on one map to a position on another is meaningless. It will not error. It will just quietly return nonsense.

---

## 5. Setup

Today's install is large. Be prepared.

```bash
cd research-assistant/ai
source venv/bin/activate

pip install sentence-transformers chromadb
```

**This downloads about 2 GB**, mostly PyTorch, which `sentence-transformers` sits on top of. On a slow connection it can take 10 minutes. Then the first time you run it, it downloads the embedding model itself, around 90 MB.

After that, everything is local and instant, forever. No API, no key, no limits.

**If disk space or RAM is tight**, there is a lighter path: `pip install fastembed` gives you the same models in a much smaller package, using ONNX instead of PyTorch. The API is slightly different, but the concepts in this lesson are identical. Use it if the big install is painful.

```bash
pip freeze > requirements.txt
```

---

## 6. Build it

---

### Stage 1 — Look at an embedding

Make `embeddings.py`:

```python
from sentence_transformers import SentenceTransformer

model = SentenceTransformer("all-MiniLM-L6-v2")

vector = model.encode("our revenue grew 12% last quarter")

print(type(vector))
print(vector.shape)
print(vector[:8])
```

Run it. First time, it downloads the model. Then:

```
<class 'numpy.ndarray'>
(384,)
[ 0.0213 -0.1184  0.3341 -0.0072  0.0918  0.1457 -0.2201  0.0339]
```

**That is it.** That is what an embedding is. A list of 384 numbers. There is nothing hidden — no text stored inside, no dictionary, no magic. Just a position.

Look at those numbers for a moment. They mean nothing individually. No single number is "the money number". The meaning is spread across all 384, which is why you can never inspect them and understand why something matched. This is a real limitation, and it is worth knowing early.

`all-MiniLM-L6-v2` is the standard starting model: small, fast, good enough, works on a plain laptop CPU. There are better ones and you can swap later — but if you swap, you must re-embed everything, because the map changes.

---

### Stage 2 — Measure closeness yourself

Before using a library that hides it, compute similarity by hand once.

```python
import numpy as np

def similarity(a, b):
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))


pairs = [
    ("our revenue grew 12%",        "our earnings rose 12%"),
    ("our revenue grew 12%",        "the cat sat on the mat"),
    ("the deadline is 30 November", "when is this due?"),
    ("I love this product",         "I hate this product"),
    ("car",                         "vehicle"),
]

for first, second in pairs:
    score = similarity(model.encode(first), model.encode(second))
    print(f"{score:.3f}   {first}  <->  {second}")
```

Run it. You should see roughly:

```
0.81   our revenue grew 12%  <->  our earnings rose 12%
0.03   our revenue grew 12%  <->  the cat sat on the mat
0.62   the deadline is 30 November  <->  when is this due?
0.71   I love this product  <->  I hate this product
0.64   car  <->  vehicle
```

**Stop and read line by line.**

Line 1: **0.81 between revenue and earnings.** Yesterday this scored zero. That is the whole day, in one number.

Line 3: 0.62 between a statement and a question that shares no meaningful words. The map understands what the question is *asking for*.

Line 4: **0.71 between love and hate.** This is the warning from section 3, and here it is in your own terminal. Opposites are close, because they are about the same thing in the same shape. Retrieval finds relevant text — it does not find *correct* text. The model still has to read it and work out what it says.

**The maths, briefly.** `np.dot(a, b)` multiplies the lists together and sums the result — big when they point the same way. Dividing by both lengths (`np.linalg.norm`) removes the effect of size, leaving only direction. Three lines, and it is the engine under every vector database on earth.

---

### Stage 3 — Search your own documents by meaning

Now replace yesterday's keyword search. Add to `embeddings.py`:

```python
import numpy as np
from documents import load_all_documents, chunk_text

_model = None
_chunks = []
_vectors = None


def get_model():
    global _model
    if _model is None:
        _model = SentenceTransformer("all-MiniLM-L6-v2")
    return _model


def build_index(folder="documents"):
    """Read, chunk and embed everything once."""
    global _chunks, _vectors

    _chunks = []
    for name, text in load_all_documents(folder).items():
        for chunk in chunk_text(text):
            _chunks.append(f"[From: {name}]\n{chunk}")

    print(f"Embedding {len(_chunks)} chunks...")
    _vectors = get_model().encode(_chunks, show_progress_bar=True)
    print("Done.")


def semantic_search(question, top_n=3):
    if _vectors is None:
        build_index()

    question_vector = get_model().encode(question)

    scores = np.dot(_vectors, question_vector) / (
        np.linalg.norm(_vectors, axis=1) * np.linalg.norm(question_vector)
    )

    best = np.argsort(scores)[::-1][:top_n]
    return [(float(scores[i]), _chunks[i]) for i in best]


if __name__ == "__main__":
    build_index()
    while True:
        q = input("\nSearch: ")
        if q.lower() in ["quit", "exit"]:
            break
        for score, chunk in semantic_search(q):
            print(f"\n[{score:.3f}] {chunk[:250]}...")
```

**The parts worth understanding:**

- `encode(_chunks)` with a **list** embeds them all in one batch. Far faster than one at a time.
- `np.dot(_vectors, question_vector)` — one line comparing your question against *every* chunk at once. `_vectors` is a grid of 384-number rows; numpy multiplies the whole grid in a single operation. This is why vector search stays fast with thousands of chunks.
- `np.argsort(scores)[::-1][:top_n]` — sort positions by score, reverse for highest first, take the top few.
- Returning the **score alongside the chunk**. Do not hide it. You want to see when your best match scored 0.21 and is probably rubbish.

Run it, and **go through your five synonym failures from yesterday, one by one.**

```
Search: what were the earnings?
[0.734] [From: report.pdf] [Page 2] Revenue for the quarter grew...
```

There it is. Same document, same chunking, same everything — one function replaced, and the wall is gone.

---

### Stage 4 — Stop re-embedding every time

Restart your script. It embeds everything again. With 500 chunks that is a minute of waiting, every single run.

Save it instead. Chroma does this with almost no code. Make `vector_store.py`:

```python
import chromadb
from chromadb.utils import embedding_functions
from documents import load_all_documents, chunk_text

client = chromadb.PersistentClient(path="./chroma_db")

embedder = embedding_functions.SentenceTransformerEmbeddingFunction(
    model_name="all-MiniLM-L6-v2"
)

collection = client.get_or_create_collection(
    name="documents",
    embedding_function=embedder
)


def index_documents(folder="documents"):
    ids, texts, metadatas = [], [], []

    for name, text in load_all_documents(folder).items():
        for number, chunk in enumerate(chunk_text(text)):
            ids.append(f"{name}::{number}")
            texts.append(chunk)
            metadatas.append({"source": name, "chunk": number})

    collection.upsert(ids=ids, documents=texts, metadatas=metadatas)
    print(f"Indexed {len(ids)} chunks. Total stored: {collection.count()}")


def search(question, top_n=3):
    results = collection.query(query_texts=[question], n_results=top_n)

    found = []
    for text, meta, distance in zip(results["documents"][0],
                                    results["metadatas"][0],
                                    results["distances"][0]):
        found.append({
            "text": text,
            "source": meta["source"],
            "score": 1 - distance
        })
    return found


if __name__ == "__main__":
    index_documents()
    for hit in search("what were the earnings?"):
        print(f"\n[{hit['score']:.3f}] {hit['source']}\n{hit['text'][:200]}...")
```

**What Chroma is doing for you:**

- `PersistentClient(path="./chroma_db")` — writes to disk. Restart and your embeddings are still there.
- `embedding_function` — Chroma calls the same model for you, so you pass text in and text out. **This is also a safety feature**: the collection remembers which model it was built with, so you cannot accidentally mix two maps.
- `upsert` rather than `add` — running it twice updates instead of creating duplicates. `add` would give you every chunk twice, and your search results would come back in pairs.
- `ids=f"{name}::{number}"` — stable ids. Re-index after editing a file and the chunks are replaced, not duplicated.
- `metadatas` — extra information travelling with each chunk. You are only storing the filename now; on Day 12 this is how you filter by date, author or document type.
- `1 - distance` — Chroma returns *distance* (smaller is closer), not similarity. Flipping it keeps the "higher is better" feel of Stage 3. Getting this backwards is a very common and very confusing bug.

Add `chroma_db/` to your `.gitignore`.

---

### Stage 5 — Plug it into the assistant

One function changes in `tools.py`. That is all.

```python
from vector_store import search as vector_search


def search_documents(query):
    """Search the user's documents by meaning."""
    hits = vector_search(query, top_n=3)

    if not hits or hits[0]["score"] < 0.25:
        return "Nothing in the user's documents is relevant to that."

    parts = []
    for hit in hits:
        parts.append(f"[Source: {hit['source']}, relevance {hit['score']:.2f}]\n{hit['text']}")
    return "\n\n---\n\n".join(parts)
```

Now update the tool description, because yesterday's had an apology built into it:

```python
"description": "Search the user's own documents, notes and PDFs by meaning. You can use natural language and do not need to guess the exact words used in the document. Use this whenever the question might involve the user's personal files or anything you would not know from general knowledge."
```

**Delete that old line** begging the model to use the document's own vocabulary. It is not needed any more. That deletion is the clearest possible sign of what you built today.

**About that `0.25` threshold.** It is a guess, and you should treat it as one. Similarity scores are relative, not absolute — there is no universal number above which a match is "good". The right threshold depends on your documents, your chunk size and your embedding model. Find yours by printing scores for questions you know the answers to, and questions you know are unanswerable, then picking a line between them. Doing this properly is part of Day 12.

Run `chat.py` and ask about your documents using completely different wording from the files. It finds them.

---

### Stage 6 — Find where it still fails

You have built something genuinely useful. Now go and find its edges, before they find you.

Try these four:

**1. An exact code.** If your documents contain an invoice number, order id or version number, search for it exactly.
*Often worse than yesterday.* Meaning-search sees `INV-2024-8871` and `INV-2024-8872` as nearly identical. Keyword search nails it.

**2. Negation.** "Which projects are *not* delayed?"
*Usually fails.* It retrieves chunks about delayed projects, because that is what the question is about. The word "not" barely moves the position.

**3. Counting.** "How many times is the budget mentioned?"
*Fails.* It only ever sees three chunks. It cannot count what it was not shown.

**4. Something that needs two documents at once.** "How does the plan compare to the report?"
*Usually poor.* Top 3 chunks might all come from one file.

**None of these are bugs in your code.** They are the honest limits of simple RAG, and every one of them has a name and a fix:

- Exact codes → **hybrid search**, running keyword and vector together (Day 12)
- Counting and comparing → the **agent** deciding to search several times (Day 7, three days' work away)
- Better ranking → **re-ranking** (Day 12)

Write these four failures down, the same way you wrote down the synonym failures yesterday. You will re-test them on Day 12.

---

## 7. Words I heard today

| Word | Plain meaning |
|---|---|
| **Embedding** | A list of numbers giving the position of a piece of text on a map of meaning. |
| **Vector** | The same thing. A list of numbers. |
| **Dimensions** | How many numbers. 384 for our model. |
| **Embedding model** | A small model that converts text to a position. Does not talk. |
| **Cosine similarity** | Closeness measure from -1 to 1, based on direction not size. |
| **Semantic search** | Searching by meaning instead of by words. |
| **Vector store** | A database of embeddings you can search quickly. |
| **Index / indexing** | Reading, chunking and embedding everything in advance. |
| **top_k / top_n** | How many results to return. |
| **RAG** | Retrieval Augmented Generation. Find relevant text, then answer with it. |
| **Distance** | The opposite of similarity. Smaller is closer. Chroma returns this. |
| **Upsert** | Insert or update. Safe to run twice. |
| **Metadata** | Extra information stored alongside each chunk. |
| **Hybrid search** | Keyword and vector search combined. Day 12. |

---

## 8. Break it on purpose

**1. Test the opposite problem.**
Score these pairs: "the meeting is confirmed" / "the meeting is cancelled"; "profits rose" / "profits fell".
*You will see:* high similarity for opposite meanings.
*It teaches:* retrieval finds relevant passages, not correct ones. The reading is still the model's job. This is the most important thing on this page.

**2. Mix the maps.**
Embed your documents with `all-MiniLM-L6-v2` and your query with a different model. Search.
*You will see:* meaningless results, and **no error at all**.
*It teaches:* the silent failure mode. This is why Chroma binds the model to the collection.

**3. Turn the dial on chunk size.**
Re-index with `chunk_size=200`, then `chunk_size=3000`. Run the same five questions.
*You will see:* small chunks match precisely but lack surrounding context, so answers are thin. Large chunks carry context but blur the meaning, so ranking gets worse.
*It teaches:* chunk size affects retrieval quality as much as prompt wording. Day 12 has real strategies.

**4. Ask for more.**
Set `top_n=10`. Watch `prompt_tokens`.
*You will see:* better recall, and a token count that may blow your free tier in one question.
*It teaches:* `top_n` is a direct trade between finding things and affording things.

**5. Cross languages.**
If you speak another language, put a document in it and ask in English.
*You will see:* with this model, poor results. Multilingual embedding models exist and are a straight swap.
*It teaches:* the map's coverage depends entirely on what it was trained on.

**6. Race yesterday against today.**
Keep both `search_chunks` and `semantic_search`. Run ten questions through each and record which wins.
*You will see:* vector wins on paraphrasing, keyword wins on exact names and codes.
*It teaches:* why hybrid search exists, from your own data rather than from being told.

---

## 9. Traps

**Trap 1 — two maps, no error**
*Symptom:* search returns confident nonsense.
*Cause:* query and documents embedded with different models.
*Fix:* one model, defined in one place. Let Chroma hold it.

**Trap 2 — distance read as similarity**
*Symptom:* your worst results rank first.
*Cause:* Chroma returns distance; small is good. If you sort as if bigger is better, you get it exactly backwards.
*Fix:* convert once, at the boundary, as in `search()`.

**Trap 3 — duplicate chunks**
*Symptom:* the same passage appears three times in your results, crowding out everything else.
*Cause:* `add` instead of `upsert`, or unstable ids, run repeatedly.
*Fix:* `upsert` with stable `filename::number` ids.

**Trap 4 — re-embedding on every start**
*Symptom:* a minute of waiting each run, and it gets worse as documents grow.
*Fix:* `PersistentClient`. Index when documents change, not when the program starts.

**Trap 5 — a threshold that does not travel**
*Symptom:* `0.25` works beautifully on your documents and badly on someone else's.
*Cause:* scores are relative to your data and your model.
*Fix:* measure it. Print scores for known-good and known-bad questions, and set the line between them. Re-measure whenever you change model or chunk size.

**Trap 6 — assuming retrieval is the answer**
*Symptom:* a fluent, wrong answer, with a citation attached.
*Cause:* the top chunk was about the right topic but said something different — see experiment 1.
*Fix:* keep the grounding prompt from Day 5, keep the citations, and open the source occasionally to check. An unverified citation is decoration.

---

## 10. Check yourself

1. What is an embedding, concretely? What does the model give you back?
2. Why must the query and the documents use the same embedding model, and what happens if they do not?
3. "I love this" and "I hate this" score 0.71. Why, and what does that tell you about what retrieval can and cannot do?
4. Why is the embedding model run on your laptop rather than through the API?
5. Yesterday's keyword search beats today's on one kind of question. Which kind, and why?

---

## 11. Where this goes

- **Day 7 is tomorrow and it is the big one.** Right now your assistant searches *once* and answers. An agent can search, read the result, notice it is missing something, and search again with better words. Several of today's failures are fixed not by better retrieval but by *repeated* retrieval.
- **Day 11** uses embeddings on conversation history — remembering what matters instead of what is recent. The exact problem you hit on Day 2.
- **Day 12** is this day done properly: hybrid search, re-ranking, better chunking, metadata filtering, and measuring retrieval quality instead of guessing.
- **Day 18 and 21** build the research platform on top of this. The vector store you created today is a real piece of the capstone.

---

## 12. PROJECT STATE

```
PROJECT STATE after Day 6:

Folders:
  research-assistant/
    ai/
      venv/, .env, .gitignore (now includes chroma_db/), requirements.txt
      chat.py, prompts.py, classify.py, test_prompt.py
      tools.py             (search_documents now uses the vector store)
      tool_test.py
      documents.py         (Day 5 - reading and chunking, unchanged)
      ask_document.py
      embeddings.py        (NEW - raw embedding + hand-written cosine search)
      vector_store.py      (NEW - Chroma, persistent)
      chroma_db/           (NEW - saved embeddings, gitignored)
      conversation.json, notes/, documents/
    dashboard/             (still empty)

Libraries: openai, python-dotenv, pypdf,
           sentence-transformers (NEW, ~2GB with torch),
           chromadb (NEW), numpy

Embedding model: all-MiniLM-L6-v2, 384 dimensions, runs locally on CPU.
Free, no API, no rate limits. Chat model unchanged (Groq llama-3.3-70b).

embeddings.py:
  get_model(), build_index(), semantic_search(question, top_n)
  similarity(a, b) written by hand with numpy, kept for understanding

vector_store.py:
  chromadb.PersistentClient(path="./chroma_db")
  collection "documents" bound to the embedding function, so query and
  documents can never use different models
  index_documents()  - upsert with stable ids "filename::chunknumber"
  search(question)   - returns dicts with text, source, score (1 - distance)

tools.py:
  search_documents(query) now calls vector_store.search
  returns "nothing relevant" when top score < 0.25 (a GUESSED threshold,
  needs measuring properly on Day 12)
  tool description rewritten: the old plea to "use the document's own
  vocabulary" was deleted, because synonyms now work

Key decisions made:
  - embeddings run locally so indexing thousands of chunks costs nothing
  - similarity computed by hand once before using a library
  - relevance scores always shown, never hidden
  - upsert + stable ids so re-indexing never duplicates
  - distance converted to similarity at one boundary only

Verified working:
  - the 5 synonym failures from Day 5 now all return the right chunk
    (revenue/earnings, car/vehicle, "when is it due" etc.)

Known problems, written down to re-test on Day 12:
  - exact codes and ids are now WORSE than keyword search (INV-2024-8871
    vs -8872 look almost identical) -> needs hybrid search
  - negation fails ("which projects are NOT delayed")
  - counting fails ("how many times is X mentioned") - only 3 chunks seen
  - cross-document comparison is poor, top 3 often all from one file
  - 0.25 threshold is a guess, not measured
  - opposites score high (love/hate 0.71); retrieval finds relevant text,
    not correct text
```

---

## Answers

**1.** A list of numbers — 384 of them with this model — describing where a piece of text sits on a map of meaning. Nothing is stored inside it: no words, no dictionary. Just a position, where closeness means similar meaning.

**2.** Because each model draws its own map. A position on one map compared to a position on another is meaningless. It produces no error, just quietly wrong results, which makes it one of the nastier bugs to find.

**3.** Because the map measures what text is *about* and how it is shaped, more than what it claims. Both sentences concern the same product in the same form. It tells you retrieval finds relevant passages, not correct ones — working out what the passage actually says is still the model's job.

**4.** Because indexing means embedding thousands of chunks, and an API would burn your entire free tier doing it. The embedding model is small enough to run on a normal CPU, so it is free, unlimited and instant after the first download.

**5.** Exact strings: codes, ids, part numbers, precise names. Keyword search matches them perfectly. Meaning-search sees `INV-2024-8871` and `INV-2024-8872` as almost the same position, because they are almost the same text. Running both together is called hybrid search.
