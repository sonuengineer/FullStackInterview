# LLM Fundamentals & Prompting

## Zero-shot and few-shot prompting

> Core | Fast CP2 / Slow CP3 | ~1.2 h | Builds on: M01-07, M02-02

### Kahani
Ek insurance customer ke paas roz 3,000 claim emails aate hain. Unhe chahiye ki LLM har email ko `fraud_risk`, `routine`, ya `escalate` mein daale.
Aapne prompt likha: "Classify this email." Demo mein theek chala. Production mein model ne "policy lapsed, backdated payment" wale emails ko `routine` bol diya -- jabki customer ki team ke liye ye classic fraud pattern hai.
Model ko general English aati hai, lekin is company ki definition of "fraud" nahi aati. Aapko model ko 4-5 asli examples dikhane padenge, aur prove karna padega ki examples se accuracy sach mein badhi.

### What it is
**Zero-shot** = sirf instruction do ("Classify into A/B/C"), koi example nahi. **Few-shot** = instruction ke saath kuch input -> output examples bhi do, taaki model pattern copy kare (in-context learning).
Messages API mein few-shot ka clean tareeka: examples ko alternate `user` / `assistant` turns ke roop mein bhejo, phir asli input last `user` turn mein.

### Why it matters for an FDE
Customer ke labels hamesha domain-specific hote hain. Bina examples ke model "common sense" label deta hai, customer ka label nahi -- aur bina eval set ke aap prove hi nahi kar sakte ki prompt change ne kuch sudhara ya bigaada.

### Key concepts
- **Instruction first** -- labels ki exact list aur "output only the label" zero-shot mein bhi zaroori hai; output format fix rakho.
- **Few-shot as turns** -- `user` (example input) + `assistant` (example label) pairs; model ko lagta hai usne pehle aise hi jawab diye.
- **Example selection** -- har label ka kam se kam ek example, aur "tricky" boundary cases; sirf easy examples se bias aata hai.
- **Order / majority bias** -- saare examples ek hi label ke ho ya last example hamesha same ho to model usi taraf jhukta hai.
- **Eval set** -- 20-50 labelled examples jo prompt mein NAHI hain; har prompt change pe accuracy compare karo.

### Code example
stdlib only

> Needs API key for the real version: ANTHROPIC_API_KEY (or OPENAI_API_KEY)

```python
# runnable
import re

LABELS = ["fraud_risk", "routine", "escalate"]
SYSTEM = ("You classify insurance claim emails. Answer with exactly one label from: "
          + ", ".join(LABELS) + ". Output only the label.")

FEW_SHOT = [
    ("Policy lapsed last month, I paid today, please date the payment to the 1st.", "fraud_risk"),
    ("Please update my mailing address to 12 Park Road.", "routine"),
    ("My lawyer will contact you, the claim denial is unacceptable.", "escalate"),
    ("Can you backdate my cover so the accident on Monday is included?", "fraud_risk"),
]
STOP = {"the", "my", "i", "to", "a", "please", "can", "you", "of", "is", "so", "on"}


def build_messages(email, shots=()):
    msgs = []
    for example, label in shots:                      # few-shot = alternating turns
        msgs += [{"role": "user", "content": example}, {"role": "assistant", "content": label}]
    msgs.append({"role": "user", "content": email})
    return msgs


def words(t):
    return set(re.findall(r"[a-z]+", t.lower())) - STOP


class FakeLLM:
    """Same call shape as client.messages.create(...). No network.
    Toy simulation: with examples it copies the label of the most similar example
    (crude in-context learning); without examples it uses generic 'common sense'."""
    def create(self, model, system, messages, max_tokens=10):
        email = messages[-1]["content"]
        shots = [(messages[i]["content"], messages[i + 1]["content"])
                 for i in range(0, len(messages) - 1, 2)]
        label = "escalate" if "lawyer" in email.lower() else "routine"
        if shots:
            best = max(shots, key=lambda s: len(words(s[0]) & words(email)))
            if words(best[0]) & words(email):
                label = best[1]
        return {"content": [{"type": "text", "text": label}]}


EVAL_SET = [   # never put these in the prompt
    ("I paid after the policy lapsed, can you date it to the 1st of the month?", "fraud_risk"),
    ("Please backdate my cover to last week.", "fraud_risk"),
    ("Update my phone number please.", "routine"),
    ("I will speak to my lawyer about this denial.", "escalate"),
    ("Change my mailing address.", "routine"),
]


def accuracy(llm, shots):
    hits = 0
    for email, gold in EVAL_SET:
        resp = llm.create(model="fake", system=SYSTEM, messages=build_messages(email, shots))
        out = resp["content"][0]["text"].strip()
        assert out in LABELS, f"bad label {out!r}"   # format check on every call
        hits += out == gold
    return hits / len(EVAL_SET)


llm = FakeLLM()
zero, few = accuracy(llm, ()), accuracy(llm, FEW_SHOT)
print(f"zero-shot accuracy={zero:.0%}  few-shot accuracy={few:.0%}")
msgs = build_messages("x", FEW_SHOT)
assert [m["role"] for m in msgs] == ["user", "assistant"] * 4 + ["user"]
assert not {e for e, _ in EVAL_SET} & {e for e, _ in FEW_SHOT}, "eval leaked into prompt"
assert few > zero, "few-shot should beat zero-shot on domain labels"
print("OK: few-shot turns built, eval set kept out of the prompt")
```

- `SYSTEM` mein labels ki closed list + "Output only the label" -- ye zero-shot ka minimum hai; isse parse karna aasaan.
- `build_messages` -- examples alternate user/assistant turns ban jaate hain, asli email hamesha last `user` message.
- `FakeLLM` sirf toy hai (similar example ka label copy karta hai) -- real model kahin zyada smart hai, lekin **eval harness** wahi rahega.
- `EVAL_SET` prompt ke examples se alag hai (assert bhi hai) -- warna aap model ki memory test kar rahe ho, generalisation nahi.
- `assert out in LABELS` -- har call pe format check; yahi idea M05-06 mein strict JSON schema ban jaata hai.

```python
# real version -- not run here, needs: pip install anthropic
import os
import anthropic

MODEL = os.environ.get("LLM_MODEL", "<your-model-id>")
client = anthropic.Anthropic()          # reads ANTHROPIC_API_KEY from env
resp = client.messages.create(
    model=MODEL, max_tokens=10, system=SYSTEM,
    messages=build_messages("Please backdate my cover to last week.", FEW_SHOT),
)
label = next(b.text for b in resp.content if b.type == "text").strip()
print(label)
```

OpenAI equivalent: `client.chat.completions.create(model=..., messages=[{"role": "system", ...}, ...])` -- same alternating user/assistant few-shot idea.

### Mini-exercise (30-60 min)
CP2 capstone shuru: apne `omniguard` repo mein `omniguard/prompts.py` aur `evals/triage_eval.jsonl` banao.
- Domain chuno (jaise bank support messages: `card_block`, `fraud_report`, `general`). 30 labelled examples likho; 5 prompt ke liye, 25 eval ke liye.
- `build_messages(text, shots)` function + ek `run_eval(llm, shots)` jo accuracy aur galat predictions print kare.
- FakeLLM se pehle chalao, phir (agar key hai) real model se zero-shot vs few-shot compare karo.
- Acceptance: pytest test -- eval file ka koi text few-shot list mein nahi hai; har output `LABELS` mein hai; report mein dono accuracies dikhti hain.

### Common pitfalls
- Eval examples ko hi few-shot mein daal dena -- accuracy 100% dikhegi, production mein gir jaayegi.
- 20+ examples thoons dena -- har call pe tokens (cost + latency) badhte hain (M05-03); pehle 3-6 se shuru karo aur measure karo.
- Real customer emails (naam, policy number) examples mein daal ke git mein commit karna -- PII leak. Examples anonymise karo.

### Checklist before moving on
- [ ] Zero-shot aur few-shot ka fark ek example se samjha sakta hoon.
- [ ] Few-shot ko alternating user/assistant turns mein bana sakta hoon.
- [ ] Mere paas ek alag eval set hai aur har prompt change ki accuracy compare karta hoon.
- [ ] Output labels closed list mein hain aur har response check hota hai.

### Related
- M05-02 Chain of thought reasoning
- M05-03 Token calculation
- M05-06 Enforcing strict JSON output schemas via APIs
- M14-05 Automating LLM-as-a-judge scoring pipelines

### Self-quiz
1. Customer bolta hai "model galat label deta hai". Aap prompt badalne se pehle kya banaoge, aur kyun?
2. Few-shot examples ko system prompt mein text ke roop mein daalna vs user/assistant turns -- kya fark pad sakta hai?
3. Aapke 5 examples mein se 4 `routine` hain. Model ke outputs pe kya asar padega?
4. Few-shot se accuracy badhi lekin latency 40% badh gayi. Aap kaise decide karoge kitne examples rakhne hain?
