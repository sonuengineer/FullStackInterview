# Vector Search & Core RAG

## Precision and recall metrics

> Core | Fast CP3 / Slow CP4 | ~1.2 h | Builds on: M06-10, M06-12, M06-13

### Kahani
Logistics customer ka steering meeting. Aapne chunk size badla, hybrid lagaya, RRF add kiya -- aur slide pe likha "retrieval improved". VP Operations poochti hain: "Kitna? Kis cheez mein? Pichhle hafte se compare karke dikhao."
Aapke paas sirf 5 screenshots hain jahan answer accha aaya. Unke data team lead ne turant ek aisa sawaal poocha jo ab fail ho raha hai, pehle chalta tha.
Bina numbers ke har change ek opinion hai. Retrieval metrics woh numbers hain -- aur CP3 gate ka eval report inhi se banta hai.

### What it is
Labelled eval set (question -> relevant chunk ids) pe retriever ki ranked list ko score karna. **Precision@k** = top-k mein kitne relevant / k. **Recall@k** = saare relevant mein se kitne top-k mein aaye.
**MRR** = pehle relevant result ki rank ka reciprocal (1/rank), average. **nDCG@k** = graded relevance + position discount: upar wale sahi results zyada count hote hain.

### Why it matters for an FDE
"Measure before tuning" -- chunking, overlap, alpha, k, reranker: har knob ka effect isi table se dikhta hai. Customer ko trend dikhane, regressions pakadne, aur "kab ruke" decide karne ka yahi tareeka hai.

### Key concepts
- **Recall@k is the RAG ceiling** -- relevant chunk top-k mein hi nahi aaya to LLM usse use nahi kar sakta. Pehle recall theek karo.
- **Precision@k = noise in context** -- low precision = prompt mein irrelevant chunks, tokens waste, hallucination risk.
- **MRR = "how high is the first good hit"** -- single-answer FAQ style questions ke liye best signal.
- **nDCG = graded + ordered** -- "perfect" vs "partial" chunks alag value; reranker evaluation ke liye useful.
- **Unanswerable questions** -- recall undefined; inhe alag track karo ("not found" rate, M06-10).

### Code example
stdlib only

```python
# runnable
import math

def precision_at_k(ranked, relevant, k):
    return sum(d in relevant for d in ranked[:k]) / k           # divide by k, even if fewer results

def recall_at_k(ranked, relevant, k):
    if not relevant:
        return None                                              # undefined for unanswerable questions
    return sum(d in relevant for d in ranked[:k]) / len(relevant)

def reciprocal_rank(ranked, relevant):
    for i, d in enumerate(ranked, start=1):
        if d in relevant:
            return 1 / i
    return 0.0

def ndcg_at_k(ranked, grades, k):
    """grades: doc -> graded relevance (0..3). Linear gain rel / log2(rank + 1)."""
    dcg = sum(grades.get(d, 0) / math.log2(i + 1) for i, d in enumerate(ranked[:k], start=1))
    ideal = sorted(grades.values(), reverse=True)[:k]
    idcg = sum(g / math.log2(i + 1) for i, g in enumerate(ideal, start=1))
    return dcg / idcg if idcg else 0.0

# ---- hand-checked examples -------------------------------------------------
ranked = ["d3", "d1", "d2", "d7", "d5"]
relevant = {"d3", "d2", "d9"}                                    # d9 never retrieved
assert precision_at_k(ranked, relevant, 3) == 2 / 3              # d3, d2 in top-3
assert recall_at_k(ranked, relevant, 3) == 2 / 3                 # 2 of 3 relevant found
assert precision_at_k(ranked, relevant, 5) == 2 / 5              # bigger k: precision drops...
assert recall_at_k(ranked, relevant, 5) == 2 / 3                 # ...recall can only stay or rise
assert reciprocal_rank(["d1", "d2", "d3"], {"d3"}) == 1 / 3
g = {"d3": 3, "d2": 2}                                           # d3 = perfect answer, d2 = partial
# DCG = 3/log2(2) + 0/log2(3) + 2/log2(4) = 3 + 0 + 1 = 4 ; IDCG = 3/1 + 2/log2(3)
assert abs(ndcg_at_k(["d3", "d1", "d2"], g, 3) - 4 / (3 + 2 / math.log2(3))) < 1e-12
assert ndcg_at_k(["d3", "d2", "d1"], g, 3) == 1.0

# ---- mini eval: same questions, two retrieval systems ------------------------
EVAL = [  # question id, relevant chunk ids (from your labelled eval/questions.jsonl)
    ("q1 refund window", {"c4"}), ("q2 PX-2291 cover", {"c9", "c10"}),
    ("q3 battery warranty", {"c21"}), ("q4 hazmat approval", {"c33", "c34"}),
    ("q5 gift cards (unanswerable)", set()),
]
RUNS = {
    "bm25":         [["c4", "c1", "c2"], ["c9", "c3", "c10"], ["c5", "c6", "c7"], ["c40", "c33", "c2"], ["c8", "c1", "c3"]],
    "hybrid_rrf":   [["c4", "c2", "c1"], ["c10", "c9", "c3"], ["c21", "c5", "c6"], ["c33", "c34", "c40"], ["c8", "c1", "c3"]],
}

def report(run, k=3):
    rows = list(zip(EVAL, run))
    answerable = [(rel, r) for (_, rel), r in rows if rel]
    return {
        f"precision@{k}": sum(precision_at_k(r, rel, k) for rel, r in answerable) / len(answerable),
        f"recall@{k}": sum(recall_at_k(r, rel, k) for rel, r in answerable) / len(answerable),
        "MRR": sum(reciprocal_rank(r, rel) for rel, r in answerable) / len(answerable),
        f"nDCG@{k}": sum(ndcg_at_k(r, {d: 1 for d in rel}, k) for rel, r in answerable) / len(answerable),
    }

reports = {name: report(run) for name, run in RUNS.items()}
metrics = list(reports["bm25"])
print("| system | " + " | ".join(metrics) + " |")
print("|---|" + "---|" * len(metrics))
for name, rep in reports.items():
    print(f"| {name} | " + " | ".join(f"{rep[m]:.2f}" for m in metrics) + " |")

assert reports["hybrid_rrf"]["recall@3"] == 1.0 and reports["bm25"]["recall@3"] == 0.625
assert reports["hybrid_rrf"]["MRR"] > reports["bm25"]["MRR"]
print("OK: metrics hand-checked; README-ready eval table printed")
```

- `precision_at_k` hamesha `k` se divide karta hai: single-relevant question pe precision@3 max 0.33 hi ho sakta hai -- isliye precision ko recall ke saath padho, akela nahi.
- `recall_at_k` unanswerable (`relevant` empty) pe `None` -- usse 0 ya 1 count karna average ko jhootha banata hai. `report` unhe answerable set se bahar rakhta hai.
- nDCG hand-check: DCG = 3/1 + 0 + 2/log2(4) = 4, IDCG = 3 + 2/log2(3). Formula variant (linear vs `2^rel - 1` gain) choose karo aur README mein likho.
- `RUNS` -- same questions, do systems. Printed table directly README mein paste hoti hai: bm25 recall@3 0.62 -> hybrid 1.00.
- Real eval set bada hona chahiye (30-100+ questions); 5 questions pe numbers bahut noisy hain -- yahan sirf mechanics hain.

### Mini-exercise (30-60 min)
CP3 gate ka pehla hissa: `omniguard/eval/retrieval_eval.py`.
- Input `eval/questions.jsonl`: `{"id", "question", "tenant", "relevant_chunk_ids": [...], "grades": {...}}` -- kam se kam 30 questions, 5 unanswerable, 5 ID-style. Labels customer SME ke saath verify karo (ya M14-08 se synthetic, phir spot-check).
- Har system config (bm25, dense, hybrid_minmax, hybrid_rrf, +reranker baad mein) ke liye precision@5, recall@5, MRR, nDCG@5 + not-found rate on unanswerable.
- Output `eval/report.md` (markdown table + git commit hash + config) aur README ke "Eval report" section mein embed.
- Acceptance: pytest -- hand-computed metric values match; report script deterministic (same input -> same table). Answer-level metrics (faithfulness, context precision/recall) M14-05..M14-08 mein add honge.

### Common pitfalls
- Eval questions khud likhna jo exactly docs ke words copy karte hain -- BM25 artificially jeet-ta hai; real user wording (tickets, chat logs) se lo.
- Chunk IDs pe label kiye, phir chunking badla -- labels toot gaye. Label `doc_id + text span` pe rakho aur chunk ids map karo.
- Sirf average dekhna -- per-question diff dekho; ek fix 3 questions theek aur 2 kharab kar sakta hai.

### Checklist before moving on
- [ ] Precision@k, recall@k, MRR, nDCG@k haath se compute kar sakta hoon.
- [ ] Unanswerable questions ko metrics mein sahi handle karta hoon.
- [ ] Mere paas labelled eval set aur ek reproducible report script hai.
- [ ] Har retrieval change ke saath before/after table banata hoon.

### Related
- M06-13 Implementing RRF algorithms
- M06-15 Cross-encoder reranking models
- M14-05 Automating LLM-as-a-judge scoring pipelines
- M14-06 Calculating RAGAS faithfulness and answer relevance metrics
- M14-07 Measuring context precision and recall
- M14-08 Creating synthetic benchmark datasets from source documents

### Self-quiz
1. Ranked list [d3, d1, d2, d7], relevant {d3, d2, d9}. Precision@4, recall@4 aur RR nikalo.
2. Recall@5 = 0.6 aur precision@5 = 0.9 -- RAG answers pe iska kya asar dikhega?
3. VP ko ek number dikhana hai. Recall@k, MRR ya nDCG -- kaunsa aur kyun?
4. Chunking change ke baad recall gira. Kaise pata karoge ki retrieval kharab hua ya labels toot gaye?
