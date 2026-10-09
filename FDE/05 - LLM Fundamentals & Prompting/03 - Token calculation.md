# LLM Fundamentals & Prompting

## Token calculation

> Core | Fast CP2 / Slow CP3 | ~1.2 h | Builds on: M05-01, M05-02

### Kahani
Ek hospital network ne aapka discharge-summary bot pilot kiya: 200 doctors, har din ~40 summaries. Pilot ka bill aaya to CFO ne poocha: "Production mein 5,000 doctors honge, monthly kitna?"
Aapke paas jawab nahi tha. Upar se kuch lambe patient records pe API ne error diya -- context window se bade the. Aur jo prompt aapne "chhota" samjha tha, usme 12 few-shot examples har call pe jaa rahe the.
FDE ko pehle din se pata hona chahiye: ek call kitne tokens ki hai, kitne paise ki hai, aur kab limit cross hogi.

### What it is
**Token** = model ka text unit (word ka tukda, punctuation, space). English mein roughly 1 token ~ 4 characters ~ 0.75 words; Hindi/code/JSON mein ratio alag hota hai. Har model ka apna tokenizer hai.
Bill = input tokens x input price + output tokens x output price (dono "per million tokens" mein). Exact count ke liye provider ka token counter ya response ka `usage` field use karo; planning ke liye approximation kaafi hai.

### Why it matters for an FDE
Customer ko cost estimate, `max_tokens` setting, context window overflow, aur latency -- sab tokens se decide hote hain. Galat estimate = budget overrun ya production mein "prompt too long" errors.

### Key concepts
- **Approximate vs exact** -- chars/4 ya words/0.75 planning ke liye; billing ke liye `usage.input_tokens` / `usage.output_tokens` (har response mein aata hai) ya count-tokens API.
- **Input includes everything** -- system prompt + few-shot examples + chat history + tool definitions + documents; sirf user ka sawaal nahi.
- **Output is pricier** -- output token usually input se kai guna mehnga; `max_tokens` aur concise format se control karo.
- **Context window** -- input + output ki max limit; usse pehle hi truncate/compress karo (M05-04, M05-05).
- **Prices change** -- price hard-code mat karo; config/env se lo aur provider ka pricing page check karo.

### Code example
stdlib only

> Needs API key for the real version: ANTHROPIC_API_KEY (or OPENAI_API_KEY)

```python
# runnable
import json
import math
import re


def approx_tokens_chars(text: str) -> int:
    return math.ceil(len(text) / 4)                   # ~4 chars per token (English)


def approx_tokens_words(text: str) -> int:
    pieces = re.findall(r"\w+|[^\w\s]", text)         # words + punctuation
    return math.ceil(len(pieces) / 0.75)              # ~0.75 words per token


def request_tokens(system, messages, tools=(), counter=approx_tokens_chars):
    total = counter(system)
    for m in messages:
        c = m["content"]
        total += counter(c if isinstance(c, str) else json.dumps(c)) + 4  # per-message overhead guess
    for t in tools:
        total += counter(json.dumps(t))               # tool schemas are input tokens too
    return total


def cost_usd(input_tokens, output_tokens, input_price_per_m, output_price_per_m):
    """Prices are INPUTS -- check the provider pricing page, they change."""
    return input_tokens / 1e6 * input_price_per_m + output_tokens / 1e6 * output_price_per_m


def monthly_estimate(calls_per_day, in_tok, out_tok, in_price, out_price, days=30):
    return calls_per_day * days * cost_usd(in_tok, out_tok, in_price, out_price)


def check_fits(in_tok, max_tokens, context_window):
    if in_tok + max_tokens > context_window:
        raise ValueError(f"needs {in_tok + max_tokens} tokens, window is {context_window}")


system = "You write discharge summaries for doctors. Be concise. " * 3
record = "Patient admitted with chest pain, troponin normal, ECG normal, discharged on aspirin. " * 40
messages = [{"role": "user", "content": record}]
tools = [{"name": "lookup_drug", "description": "Get drug info",
          "input_schema": {"type": "object", "properties": {"name": {"type": "string"}}}}]

a = request_tokens(system, messages, tools, approx_tokens_chars)
b = request_tokens(system, messages, tools, approx_tokens_words)
print(f"approx input tokens: chars/4={a}  words/0.75={b}")
assert 0.5 < a / b < 2.0, "two estimates should be in the same ballpark"

# Example prices are placeholders, NOT real ones -- pass your own from config.
IN_PRICE, OUT_PRICE = 3.0, 15.0      # USD per million tokens (placeholder)
per_call = cost_usd(a, 400, IN_PRICE, OUT_PRICE)
pilot = monthly_estimate(200 * 40, a, 400, IN_PRICE, OUT_PRICE)
prod = monthly_estimate(5000 * 40, a, 400, IN_PRICE, OUT_PRICE)
print(f"per call ${per_call:.5f}  pilot/month ${pilot:,.2f}  prod/month ${prod:,.2f}")
assert math.isclose(prod / pilot, 25.0)            # cost scales linearly with calls

check_fits(a, 1024, context_window=200_000)
try:
    check_fits(a * 400, 1024, context_window=200_000)
except ValueError as e:
    print("blocked before calling the API:", e)

fake_usage = {"input_tokens": a + 7, "output_tokens": 388}   # what a real response reports
drift = abs(fake_usage["input_tokens"] - a) / fake_usage["input_tokens"]
assert drift < 0.2
print("OK: estimate, cost and window check done; reconcile with response usage")
```

- Do counters (chars/4, words/0.75) -- dono approximate; agar ye bahut alag aayein to text unusual hai (code, Hindi, tables) -- exact counter use karo.
- `request_tokens` mein system + har message + tool schemas sab jud rahe hain -- yahi bhool se bill surprise hota hai.
- `cost_usd` prices ko parameter leta hai; script mein `3.0/15.0` sirf placeholder hai, real numbers config se.
- `check_fits` API call se pehle overflow pakadta hai -- 400 error aur wasted latency se bachao.
- `fake_usage` -- production mein har response ka `usage` log karo aur estimate se reconcile karo (M14-11).

```python
# real version -- not run here, needs: pip install anthropic tiktoken
import os
import anthropic

MODEL = os.environ.get("LLM_MODEL", "<your-model-id>")
client = anthropic.Anthropic()
count = client.messages.count_tokens(model=MODEL, system=system, messages=messages, tools=tools)
print("exact input tokens:", count.input_tokens)
resp = client.messages.create(model=MODEL, max_tokens=400, system=system, messages=messages)
print(resp.usage.input_tokens, resp.usage.output_tokens)    # what you are billed for

# OpenAI models: count locally with tiktoken
import tiktoken
enc = tiktoken.get_encoding("o200k_base")    # pick the encoding for your model -- check the docs
print(len(enc.encode(record)))
```

### Mini-exercise (30-60 min)
`omniguard` repo mein `omniguard/tokens.py` banao.
- `estimate(system, messages, tools)`, `cost_usd(...)` with prices from env vars (`PRICE_IN_PER_M`, `PRICE_OUT_PER_M`), aur `check_fits(...)`.
- OmniGuard ke har LLM call ke baad `usage` (FakeLLM bhi fake usage return kare) ek `usage.jsonl` mein likho: timestamp, model, input/output tokens, cost.
- Acceptance: pytest -- (a) prices missing ho to clear error, (b) 1M-token input pe `check_fits` call se pehle fail, (c) `usage.jsonl` se daily total cost nikalne ka function sahi sum deta hai.

### Common pitfalls
- Sirf user message count karna -- system prompt, history, tool schemas aur retrieved documents (RAG) bhool jaana.
- Price code mein hard-code -- 3 mahine baad estimate galat. Config + date ke saath rakho.
- `max_tokens` bahut chhota rakh ke cost bachana -- JSON beech mein kat jaata hai, retry ka cost zyada (M05-09).

### Checklist before moving on
- [ ] Ek request ka approximate token count aur cost nikaal sakta hoon.
- [ ] Jaanta hoon exact count kahan se milta hai (count-tokens API, `usage`, tiktoken).
- [ ] Context window overflow ko call se pehle detect karta hoon.
- [ ] Pilot se production monthly cost estimate bana sakta hoon.

### Related
- M05-04 Sliding window techniques
- M05-05 Context compression
- M14-11 Monitoring granular token costs and endpoint latency
- M14-15 Prompt caching strategies

### Self-quiz
1. Chars/4 estimate Hindi ya JSON-heavy prompt pe kyun galat ho sakta hai?
2. Aapke bill mein input tokens output se 20x zyada hain. Kahan dekhoge pehle?
3. `max_tokens` badhane se kya har call mehngi ho jaati hai? Kab hoti hai, kab nahi?
4. Customer 5x users badhata hai. Monthly cost exactly 5x hoga ya alag? Kya assumptions hain?
