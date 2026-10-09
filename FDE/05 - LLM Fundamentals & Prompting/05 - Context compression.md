# LLM Fundamentals & Prompting

## Context compression

> Core | Fast CP2 / Slow CP3 | ~1.2 h | Builds on: M05-03, M05-04

### Kahani
Ek SaaS customer ka support copilot har ticket ke saath poori chat history (80 turns), 6 KB ka account JSON aur 3 knowledge-base articles bhejta hai. Har call ~30k tokens, latency 9 s, aur bill pilot budget ka 4x.
Sabse bura: lambi chats mein model beech ki important baat ("customer ne pehle hi password reset kar liya") miss kar raha tha -- itne noise mein signal kho gaya.
Aapko context chhota karna hai bina wo facts khoye jo answer ke liye zaroori hain -- aur prove karna hai ki quality nahi giri.

### What it is
**Context compression** = model ko bhejne se pehle input ko chhota karna, information bachaate hue. Teen common levels:
(1) **Cheap / deterministic** -- whitespace, duplicate lines, unused JSON fields hatao. (2) **Selective** -- sirf relevant cheezein rakho (last N turns, top-k documents). (3) **Summarisation** -- purani history ko ek chhote summary mein badlo (aksar ek sasta LLM call), aur recent turns verbatim rakho.

### Why it matters for an FDE
Tokens = paise + latency (M05-03). Lekin galat compression (important fact drop) silent quality bug hai -- customer complain karega "bot bhool jaata hai", aur logs mein koi error nahi hoga.

### Key concepts
- **Prune before you summarise** -- JSON se sirf zaroori fields (allowlist), duplicate/boilerplate text hatao; ye free hai aur deterministic.
- **Rolling summary** -- purane turns -> ek "summary so far" message; last K turns verbatim. Summary ko har kuch turns pe update karo.
- **Pinned facts** -- IDs, amounts, dates, decisions jo kabhi compress nahi hone chahiye; alag rakho aur verbatim bhejo.
- **Measure both sides** -- tokens kitne bache AND eval accuracy kitni rahi; dono ke bina "optimisation" adhoora.
- **Provider features** -- kuch APIs server-side compaction / context editing dete hain; concept same, lekin pehle apna simple version samjho.

### Code example
stdlib only

> Needs API key for the real version: ANTHROPIC_API_KEY (or OPENAI_API_KEY)

```python
# runnable
import json
import math
import re


def tokens(obj) -> int:                                  # approx, see M05-03
    text = obj if isinstance(obj, str) else json.dumps(obj)
    return math.ceil(len(text) / 4)


def prune_account(account: dict, keep=("id", "plan", "status", "open_tickets")) -> dict:
    return {k: account[k] for k in keep if k in account}  # allowlist, not denylist


def clean(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    return re.sub(r"(Sent from my phone\.|-- Support Bot auto reply --)", "", text).strip()


class FakeSummarizer:
    """Stands in for a cheap LLM call that summarises old turns. No network."""
    def summarize(self, turns):
        facts = [t["content"] for t in turns if re.search(r"\b(reset|refund|order \d+)\b", t["content"], re.I)]
        return "Summary so far: " + " | ".join(facts)[:300]


def compress(history, account, pinned, summarizer, keep_last=4):
    old, recent = history[:-keep_last], history[-keep_last:]
    msgs = []
    if old:
        msgs.append({"role": "user", "content": summarizer.summarize(old)})
        msgs.append({"role": "assistant", "content": "Noted."})   # keep user/assistant alternation
    msgs += [{"role": t["role"], "content": clean(t["content"])} for t in recent]
    context = {"pinned": pinned, "account": prune_account(account)}
    msgs[-1]["content"] = f"Context: {json.dumps(context)}\n\n{msgs[-1]['content']}"
    return msgs


history = []
for i in range(40):
    history.append({"role": "user", "content": f"Hi   again,   still stuck on login (try {i}).  Sent from my phone."})
    history.append({"role": "assistant", "content": "-- Support Bot auto reply -- Please try clearing cache."})
history[10]["content"] = "I already did a password reset yesterday, still fails."
history.append({"role": "user", "content": "So what now? Order 5521 also shows wrong plan."})
account = {"id": "acc_88", "plan": "pro", "status": "active", "open_tickets": 2,
           "audit_log": ["login"] * 300, "feature_flags": {f"f{i}": True for i in range(100)}}
pinned = {"customer_id": "acc_88", "ticket": "T-1201"}

before = sum(tokens(m["content"]) for m in history) + tokens(account)
msgs = compress(history, account, pinned, FakeSummarizer())
after = sum(tokens(m["content"]) for m in msgs)
print(f"tokens before={before} after={after} saved={1 - after / before:.0%}")
blob = json.dumps(msgs)
assert after < before * 0.25, "should cut most of the noise"
assert "password reset" in blob, "key fact from old history must survive"
assert "acc_88" in blob and "T-1201" in blob and "Order 5521" in blob
assert "audit_log" not in blob and msgs[0]["role"] == "user" and msgs[-1]["role"] == "user"
print("OK: pruned, summarised, pinned facts kept")
```

- `prune_account` allowlist use karta hai -- naya field (jaise `ssn`) customer add kare to wo apne aap nahi jaayega. Denylist mein ye leak hota.
- `clean` boilerplate aur extra whitespace hatata hai -- deterministic, free, koi quality risk nahi.
- `FakeSummarizer` real mein ek chhota/sasta model call hoga; yahan fake hai, lekin contract same: old turns -> ek summary string.
- Summary ke baad `"Noted."` assistant turn -- roles alternate rehte hain aur conversation `user` se shuru hoti hai.
- Asserts dono taraf check karte hain: tokens 75%+ kam, AUR "password reset" + pinned IDs bache hue.

```python
# real version -- not run here, needs: pip install anthropic
import json
import os
import anthropic

MODEL = os.environ.get("LLM_MODEL", "<your-model-id>")
SUMMARY_MODEL = os.environ.get("LLM_SUMMARY_MODEL", MODEL)   # often a cheaper model
client = anthropic.Anthropic()


def summarize(turns):
    resp = client.messages.create(
        model=SUMMARY_MODEL, max_tokens=300,
        system="Summarise this support chat. Keep every ID, amount, date and action already taken.",
        messages=[{"role": "user", "content": json.dumps(turns)}],
    )
    return "".join(b.text for b in resp.content if b.type == "text")
```

### Mini-exercise (30-60 min)
`omniguard/context.py` mein `compress(history, account, pinned)` banao.
- Account JSON ka allowlist pruning, boilerplate cleaning, aur 6 turns se purani history ka rolling summary (FakeSummarizer se test, real summary model optional).
- 10 eval chats banao jinme ek important fact purani history mein chhupa ho; har chat pe ek question jiska answer us fact pe depend kare.
- Acceptance: pytest -- token savings >= 60%, aur 10/10 chats mein critical fact compressed messages mein present; pinned IDs hamesha verbatim.

### Common pitfalls
- Summary mein numbers/IDs ka paraphrase ho jaana ("order 5521" -> "an order") -- summary prompt mein explicitly bolo, aur pinned facts alag rakho.
- Har request pe poori history re-summarise karna -- extra LLM call har baar; summary cache karo aur incremental update karo.
- Compression se pehle PII ko summariser model ko bhejna jab main model ko bhi nahi bhejna tha -- data flow same rules follow kare (M13-05).

### Checklist before moving on
- [ ] Prune, select aur summarise -- teeno levels ka fark aur cost samjha sakta hoon.
- [ ] Allowlist pruning kyun safe hai, bata sakta hoon.
- [ ] Pinned facts ko compression se bachata hoon.
- [ ] Token savings aur quality, dono measure karta hoon.

### Related
- M05-03 Token calculation
- M05-04 Sliding window techniques
- M14-15 Prompt caching strategies
- M06-01 Fixed-size and semantic chunking

### Self-quiz
1. Account JSON ke liye allowlist vs denylist pruning -- security aur maintenance mein kya fark hai?
2. Rolling summary ka ek failure mode batao jo logs mein error nahi dikhata. Use kaise pakdoge?
3. Summary ke liye sasta model use karna kab galat decision hai?
4. Prompt caching aur compression -- dono cost kam karte hain. Kab ek doosre ke against kaam karte hain?
