# LLM Fundamentals & Prompting

## Handling multi-tool parallel execution

> Core | Fast CP2 / Slow CP3 | ~1.2 h | Builds on: M01-07, M05-12

### Kahani
Logistics customer ka ops assistant: user poochta hai "Shipment S-77 kahan hai, DEL-BOM lane pe delay risk kya hai, aur late delivery ka refund rule kya hai?"
Model ek hi response mein teen `tool_use` blocks bhejta hai. Aapka code unhe ek-ek karke chala raha tha: 1.2 s + 0.8 s + 2.5 s = 4.5 s, aur jis din tracking API hang hui, user 60 s tak spinner dekhta raha.
Ek aur bug: tracking API fail hui to poora request 500 -- jabki baaki do tools ke answers ready the.
Aapko chahiye: tools concurrently chalein, har ek pe timeout, ek fail ho to baaki ka result phir bhi model tak jaaye.

### What it is
**Parallel tool use** = model ek assistant turn mein multiple `tool_use` blocks bhejta hai (Anthropic mein default on; `disable_parallel_tool_use` se band). Aapka kaam: sab ko concurrently execute karo (`asyncio.gather`), har ek pe per-tool timeout, aur **saare** `tool_result` blocks **ek hi** user message mein, har ek apne `tool_use_id` ke saath, wapas bhejo.
Failure ek normal result hai: `is_error: true` wala tool_result, exception nahi.

### Why it matters for an FDE
Customer ke backend APIs slow aur flaky hote hain. Serial execution latency jodta hai; ek tool ka crash poori conversation todta hai. Sahi parallel execution se response time max(tool) ke barabar aata hai, sum ke nahi.

### Key concepts
- **gather + per-tool timeout** -- `asyncio.wait_for(run(...), timeout)` har tool pe; `gather(..., return_exceptions=True)` taaki ek failure baaki ko na maare.
- **Order and IDs** -- result list `tool_use` blocks ke order mein banao; matching `tool_use_id` se hoti hai, lekin same order debugging aasaan karta hai.
- **One user message** -- saare tool_results ek message mein; alag-alag messages mein todna model ko parallel calls band karna sikha deta hai.
- **Side effects** -- read-only tools parallel safe; write tools (refund, block card) ke liye idempotency key ya sequential execution (M14-01).
- **Concurrency limit** -- model 10 calls bhej de to semaphore se backend ko bachao (M01-07).

### Code example
stdlib only

> Needs API key for the real version: ANTHROPIC_API_KEY (or OPENAI_API_KEY)

```python
# runnable
import asyncio
import json
import time


async def track_shipment(shipment_id: str):
    await asyncio.sleep(0.3)
    return {"shipment_id": shipment_id, "location": "Nagpur hub"}


async def lane_risk(lane: str):
    await asyncio.sleep(0.3)
    return {"lane": lane, "delay_risk": 0.42}


async def refund_policy(topic: str):
    await asyncio.sleep(5)                       # stuck backend
    return {"text": "never reached"}


async def broken_tool(**_):
    raise ConnectionError("upstream 503")


TOOLS = {"track_shipment": track_shipment, "lane_risk": lane_risk,
         "refund_policy": refund_policy, "carrier_contacts": broken_tool}
TIMEOUTS = {"refund_policy": 0.5}                # per-tool, default below
SEM = asyncio.Semaphore(4)


async def run_one(block):
    fn = TOOLS[block["name"]]                    # unknown names: see M05-15
    async with SEM:
        return await asyncio.wait_for(fn(**block["input"]), TIMEOUTS.get(block["name"], 2.0))


def to_result(block, outcome):
    if isinstance(outcome, asyncio.TimeoutError):
        return {"type": "tool_result", "tool_use_id": block["id"], "is_error": True,
                "content": f"{block['name']} timed out; answer without it or say it is unavailable"}
    if isinstance(outcome, Exception):
        return {"type": "tool_result", "tool_use_id": block["id"], "is_error": True,
                "content": f"{block['name']} failed: {type(outcome).__name__}"}
    return {"type": "tool_result", "tool_use_id": block["id"], "content": json.dumps(outcome)}


async def execute_tool_calls(content):
    calls = [b for b in content if b["type"] == "tool_use"]
    outcomes = await asyncio.gather(*(run_one(b) for b in calls), return_exceptions=True)
    return {"role": "user", "content": [to_result(b, o) for b, o in zip(calls, outcomes)]}


async def main():
    # assistant response.content with 4 parallel tool calls (fake model output, no network)
    content = [
        {"type": "text", "text": "Checking all of that now."},
        {"type": "tool_use", "id": "tu_1", "name": "track_shipment", "input": {"shipment_id": "S-77"}},
        {"type": "tool_use", "id": "tu_2", "name": "lane_risk", "input": {"lane": "DEL-BOM"}},
        {"type": "tool_use", "id": "tu_3", "name": "refund_policy", "input": {"topic": "late delivery"}},
        {"type": "tool_use", "id": "tu_4", "name": "carrier_contacts", "input": {"carrier": "XL"}},
    ]
    t0 = time.perf_counter()
    msg = await execute_tool_calls(content)
    took = time.perf_counter() - t0
    for r in msg["content"]:
        print(r["tool_use_id"], "error" if r.get("is_error") else "ok   ", r["content"][:60])
    ids = [r["tool_use_id"] for r in msg["content"]]
    assert msg["role"] == "user" and ids == ["tu_1", "tu_2", "tu_3", "tu_4"]
    assert [bool(r.get("is_error")) for r in msg["content"]] == [False, False, True, True]
    print(f"took {took:.2f}s (serial would be > 5.6s)")
    assert took < 3.0, "tools must run concurrently and the stuck one must time out"
    print("OK: parallel tools, per-tool timeout, all results in one user message")


asyncio.run(main())
```

- `asyncio.gather(..., return_exceptions=True)` -- `ConnectionError` aur `TimeoutError` exceptions values ban ke list mein aate hain; baaki tools ke results safe.
- `asyncio.wait_for(..., TIMEOUTS.get(...))` -- har tool ka apna budget; stuck `refund_policy` 0.5 s pe kat gaya, 5 s nahi.
- `zip(calls, outcomes)` -- gather order preserve karta hai, isliye result `tool_use` order mein aur sahi `tool_use_id` ke saath.
- Error content model ke liye instruction jaisa hai ("answer without it") -- aur exception ka sirf type, internal message/URL nahi.
- Ek hi `{"role": "user", "content": [...]}` -- chaaron results saath; M05-14 mein ye history mein append hoga.

```python
# real version -- not run here, needs: pip install anthropic
import os
import anthropic

MODEL = os.environ.get("LLM_MODEL", "<your-model-id>")
client = anthropic.AsyncAnthropic()


async def turn(messages, tools):
    resp = await client.messages.create(model=MODEL, max_tokens=2000, tools=tools, messages=messages)
    if resp.stop_reason == "tool_use":
        messages.append({"role": "assistant", "content": resp.content})   # append blocks unchanged
        calls = [{"type": "tool_use", "id": b.id, "name": b.name, "input": b.input}
                 for b in resp.content if b.type == "tool_use"]
        messages.append(await execute_tool_calls(calls))
    return resp
```

OpenAI equivalent: multiple entries in `message.tool_calls`; send one `{"role": "tool", "tool_call_id": ..., "content": ...}` message per call (`parallel_tool_calls=False` disables it).

### Mini-exercise (30-60 min)
`omniguard/tools/executor.py` mein `execute_tool_calls(content)` banao, OmniGuard ke 2 tools ke async fake backends ke saath (random latency 0.05-1 s, 10% errors, 5% hang).
- Per-tool timeout config (`TOOL_TIMEOUTS` dict), global semaphore, aur `WRITE_TOOLS` set jo parallel ki jagah sequentially chale.
- Har tool execution ka log: name, duration_ms, outcome (`ok` / `error` / `timeout`).
- Acceptance: pytest -- 20 random batches; har batch mein results count == tool_use count, IDs match, total time < sum of latencies, koi exception bahar nahi.

### Common pitfalls
- `gather` bina `return_exceptions=True` -- pehla exception poora batch udaata hai aur baaki results kho jaate hain (ya TaskGroup bina andar catch kiye).
- Timeout pe tool ka side effect "shayad hua, shayad nahi" -- write tools pe idempotency key bina retry mat karo.
- Results ko alag-alag user messages mein bhejna ya kuch results drop karna -- API error (har `tool_use` ko `tool_result` chahiye) ya model behaviour kharab.

### Checklist before moving on
- [ ] Multiple tool_use blocks ko concurrently execute kar sakta hoon with per-tool timeout.
- [ ] Ek tool fail ho to baaki results phir bhi model tak jaate hain.
- [ ] Saare tool_results ek user message mein, sahi `tool_use_id` ke saath bhejta hoon.
- [ ] Read vs write tools ka parallel risk samajhta hoon.

### Related
- M01-07 Coroutines and tasks
- M05-14 Processing tool results into chat history
- M09-09 Running agent tasks concurrently using async execution
- M14-01 Idempotency keys for safe tool execution

### Self-quiz
1. 4 tools ki latency 0.3, 0.3, 0.5 (timeout), 0.01 s. Total wall time kitna hoga aur kyun?
2. `return_exceptions=True` hata do to is example mein kya hoga?
3. Model ne `refund_payment` aur `send_email` parallel mein bheje. Kya concurrently chalaoge? Kya risk hai?
4. Timeout wale tool ka error content model ko kya instruction deta hai, aur ye kyun important hai?
