# Vector Search & Core RAG

## Understanding vector representations

> Core | Fast CP3 / Slow CP4 | ~1.2 h | Builds on: M06-01

### Kahani
Insurance customer ke support portal pe log likhte hain "when do I get my money back?". Policy doc mein likha hai "Reimbursement is processed within one week". Purana keyword search: zero results, kyunki ek bhi word common nahi.
CTO poochta hai: "Ye vector wala search kaise jaanta hai ki money back aur reimbursement same cheez hai? Ye magic hai ya bug?"
FDE ke taur pe aapko ye whiteboard pe 5 minute mein samjhana hai -- aur ye bhi batana hai ki ye kab fail hota hai.

### What it is
**Embedding** = ek model text ko fixed-length list of numbers (vector, e.g. 384 ya 1536 floats) mein badalta hai, aise ki similar meaning wale texts space mein paas-paas aayein.
Search = query ka vector banao, har chunk ke vector se similarity (usually cosine) nikalo, top-k lo. Bas itna -- baaki sab (ANN, index, DB) isi ko fast banane ke tareeke hain.

### Why it matters for an FDE
Customer ke users docs ki language mein nahi poochte. Embeddings vocabulary gap bharte hain -- lekin product codes, IDs, exact clause numbers pe kamzor hote hain. Ye dono baatein samjhe bina aap hybrid search (M06-12) justify nahi kar paoge.

### Key concepts
- **Dense vector** -- har dimension mein kuch value; dimensions human-readable nahi; model training se seekhe gaye "directions".
- **Sparse vector** -- vocabulary-size length, zyada tar zeros (bag-of-words, BM25); exact word match pakadta hai.
- **Normalisation** -- unit length (L2 norm = 1) pe dot product == cosine similarity; zyada tar vector DBs isi pe optimised hain.
- **Same model rule** -- query aur documents ek hi model (aur same version) se embed hone chahiye; mix kiya to scores bekaar.
- **Search as matrix math** -- `scores = M @ q`; 1 lakh chunks x 384 dims bhi numpy mein milliseconds ka kaam hai.

### Code example
`pip install numpy`

```python
# runnable
import re
import zlib

import numpy as np

def toy_embed(text, dim=1024):
    """TOY embedder: hashed bag-of-words, L2-normalised. Word overlap only, NOT meaning."""
    v = np.zeros(dim, dtype=np.float32)
    for w in re.findall(r"[a-z0-9]+", text.lower()):
        v[zlib.crc32(w.encode()) % dim] += 1.0
    n = np.linalg.norm(v)
    return v / n if n else v

# A hand-made 4-dim "concept space" to imitate what a trained model learns:
# each axis = a concept; synonyms land on the same axis. Real models learn ~384-3072 such
# directions from data, and the axes are not human-readable.
AXES = ["money", "time", "health", "shipping"]
LEXICON = {"refund": [1, 0, 0, 0], "money": [1, 0, 0, 0], "back": [0.3, 0, 0, 0],
           "reimbursement": [1, 0, 0, 0], "days": [0, 1, 0, 0], "week": [0, 1, 0, 0],
           "doctor": [0, 0, 1, 0], "clinic": [0, 0, 1, 0], "parcel": [0, 0, 0, 1],
           "delivery": [0, 0, 0, 1], "late": [0, 0.6, 0, 0.4]}

def concept_embed(text):
    v = np.zeros(len(AXES), dtype=np.float32)
    for w in re.findall(r"[a-z]+", text.lower()):
        v += np.array(LEXICON.get(w, [0, 0, 0, 0]), dtype=np.float32)
    n = np.linalg.norm(v)
    return v / n if n else v

a, b, c = "refund in 14 days", "money back within a week", "parcel delivery is late"

va = toy_embed(a)
print("toy vector: dim =", va.shape[0], "non-zero =", int((va != 0).sum()), "norm =", round(float(np.linalg.norm(va)), 3))
toy_ab, toy_ac = float(toy_embed(a) @ toy_embed(b)), float(toy_embed(a) @ toy_embed(c))
con_ab, con_ac = float(concept_embed(a) @ concept_embed(b)), float(concept_embed(a) @ concept_embed(c))
print(f"toy     sim(refund, money back) = {toy_ab:.2f}   sim(refund, parcel) = {toy_ac:.2f}")
print(f"concept sim(refund, money back) = {con_ab:.2f}   sim(refund, parcel) = {con_ac:.2f}")
print("concept vector of b:", {k: round(float(x), 2) for k, x in zip(AXES, concept_embed(b))})

# Search = one matrix-vector product over a stack of unit vectors
docs = ["Refund requests are paid within 14 days", "Parcel delivery is late during monsoon",
        "Book a doctor at the clinic", "Reimbursement takes one week"]
M = np.stack([concept_embed(d) for d in docs])          # shape (n_docs, dim)
q = concept_embed("how fast do I get my money back")
scores = M @ q                                           # cosine for every doc at once
ranked = [docs[i] for i in np.argsort(-scores)]
print("ranked:", ranked[:2])

assert toy_ab == 0.0                                     # no shared words -> toy says unrelated
assert con_ab > 0.9 and con_ac < 0.5                     # concept space puts synonyms together
assert abs(float(np.linalg.norm(va)) - 1.0) < 1e-6       # unit length -> dot product == cosine
assert M.shape == (4, 4) and set(ranked[:2]) == {docs[0], docs[3]}
print("OK: vectors, similarity and search as matrix math")
```

- `toy_embed` -- hashed bag-of-words: 1024 dims mein sirf 4 non-zero (sparse jaisa). "refund" aur "money back" ka similarity 0 -- ye toy sirf word overlap dekhta hai, meaning nahi.
- `concept_embed` -- haath se banaya 4-dim "concept space" sirf intuition ke liye: synonyms same axis pe, isliye similarity 0.99. Real model yahi kaam data se seekhta hai, 384+ dims mein.
- `M @ q` -- poora search ek line: har doc ka cosine ek saath. Vector DB is operation ko billions pe fast karta hai (M06-06).
- Norm assert -- normalise nahi kiya to lambe documents ka dot product bada aayega aur ranking length se bias hogi.

```python
# real version -- not run here, needs: pip install sentence-transformers  (or a provider SDK)
from sentence_transformers import SentenceTransformer

model = SentenceTransformer("all-MiniLM-L6-v2")                      # 384-dim, runs on CPU
vecs = model.encode(["refund in 14 days", "money back within a week"], normalize_embeddings=True)
print(vecs.shape, float(vecs[0] @ vecs[1]))                           # (2, 384) and a high similarity

# Hosted alternative (shape only -- check the provider docs for your SDK version):
# from openai import OpenAI
# resp = OpenAI().embeddings.create(model="text-embedding-3-small", input=["refund in 14 days"])
# vec = resp.data[0].embedding                                         # list[float]
```

> Needs API key for the hosted version: OPENAI_API_KEY (or your provider's key). The local sentence-transformers model needs no key.

### Mini-exercise (30-60 min)
`omniguard/rag/embed.py` banao with one interface: `class Embedder(Protocol): dim: int; def embed(self, texts: list[str]) -> np.ndarray`.
- `ToyEmbedder` (tests ke liye, deterministic) aur `LocalEmbedder` (sentence-transformers, optional import).
- 10 query-doc pairs likho apne domain se: 5 synonym-type ("money back" vs "reimbursement"), 5 exact-ID type ("policy PX-2291"). Dono embedders se similarity table print karo.
- Acceptance: test -- har vector ka norm 1 (+-1e-5), `embed([])` empty array return kare, aur embedder ka `model_name` + `dim` index metadata mein save ho.

### Common pitfalls
- Index ek model se banaya, query doosre (ya naye version) se embed ki -- crash nahi hota, bas results chupchap kharab. Model name index ke saath store karo.
- Embeddings ko "meaning ka sach" maan lena -- negation ("is refundable" vs "is not refundable") aksar bahut similar vectors dete hain.
- Raw customer PII embed karke third-party API ko bhejna bina approval -- data residency/DPA pehle check karo.

### Checklist before moving on
- [ ] Dense vs sparse vector ka farak ek example se bata sakta hoon.
- [ ] Samajhta hoon ki normalised vectors pe dot product == cosine.
- [ ] Query aur docs same model se embed karta hoon aur model name save karta hoon.
- [ ] Embeddings kahan fail hote hain (IDs, negation) bata sakta hoon.

### Related
- M06-04 Dimensionality trade-offs
- M06-05 BM25 sparse matrices
- M06-07 Distance metrics (Cosine, Euclidean)
- M06-12 Combining dense and sparse signals
- M08-06 Contrastive language-image pretraining (CLIP) concepts

### Self-quiz
1. CTO ko 3 lines mein samjhao "money back" aur "reimbursement" match kaise hue.
2. Ek user "policy PX-2291" search karta hai aur dense search galat policy deta hai. Kyun, aur kya fix?
3. Model upgrade kiya (v2 -> v3). Purane index ka kya karoge, aur kyun?
4. `scores = M @ q` mein M aur q ke shapes kya hain? Normalise na karne se kya bias aata hai?
