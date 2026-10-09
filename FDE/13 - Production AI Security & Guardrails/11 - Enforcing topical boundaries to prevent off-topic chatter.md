# Production AI Security & Guardrails

## Enforcing topical boundaries to prevent off-topic chatter

> Core | Fast CP6 / Slow CP8 | ~1.2 h | Builds on: M13-10, M06-03, M06-07

### Kahani
Ek telecom customer ka billing bot. Ek hafte ke logs dekhe: 18% traffic "write my college essay", "IPL prediction", "which stock should I buy" tha.
Teen problems: LLM bill 18% zyada, bot ne ek user ko stock tip de di (legal ne turant call kiya), aur ek screenshot mein bot politics pe opinion de raha tha.
System prompt mein "only answer billing questions" likha tha. Model ne zyada-tar maana, par "friendly" banne ke chakkar mein kabhi-kabhi nahi.
Fix: model se **pehle** ek topic classifier jo decide kare ki sawaal scope mein hai ya nahi -- aur scope ke bahar ho to cheap, polite refusal, bina LLM call ke.

### What it is
**Topical rail** = allowed topics (billing, plans, recharge) aur denied topics (investment advice, medical, politics) ki explicit list, aur ek classifier jo har message ko inme map karta hai.
Decision: allowed topic + confidence threshold se upar = LLM ko bhejo; denied topic = category-specific refusal; unclear = clarify ya generic refusal.

### Why it matters for an FDE
Off-topic answers teen cheezein bigaadte hain: cost, liability (financial/medical advice), aur brand. Customer ka legal team "denied topics" list sign-off karega -- aapko use code mein enforce karna hai.

### Key concepts
- **Allow-list over deny-list** -- "billing ke alawa sab refuse" zyada safe hai "politics, stocks, ... refuse" se; deny-list kabhi complete nahi hoti.
- **Embedding classifier** -- har topic ke 5-20 example utterances ka centroid; naya message ka cosine similarity (M06-07). Production mein real embeddings (M06-03).
- **Confidence threshold** -- top score kam hai to "unclear"; threshold eval set pe tune karo, guess mat karo.
- **Refusal templates** -- category-wise polite message + redirect ("main billing mein help kar sakta hoon..."). Same template har baar, model-generated nahi.
- **Output-side check** -- model ka answer bhi denied topic classifier se guzaro; RAG context se bhi drift hota hai.

### Code example
`pip install numpy`

```python
# runnable
import re
import numpy as np

TOPICS = {   # label -> (allowed?, example utterances); real system: 10-50 examples per topic
    "billing": (True, ["why is my bill higher this month", "explain extra charges on my invoice",
                       "when is my bill due", "pay my bill online"]),
    "plans": (True, ["upgrade my mobile plan", "which plan has more data", "change my recharge plan"]),
    "investment": (False, ["which stock should i buy", "is bitcoin a good investment", "share market tips"]),
    "politics": (False, ["who will win the election", "what do you think about the government"]),
}
REFUSALS = {
    "investment": "I can't give investment advice. I can help with your bill, plan or recharge.",
    "politics": "I'm not able to discuss politics. I can help with your bill, plan or recharge.",
    "unclear": "I can help with bills, plans and recharges. Could you rephrase your question?",
}
STOP = {"the", "a", "my", "me", "is", "i", "you", "what", "do", "about", "this", "on", "to", "of", "which", "who",
        "will", "has", "think", "some", "when", "why", "more", "and", "also", "so", "today", "want", "with", "for"}
def words(text: str) -> list[str]:            # lowercase, drop stopwords, crude plural stemming
    return [w.rstrip("s") if len(w) > 3 else w for w in re.findall(r"[a-z]+", text.lower()) if w not in STOP]
VOCAB = sorted({w for _, ex in TOPICS.values() for s in ex for w in words(s)})

def embed(text: str) -> np.ndarray:          # toy bag-of-words "embedding"; real: an embedding model
    ws = words(text)
    v = np.array([ws.count(w) for w in VOCAB], dtype=float)
    n = np.linalg.norm(v)
    return v / n if n else v

CENTROIDS = {}
for label, (_, examples) in TOPICS.items():
    c = np.mean([embed(e) for e in examples], axis=0)
    CENTROIDS[label] = c / np.linalg.norm(c)

def classify(text: str, threshold: float = 0.35) -> tuple[str, float]:
    v = embed(text)
    scores = {lbl: float(v @ c) for lbl, c in CENTROIDS.items()}
    best = max(scores, key=scores.get)
    return (best, scores[best]) if scores[best] >= threshold else ("unclear", scores[best])

class FakeLLM:   # stands in for the chat call; counts calls so we can prove refusals are free
    calls = 0
    def answer(self, q: str) -> str:
        FakeLLM.calls += 1
        return "Your bill rose because of 2 GB extra data. Also, you should buy some bank stocks."

def topical_answer(q: str) -> tuple[str, str]:
    label, _ = classify(q)
    if label == "unclear" or not TOPICS[label][0]:
        return label, REFUSALS.get(label, REFUSALS["unclear"])        # no LLM call, no cost
    out = FakeLLM().answer(q)
    sentences = re.split(r"(?<=\.)\s+", out)                           # output-side topical check
    kept = [s for s in sentences if classify(s)[0] not in ("investment", "politics")]
    return label, " ".join(kept) or REFUSALS["unclear"]

cases = {
    "Why is my bill so high this month?": "billing",
    "I want to upgrade to a plan with more data": "plans",
    "Which stock should I buy today?": "investment",
    "Who will win the election?": "politics",
    "Write me a poem about the moon": "unclear",
}
for q, expected in cases.items():
    label, reply = topical_answer(q)
    print(f"{label:10} | {q} -> {reply}")
    assert label == expected, (q, label)

assert FakeLLM.calls == 2                       # only the 2 in-scope questions reached the model
_, reply = topical_answer("Why is my bill higher?")
assert "stocks" not in reply and "2 GB" in reply   # output rail stripped the off-topic sentence
assert topical_answer("Is bitcoin a good investment?")[1] == REFUSALS["investment"]
print("OK: allow-listed topics reach the LLM, denied/unclear get templates, output drift removed")
```

- `TOPICS` -- har label ke saath `allowed` flag. Legal team isi table ko review karti hai; code mein topic add karna = ek dict entry.
- `words` + `embed` + `CENTROIDS` -- stopwords hata ke bag-of-words toy hai (bina stopwords hataye "about the moon" politics ke kareeb aa gaya tha), par flow real jaisa: examples -> centroid -> cosine. Real embeddings ke saath "IPL prediction" bhi "unclear/denied" pakda jaayega bina exact words ke.
- `threshold` -- poem wala sawaal kisi topic ke kareeb nahi, to `unclear`. Allow-list ka faayda: nayi off-topic cheez apne aap refuse.
- `FakeLLM.calls == 2` -- refusals ne LLM call hi nahi kiya: cost aur latency dono bache.
- Output check -- model ne billing answer mein stock tip ghusa di; sentence-level filter ne hata di. Production mein poora answer block bhi kar sakte ho (stricter).

```python
# real version -- not run here, needs: pip install sentence-transformers
from sentence_transformers import SentenceTransformer
model = SentenceTransformer("all-MiniLM-L6-v2")   # or your provider's embedding API
def embed(text: str):
    return model.encode(text, normalize_embeddings=True)
```

### Mini-exercise (30-60 min)
OmniGuard CP6: `omniguard/guardrails/topics.py`.
- `config/topics.yaml`: OmniGuard ke allowed topics (policy docs, claims, SQL reports) + denied (legal advice, HR gossip, politics) with 10 examples each, aur refusal templates.
- `classify()` + `topical_check(text) -> Decision` jo M13-10 pipeline mein input aur output dono side plug ho.
- `tests/test_topics.py`: 30 labelled questions (20 in-scope, 10 out); accuracy print karo; in-scope ka false refusal <= 1.
- Threshold ko eval set pe sweep karo (0.2 se 0.6) aur chosen value ka reason README mein likho.

### Common pitfalls
- Sirf system prompt se scope enforce karna -- model "helpful" banke drift karta hai; classifier model ke bahar chahiye.
- Threshold itna strict ki genuine users refuse ho -- "my bil is hi" jaise typos; false refusals bhi measure karo.
- Refusal LLM se generate karwana -- cost bhi, aur kabhi refusal ke andar hi off-topic answer aa jaata hai. Templates use karo.

### Checklist before moving on
- [ ] Allowed + denied topics config file mein hain, customer ne sign off kiya.
- [ ] Classifier ka threshold eval set se tune kiya.
- [ ] Out-of-scope requests LLM tak nahi jaati (call count test).
- [ ] Output-side topical check hai.

### Related
- M13-10 Configuring strict input and output filtering pipelines natively in Python
- M13-09 Writing programmable conversational rails using Colang
- M13-12 Setting up AWS Bedrock managed guardrail configurations via Boto3
- M06-03 Understanding vector representations
- M06-07 Distance metrics (Cosine, Euclidean)

### Self-quiz
1. Allow-list topical rail deny-list se zyada safe kyun hai? Ek example do jo deny-list miss karegi.
2. Threshold 0.35 se 0.6 kar diya. Kya badhega, kya ghatega?
3. Refusal ko LLM-generated ki jagah template kyun rakhna chahiye?
4. Input classifier ne allow kiya, phir bhi output-side check kyun chahiye?
