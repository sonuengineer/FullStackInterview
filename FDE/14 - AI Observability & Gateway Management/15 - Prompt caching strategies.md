# AI Observability & Gateway Management

## Prompt caching strategies

> Core | Fast CP8 / Slow CP10 | ~1.2 h | Builds on: M14-11, M05-03, M05-11

### Kahani
Ek insurance customer ka claims agent har request pe 9,000 token ka system prompt bhejta hai: policy rules, 14 tool definitions, few-shot examples. User ka actual sawaal 150 tokens.
Team ne "prompt caching on" kar diya, lekin bill nahi gira. Dashboard (M14-11) pe `cache_read_input_tokens` lagbhag zero.
Debug karne pe pata chala: system prompt ki pehli line thi `Current time: 2026-10-09 14:03:27` -- har request pe prefix alag, cache har baar miss. Upar se tool list ek `dict` se banti thi jiska order deploy ke saath badal jaata tha.
Fix ek line ka tha. Lekin ise pakadne ke liye aapko pata hona chahiye ki cache kaise kaam karta hai.

### What it is
**Prompt caching** = provider aapke prompt ke ek **prefix** ka processed state kuch der (TTL) ke liye rakhta hai; agla request same prefix se shuru ho to wo part sasta aur tez padhta hai.
Shart: prefix **byte-identical** ho. Isliye stable cheezein pehle (tools, system prompt, documents), volatile cheezein last (user message, time, request ids).

### Why it matters for an FDE
Long system prompts aur RAG context wale agents mein input tokens hi bill ka bada hissa hote hain. Sahi caching cost aur latency dono gira sakti hai -- galat caching chupke se cost *badha* deti hai (cache write ka extra charge, read kabhi nahi).

### Key concepts
- **Prefix order** -- Anthropic mein cache order `tools -> system -> messages` hai; kisi bhi pehle wale hisse mein ek byte badla to uske baad sab miss.
- **`cache_control: {"type": "ephemeral"}` breakpoints** -- block pe lagao jahan tak cache karna hai; max 4 breakpoints per request; minimum cacheable length aur TTL options model pe depend karte hain -- check the docs for your version.
- **Verify, don't assume** -- response `usage.cache_creation_input_tokens` (write) aur `usage.cache_read_input_tokens` (hit) log karo; hit rate dashboard pe rakho.
- **Silent invalidators** -- system prompt mein timestamp/user name, unsorted JSON (tool schemas, few-shot data), har request pe badalti tool list, random example order.
- **OpenAI** -- lambe prompts pe automatic prefix caching, koi breakpoint nahi; `usage.prompt_tokens_details.cached_tokens` se verify. Prefix-stable rule wahi hai.

### Code example
stdlib only

```python
# runnable
import hashlib, json, re, datetime as dt

TS = re.compile(r"\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}")
POLICY = "You are a claims assistant. Rules: " + "Cover accidents after 30 days. " * 300

def build(question, tools, now=None, sort=True):
    sys_text = (f"Current time: {now}\n" if now else "") + POLICY
    return {"tools": [json.loads(json.dumps(t, sort_keys=sort)) for t in tools],
            "system": [{"type": "text", "text": sys_text, "cache_control": {"type": "ephemeral"}}],
            "messages": [{"role": "user", "content": question}]}          # volatile part LAST

def prefix_bytes(req):          # what the provider hashes: everything up to the last breakpoint
    return json.dumps({"tools": req["tools"], "system": req["system"]}, separators=(",", ":")).encode()

def check(reqs):
    issues, prev = [], None
    for i, r in enumerate(reqs):
        bps = sum("cache_control" in b for b in r["system"]) + sum("cache_control" in t for t in r["tools"])
        if bps > 4:
            issues.append((i, "more than 4 cache_control breakpoints"))
        if prev and hashlib.sha256(prefix_bytes(r)).digest() != hashlib.sha256(prefix_bytes(prev)).digest():
            if [t["name"] for t in r["tools"]] != [t["name"] for t in prev["tools"]]:
                issues.append((i, "tool list/order changed"))
            elif json.dumps(r["tools"]) != json.dumps(prev["tools"]):
                same = json.dumps(r["tools"], sort_keys=True) == json.dumps(prev["tools"], sort_keys=True)
                issues.append((i, "same tools JSON, different key order -> use sort_keys" if same else "tool schema changed"))
            elif TS.search(r["system"][0]["text"]):
                issues.append((i, "timestamp inside cached system prompt"))
            else:
                issues.append((i, "prefix changed"))
        prev = r
    return issues

class FakeCachingAPI:           # mimics usage fields of a caching provider; NOT the real algorithm
    def __init__(self): self.seen = set()
    def create(self, req):
        h, n = hashlib.sha256(prefix_bytes(req)).hexdigest(), len(prefix_bytes(req)) // 4
        hit, _ = h in self.seen, self.seen.add(h)
        return {"input_tokens": len(req["messages"][0]["content"]) // 4,
                "cache_creation_input_tokens": 0 if hit else n, "cache_read_input_tokens": n if hit else 0}

def cost(n_req, prefix_tok, suffix_tok, price_in, write_mult, read_mult, hit_rate):
    misses = 1 + (n_req - 1) * (1 - hit_rate)                       # first call always writes
    return (misses * prefix_tok * price_in * write_mult + (n_req - misses) * prefix_tok * price_in * read_mult
            + n_req * suffix_tok * price_in) / 1e6

TOOLS = [{"name": "get_policy", "input_schema": {"type": "object", "properties": {"id": {"type": "string"}}}},
         {"name": "open_claim", "input_schema": {"properties": {"amount": {"type": "number"}}, "type": "object"}}]
good = [build(q, TOOLS) for q in ["Is my accident covered?", "Claim status for C-91?"]]
api = FakeCachingAPI()
usage = [api.create(r) for r in good]
assert check(good) == [] and usage[1]["cache_read_input_tokens"] > 2000

now = lambda m: dt.datetime(2026, 10, 9, 14, m).isoformat(sep=" ")
bad_ts = [build("q1", TOOLS, now(3)), build("q2", TOOLS, now(4))]
bad_order = [build("q1", TOOLS, sort=False), build("q2", [{**TOOLS[0]}, {"input_schema": TOOLS[1]["input_schema"], "name": "open_claim"}], sort=False)]
bad_tools = [build("q1", TOOLS), build("q2", TOOLS[::-1])]
for name, reqs in [("timestamp", bad_ts), ("key order", bad_order), ("tools", bad_tools)]:
    print(f"{name:10} ->", check(reqs))
    fresh = FakeCachingAPI()
    assert len(check(reqs)) == 1 and [fresh.create(r)["cache_read_input_tokens"] for r in reqs] == [0, 0]
assert "key order" in check(bad_order)[0][1] and "timestamp" in check(bad_ts)[0][1]

# prices are INPUTS (check the provider pricing page); multipliers here are placeholders
args = dict(n_req=10_000, prefix_tok=9000, suffix_tok=150, price_in=3.0, write_mult=1.25, read_mult=0.1)
no_cache = cost(**args | {"write_mult": 1.0, "read_mult": 1.0, "hit_rate": 0.0})
stable, broken = cost(**args, hit_rate=0.95), cost(**args, hit_rate=0.0)
print(f"no cache ${no_cache:.0f} | stable prefix ${stable:.0f} | timestamp-broken cache ${broken:.0f}")
assert stable < 0.3 * no_cache and broken > no_cache                  # broken caching costs MORE
print("OK: prefix-stability checker flags invalidators; cost model with input prices")
```

- `build()` -- tools aur system pehle, user question last; `cache_control` system block pe, isliye tools + system dono cached prefix mein.
- `check()` -- consecutive requests ka prefix hash compare karta hai aur cause guess karta hai: tool order, JSON key order, timestamp. Ye CI mein ya staging traffic pe chalao.
- `bad_order` -- content same, sirf dict key order alag; bytes alag = cache miss. `sort_keys=True` fix hai.
- `FakeCachingAPI` usage shape real jaisa (`cache_read_input_tokens`) lekin algorithm fake hai -- real verification real usage fields se hi.
- Cost model -- broken caching (hamesha write, kabhi read nahi) no-cache se bhi mehenga, kyunki write ka multiplier > 1.

```python
# real version -- not run here, needs: pip install anthropic
import os, anthropic
client = anthropic.Anthropic()
msg = client.messages.create(
    model=os.environ["LLM_MODEL"], max_tokens=512, tools=TOOLS,
    system=[{"type": "text", "text": POLICY, "cache_control": {"type": "ephemeral"}}],
    messages=[{"role": "user", "content": f"(asked at {now_iso}) {question}"}],   # volatile data goes here
)
u = msg.usage
print(u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens)
```

### Mini-exercise (30-60 min)
AuditMesh v1.0 ke supervisor prompt ko cache-friendly banao: `auditmesh/prompts/supervisor.py` mein tools sorted by name, schemas `sort_keys=True`, date/user/run id sirf last user message mein.
- `auditmesh/obs/cache_check.py` -- upar jaisa checker; staging ke 20 recorded requests pe chalao, issues list print kare.
- `costs.py` (M14-11) mein `cache_hit_rate = cache_read / (cache_read + cache_creation + input)` per endpoint add karo -- M16-08 dashboard pe dikhe.
- Acceptance: checker 0 issues; real ya fake usage logs mein doosre request se `cache_read_input_tokens > 0`; cost report cache ke saath aur bina dono dikhaye.

### Common pitfalls
- "Caching enabled" bol ke verify na karna -- hit rate metric ke bina pata hi nahi chalta ki timestamp ne sab tod diya.
- Chhote prompts ya kam traffic (TTL ke andar repeat nahi) pe caching -- write charge lagta hai, read kabhi nahi. Minimum length aur traffic pattern check karo.
- Per-user data (naam, account) system prompt mein daal ke cache karna -- prefix har user ka alag, aur cached data mein PII; user-specific cheezein messages mein.

### Checklist before moving on
- [ ] Bata sakta hoon cache prefix ka order kya hai aur volatile data kahan jaana chahiye.
- [ ] Teen silent invalidators bina dekhe gina sakta hoon.
- [ ] `cache_read_input_tokens` / `cached_tokens` se hit verify karta hoon.
- [ ] Caching ke saath aur bina cost calculate kar sakta hoon, prices input ke roop mein.

### Related
- M14-11 Monitoring granular token costs and endpoint latency
- M14-16 Model selection and routing
- M05-03 Token calculation
- M05-11 Defining precise function schemas for LLMs

### Self-quiz
1. System prompt ki last line mein `user_name` hai. Cache hit rate pe kya asar hoga aur fix kya hai?
2. Cache "on" hai lekin bill badh gaya -- kya kya causes ho sakte hain?
3. Tool definitions ko `dict` se generate karte waqt kya dhyan rakhoge aur kyun?
4. Anthropic ke explicit breakpoints aur OpenAI ke automatic prefix caching mein design ke liye kya common rule hai?
