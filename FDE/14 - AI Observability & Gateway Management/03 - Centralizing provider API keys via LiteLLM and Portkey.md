# AI Observability & Gateway Management

## Centralizing provider API keys via LiteLLM/Portkey

> Core | Fast CP8 / Slow CP10 | ~1.2 h | Builds on: M04-11, M03-09, M14-02

### Kahani
Ek hospital group mein 6 teams AI features bana rahi hain. Har team ke paas apni OpenAI aur Anthropic key hai -- kuch `.env` mein, kuch CI secrets mein, ek Slack message mein bhi.
Ek intern ne key GitHub pe push kar di; rotate karne mein 2 din lage kyunki kisi ko pata hi nahi tha wo key kahan-kahan use ho rahi hai.
Month end pe finance poochta hai: "AI bill 3x kyun hua, kis team ne kiya?" -- kisi ke paas jawab nahi.
CISO ka order: "Provider keys ek jagah. Teams ko sirf apni scoped key milegi, budget ke saath."

### What it is
**LLM gateway** = ek proxy jo saari teams aur provider APIs ke beech baithta hai. Real provider keys sirf gateway ke paas; teams ko **virtual keys** milti hain jo team, allowed models aur budget se bandhi hoti hain.
Gateway har call log karta hai (team, model, tokens, cost), routing/fallback karta hai (M14-04). **LiteLLM proxy** (open source, self-host) aur **Portkey** (hosted/OSS gateway) is pattern ke popular tools hain.

### Why it matters for an FDE
Enterprise customer pe pehla security review yahi poochta hai: "keys kahan hain, kaun use karta hai, leak hui to blast radius kya hai?" Gateway ke bina rotation, chargeback aur audit -- teeno manual aur fragile hain.

### Key concepts
- **Virtual key** -- team ka apna token; revoke/rotate karne se provider key chhedni nahi padti, aur leak hone pe sirf ek team ka budget risk mein.
- **Model alias** -- teams `claude-default` bolti hain, gateway decide karta hai kaunsa provider + model id; model badalna = config change, code change nahi.
- **Budget** -- per key/team spend limit; cross hone pe request reject, provider tak pahunchti hi nahi.
- **Spend logging** -- team, model, tokens, cost per request; prompts nahi (M13-14).
- **Single egress** -- network policy se sirf gateway ko provider domains tak jaane do; teams direct call kar hi na sakein.

### Code example
`pip install fastapi httpx`

```python
# runnable
import os
from fastapi import FastAPI, Header, HTTPException
from fastapi.testclient import TestClient
from pydantic import BaseModel

os.environ["FAKE_ANTHROPIC_KEY"] = "sk-real-SECRET-123"     # in prod: secret manager, never in code
PRICES = {"claude-default": (3.0, 15.0), "small-fast": (0.25, 1.25)}   # USD per 1M in/out -- INPUT, not truth
ROUTES = {"claude-default": ("anthropic", "model-a"), "small-fast": ("anthropic", "model-b")}
VKEYS = {"vk-radiology": {"team": "radiology", "models": {"small-fast"}, "budget": 0.002, "spent": 0.0},
         "vk-billing": {"team": "billing", "models": {"claude-default", "small-fast"}, "budget": 5.0, "spent": 0.0}}
SPEND_LOG = []

class FakeProvider:
    """Stand-in for the provider SDK: same idea (model + messages in, text + usage out)."""
    def __init__(self, api_key): self.api_key = api_key
    def create(self, model, messages, max_tokens):
        assert self.api_key.startswith("sk-real"), "gateway must inject the real key"
        n_in = sum(len(m["content"].split()) for m in messages) * 4
        return {"text": f"[{model}] ok", "usage": {"input_tokens": n_in, "output_tokens": 50}}

class ChatReq(BaseModel):
    model: str
    messages: list[dict]
    max_tokens: int = 256

app = FastAPI()

@app.post("/v1/chat")
def chat(req: ChatReq, authorization: str = Header(...)):
    vk = VKEYS.get(authorization.removeprefix("Bearer "))
    if vk is None:
        raise HTTPException(401, "unknown virtual key")
    if req.model not in vk["models"]:
        raise HTTPException(403, f"team {vk['team']} may not use {req.model}")
    if vk["spent"] >= vk["budget"]:
        raise HTTPException(429, "budget_exceeded")               # never reaches the provider
    provider, model_id = ROUTES[req.model]
    out = FakeProvider(os.environ["FAKE_ANTHROPIC_KEY"]).create(model_id, req.messages, req.max_tokens)
    p_in, p_out = PRICES[req.model]
    u = out["usage"]
    cost = (u["input_tokens"] * p_in + u["output_tokens"] * p_out) / 1_000_000
    vk["spent"] += cost
    SPEND_LOG.append({"team": vk["team"], "model": req.model, **u, "cost": cost})   # no prompt text
    return {"text": out["text"], "usage": u}

@app.get("/spend")
def spend():
    return {vk["team"]: round(vk["spent"], 6) for vk in VKEYS.values()}

c = TestClient(app)
msg = [{"role": "user", "content": "summarise the discharge note for bed 12 please"}]
ok = c.post("/v1/chat", json={"model": "small-fast", "messages": msg}, headers={"Authorization": "Bearer vk-radiology"})
assert ok.status_code == 200 and "SECRET" not in ok.text
assert c.post("/v1/chat", json={"model": "x", "messages": msg}, headers={"Authorization": "Bearer sk-real-SECRET-123"}).status_code == 401
assert c.post("/v1/chat", json={"model": "claude-default", "messages": msg},
              headers={"Authorization": "Bearer vk-radiology"}).status_code == 403
codes = [c.post("/v1/chat", json={"model": "small-fast", "messages": msg},
                headers={"Authorization": "Bearer vk-radiology"}).status_code for _ in range(40)]
assert 429 in codes and codes[-1] == 429                         # budget enforced
calls_before = len(SPEND_LOG)
c.post("/v1/chat", json={"model": "small-fast", "messages": msg}, headers={"Authorization": "Bearer vk-radiology"})
assert len(SPEND_LOG) == calls_before                            # rejected call cost nothing
assert all("content" not in str(row) and "SECRET" not in str(row) for row in SPEND_LOG)
print("spend by team:", c.get("/spend").json(), "| first 429 at call", codes.index(429) + 2)
print("OK: virtual keys, model allow-list, budget cut-off, real key never leaves the gateway")
```

- `VKEYS` -- team ko sirf `vk-...` milta hai; real `sk-real-...` env/secret manager se gateway ke andar inject hota hai. Real key se seedha call karne ki koshish = 401.
- `models` allow-list -- radiology team mehenga model use nahi kar sakti (403); cost control config mein hai, code review pe depend nahi.
- Budget check provider call se *pehle* -- 429 wale requests `SPEND_LOG` mein nahi badhte, matlab provider tak gaye hi nahi.
- `PRICES` input hai -- real prices provider pricing page se config mein daalo; hard-coded numbers jaldi purane hote hain.
- `SPEND_LOG` mein tokens aur cost hai, prompt text nahi -- yahi M14-11 ka cost dashboard feed karega.

LiteLLM proxy config (keys `os.environ/...` se padhi jaati hain; field names check the docs for your version):

```yaml
model_list:
  - model_name: claude-default
    litellm_params:
      model: anthropic/your-model-id-from-config
      api_key: os.environ/ANTHROPIC_API_KEY
  - model_name: small-fast
    litellm_params:
      model: openai/your-small-model-id
      api_key: os.environ/OPENAI_API_KEY
general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
  database_url: os.environ/DATABASE_URL
```

```bash
# real version -- not run here: start the proxy, then mint a scoped virtual key (check the docs for your version)
litellm --config config.yaml --port 4000
curl -s http://localhost:4000/key/generate \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" -H "Content-Type: application/json" \
  -d '{"models": ["small-fast"], "max_budget": 50, "metadata": {"team": "radiology"}}'
```

Teams phir OpenAI-compatible client ko `base_url="http://gateway:4000"` aur apni virtual key dete hain. **Portkey** mein bhi same idea hai: provider keys Portkey vault mein, app Portkey ki API key + config/virtual key header bhejta hai -- exact header names check the docs for your version.

### Mini-exercise (30-60 min)
AuditMesh v1.0 ke liye `auditmesh/obs/gateway/config.yaml` likho (LiteLLM format): do aliases (`supervisor-large`, `worker-small`), keys sirf `os.environ/...`.
- `docker-compose.yml` mein LiteLLM proxy service (local, free); agents sirf `GATEWAY_URL` + `GATEWAY_VKEY` env vars jaante hain.
- Ek script `mint_keys.py` jo `supervisor` aur `jira-worker` ke liye alag virtual keys banaye, alag budgets ke saath.
- Acceptance: `grep -r "sk-" auditmesh/` khaali; yaml `python -c "import yaml; yaml.safe_load(open(...))"` pass; worker key se `supervisor-large` call = denied.

### Common pitfalls
- Gateway khud single point of failure -- kam se kam 2 replicas, health check, aur timeout (M14-02) zaroori.
- Gateway logs mein full prompts/responses on by default -- PII ka naya data lake ban jaata hai; logging config explicitly set karo (M13-14).
- Virtual keys bana diye lekin network egress open -- teams purani direct key se bypass karti rahengi.

### Checklist before moving on
- [ ] Virtual key aur provider key ka farak aur leak blast radius samjha sakta hoon.
- [ ] LiteLLM `model_list` config likh sakta hoon jisme koi secret literal nahi.
- [ ] Budget enforcement provider call se pehle hota hai -- test se proved.
- [ ] Spend log mein kya hona chahiye aur kya kabhi nahi, bata sakta hoon.

### Related
- M12-01 Authentication vs authorization
- M14-04 Configuring rate limiting and fallback routing
- M14-11 Monitoring granular token costs and endpoint latency
- M13-14 Safe logging (never log PII or prompts)

### Self-quiz
1. Ek team ki virtual key leak hui. Gateway ke saath aur bina gateway ke -- response steps kaise alag hain?
2. Model alias ka fayda kya hai jab provider naya model launch kare?
3. Budget check provider call ke baad karne mein kya problem hai?
4. Gateway ko "single point of failure" kehte hain -- aap isko kaise mitigate karoge?
