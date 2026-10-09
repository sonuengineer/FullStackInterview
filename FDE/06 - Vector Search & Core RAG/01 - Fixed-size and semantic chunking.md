# Vector Search & Core RAG

## Fixed-size and semantic chunking

> Core | Fast CP3 / Slow CP4 | ~1.2 h | Builds on: M05-03, M05-04

### Kahani
Ek bank ne aapko 400 scanned policy PDFs diye: "isse ek chatbot banao, branch staff use karega". Pehle din aapne har PDF ko 500-character tukdon mein kaata aur vector DB mein daal diya.
Demo mein manager ne poocha: "Digital goods ka refund milta hai?" Bot bola "Refunds are issued within 14 days" -- jabki asli line "Refunds for digital goods are refused after download" agle chunk mein thi, aadhi kati hui, saath mein "Customer records are retained..." chipka hua.
Retrieval galat nahi tha -- chunk hi galat tha. Ek chunk mein do topics, aur ek topic do chunks mein.

### What it is
**Chunking** = lambe document ko chhote retrievable pieces mein todna, kyunki embedding model aur LLM context dono limited hain, aur hum sirf relevant hissa prompt mein bhejna chahte hain.
**Fixed-size** = har N characters/tokens pe kaato (simple, predictable). **Semantic** = sentences ko embed karo, aur jahan adjacent sentences ki similarity gire wahan kaato -- topic boundary pe.

### Why it matters for an FDE
Customer ke docs messy hote hain: headers, page footers, "CONFIDENTIAL" stamps, tables. Chunk quality kharab ho to koi reranker ya prompt usse bacha nahi sakta -- retrieval ka ceiling chunking set karta hai.

### Key concepts
- **Chunk size** -- chhota chunk = precise match lekin context kam; bada chunk = context zyada lekin embedding "blurry" aur tokens mehenge.
- **Structure-aware split** -- pehle headings/paragraphs/pages pe todo, phir size limit lagao; customer docs mein yahi sabse bada win hai.
- **Semantic split** -- sentence embeddings ki adjacent cosine similarity threshold se neeche jaaye to naya chunk.
- **Noise removal** -- page footers, headers, watermarks chunking se pehle hatao, warna har chunk mein same garbage embed hota hai.
- **Max size guard** -- semantic chunk bhi ek hard limit (tokens) ke andar rehna chahiye.

### Code example
`pip install numpy`

```python
# runnable
import re
import zlib

import numpy as np

DOC = """ACME Bank -- Customer Policy Manual (scanned, v3)
Refunds are issued within 14 days of purchase. A refund needs the original receipt. Refunds for digital goods are refused after download.
Page 3 of 12 -- CONFIDENTIAL
Customer records are retained for 7 years. Records older than 7 years are deleted. Backups of customer records are encrypted at rest.
Wire transfers above 10000 USD need two approvals. Wire transfer approvals are logged for audit."""

STOP = {"a", "an", "the", "of", "for", "are", "is", "to", "at", "after", "within", "than", "above", "need", "needs"}

def toy_embed(text, dim=512):
    """TOY embedder: hashed bag-of-words, L2-normalised. Captures word overlap only, NOT meaning."""
    v = np.zeros(dim)
    for w in re.findall(r"[a-z0-9]+", text.lower()):
        if w not in STOP:
            v[zlib.crc32(w.rstrip("s").encode()) % dim] += 1   # crc32 = stable across runs
    n = np.linalg.norm(v)
    return v / n if n else v

def fixed_size_chunks(text, size=120, overlap=0):
    flat = " ".join(text.split())
    step = size - overlap
    return [flat[i:i + size] for i in range(0, len(flat), step)]

def clean_sentences(text):
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line or re.match(r"^Page \d+ of \d+", line):   # drop footer noise
            continue
        out += [s for s in re.split(r"(?<=[.!?])\s+", line) if s]
    return out

def semantic_chunks(text, threshold=0.1, max_chars=400):
    sents = clean_sentences(text)
    vecs = [toy_embed(s) for s in sents]
    chunks, cur = [], [sents[0]]
    for i in range(1, len(sents)):
        sim = float(vecs[i - 1] @ vecs[i])                      # cosine, since vectors are unit length
        too_big = len(" ".join(cur + [sents[i]])) > max_chars
        if sim < threshold or too_big:
            chunks.append(" ".join(cur))
            cur = []
        cur.append(sents[i])
    chunks.append(" ".join(cur))
    return chunks

fixed = fixed_size_chunks(DOC, size=120)
sem = semantic_chunks(DOC)
print("FIXED:")
for c in fixed: print("  |", c)
print("SEMANTIC:")
for c in sem: print("  |", c)

# fixed-size: some chunk mixes two topics, and the footer got embedded
assert any("refused" in c or "digital" in c for c in fixed)
assert any("CONFIDENTIAL" in c for c in fixed)
assert any(("download" in c and "records" in c) or ("refund" in c.lower() and "retained" in c) for c in fixed)
# semantic: one topic per chunk, no footer, nothing lost
refund = [c for c in sem if "Refunds are issued" in c][0]
assert "digital goods" in refund and "records" not in refund
assert not any("CONFIDENTIAL" in c for c in sem)
assert sum(len(c.split()) for c in sem) == sum(len(s.split()) for s in clean_sentences(DOC))
print(f"OK: fixed={len(fixed)} chunks, semantic={len(sem)} chunks")
```

- `toy_embed` sirf word overlap pakadta hai ("refund" vs "refunds"); "money back" aur "refund" ko similar nahi samjhega. Real model meaning pakadta hai -- neeche real version.
- `fixed_size_chunks` sentence beech mein kaat deta hai aur footer ("Page 3 of 12 -- CONFIDENTIAL") ko content ki tarah embed karta hai.
- `semantic_chunks` -- adjacent sentence similarity `threshold` se kam = topic badla = naya chunk. `max_chars` guard taaki ek "topic" 10 pages ka chunk na ban jaaye.
- Last assert -- koi word gum nahi hua; chunking kabhi content drop nahi kare (sirf known noise).

```python
# real version -- not run here, needs: pip install sentence-transformers numpy
from sentence_transformers import SentenceTransformer

model = SentenceTransformer("all-MiniLM-L6-v2")        # small, CPU-friendly, 384-dim

def real_embed_many(sentences):
    return model.encode(sentences, normalize_embeddings=True)   # unit vectors -> dot = cosine

# Drop-in: compute vecs = real_embed_many(sents) inside semantic_chunks.
# Real thresholds are different (often a percentile of the similarity drops, not a fixed 0.1) -- tune on your docs.
```

### Mini-exercise (30-60 min)
CP3 capstone shuru: `omniguard/rag/chunking.py` banao.
- `chunk_fixed(text, size_tokens, overlap)` aur `chunk_semantic(text, threshold, max_tokens)`; tokens ke liye ek simple `len(text.split())` approximation ya tiktoken (M05-03).
- Har chunk ek dict: `{"chunk_id", "doc_id", "page", "text", "n_tokens"}` -- `page` aage citations aur filtering ke kaam aayega.
- `clean_text()` -- page footers, repeated headers, multiple spaces hatao; regex list config mein.
- 3 messy sample docs lo (ek policy, ek support ticket thread, ek PDF se nikla text via pypdf). Report print karo: chunk count, avg/max tokens, kitne chunks sentence ke beech mein shuru hote hain.
- Acceptance: pytest -- koi chunk `max_tokens` se bada nahi, footer pattern kisi chunk mein nahi, saare words (noise ke alawa) chunks mein maujood.

### Common pitfalls
- Ek hi chunk size sab docs pe -- FAQ (chhote answers) aur legal contract (lambe clauses) ko alag settings chahiye; doc type ke hisaab se config.
- Tables aur lists ko sentence splitter se todna -- row ka header alag chunk mein chala jaata hai; tables ko as a unit rakho (M08-08).
- Chunking change karke "feel" se judge karna -- hamesha eval set pe recall@k compare karo (M06-14) before/after.

### Checklist before moving on
- [ ] Fixed-size aur semantic chunking ka trade-off 2 lines mein samjha sakta hoon.
- [ ] Chunking se pehle noise (footers, headers) hatata hoon.
- [ ] Har chunk ke saath `doc_id` aur `page` metadata rakhta hoon.
- [ ] Semantic chunk pe bhi hard max-size guard hai.

### Related
- M05-03 Token calculation
- M06-02 Overlap optimization
- M06-03 Understanding vector representations
- M06-14 Precision and recall metrics
- M08-10 Ingesting unstructured legacy enterprise PDFs

### Self-quiz
1. 500-char fixed chunks se bank bot ne galat refund answer diya. Exactly kya galat hua tha, aur do fixes batao.
2. Semantic chunking mein threshold bahut high rakhoge to kya hoga? Bahut low?
3. Toy embedder "money back" aur "refund" ko similar kyun nahi maanega, aur real model kyun maanega?
4. Customer kehta hai "chunk size 1000 kar do, zyada context milega". Aap kya measure karke jawab doge?
