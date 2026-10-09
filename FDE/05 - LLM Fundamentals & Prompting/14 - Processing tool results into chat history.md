# LLM Fundamentals & Prompting

## Processing tool results into chat history

> Core | Fast CP2 / Slow CP3 | ~1.2 h | Builds on: M05-12, M05-13

### Kahani
Hospital ke scheduling assistant ka pehla agent loop production mein gaya. Doctor ne poocha "Dr. Mehta ka kal ka free slot aur patient P-88 ka last visit?" -- model ne do tools call kiye, aapne results bheje, aur API ne 400 phenka: "tool_use ids were found without tool_result blocks".
Fix ke chakkar mein kisi ne sirf text answer history mein rakhna shuru kar diya (assistant ka tool_use block drop) -- ab next turn pe model bhool gaya ki usne kya dekha tha aur same tools dobara call karne laga.
Aur ek tool ne 400 KB ka patient history JSON return kiya -- har agle turn pe wo poora history ke saath dobara bheja gaya, bill aur latency dono upar.

### What it is
Tool loop ka contract (Anthropic Messages API): (1) model ka **poora** assistant `content` (text + tool_use blocks) as-is history mein append karo. (2) Agla message `role: "user"` jisme har `tool_use` ke liye ek `{"type": "tool_result", "tool_use_id": ..., "content": ...}` ho -- tool_result blocks content ke shuru mein, koi extra text unke baad. (3) Phir model ko dobara call karo; `stop_reason != "tool_use"` hone tak loop.
OpenAI mein shape alag: har result ek alag `{"role": "tool", "tool_call_id": ...}` message -- idea same.

### Why it matters for an FDE
History galat bani to ya to API error, ya model ka "memory loss" (repeat calls, galat answers). Aur tool results bina size limit ke context ko phula dete hain -- cost, latency, aur context window overflow (M05-03).

### Key concepts
- **Append assistant content unchanged** -- text, tool_use (aur thinking blocks agar hain) sab; edit ya filter mat karo.
- **Every tool_use gets a tool_result** -- error ho to bhi (`is_error: true`); ek bhi missing = 400.
- **Ordering** -- user message mein tool_result blocks pehle; extra instruction text chahiye to unke baad.
- **Result size budget** -- tool output ko truncate/summarise karke bhejo (e.g. max 2k chars) aur model ko batao ki truncated hai; poora data apne store mein rakho.
- **Validate history** -- ek `validate_history()` helper jo har call se pehle invariants check kare; bugs local pe pakdo, production 400 pe nahi.

### Code example
stdlib only

> Needs API key for the real version: ANTHROPIC_API_KEY (or OPENAI_API_KEY)

```python
# runnable
import json

MAX_RESULT_CHARS = 300


class FakeLLM:
    """Mimics client.messages.create(...). No network. First asks for 2 tools, then answers
    from the tool_result blocks it finds in history."""
    def create(self, model, max_tokens, tools, messages):
        last = messages[-1]["content"]
        results = [b for b in last if isinstance(last, list) and b.get("type") == "tool_result"]
        if not results:
            return {"stop_reason": "tool_use", "content": [
                {"type": "text", "text": "Let me check both."},
                {"type": "tool_use", "id": "tu_a", "name": "free_slots", "input": {"doctor": "Mehta"}},
                {"type": "tool_use", "id": "tu_b", "name": "last_visit", "input": {"patient": "P-88"}}]}
        seen = {r["tool_use_id"]: r["content"] for r in results}
        slot = json.loads(seen["tu_a"])["slots"][0]
        return {"stop_reason": "end_turn",
                "content": [{"type": "text", "text": f"Dr. Mehta is free at {slot}. P-88 history attached."}]}


def run_tool(name, args):
    if name == "free_slots":
        return {"slots": ["10:30", "15:00"]}
    return {"patient": args["patient"], "visits": [{"note": "x" * 500}] * 50}   # huge payload


def fit(payload) -> str:
    text = json.dumps(payload)
    if len(text) <= MAX_RESULT_CHARS:
        return text
    return text[:MAX_RESULT_CHARS] + f'... [truncated, {len(text)} chars total, ask for a narrower query]'


def validate_history(messages):
    assert messages[0]["role"] == "user", "history must start with a user turn"
    for i, m in enumerate(messages):
        if m["role"] != "assistant" or isinstance(m["content"], str):
            continue
        ids = {b["id"] for b in m["content"] if b["type"] == "tool_use"}
        if not ids:
            continue
        nxt = messages[i + 1]["content"] if i + 1 < len(messages) else []
        got = [b for b in nxt if b.get("type") == "tool_result"]
        assert {b["tool_use_id"] for b in got} == ids, f"turn {i}: missing tool_result for {ids}"
        assert nxt[:len(got)] == got, f"turn {i + 1}: tool_result blocks must come first"


def agent(llm, question, max_turns=5):
    messages = [{"role": "user", "content": question}]
    for _ in range(max_turns):
        validate_history(messages)
        resp = llm.create(model="fake", max_tokens=1000, tools=[], messages=messages)
        messages.append({"role": "assistant", "content": resp["content"]})   # unchanged
        if resp["stop_reason"] != "tool_use":
            return messages
        results = [{"type": "tool_result", "tool_use_id": b["id"], "content": fit(run_tool(b["name"], b["input"]))}
                   for b in resp["content"] if b["type"] == "tool_use"]
        messages.append({"role": "user", "content": results})               # one message, all results
    raise RuntimeError("max_turns reached")


history = agent(FakeLLM(), "Dr. Mehta free slot tomorrow and P-88 last visit?")
for m in history:
    kinds = m["content"] if isinstance(m["content"], str) else [b["type"] for b in m["content"]]
    print(m["role"], "->", kinds)
validate_history(history)
assert [m["role"] for m in history] == ["user", "assistant", "user", "assistant"]
assert "10:30" in history[-1]["content"][0]["text"]
big = history[2]["content"][1]["content"]
assert len(big) < 400 and "truncated" in big, "huge tool output must be capped"

broken = history[:2] + [{"role": "user", "content": [history[2]["content"][0]]}]   # one result dropped
try:
    validate_history(broken)
except AssertionError as e:
    print("caught:", e)
print("OK: assistant content kept, every tool_use answered, results capped")
```

- `messages.append({"role": "assistant", "content": resp["content"]})` -- poora content, text + dono tool_use; model next turn pe apni calls "yaad" rakhta hai.
- Saare `tool_result` ek user message mein, har ek apne `tool_use_id` ke saath -- `validate_history` isse har call se pehle check karta hai.
- `fit()` -- 25 KB ka payload 300 chars + "truncated, ask for a narrower query" ban gaya; model ko pata hai data adhoora hai.
- `broken` example -- ek result drop kiya to helper turant batata hai kaunsa turn toota (real API yahan 400 deti).
- `max_turns` -- loop kabhi infinite nahi; M05-15 mein isse aur guards judenge.

```python
# real version -- not run here, needs: pip install anthropic
import os
import anthropic

MODEL = os.environ.get("LLM_MODEL", "<your-model-id>")
client = anthropic.Anthropic()
messages = [{"role": "user", "content": "Dr. Mehta free slot tomorrow and P-88 last visit?"}]
for _ in range(5):
    resp = client.messages.create(model=MODEL, max_tokens=2000, tools=TOOLS, messages=messages)
    messages.append({"role": "assistant", "content": resp.content})     # SDK blocks, unchanged
    if resp.stop_reason != "tool_use":
        break
    messages.append({"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": b.id, "content": fit(run_tool(b.name, b.input))}
        for b in resp.content if b.type == "tool_use"]})
print(next(b.text for b in resp.content if b.type == "text"))
```

The SDK also has a tool-runner helper that drives this loop for you -- learn the manual loop first, then use the helper.

### Mini-exercise (30-60 min)
`omniguard/agent.py` mein `run_agent(llm, question)` banao jo M05-12 (validation) aur M05-13 (parallel executor) ko jode.
- `validate_history()` har LLM call se pehle; `fit()` with `MAX_RESULT_CHARS` config.
- History ko per-conversation store karo (dict ya sqlite), aur sliding window (M05-04) lagate waqt tool_use/tool_result pair kabhi split na ho.
- Acceptance: pytest -- (a) 2-tool flow ka final history `validate_history` pass karta hai, (b) dropped result pe helper fail karta hai, (c) 1 MB tool output ke baad request size < 10 KB.

### Common pitfalls
- Sirf assistant ka text history mein rakhna (tool_use drop) -- next turn pe 400 ya repeat tool calls.
- tool_result content mein raw DB rows/PII bhejna jo answer ke liye zaroori nahi -- model context aur logs dono mein leak. Sirf zaroori fields bhejo.
- Thinking blocks ya unknown block types filter karke history mein bhejna -- kuch models ko wo unchanged chahiye hote hain; content as-is append karo.

### Checklist before moving on
- [ ] Tool loop ke message shape (assistant content -> user tool_results) bina dekhe likh sakta hoon.
- [ ] Har tool_use ka tool_result, error case mein bhi, bhejta hoon.
- [ ] Tool output ka size cap karta hoon aur truncation model ko batata hoon.
- [ ] History invariants ko call se pehle validate karta hoon.

### Related
- M05-04 Sliding window techniques
- M05-13 Handling multi-tool parallel execution
- M05-15 Managing hallucinated tool calls
- M09-02 ReAct framework loops

### Self-quiz
1. Assistant message se tool_use blocks hata ke sirf text rakha. Agle API call pe kya hoga, aur agar error na aaye to model behaviour pe kya asar?
2. Tool_result ko user message mein text ke baad rakhna kyun galat hai?
3. Tool ne 2 MB JSON diya. Aap model ko kya bhejoge aur baaki data ka kya karoge?
4. History trim karte waqt tool_use aur tool_result ko alag kar diya -- kya toot jaayega?
