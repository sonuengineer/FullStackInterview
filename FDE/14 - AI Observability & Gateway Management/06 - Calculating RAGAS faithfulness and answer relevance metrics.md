# AI Observability & Gateway Management

## Calculating RAGAS faithfulness and answer relevance metrics

> Core | Fast CP3 / Slow CP4 | ~1.2 h | Builds on: M06-10, M14-05

### Kahani
Ek e-commerce company ka refund-policy RAG bot. Retriever sahi chunk laata hai, phir bhi ek customer ko bot ne bola "express refunds 1 hour mein aate hain" -- ye line kisi document mein nahi thi. Model ne context ke upar apni taraf se ek "helpful" claim jod diya.
Doosre case mein user ne address change ke baare mein poocha, bot ne perfectly grounded refund policy suna di -- sach, lekin bekaar.
Customer ka QA lead poochta hai: "In dono failures ko alag-alag number se pakad sakte ho?" Haan -- faithfulness aur answer relevance.

### What it is
**Faithfulness** = (answer ke jo claims retrieved context se supported hain) / (answer ke total claims). Ye hallucination measure karta hai -- answer context ke bahar gaya ya nahi. Correctness nahi; context galat ho to faithful answer bhi galat ho sakta hai.
**Answer relevance** = answer question ko kitna address karta hai. RAGAS ise reverse karke naapta hai: LLM answer se N questions generate karta hai, unke embeddings ka original question se mean cosine similarity; noncommittal answer ("I don't know") ko 0 milta hai (details check the docs for your ragas version).

### Why it matters for an FDE
Ek single "quality score" do alag bugs ko mix kar deta hai: hallucination (fix: prompt/grounding) aur off-topic answer (fix: retrieval/routing). Alag metric = sahi team ko sahi bug.

### Key concepts
- **Claim extraction** -- answer ko atomic statements mein todna (real: LLM; yahan fake: sentence split). Claims ki granularity score badal deti hai.
- **Support check (NLI-style)** -- har claim ke liye judge: "kya ye context se infer hota hai?" yes/no. Context ke bahar ka sach bhi "unsupported" hai.
- **Reverse-question relevance** -- answer se question guess karo; agar guessed question original jaisa hai to answer on-topic tha.
- **Orthogonal metrics** -- faithful-but-irrelevant aur relevant-but-hallucinated dono possible; dono saath report karo.
- **Reference-free** -- dono metrics ko ground-truth answer nahi chahiye, sirf question + answer + contexts; isliye production traffic pe bhi chal sakte hain.

### Code example
`pip install numpy pydantic`

> Needs API key for the real version: ANTHROPIC_API_KEY (or OPENAI_API_KEY) for the judge LLM, plus an embeddings model

```python
# runnable
import hashlib, re
import numpy as np

STOP = set("a an the is are to of in on for my i do does can how what when will be with and our it".split())
NONCOMMITTAL = ("i don't know", "i do not know", "not sure", "cannot answer")

def words(s):
    return [w[:-1] if len(w) > 3 and w.endswith("s") else w
            for w in re.findall(r"[a-z0-9']+", s.lower()) if w not in STOP]

class FakeJudge:
    """Deterministic stand-in for the LLM + embeddings that ragas uses. ONLY for wiring/tests:
    claims = sentence split, support = token overlap, questions = answer content words."""
    def extract_claims(self, answer):
        return [s.strip() for s in re.split(r"(?<=[.!?])\s+", answer) if s.strip()]
    def is_supported(self, claim, contexts):
        c, ctx = set(words(claim)), set(words(" ".join(contexts)))
        return len(c & ctx) / max(len(c), 1) >= 0.7
    def generate_questions(self, answer, n=3):
        return [" ".join(words(s)) for s in self.extract_claims(answer)][:n]
    def is_noncommittal(self, answer):
        return any(p in answer.lower() for p in NONCOMMITTAL)
    def embed(self, text, dim=256):
        v = np.zeros(dim)
        for w in words(text):
            v[int(hashlib.md5(w.encode()).hexdigest(), 16) % dim] += 1
        return v / (np.linalg.norm(v) or 1.0)

def faithfulness(judge, answer, contexts):
    claims = judge.extract_claims(answer)
    if not claims:
        return None, []                                 # nothing to score -> not 1.0, not 0.0
    verdicts = [judge.is_supported(c, contexts) for c in claims]
    return sum(verdicts) / len(claims), [c for c, ok in zip(claims, verdicts) if not ok]

def answer_relevance(judge, question, answer):
    if judge.is_noncommittal(answer):
        return 0.0
    q = judge.embed(question)
    sims = [float(q @ judge.embed(g)) for g in judge.generate_questions(answer)]
    return sum(sims) / len(sims) if sims else 0.0

CTX = ["Refunds are sent to the original card within 5 business days.",
       "Delivery address can be changed until the order is packed."]
Q = "How long does a refund take to reach my card?"
cases = {
    "grounded":     "Refunds reach the original card within 5 business days.",
    "hallucinated": "Refunds reach the original card within 5 business days. Express refunds take 1 hour.",
    "off_topic":    "Delivery address can be changed until the order is packed.",
    "noncommittal": "I don't know, please contact support.",
}
j, rows = FakeJudge(), {}
for name, ans in cases.items():
    f, unsupported = faithfulness(j, ans, CTX)
    rows[name] = (f, answer_relevance(j, Q, ans))
    print(f"{name:13s} faithfulness={f:.2f} relevance={rows[name][1]:.2f} unsupported={unsupported}")

assert rows["grounded"][0] == 1.0 and rows["hallucinated"][0] == 0.5
assert rows["off_topic"][0] == 1.0 and rows["off_topic"][1] < 0.1     # faithful but irrelevant
assert rows["grounded"][1] > rows["hallucinated"][1] > rows["off_topic"][1]
assert rows["noncommittal"][1] == 0.0
print("OK: faithfulness and answer relevance catch different failures")
```

- `faithfulness` -- unsupported claims bhi return karta hai; report mein sirf number nahi, "kaunsa claim hallucinated tha" dikhao -- debugging isi se hoti hai.
- `off_topic` case -- faithfulness 1.0 (har line context mein hai) lekin relevance ~0: ek metric akela kabhi kaafi nahi.
- `hallucinated` -- relevance bhi thoda girta hai kyunki extra claim se generated question topic se bhatakta hai; lekin asli signal faithfulness 0.5 hai.
- `FakeJudge` -- absolute numbers ka koi matlab nahi (token overlap ek bekaar grader hai); sirf pipeline wiring aur ordering test karne ke liye. Real scores real LLM + embeddings se aate hain.
- `None` jab claims hi nahi -- empty answer ko 1.0 dena (koi unsupported claim nahi!) ek classic averaging bug hai.

```python
# real version -- not run here, needs: pip install ragas  (API shown is ragas 0.2-style;
# ragas changes often -- check the docs for your ragas version before copying)
from ragas import EvaluationDataset, evaluate
from ragas.metrics import Faithfulness, ResponseRelevancy

rows = [{"user_input": Q, "response": cases["hallucinated"], "retrieved_contexts": CTX}]
result = evaluate(dataset=EvaluationDataset.from_list(rows),
                  metrics=[Faithfulness(), ResponseRelevancy()],
                  llm=evaluator_llm, embeddings=evaluator_embeddings)   # wrappers: see ragas docs
print(result)
```

### Mini-exercise (30-60 min)
OmniGuard Hybrid RAG v1 ke liye `omniguard/evals/metrics.py` banao.
- `faithfulness(judge, answer, contexts)` aur `answer_relevance(judge, question, answer, embedder)` -- judge interface M14-05 wala hi (FakeJudge tests mein, real judge env var se).
- `run_eval.py` har row ke liye ye dono compute kare aur `report.md` mein mean + 5 worst rows (with unsupported claims) likhe.
- Agar ragas install kar sakte ho: same 10 rows pe ragas aur apna implementation chalao, difference table `report.md` mein.
- Acceptance: pytest -- empty answer pe `None`; "I don't know" pe relevance 0; ek injected hallucinated sentence pe faithfulness < 1.

### Common pitfalls
- Faithfulness ko "accuracy" bolna -- galat chunk retrieve hua aur answer ne usko faithfully repeat kiya to score 1.0 aayega. Correctness ke liye reference answer chahiye (M14-07, M14-08).
- Judge LLM ko poora context window bhar ke dena -- har claim x har context = cost explode; claims cap karo, sample karo, cache karo (M14-05).
- ragas version upgrade ke baad scores compare karna -- metric implementation badalti hai; version ko report mein pin karo (M14-09).

### Checklist before moving on
- [ ] Faithfulness ka formula aur ye kya NAHI measure karta, dono bata sakta hoon.
- [ ] Answer relevance ka reverse-question + embedding method samjha sakta hoon.
- [ ] Faithful-but-irrelevant ka example de sakta hoon.
- [ ] Mera metric code empty/noncommittal answers ko sahi handle karta hai.

### Related
- M06-10 End-to-end basic retrieval
- M14-05 Automating LLM-as-a-judge scoring pipelines
- M14-07 Measuring context precision and recall
- M14-09 Tracking evaluation scores across deployment runs

### Self-quiz
1. Faithfulness 1.0 hai lekin user ko galat jawab mila. Ye kaise possible hai, aur kaunsa metric isse pakdega?
2. RAGAS answer relevance seedha "question vs answer" similarity kyun nahi leta, reverse questions kyun banata hai?
3. Claim extraction coarse (poora paragraph = 1 claim) ho to faithfulness score pe kya asar padega?
4. Production traffic pe in metrics ko chalane ke liye ground truth kyun nahi chahiye -- aur iska fayda kya hai?
