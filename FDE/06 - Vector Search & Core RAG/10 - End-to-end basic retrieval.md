# Vector Search & Core RAG

## End-to-end basic retrieval

> Core | Fast CP3 / Slow CP4 | ~1.2 h | Builds on: M06-01, M06-03, M06-06, M06-08

### Kahani
Retail customer ne Friday ko bola: "Monday ko leadership demo hai -- hamare policy PDFs pe ek bot dikhao jo citations ke saath answer de." Aapke paas ab chunking, embeddings, index, filters -- sab alag-alag pieces hain.
Pichhle FDE ne aisa hi demo banaya tha: answer sahi lagta tha, lekin "kahan likha hai?" poocha to bot ne page number hallucinate kar diya, aur "gift cards" pe confident galat jawab diya.
Is baar pipeline end-to-end chahiye: PDF se citation tak, aur "nahi mila" bolne ki himmat bhi.

### What it is
**Basic retrieval pipeline** = ingest (extract -> clean -> chunk -> embed -> index with metadata) aur query (embed query -> filter -> top-k -> prompt with cited context -> LLM).
Ye RAG ka "R" hai. Answer quality ka ceiling yahin set hota hai -- LLM sirf wahi bol sakta hai jo context mein aaya.

### Why it matters for an FDE
Customer demo mein sabse pehle citations aur "not found" behaviour check hota hai. Pipeline ke har stage ko alag test kar sako to bug 10 minute mein milta hai; ek monolithic script mein poora din.

### Key concepts
- **Ingest vs query path** -- ingest offline/batch (slow, ek baar), query online (fast, har request). Dono same tokenizer/embedder use karein.
- **Provenance metadata** -- har chunk ke saath `doc_id`, `page`, `tenant`; citations aur filtering isi se.
- **Contextual chunk header** -- section title ko har chunk ke aage jodo ("Warranty: Batteries are covered..."); chhote chunks ka context bachta hai.
- **Score floor** -- `min_score` ke neeche results drop; empty context pe LLM ko "not found" bolna hai, guess nahi.
- **Grounded prompt** -- "answer only from context, cite [doc pN], say if not found".

### Code example
`pip install numpy pypdf fpdf2`

> Needs API key for the real version: ANTHROPIC_API_KEY (or OPENAI_API_KEY)

```python
# runnable
import re
import tempfile
import zlib
from pathlib import Path

import numpy as np
from fpdf import FPDF
from pypdf import PdfReader

PAGES = [
    "Returns Policy. Items can be returned within 30 days. Opened electronics are not returnable.",
    "Shipping. Standard delivery takes 5 business days. Express delivery takes 2 business days.",
    "Warranty. Laptops have a 1 year warranty. Batteries are covered for 6 months.",
]

def make_messy_pdf(path):
    pdf = FPDF()
    for i, text in enumerate(PAGES, 1):
        pdf.add_page()
        pdf.set_font("Helvetica", size=11)
        pdf.cell(0, 8, "ACME Retail -- INTERNAL", new_x="LMARGIN", new_y="NEXT")   # repeated header
        pdf.multi_cell(0, 6, text)
        pdf.cell(0, 8, f"Page {i} of {len(PAGES)}")                               # repeated footer
    pdf.output(str(path))

def extract(path, doc_id):
    for page_no, page in enumerate(PdfReader(str(path)).pages, 1):
        text = page.extract_text() or ""
        text = re.sub(r"ACME Retail -- INTERNAL|Page \d+ of \d+", " ", text)       # strip boilerplate
        sents = [s for s in re.split(r"(?<=\.)\s+", " ".join(text.split())) if s.strip()]
        heading = sents[0].rstrip(".")                                              # first line = section title
        for sent in sents[1:]:                                                      # prefix it to every chunk
            yield {"doc_id": doc_id, "page": page_no, "tenant": "acme", "text": f"{heading}: {sent}"}

STOP = {"the", "a", "are", "is", "can", "be", "how", "do", "does", "what", "for", "of", "have", "take", "takes"}

def toy_embed(text, dim=512):
    """TOY embedder: hashed bag-of-words, L2-normalised. Word overlap only, NOT meaning."""
    v = np.zeros(dim)
    for w in re.findall(r"[a-z0-9]+", text.lower()):
        if w not in STOP:
            w = re.sub(r"ies$", "y", w).rstrip("s")                                   # crude stemming
            v[zlib.crc32(w.encode()) % dim] += 1
    return v / (np.linalg.norm(v) or 1)

class Retriever:
    def __init__(self, chunks):
        self.chunks = chunks
        self.M = np.stack([toy_embed(c["text"]) for c in chunks])
    def search(self, query, tenant, k=3, min_score=0.15):
        allowed = [i for i, c in enumerate(self.chunks) if c["tenant"] == tenant]
        scores = self.M[allowed] @ toy_embed(query)
        order = np.argsort(-scores)[:k]
        return [{**self.chunks[allowed[j]], "score": round(float(scores[j]), 3)}
                for j in order if scores[j] >= min_score]

def build_prompt(query, hits):
    ctx = "\n".join(f"[{h['doc_id']} p{h['page']}] {h['text']}" for h in hits)
    return f"Answer only from the context. Cite like [doc pN]. If not found, say so.\n\n{ctx}\n\nQ: {query}"

class FakeLLM:
    """Stand-in for client.messages.create(...): echoes the first context line as the 'answer'."""
    def answer(self, prompt):
        lines = [l for l in prompt.splitlines() if l.startswith("[")]
        return lines[0] if lines else "I could not find this in the documents."

with tempfile.TemporaryDirectory() as tmp:
    pdf_path = Path(tmp) / "acme_policies.pdf"
    make_messy_pdf(pdf_path)
    chunks = list(extract(pdf_path, "acme_policies"))

retriever, llm = Retriever(chunks), FakeLLM()
print(f"{len(chunks)} chunks from {len(PAGES)} pages")
for q in ["How long does express delivery take?", "Is the battery under warranty?", "Do you sell gift cards?"]:
    hits = retriever.search(q, tenant="acme")
    print(f"Q: {q}\n   hits={[(h['page'], h['score']) for h in hits]}\n   A: {llm.answer(build_prompt(q, hits))}")

assert not any("INTERNAL" in c["text"] or "Page 1" in c["text"] for c in chunks)
assert retriever.search("express delivery", "acme")[0]["page"] == 2
assert retriever.search("battery warranty", "acme")[0]["text"] == "Warranty: Batteries are covered for 6 months."
assert retriever.search("gift cards", "acme") == []                # below min_score -> honest "not found"
assert retriever.search("express delivery", "globex") == []        # other tenant sees nothing
print("OK: PDF -> clean -> chunk -> embed -> filter -> top-k -> cited prompt")
```

- `make_messy_pdf` -- har page pe repeated header/footer, jaise customer ke real PDFs. `extract` unhe regex se hatata hai, warna har chunk mein "INTERNAL" embed hota.
- `heading` prefix -- pehli try mein "Warranty." akela chunk ban gaya aur battery query pe wahi top pe aaya. Section title ko har sentence ke aage jodna is problem ka simple fix hai.
- `Retriever.search` -- pehle tenant filter (M06-08), phir cosine, phir `min_score` floor. "gift cards" pe `[]` -- fake confident answer se behtar.
- `build_prompt` -- har context line pe `[doc pN]` tag; LLM ko citation format diya, invent karne ka mauka nahi.
- `FakeLLM` -- real LLM call ka stand-in (no network). Toy embedder sirf word overlap dekhta hai; real pipeline mein M06-03 ka model aur neeche real call.

```python
# real version -- not run here, needs: pip install anthropic sentence-transformers numpy pypdf
import os
import anthropic
from sentence_transformers import SentenceTransformer

model = SentenceTransformer("all-MiniLM-L6-v2")
embed = lambda texts: model.encode(texts, normalize_embeddings=True)      # replace toy_embed
client = anthropic.Anthropic(timeout=30, max_retries=2)

def answer(query, hits):
    if not hits:
        return "I could not find this in the documents."                   # do not call the LLM at all
    resp = client.messages.create(model=os.environ["LLM_MODEL"], max_tokens=400,
                                  messages=[{"role": "user", "content": build_prompt(query, hits)}])
    return "".join(b.text for b in resp.content if b.type == "text")
```

### Mini-exercise (30-60 min)
OmniGuard Hybrid RAG v1 ka dense half: `omniguard/rag/pipeline.py`.
- `ingest(pdf_paths, tenant) -> list[Chunk]` (pypdf + `clean_text` + M06-01 chunker + heading prefix) aur `retrieve(query, user_ctx, k) -> list[Hit]`.
- FastAPI `POST /ask` (M02): response `{"answer", "citations": [{"doc_id", "page"}], "retrieval_ms"}`; empty hits pe LLM call skip.
- 3 messy PDFs (fpdf2 se generate ya real public policy PDFs) + 10 questions (2 unanswerable) ka `eval/questions.jsonl` -- M06-14 mein isi pe metrics chalenge.
- Acceptance: pytest -- har answer ki citation retrieved hits mein se hi ho; unanswerable questions pe "not found"; dusre tenant ka chunk kabhi nahi.

### Common pitfalls
- Citations LLM se generate karwana instead of retrieved metadata se -- page numbers hallucinate hote hain. Citation list code se banao.
- Ingest aur query mein alag cleaning/tokenizer -- query embedding aur chunk embeddings alag "language" bolte hain.
- Retrieval latency log na karna -- slow answer pe pata nahi chalta embedding API slow hai, DB ya LLM (M14-11).

### Checklist before moving on
- [ ] Ingest aur query path alag-alag bata aur test kar sakta hoon.
- [ ] Har chunk mein `doc_id`, `page`, `tenant` metadata hai.
- [ ] Empty/low-score retrieval pe system "not found" bolta hai.
- [ ] Citations code se aati hain, LLM se nahi.

### Related
- M06-01 Fixed-size and semantic chunking
- M06-08 Metadata filtering
- M06-12 Combining dense and sparse signals
- M06-14 Precision and recall metrics
- M08-10 Ingesting unstructured legacy enterprise PDFs

### Self-quiz
1. Ingest path aur query path ke stages list karo. Kaunsa stage galat ho to kaunsa symptom dikhega?
2. "Warranty." heading akela chunk kyun nuksaan karta hai, aur heading prefix kaise fix karta hai?
3. `min_score` bahut high rakha to kya hoga? Usse kaise tune karoge?
4. Citations LLM se generate karwane mein kya risk hai?
