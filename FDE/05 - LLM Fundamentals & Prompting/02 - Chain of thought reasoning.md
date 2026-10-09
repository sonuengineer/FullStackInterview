# LLM Fundamentals & Prompting

## Chain of thought reasoning

> Core | Fast CP2 / Slow CP3 | ~1.2 h | Builds on: M05-01

### Kahani
Ek logistics customer chahta hai ki LLM decide kare: late shipment pe customer ko refund milega ya nahi. Rule: "SLA 48 h, weekend count nahi hota, weather delay pe refund nahi, Gold customers ko hamesha 50%".
Direct "Answer refund yes/no" prompt pe model ne Friday-to-Tuesday shipment ko late bol diya (weekend gin liya). Jab aapne bola "step by step socho", answer sahi aaya -- lekin ab UI mein customer ko 15 line ka "Step 1: Friday 6 PM..." dikhne laga, aur ek baar usme internal policy note bhi leak ho gaya.
Aapko chahiye: reasoning jab zaroori ho tab, final answer clean JSON, aur reasoning end user tak kabhi raw na pahunche.

### What it is
**Chain of thought (CoT)** = model ko final answer se pehle intermediate steps likhne dena. Multi-step logic (dates, maths, rules ka combination) mein ye accuracy badhata hai, kyunki model har token "soch" ke aage badhta hai.
Do tareeke: (1) prompt mein bolo "think inside `<reasoning>` tags, then answer inside `<answer>`"; (2) bahut se current models mein **built-in extended thinking / reasoning mode** hota hai -- reasoning alag `thinking` content blocks mein aati hai (ya hidden rehti hai) aur final `text` block alag.

### Why it matters for an FDE
Galat decision (refund, claim, risk flag) customer ka paisa hai. Lekin reasoning text ko JSON ke andar mix karna parse errors deta hai, tokens ka bill badhata hai, aur raw reasoning dikhana compliance/UX problem hai.

### Key concepts
- **When to ask** -- multi-step rules, calculations, comparisons: haan. Simple classification / extraction: usually nahi -- sirf latency aur cost badhegi. Eval se decide karo (M05-01).
- **Separate channels** -- reasoning ek jagah (`<reasoning>` tag ya `thinking` block), final answer doosri jagah (`<answer>` JSON ya `text` block). Parser sirf answer padhe.
- **Built-in thinking** -- naye models khud sochte hain; aapko "think step by step" likhne ki zaroorat kam hoti hai. Parameter names model version ke saath badle hain -- docs dekho.
- **Never show raw reasoning** -- user ko short, approved explanation do (`reason_code`), raw chain nahi. Raw reasoning galat bhi ho sakti hai aur policy text leak kar sakti hai.
- **Log carefully** -- reasoning ko debug ke liye store karna ho to PII rules ke saath (M13-14); default mein sirf length/hash log karo.

### Code example
stdlib only

> Needs API key for the real version: ANTHROPIC_API_KEY (or OPENAI_API_KEY)

```python
# runnable
import json
import re

SYSTEM = ("Decide refund eligibility. Think step by step inside <reasoning></reasoning>. "
          'Then output ONLY JSON inside <answer></answer>: {"refund_pct": int, "reason_code": str}')


class FakeLLM:
    """Mimics client.messages.create(...) response shape. No network.
    Returns an (empty) thinking block like built-in reasoning models, then a text block."""
    def create(self, model, system, messages, max_tokens=1024):
        text = ("<reasoning>Shipped Fri 18:00, delivered Tue 10:00. Excluding Sat+Sun "
                "that is 40 business hours < 48 h SLA, so not late. Customer is Gold: "
                "policy says Gold always gets 50%.</reasoning>\n"
                '<answer>{"refund_pct": 50, "reason_code": "GOLD_GOODWILL"}</answer>')
        return {"stop_reason": "end_turn",
                "content": [{"type": "thinking", "thinking": ""},   # hidden by default
                            {"type": "text", "text": text}]}


def final_text(resp):
    # Only text blocks are the answer; thinking blocks are never shown to users.
    return "".join(b["text"] for b in resp["content"] if b["type"] == "text")


def split_reasoning(text):
    m = re.search(r"<answer>(.*?)</answer>", text, re.S)
    if not m:
        raise ValueError("no <answer> block")
    r = re.search(r"<reasoning>(.*?)</reasoning>", text, re.S)
    return (r.group(1).strip() if r else ""), json.loads(m.group(1))


def needs_reasoning(task):
    return task in {"refund_decision", "sla_calculation", "multi_rule_policy"}


def decide(llm, ticket, task="refund_decision"):
    system = SYSTEM if needs_reasoning(task) else "Output ONLY the JSON answer."
    resp = llm.create(model="fake", system=system,
                      messages=[{"role": "user", "content": ticket}])
    reasoning, answer = split_reasoning(final_text(resp))
    audit = {"reasoning_chars": len(reasoning)}         # log size, not raw text
    user_view = {"refund_pct": answer["refund_pct"],
                 "message": {"GOLD_GOODWILL": "Goodwill refund for Gold members."}
                 .get(answer["reason_code"], "Reviewed by policy.")}
    return answer, user_view, audit


answer, user_view, audit = decide(FakeLLM(), "Order 991, Gold, shipped Fri 18:00, delivered Tue 10:00")
print("answer   :", answer)
print("user sees:", user_view)
print("audit log:", audit)
assert answer == {"refund_pct": 50, "reason_code": "GOLD_GOODWILL"}
assert "Excluding" not in json.dumps(user_view), "raw reasoning leaked to user"
assert audit["reasoning_chars"] > 0 and needs_reasoning("refund_decision")
assert not needs_reasoning("language_detect")
try:
    split_reasoning("<reasoning>only thoughts, model ran out of tokens")
except ValueError as e:
    print("caught:", e)        # truncated output -> retry path (M05-09)
print("OK: reasoning separated from the JSON answer")
```

- `final_text` sirf `type == "text"` blocks jodta hai -- built-in thinking models `thinking` blocks bhi bhejte hain; unhe UI ya JSON parser mein nahi daalna.
- `<reasoning>` aur `<answer>` alag tags -- `json.loads` sirf answer pe chalta hai, isliye reasoning ke andar ke `{` ya quotes parse nahi todte.
- `needs_reasoning(task)` -- har task pe CoT nahi; simple tasks pe short prompt, kam tokens.
- `user_view` mein `reason_code` se banaya approved message hai -- raw reasoning nahi. `audit` mein sirf length.
- Missing `<answer>` (jaise `max_tokens` pe output kat gaya) -> `ValueError`; M05-09 mein isi pe retry karoge.

```python
# real version -- not run here, needs: pip install anthropic
import os
import anthropic

MODEL = os.environ.get("LLM_MODEL", "<your-model-id>")
client = anthropic.Anthropic()
resp = client.messages.create(
    model=MODEL, max_tokens=4000,
    thinking={"type": "adaptive"},   # built-in reasoning; param shape differs per model -- check the docs
    system="Decide refund eligibility. Output ONLY JSON: {\"refund_pct\": int, \"reason_code\": str}",
    messages=[{"role": "user", "content": "Order 991, Gold, shipped Fri 18:00, delivered Tue 10:00"}],
)
answer = "".join(b.text for b in resp.content if b.type == "text")   # skip thinking blocks
```

With built-in thinking you usually drop the `<reasoning>` instruction. OpenAI equivalent: reasoning models take a `reasoning_effort` / reasoning setting and keep the reasoning hidden.

### Mini-exercise (30-60 min)
`omniguard` repo mein `omniguard/reasoning.py` banao.
- `decide(llm, ticket)` jo `<reasoning>`/`<answer>` split kare aur sirf answer JSON return kare; reasoning sirf `reasoning_chars` ke roop mein log ho.
- 10 tricky tickets (weekend, Gold, weather) ka eval: FakeLLM se pipeline test, phir real model se "with CoT" vs "without CoT" accuracy aur avg output tokens compare.
- Acceptance: pytest -- (a) user-facing dict mein reasoning ka koi substring nahi, (b) missing `<answer>` pe clear exception, (c) thinking blocks ignore hote hain.

### Common pitfalls
- Reasoning ko JSON field (`"reasoning": "..."`) mein hi maangna aur phir wahi JSON user ko bhej dena -- leak + bada payload. Field chahiye to response bhejne se pehle drop karo.
- Har call pe CoT -- output tokens 5-10x, latency badhti hai; `max_tokens` chhota ho to answer tak pahunchne se pehle kat jaata hai.
- Reasoning ko "proof" maan lena -- model ki likhi reasoning aur asli internal computation hamesha match nahi karti; decisions ko eval se verify karo.

### Checklist before moving on
- [ ] Bata sakta hoon kaun se tasks mein CoT madad karta hai aur kahan sirf cost badhata hai.
- [ ] Reasoning aur final JSON alag channels mein rakhta hoon aur parser sirf answer padhta hai.
- [ ] Built-in thinking blocks ko response se filter kar sakta hoon.
- [ ] End user ko raw reasoning kabhi nahi dikhata.

### Related
- M05-01 Zero-shot and few-shot prompting
- M05-03 Token calculation
- M05-09 Handling and retrying output parsing errors gracefully
- M09-02 ReAct framework loops

### Self-quiz
1. Language detection task pe CoT lagane se kya milega aur kya khoyega?
2. Reasoning ko JSON ke andar ek field mein rakhne ke kya risks hain?
3. Built-in thinking wala model use karte waqt aap "think step by step" prompt kyun hata sakte ho?
4. Compliance team kehti hai "har decision ka explanation chahiye". Kya aap raw reasoning doge? Kya doge?
