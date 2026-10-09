# Vector Search & Core RAG

## Overlap optimization

> Core | Fast CP3 / Slow CP4 | ~1.2 h | Builds on: M06-01

### Kahani
Logistics customer ka 80-page SOP hai. Driver poochta hai: "Hazmat shipment ke liye carrier approval kaun deta hai?" Answer ek sentence mein hai jo chunk 14 ke end se shuru hoke chunk 15 mein khatam hota hai.
Chunk 14 mein "Hazmat shipments require" hai, chunk 15 mein "approval from the regional safety lead". Dono mein se koi bhi akela query se strongly match nahi karta -- bot bolta hai "I could not find this".
Team lead ne suggest kiya "overlap 50% kar do". Index size double, embedding bill double, aur top-5 mein ek hi text 3 baar aane laga.

### What it is
**Overlap** = consecutive chunks ke beech kuch words/tokens repeat karna (`step = size - overlap`), taaki boundary pe kata hua fact kam se kam ek chunk mein poora mile.
**Optimization** = overlap ko measure karke choose karna: kitne facts intact rehte hain vs kitna extra storage, embedding cost aur duplicate context.

### Why it matters for an FDE
Customer ke SOPs, contracts aur ticket threads mein answers boundary pe katenge hi. Zero overlap = missed answers; bahut overlap = mehenga index aur LLM ko repeated text (tokens waste, M05-05). Number se decide karo, guess se nahi.

### Key concepts
- **Step vs size** -- `step = size - overlap`; chunk count roughly `doc_len / step`, isliye cost `size / step` guna badhti hai.
- **Containment guarantee** -- agar overlap >= sabse lambi unit (sentence/clause) ki length, to koi unit kabhi nahi katti.
- **Diminishing returns** -- pehle 10-20% overlap sabse zyada facts bachata hai; uske baad cost badhti hai, gain kam.
- **Sentence-aligned overlap** -- last 1-2 sentences carry karo instead of raw N tokens; aadhe words repeat nahi hote.
- **Stitching / dedupe** -- retrieval ke baad same doc ke overlapping chunks merge karo, taaki prompt mein text do baar na jaaye.

### Code example
stdlib only

```python
# runnable
import random

rng = random.Random(42)
VOCAB = "claim policy patient invoice shipment carrier refund approval audit record branch limit".split()

# 60 "facts" (sentences) of 6-18 words, like a long SOP document
facts = []
for i in range(60):
    n = rng.randint(6, 18)
    facts.append([f"F{i}"] + [rng.choice(VOCAB) for _ in range(n - 1)])
words = [w for f in facts for w in f]
starts, pos = [], 0
for f in facts:
    starts.append(pos)
    pos += len(f)

def chunk_words(n_words, size, overlap):
    step = size - overlap
    assert step > 0, "overlap must be smaller than size"
    spans, s = [], 0
    while True:
        spans.append((s, min(s + size, n_words)))
        if s + size >= n_words:
            return spans
        s += step

def fully_contained_rate(spans):
    ok = 0
    for f, p in zip(facts, starts):
        ok += any(a <= p and p + len(f) <= b for a, b in spans)
    return ok / len(facts)

SIZE = 40
longest = max(len(f) for f in facts)
print(f"doc={len(words)} words, chunk size={SIZE}, longest fact={longest} words")
print("overlap  chunks  indexed_words  cost_x  facts_intact")
rows = {}
for ov in [0, 4, 8, 12, longest]:
    spans = chunk_words(len(words), SIZE, ov)
    indexed = sum(b - a for a, b in spans)
    rate = fully_contained_rate(spans)
    rows[ov] = (len(spans), indexed / len(words), rate)
    print(f"{ov:7d}  {len(spans):6d}  {indexed:13d}  {indexed / len(words):6.2f}  {rate:12.0%}")

def stitch(spans_hit):
    """Merge retrieved overlapping/adjacent chunks of the same doc so the LLM never sees text twice."""
    merged = []
    for a, b in sorted(spans_hit):
        if merged and a <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    return merged

spans = chunk_words(len(words), SIZE, 12)
hit = [spans[3], spans[2], spans[4]]                       # retriever returned 3 neighbours
merged = stitch(hit)
dup_words = sum(b - a for a, b in hit) - sum(b - a for a, b in merged)
print("retrieved:", hit, "-> stitched:", merged, f"(saved {dup_words} duplicate words)")

assert rows[0][2] < rows[12][2]                  # overlap rescues facts cut at boundaries
assert rows[0][1] < rows[12][1] < rows[longest][1]   # ...and costs more storage/embedding
assert rows[longest][2] == 1.0                   # overlap >= longest unit -> nothing is ever cut
assert len(merged) == 1 and dup_words == 24
print("OK: overlap trade-off measured")
```

- `chunk_words` -- `step = size - overlap`; `assert step > 0` warna infinite loop (classic bug jab config mein overlap >= size ho).
- `fully_contained_rate` -- har fact ke liye check: kya koi chunk use poora contain karta hai? Yahi asli metric hai, "overlap kitna hai" nahi.
- Table padho: 0 -> 12 overlap pe intact facts 73% -> 97%, cost 1.41x. Overlap = longest fact (18) pe 100% lekin 1.77x -- yahi trade-off customer ko dikhana hai.
- `stitch` -- retriever ne chunk 2, 3, 4 diye (neighbours); merge karke 24 duplicate words bache. Production mein ye `doc_id` + offsets pe hota hai, isliye chunk metadata mein `start`/`end` rakho.

### Mini-exercise (30-60 min)
`omniguard/rag/chunking.py` mein overlap ko measurable banao.
- Chunk metadata mein `start_token`, `end_token` add karo; `stitch_hits(hits)` function jo same `doc_id` ke overlapping hits merge kare.
- `scripts/overlap_sweep.py`: apne 3 messy docs pe overlap 0/10/20/30% sweep; har setting ke liye chunks, total tokens embedded, aur 10 hand-written questions pe "answer sentence fully inside a top-5 chunk" rate print karo.
- README mein ek chhoti table + chosen value + ek line kyun.
- Acceptance: pytest -- `overlap >= size` pe `ValueError`; stitched context mein koi sentence do baar nahi.

### Common pitfalls
- Overlap ko characters mein set karna jab embedding limit tokens mein hai -- Hindi/code-heavy text mein token count bahut alag hota hai; tokens mein socho (M05-03).
- Overlap badhaya lekin dedupe nahi kiya -- top-5 mein 3 near-duplicate chunks, asli diverse context bahar.
- Har re-index pe overlap badalna bina eval ke -- chunk IDs badal jaate hain, cached embeddings aur eval labels toot jaate hain; chunking config ko version karo.

### Checklist before moving on
- [ ] `step = size - overlap` se chunk count aur cost estimate kar sakta hoon.
- [ ] Overlap choose karne ke liye "facts intact" jaisa metric measure karta hoon.
- [ ] Retrieved overlapping chunks ko stitch/dedupe karta hoon.
- [ ] Chunking config (size, overlap, version) index metadata mein save hai.

### Related
- M06-01 Fixed-size and semantic chunking
- M05-05 Context compression
- M06-10 End-to-end basic retrieval
- M06-14 Precision and recall metrics

### Self-quiz
1. Size 400, overlap 100 tokens. 1 lakh tokens ke doc ke liye roughly kitne chunks banenge, aur zero overlap se kitna mehenga?
2. "Overlap >= longest sentence" guarantee kyun kaam karti hai? Apne words mein proof do.
3. Overlap 50% karne ke baad answer quality kyun gir sakti hai, jabki recall badha?
4. Sentence-aligned overlap raw token overlap se kab better hai?
