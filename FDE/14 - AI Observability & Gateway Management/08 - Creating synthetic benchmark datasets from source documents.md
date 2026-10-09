# AI Observability & Gateway Management

## Creating synthetic benchmark datasets from source documents

> Core | Fast CP3 / Slow CP4 | ~1.2 h | Builds on: M06-01, M14-05, M14-07

### Kahani
Ek logistics company ne aapko 400 pages ke SOPs diye: customs, damaged goods, SLA penalties. Aapka RAG ready hai, ab customer bolta hai "eval report dikhao".
Problem: koi labelled question-answer set hai hi nahi. Ops team ke paas time nahi ki 200 sawaal likhe. Aapne ek LLM se "is document se 200 questions banao" karwaya -- 40% duplicates, kuch sawaal jinka jawab document mein hai hi nahi, aur sab ke sab ek hi bade document se.
Galat dataset pe accha score = jhooth. Chahiye: ek controlled pipeline jo generate, clean, balance, review aur version kare.

### What it is
**Synthetic benchmark** = source chunks se LLM dwara banaye gaye (question, reference answer, source context) triples, jo M14-06/07 ke metrics ke liye ground truth bante hain.
Pipeline: chunk -> generate -> dedupe -> filter (answerable from context) -> stratify (doc x question type) -> human-reviewed gold subset -> versioned `dataset.jsonl`.

### Why it matters for an FDE
Customer ke paas labelled data almost kabhi nahi hota; synthetic dataset day-1 pe eval shuru karne ka sabse sasta raasta hai. Lekin bina filtering aur review ke ye aapke system ki galtiyon ko hi "sahi" maan leta hai.

### Key concepts
- **Triple** -- `question`, `reference`, `context` + metadata (`doc_id`, `chunk_id`, `qtype`); context recall (M14-07) ke liye reference zaroori hai.
- **Answerable filter** -- reference ke facts source context mein hone chahiye; nahi to generator ne hallucinate kiya, row drop.
- **Stratification** -- har doc aur har question type (factual, numeric, multi-hop, unanswerable) se fixed quota; ek bada doc poora dataset na kha jaaye.
- **Gold subset** -- har stratum se kuch rows human review karta hai; headline number gold pe, baaki pe trend. Judge calibration (M14-05) bhi isi pe.
- **Versioning + leakage** -- canonical JSONL ka hash = dataset version (M14-09 isi se compare karega); eval questions kabhi few-shot prompts mein nahi.

### Code example
stdlib only

> Needs API key for the real version: ANTHROPIC_API_KEY (or OPENAI_API_KEY) for the generator LLM

```python
# runnable
import hashlib, json, random, re, tempfile
from collections import defaultdict
from pathlib import Path

DOCS = {
    "customs_sop": "Shipments above 50000 INR need an e-way bill.\n\nCustoms holds are cleared within 2 working days.",
    "damage_sop": "Damaged parcels must be photographed at the hub.\n\nClaims for damage are filed within 7 days of delivery.",
}
words = lambda s: set(re.findall(r"[a-z0-9]+", s.lower())) - {"the", "a", "an", "of", "for", "at", "are", "is"}
norm = lambda q: " ".join(sorted(words(q)))

class FakeGenerator:
    """Deterministic stand-in for an LLM question writer -- ONLY for wiring/tests. It also injects the
    two classic LLM mistakes (duplicate question, answer not in context) so the filters have work."""
    def generate(self, doc_id, chunk_id, chunk):
        topic = " ".join(sorted(words(chunk))[:3])
        qtype = "numeric" if re.search(r"\d", chunk) else "factual"
        q = f"What does the {doc_id.replace('_', ' ')} say about {topic}?"
        out = [{"question": q, "reference": chunk, "qtype": qtype},
               {"question": q.upper(), "reference": chunk, "qtype": qtype}]          # duplicate
        if chunk_id.endswith("1"):
            out.append({"question": f"Is there a fee for {topic}?", "reference": "A 500 INR fee applies.", "qtype": "factual"})
        return [dict(r, doc_id=doc_id, chunk_id=chunk_id, context=chunk) for r in out]

def answerable(row, min_cov=0.8):
    ref = words(row["reference"])
    return len(ref & words(row["context"])) / max(len(ref), 1) >= min_cov

def build(gen, per_stratum=2, seed=13):
    raw = [r for d, text in DOCS.items() for i, ch in enumerate(text.split("\n\n"))
           for r in gen.generate(d, f"{d}#{i}", ch)]
    seen, kept = set(), []
    for r in raw:
        if norm(r["question"]) in seen or not answerable(r):
            continue
        seen.add(norm(r["question"])); kept.append(r)
    strata = defaultdict(list)
    for r in kept:
        strata[(r["doc_id"], r["qtype"])].append(r)
    rng, final = random.Random(seed), []
    for key in sorted(strata):
        picked = rng.sample(strata[key], min(per_stratum, len(strata[key])))
        for i, r in enumerate(picked):
            final.append(dict(r, review="gold_pending" if i == 0 else "auto"))
    return raw, final

def write_versioned(rows, folder):
    lines = [json.dumps(r, sort_keys=True) for r in sorted(rows, key=lambda r: r["question"])]
    body = "\n".join(lines) + "\n"
    version = hashlib.sha256(body.encode()).hexdigest()[:12]
    (folder / "dataset.jsonl").write_text(body, encoding="utf-8")
    (folder / "manifest.json").write_text(json.dumps({"version": version, "rows": len(rows)}), encoding="utf-8")
    return version

raw, rows = build(FakeGenerator())
print(f"generated={len(raw)} kept={len(rows)} strata={sorted({(r['doc_id'], r['qtype']) for r in rows})}")
assert len(raw) == 10 and len(rows) == 4                      # 4 duplicates + 2 unanswerable removed
assert all(answerable(r) for r in rows) and not any("fee" in r["question"] for r in rows)
strata = {(r["doc_id"], r["qtype"]) for r in rows}
assert len(strata) == 3 and sum(r["review"] == "gold_pending" for r in rows) == 3   # 1 gold per stratum

with tempfile.TemporaryDirectory() as tmp:
    v1 = write_versioned(rows, Path(tmp))
    v2 = write_versioned(build(FakeGenerator())[1], Path(tmp))
    rows[0]["reference"] += " Updated."
    v3 = write_versioned(rows, Path(tmp))
    print("versions:", v1, v2, v3)
    assert v1 == v2 != v3                                      # same data -> same hash; edit -> new hash

FEW_SHOT_PROMPT = "Example Q: How do I track my parcel? A: Use the tracking page."
assert not {norm(r["question"]) for r in rows} & {norm(q) for q in re.findall(r"Q: (.*?) A:", FEW_SHOT_PROMPT)}
print("OK: generate -> dedupe -> answerable filter -> stratify -> gold subset -> versioned, no leakage")
```

- `FakeGenerator` -- real LLM ki do common galtiyan jaan-boojh ke daalta hai: duplicate (sirf casing alag) aur aisa reference jo context mein hai hi nahi ("500 INR fee").
- `norm` -- word-set based normalization; casing/punctuation/word order alag ho to bhi duplicate pakda jaata hai. Real pipeline mein embedding similarity > 0.9 bhi lagao.
- `answerable` -- reference ke 80% words context mein hone chahiye; real version mein ye M14-05 ka judge call hai ("can this be answered only from CONTEXT? yes/no").
- `build` -- `(doc_id, qtype)` strata, seeded sampling: dataset reproducible hai aur har doc/type represented hai. Har stratum ka pehla row `gold_pending` -- human review queue.
- `write_versioned` -- sorted + `sort_keys` canonical JSON, phir hash; same data = same version, ek reference edit = naya version. M14-09 scores ko isi version se tag karega.
- Last assert -- few-shot prompt mein koi eval question nahi; leak hua to model test ke answers "yaad" karke score inflate karega.

```python
# real version -- not run here, needs: pip install anthropic pydantic
import os
import anthropic
from pydantic import BaseModel

class QA(BaseModel):
    question: str
    reference: str
    qtype: str

class QASet(BaseModel):
    items: list[QA]

client = anthropic.Anthropic(max_retries=2, timeout=60)

def generate(doc_id, chunk_id, chunk):
    msg = client.messages.parse(
        model=os.environ.get("LLM_MODEL", "<your-model-id>"), max_tokens=800,
        system="Write 3 questions answerable ONLY from the CONTEXT. Mix factual and numeric. "
               "The reference answer must use facts from the CONTEXT only.",
        messages=[{"role": "user", "content": f"CONTEXT:\n{chunk}"}], output_format=QASet)
    return [dict(q.model_dump(), doc_id=doc_id, chunk_id=chunk_id, context=chunk) for q in msg.parsed_output.items]
```

ragas also ships a test-set generator (knowledge-graph based); its API changes often -- check the docs for your ragas version before using it.

### Mini-exercise (30-60 min)
OmniGuard Hybrid RAG v1 ke liye `omniguard/evals/build_dataset.py` banao.
- Input: OmniGuard ke apne docs (M06-01 wale chunks). Output: `omniguard/evals/dataset.jsonl` + `manifest.json` (version hash, rows per stratum, generator model, date).
- Kam se kam 40 rows, 4 qtypes incl. 5 "unanswerable" questions (expected answer: refuse). 15 rows khud review karke `review: "gold"`.
- `run_eval.py` dataset version ko `report.md` ke top pe print kare; M14-07 ke metrics gold aur full set dono pe alag.
- Acceptance: pytest -- duplicate question drop hota hai; unanswerable-from-context reference drop hota hai; same input pe version hash stable.

### Common pitfalls
- Wahi model + wahi chunks se questions banana jo system use karta hai, aur sirf unhi pe test -- dataset aapke chunking ki blind spots share karta hai. Kuch real user questions (anonymized) bhi milao.
- Dataset ko git mein bina version ke overwrite karna -- last month ka 0.82 aur aaj ka 0.78 compare hi nahi ho sakte.
- Customer docs mein PII ho to generated questions mein bhi aa jaati hai; generate karne se pehle redact karo (M13), aur dataset ko secret jaisa treat karo.

### Checklist before moving on
- [ ] Synthetic triple ke fields aur har field ka use bata sakta hoon.
- [ ] Dedupe, answerable filter aur stratification code mein implement kar sakta hoon.
- [ ] Gold subset kyun aur kitna chahiye, samjha sakta hoon.
- [ ] Dataset version hash kaise banta hai aur eval leakage kaise rokta hoon.

### Related
- M06-01 Fixed-size and semantic chunking
- M14-05 Automating LLM-as-a-judge scoring pipelines
- M14-07 Measuring context precision and recall
- M14-09 Tracking evaluation scores across deployment runs

### Self-quiz
1. Synthetic dataset pe score 0.95 aaya lekin real users unhappy hain. Teen possible reasons?
2. Stratification na karo to kya bias aayega? Ek logistics example se samjhao.
3. Dataset version hash ke bina M14-09 ka "score across deployments" comparison kyun toot jaata hai?
4. "Unanswerable" questions dataset mein kyun daalne chahiye?
