# AI Observability & Gateway Management

## Measuring context precision and recall

> Core | Fast CP3 / Slow CP4 | ~1.2 h | Builds on: M06-14, M14-06

### Kahani
Ek bank ka KYC assistant. Faithfulness 0.95 aa raha hai, phir bhi branch staff complain karta hai ki answers "adhoore" hain -- address proof wali rule aksar missing.
Debug karne pe pata chala: retriever top-5 mein sahi chunk laata hai, lekin position 5 pe, branch timings aur FD rates ke neeche. Model pehle chunks pe focus karta hai. Kabhi wo chunk top-5 mein aata hi nahi.
Faithfulness yahan blind hai -- model ne jo kaha wo context mein tha. Problem generation nahi, **retrieval** hai. Ise naapne ke liye chahiye context precision aur context recall.

### What it is
**Context precision** (RAGAS-style) = relevant chunks top pe ranked hain ya nahi. Top-K mein har relevant position k pe precision@k lo, aur unka average: `sum(precision@k * v_k) / (relevant chunks in top K)`, jahan v_k = 1 agar chunk k relevant hai. Ranking-aware hai.
**Context recall** = ground-truth (reference) answer ke kitne claims retrieved context se attribute ho sakte hain: `covered reference claims / total reference claims`. Isko reference answer chahiye (M14-08 ka dataset).

### Why it matters for an FDE
Customer ko "answer galat hai" se aage le jaana hai: "retriever ne zaroori chunk laaya hi nahi (recall)" ya "laaya lekin neeche dafna diya (precision)". Pehle ka fix chunking/hybrid search, doosre ka fix reranker (M06-15).

### Key concepts
- **Plain retrieval P/R (M06-14)** -- labelled relevant doc IDs chahiye; precision@k ranking ke andar order ignore karta hai. Context precision order ko reward karta hai.
- **Relevance without ID labels** -- RAGAS-style mein LLM judge decide karta hai ki chunk reference/question ke liye useful hai; chunk-level labelling ki zaroorat nahi.
- **Claim-level recall** -- recall doc IDs pe nahi, reference answer ke facts pe; ek fact do chunks mein split ho to bhi chalta hai.
- **Diagnosis matrix** -- low recall -> retrieval/chunking; high recall + low precision -> reranking; dono high + low faithfulness -> generation/prompt.
- **K matters** -- K=20 pe recall badhta hai, precision girti hai, aur LLM ka context (cost, "lost in the middle") bhi; K ko report mein likho.

### Code example
stdlib only

> Needs API key for the real version: ANTHROPIC_API_KEY (or OPENAI_API_KEY) for the judge LLM

```python
# runnable
import re

STOP = set("a an the is are to of in on for my i do be can and from our it as not than".split())

def words(s):
    return {w[:-1] if len(w) > 3 and w.endswith("s") else w
            for w in re.findall(r"[a-z0-9]+", s.lower()) if w not in STOP}

class FakeJudge:
    """Deterministic stand-in for the LLM judge ragas uses. ONLY for wiring/tests:
    relevance and support are decided by token overlap, not by understanding."""
    def is_relevant(self, chunk, reference):
        c = words(chunk)
        return len(c & words(reference)) / max(len(c), 1) >= 0.5
    def is_supported(self, claim, contexts):
        c = words(claim)
        return len(c & words(" ".join(contexts))) / max(len(c), 1) >= 0.6

def context_precision(judge, ranked_chunks, reference):
    v = [judge.is_relevant(c, reference) for c in ranked_chunks]
    hits, total = 0, 0.0
    for k, rel in enumerate(v, start=1):
        if rel:
            hits += 1
            total += hits / k                      # precision@k at each relevant position
    return total / hits if hits else 0.0

def context_recall(judge, ranked_chunks, reference):
    claims = [s for s in re.split(r"(?<=[.!?])\s+", reference) if s]
    covered = [judge.is_supported(c, ranked_chunks) for c in claims]
    return sum(covered) / len(claims), [c for c, ok in zip(claims, covered) if not ok]

def plain_pr_at_k(ranked_ids, relevant_ids, k):    # M06-14 style, needs ID labels
    top = ranked_ids[:k]
    hit = len(set(top) & relevant_ids)
    return hit / k, hit / len(relevant_ids)

CHUNKS = {
    "c1": "PAN card is mandatory to open a savings account.",
    "c2": "Our branches are open from 10 am to 4 pm on weekdays.",
    "c3": "Fixed deposit rates are revised every quarter.",
    "c4": "A utility bill not older than 3 months is accepted as address proof.",
}
REFERENCE = "Savings accounts need a PAN card. Address proof can be a utility bill under 3 months old."
RELEVANT_IDS = {"c1", "c4"}
j = FakeJudge()

runs = {"good_rank": ["c1", "c4", "c2", "c3"], "bad_rank": ["c2", "c3", "c1", "c4"], "missing": ["c1", "c2", "c3"]}
res = {}
for name, ids in runs.items():
    texts = [CHUNKS[i] for i in ids]
    cp = context_precision(j, texts, REFERENCE)
    cr, missed = context_recall(j, texts, REFERENCE)
    p, r = plain_pr_at_k(ids, RELEVANT_IDS, k=len(ids))
    res[name] = (cp, cr, p, r)
    print(f"{name:9s} ctx_precision={cp:.2f} ctx_recall={cr:.2f} | plain P@{len(ids)}={p:.2f} R={r:.2f} missed={missed}")

assert res["good_rank"][2] == res["bad_rank"][2] == 0.5          # plain precision: same set, same score
assert res["good_rank"][0] == 1.0 and abs(res["bad_rank"][0] - (1/3 + 2/4) / 2) < 1e-9   # order matters
assert res["good_rank"][1] == 1.0 and res["missing"][1] == 0.5   # address-proof fact not retrieved
print("OK: context precision is ranking-aware, context recall is claim-level")
```

- `context_precision` -- `bad_rank` mein relevant chunks position 3 aur 4 pe: (1/3 + 2/4) / 2 = 0.42, jabki plain P@4 dono rankings ke liye 0.50 -- set same, order alag.
- `context_recall` -- reference ko claims mein todke har claim ko poore retrieved context ke against check; `missed` batata hai kaunsa fact retriever ne nahi laaya.
- `missing` run -- precision 1.0 (jo laaya wo top pe hai) lekin recall 0.5: precision akela "retrieval theek hai" prove nahi karta.
- `plain_pr_at_k` -- contrast ke liye: isko `RELEVANT_IDS` labels chahiye; RAGAS-style metrics ko sirf reference answer chahiye.
- `FakeJudge` -- token overlap sirf wiring test ke liye; real judge synonyms aur paraphrase samajhta hai (e.g. "under 3 months" vs "not older than 3 months").

```python
# real version -- not run here, needs: pip install ragas  (class names are ragas 0.2-style;
# they change between releases -- check the docs for your ragas version)
from ragas import EvaluationDataset, evaluate
from ragas.metrics import LLMContextPrecisionWithReference, LLMContextRecall

rows = [{"user_input": "What KYC documents do I need?", "retrieved_contexts": [CHUNKS[i] for i in runs["bad_rank"]],
         "reference": REFERENCE}]
result = evaluate(dataset=EvaluationDataset.from_list(rows),
                  metrics=[LLMContextPrecisionWithReference(), LLMContextRecall()], llm=evaluator_llm)
print(result)
```

### Mini-exercise (30-60 min)
CP3 gate ka core: OmniGuard Hybrid RAG v1 ke `omniguard/evals/run_eval.py` mein ye dono metrics add karo.
- `dataset.jsonl` ki har row (`question`, `reference`, optional `relevant_ids`) pe apna retriever chalao, top-K contexts lo, phir context precision, context recall, faithfulness (M14-06) compute karo.
- Teen configs compare karo: dense only, hybrid RRF (M06-13), hybrid + reranker (M06-15). `report.md` mein table: config | K | ctx_precision | ctx_recall | faithfulness.
- Wahi table README ke "Eval report" section mein -- ye CP3 gate hai.
- Acceptance: pytest -- relevant chunk ko neeche move karne pe precision girta hai, recall same; ek chunk hatane pe recall girta hai.

### Common pitfalls
- Reference answer khud retrieved context se generate karna -- recall hamesha ~1.0 aayega; reference independent source ya human-reviewed honi chahiye (M14-08).
- K report na karna -- K=3 vs K=10 ke numbers compare karke "reranker ne recall badhaya" bolna galat conclusion hai.
- Har chunk x har claim pe judge call bina cap ke -- K=20 aur 10 claims = 200 calls per row; batch prompts aur sampling use karo (M14-05).

### Checklist before moving on
- [ ] Context precision ka formula haath se ek ranking pe calculate kar sakta hoon.
- [ ] Context recall ko reference claims ke terms mein samjha sakta hoon.
- [ ] Plain P@k vs context precision ka difference ek example se dikha sakta hoon.
- [ ] Low recall vs low precision ke liye kaunsa fix, ye bata sakta hoon.

### Related
- M06-14 Precision and recall metrics
- M06-15 Cross-encoder reranking models
- M14-06 Calculating RAGAS faithfulness and answer relevance metrics
- M14-08 Creating synthetic benchmark datasets from source documents

### Self-quiz
1. Do retrievers ka P@5 same hai lekin context precision alag. Kya hua hoga, aur user ke liye kaunsa better hai?
2. Context recall ko reference answer kyun chahiye, jabki faithfulness ko nahi?
3. Recall 0.95, precision 0.30, faithfulness 0.90 -- aap customer ko kya fix recommend karoge?
4. K ko 5 se 20 karne pe teeno metrics aur cost pe kya asar padega?
