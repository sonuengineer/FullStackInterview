# AI Observability & Gateway Management

## Capturing deep span-level execution traces

> Core | Fast CP8 / Slow CP10 | ~1.2 h | Builds on: M14-01, M14-02, M13-14

### Kahani
Ek pharma company ka compliance agent har night 200 SOP documents check karta hai: retrieve -> LLM reasoning -> Jira ticket tool -> summary.
Ek subah report aayi: "Run 9 minute chala, 3 tickets missing." Logs mein sirf `INFO agent finished` tha -- kis step mein time gaya, kaunsa tool fail hua, LLM ne kitne tokens khaaye, kuch pata nahi.
Team ne `print()` daal-daal ke 2 din debug kiya. Parallel tool calls ke logs aapas mein mix the.
Customer bolta hai: "Mujhe har run ka X-ray chahiye -- step by step, time aur cost ke saath."

### What it is
**Trace** = ek request/agent run ki poori kahani; ek `trace_id`. **Span** = us kahani ka ek step (retrieval, LLM call, tool call) -- `span_id`, `parent_id`, start/end time, **attributes** (model, tokens), **events** (retry, exception) aur **status** (OK/ERROR).
Spans parent-child tree banate hain; isse aap dekh sakte ho ki 9 minute mein se 7 minute ek hi tool span mein gaye.

### Why it matters for an FDE
Agent bugs aksar "kaunse step pe galat hua" waale hote hain. Span tree ke bina aap guess karte ho; tree ke saath customer ko screenshot dikha ke root cause 10 minute mein bata dete ho.

### Key concepts
- **Context propagation** -- current span ek `contextvar` mein; naya span automatically uska child banta hai, asyncio tasks mein bhi.
- **GenAI attributes** -- OpenTelemetry GenAI semantic conventions jaise `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` (names evolve hote hain -- check the spec).
- **Status + events** -- exception pe span `ERROR` aur ek `exception` event; retries (M14-02) bhi events ke roop mein.
- **No raw PII in attributes** -- prompt text, emails, patient names span mein nahi; ids, hashes, lengths, counts haan (M13-14).
- **Sampling** -- har trace store karna mehenga; errors 100%, baaki sample (head ya tail sampling).

### Code example
stdlib only

```python
# runnable
import asyncio, contextvars, re, time, uuid
from contextlib import contextmanager
from dataclasses import dataclass, field

@dataclass
class Span:
    name: str; trace_id: str; span_id: str; parent_id: str | None
    attributes: dict = field(default_factory=dict); events: list = field(default_factory=list)
    status: str = "OK"; start: float = 0.0; end: float = 0.0

CURRENT: contextvars.ContextVar[Span | None] = contextvars.ContextVar("span", default=None)
FINISHED: list[Span] = []                     # stand-in for an exporter (OTLP -> Langfuse etc.)
PII = re.compile(r"[\w.+-]+@[\w-]+\.\w+|\b\d{3}-\d{2}-\d{4}\b")

@contextmanager
def span(name, **attrs):
    parent = CURRENT.get()
    s = Span(name, parent.trace_id if parent else uuid.uuid4().hex, uuid.uuid4().hex[:16],
             parent.span_id if parent else None, dict(attrs), start=time.perf_counter())
    token = CURRENT.set(s)
    try:
        yield s
    except Exception as e:
        s.status = "ERROR"
        s.events.append({"name": "exception", "type": type(e).__name__, "msg": str(e)[:200]})
        raise
    finally:
        s.end = time.perf_counter()
        s.attributes["latency_ms"] = round((s.end - s.start) * 1000, 2)
        CURRENT.reset(token)
        assert not any(PII.search(str(v)) for v in s.attributes.values()), f"PII in {name}"
        FINISHED.append(s)

class FakeLLM:                                # same shape as messages.create usage fields
    def create(self, model, prompt):
        return {"text": "create tickets", "usage": {"input_tokens": len(prompt) // 4, "output_tokens": 12}}

async def tool(name, fail=False):
    with span(f"tool.{name}", **{"tool.name": name}) as s:
        await asyncio.sleep(0.01)
        if fail:
            s.events.append({"name": "retry", "attempt": 1})
            raise ConnectionError("jira 503")

async def agent_run(question):
    with span("agent.run", **{"run.id": "run-7", "input.chars": len(question)}):
        with span("retrieval", **{"retrieval.top_k": 5}) as r:
            r.attributes["retrieval.hits"] = 3
        with span("llm.call", **{"gen_ai.operation.name": "chat", "gen_ai.request.model": "model-from-env"}) as s:
            out = FakeLLM().create("model-from-env", question)
            s.attributes["gen_ai.usage.input_tokens"] = out["usage"]["input_tokens"]
            s.attributes["gen_ai.usage.output_tokens"] = out["usage"]["output_tokens"]
        results = await asyncio.gather(tool("create_ticket"), tool("notify", fail=True), return_exceptions=True)
        return [type(x).__name__ if x else "ok" for x in results]

print(asyncio.run(agent_run("SOP-114 lacks a signature for batch QA-9; reporter jane@pharma.example")))
by = {s.name: s for s in FINISHED}
root = by["agent.run"]
assert len({s.trace_id for s in FINISHED}) == 1 and root.parent_id is None
assert all(by[n].parent_id == root.span_id for n in ["retrieval", "llm.call", "tool.create_ticket", "tool.notify"])
assert by["tool.notify"].status == "ERROR" and by["tool.notify"].events[-1]["type"] == "ConnectionError"
assert by["llm.call"].attributes["gen_ai.usage.output_tokens"] == 12
assert root.attributes["latency_ms"] >= by["tool.create_ticket"].attributes["latency_ms"]
try:
    with span("bad", **{"user.email": "jane@pharma.example"}): pass
except AssertionError as e:
    print("blocked:", e)
for s in FINISHED:
    print(f"{'  ' if s.parent_id else ''}{s.name:20} {s.status:5} {s.attributes.get('latency_ms')} ms")
print("OK: one trace, correct parent tree across asyncio tasks, error status, no PII attributes")
```

- `CURRENT` contextvar -- `asyncio.gather` har task ko context ki copy deta hai, isliye dono parallel tools ka parent `agent.run` hi hai; logs mix nahi hote.
- `try/except/finally` -- exception pe `ERROR` + event, phir re-raise; span hamesha close hota hai (latency ke saath).
- Root span pe `input.chars` hai, question text nahi -- email user ke input mein tha lekin trace mein nahi gaya. `bad` span PII guard se block hua.
- `gen_ai.*` names OpenTelemetry GenAI conventions se -- dashboards (M14-11) inhi pe group karte hain.
- `return_exceptions=True` -- ek tool fail hone se agent crash nahi, lekin trace mein wo span laal dikhega.

```python
# real version -- not run here, needs: pip install opentelemetry-sdk opentelemetry-exporter-otlp
# Langfuse and LangSmith both accept OTLP; endpoint + auth headers: check the docs for your version.
import os
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

provider = TracerProvider()
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))  # reads OTEL_EXPORTER_OTLP_* env vars
trace.set_tracer_provider(provider)
tracer = trace.get_tracer("auditmesh")
with tracer.start_as_current_span("llm.call") as s:
    s.set_attribute("gen_ai.request.model", os.environ["LLM_MODEL"])
    msg = client.messages.create(model=os.environ["LLM_MODEL"], max_tokens=512, messages=msgs)
    s.set_attribute("gen_ai.usage.input_tokens", msg.usage.input_tokens)
    s.set_attribute("gen_ai.usage.output_tokens", msg.usage.output_tokens)
```

### Mini-exercise (30-60 min)
AuditMesh v1.0 ke liye `auditmesh/obs/tracing.py` banao -- upar jaisa `span()` API, lekin exporter pluggable: `InMemoryExporter` (tests) aur `JsonlExporter` (`traces/YYYY-MM-DD.jsonl`).
- Supervisor, har worker agent, har LLM call aur Jira tool (M16-07) apna span banaye; retries M14-02 se events banein.
- Optional: local Langfuse (docker compose, free self-host) pe OTLP export.
- Acceptance: pytest -- ek run = ek trace_id; parallel workers ka parent supervisor span; failing tool = `ERROR` span; koi attribute value email/SSN regex match na kare.

### Common pitfalls
- Prompt aur completion poore span attributes mein -- trace store PII ka sabse bada leak ban jaata hai. Agar content chahiye to redacted + opt-in + short retention.
- Thread pool / background job mein context propagate na karna -- spans orphan ho jaate hain (naya trace_id). `contextvars.copy_context()` ya OTel context propagation use karo.
- Har chhoti function pe span -- 5,000 spans per run, dashboard unusable aur storage mehenga. Boundaries pe span: LLM, tool, retrieval, agent step.

### Checklist before moving on
- [ ] Trace, span, parent, attribute, event, status -- har ek ek line mein samjha sakta hoon.
- [ ] Mera tracer asyncio parallel calls mein bhi sahi tree banata hai.
- [ ] LLM span pe model aur input/output tokens hain, prompt text nahi.
- [ ] Error span status aur exception event ke saath test kiya.

### Related
- M14-11 Monitoring granular token costs and endpoint latency
- M14-12 Debugging multi-step agent reasoning and tool inputs
- M13-14 Safe logging (never log PII or prompts)
- M16-08 Building comprehensive token cost and trace dashboards

### Self-quiz
1. Log line aur span mein kya farak hai? Kaunsa sawaal sirf span tree se answer hota hai?
2. Parallel tool calls ke spans ka parent galat (ya naya trace) kyun ban sakta hai, aur contextvars isse kaise bachata hai?
3. Customer chahta hai "trace mein prompt dikhe debugging ke liye" -- aap kya design propose karoge?
4. Errors 100% aur baaki 5% sampling -- iska trade-off kya hai?
