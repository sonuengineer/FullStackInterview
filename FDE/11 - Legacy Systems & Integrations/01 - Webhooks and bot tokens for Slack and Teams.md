# Legacy Systems & Integrations

## Webhooks and bot tokens for Slack/Teams

> Core | Fast CP5 / Slow CP7 | ~1.2 h | Builds on: M02-03, M12-09

### Kahani
Logistics customer chahta hai ki OmniGuard ka answer seedha unke `#ops-help` Slack channel mein aaye, aur log bot ko mention karke sawaal pooch sakein. Pehle intern ne public `/slack/events` endpoint banaya jo har POST ko trust karta tha.
Security review mein customer ke pentester ne curl se fake event bheja: "@omniguard delete shipment 4411". Bot ne chala diya.
Saath mein incoming webhook URL ek public GitHub repo mein commit ho gaya tha -- koi bhi us channel mein kuch bhi post kar sakta tha.
Fix simple tha: har inbound request ka signature verify karo, aur secrets ko secrets ki tarah treat karo.

### What it is
**Incoming webhook** = ek secret URL; uspe JSON POST karo to fixed channel mein message aata hai (one-way, outbound only).
**Bot token** (`xoxb-...`) = OAuth token jisse aap Web API call karte ho (`chat.postMessage`, kisi bhi allowed channel mein), aur **Events API** Slack se aapke server pe events bhejta hai -- jinhe **signing secret** se verify karna zaroori hai.

### Why it matters for an FDE
Chat integration customer ke employees ke saamne sabse visible cheez hai. Bina signature check ke koi bhi aapke bot ko commands bhej sakta hai; leaked webhook URL = spam ya phishing customer ke internal channel mein.

### Key concepts
- **Signature** -- `v0=` + HMAC-SHA256(signing_secret, `v0:{timestamp}:{raw_body}`), header `X-Slack-Signature`; timestamp `X-Slack-Request-Timestamp` mein.
- **Replay window** -- timestamp 5 minute se purana ho to reject; warna attacker purani valid request dobara bhej sakta hai.
- **Raw body** -- HMAC raw bytes pe banta hai; JSON parse karke dobara serialize kiya to signature match nahi hoga.
- **Least scopes** -- bot ko sirf `chat:write`, `app_mentions:read` jaise scopes do; `admin` ya `channels:history` bina zaroorat nahi.
- **Teams** -- incoming webhook / Workflows pe Adaptive Card JSON POST hota hai. Microsoft ne Office 365 connectors retire karke Workflows pe shift kiya hai -- current setup ke liye docs check karo.

### Code example
`pip install fastapi httpx`

```python
# runnable
import hashlib, hmac, json, time
import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

SIGNING_SECRET = "test-signing-secret"          # real: os.environ["SLACK_SIGNING_SECRET"]
app = FastAPI()

def verify_slack(raw: bytes, ts: str | None, sig: str | None, now: float | None = None) -> None:
    if not ts or not sig:
        raise HTTPException(401, "missing signature headers")
    if abs((now or time.time()) - int(ts)) > 60 * 5:              # replay window: 5 minutes
        raise HTTPException(401, "stale request")
    base = f"v0:{ts}:".encode() + raw                             # raw bytes, not re-serialized JSON
    expected = "v0=" + hmac.new(SIGNING_SECRET.encode(), base, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig):                    # constant-time compare
        raise HTTPException(401, "bad signature")

@app.post("/slack/events")
async def slack_events(request: Request):
    raw = await request.body()
    verify_slack(raw, request.headers.get("X-Slack-Request-Timestamp"), request.headers.get("X-Slack-Signature"))
    event = json.loads(raw)
    if event.get("type") == "url_verification":                  # one-time handshake when you set the URL
        return {"challenge": event["challenge"]}
    return {"ok": True}                                           # real: enqueue work, ack fast

def sign(body: bytes, ts: int) -> dict:                           # what Slack does on its side
    sig = "v0=" + hmac.new(SIGNING_SECRET.encode(), f"v0:{ts}:".encode() + body, hashlib.sha256).hexdigest()
    return {"X-Slack-Request-Timestamp": str(ts), "X-Slack-Signature": sig, "Content-Type": "application/json"}

client = TestClient(app)
body = json.dumps({"type": "url_verification", "challenge": "abc123"}).encode()
now = int(time.time())
assert client.post("/slack/events", content=body, headers=sign(body, now)).json() == {"challenge": "abc123"}
tampered = body.replace(b"abc123", b"evil")
assert client.post("/slack/events", content=tampered, headers=sign(body, now)).status_code == 401
assert client.post("/slack/events", content=body, headers=sign(body, now - 600)).status_code == 401
assert client.post("/slack/events", content=body).status_code == 401

# Outbound: incoming webhook vs bot token. MockTransport = fake Slack, no network.
seen = []
def fake_slack(req: httpx.Request):
    seen.append((req.url.path, req.headers.get("authorization"), json.loads(req.content)))
    if req.url.path == "/api/chat.postMessage":
        return httpx.Response(200, json={"ok": True, "channel": "C123", "ts": "1700000000.0001"})
    return httpx.Response(200, text="ok")                         # webhooks answer plain "ok"

http = httpx.Client(transport=httpx.MockTransport(fake_slack), timeout=5.0)
http.post("https://hooks.slack.com/services/T000/B000/XXXX", json={"text": "Deploy finished"})
r = http.post("https://slack.com/api/chat.postMessage", headers={"Authorization": "Bearer xoxb-fake"},
              json={"channel": "C123", "text": "Shipment 4411 is delayed", "thread_ts": "1699999999.0001"})
assert r.json()["ok"] is True                                     # Web API returns 200 + ok:false on errors
assert seen[0][1] is None and seen[1][1] == "Bearer xoxb-fake"
teams_card = {"type": "message", "attachments": [{"contentType": "application/vnd.microsoft.card.adaptive",
              "content": {"type": "AdaptiveCard", "version": "1.4", "body": [{"type": "TextBlock", "text": "Hi"}]}}]}
assert teams_card["attachments"][0]["content"]["type"] == "AdaptiveCard"
print("OK: signature, replay window, webhook vs bot token shapes")
```

- `verify_slack` -- teen checks: headers present, timestamp 5 min ke andar, HMAC match. `hmac.compare_digest` timing attack se bachata hai (`==` mat use karo).
- `await request.body()` -- raw bytes pe verify, parse baad mein. FastAPI ka pydantic body model pehle parse kar dega, isliye yahan `Request` liya.
- `url_verification` -- Slack app config mein URL set karte waqt challenge echo karna padta hai.
- Webhook call mein koi auth header nahi -- URL hi secret hai. Bot token `Authorization: Bearer xoxb-...` header mein jaata hai.
- Slack Web API errors pe bhi aksar HTTP 200 + `{"ok": false, "error": "..."}` deta hai -- `ok` field check karo, sirf status code nahi.

```python
# real version -- not run here, needs: pip install slack_sdk
import os
from slack_sdk import WebClient
from slack_sdk.signature import SignatureVerifier

verifier = SignatureVerifier(signing_secret=os.environ["SLACK_SIGNING_SECRET"])
ok = verifier.is_valid_request(raw_body, dict(request.headers))      # same HMAC + timestamp check
client = WebClient(token=os.environ["SLACK_BOT_TOKEN"], timeout=5)
client.chat_postMessage(channel=os.environ["SLACK_CHANNEL_ID"], text="Shipment 4411 is delayed")
```

### Mini-exercise (30-60 min)
OmniGuard: `omniguard/integrations/slack.py` banao.
- `verify_slack_request(raw, headers, secret, now)` -- pure function, upar wala logic; FastAPI route `/integrations/slack/events` isko dependency ki tarah use kare.
- `SlackNotifier` Protocol with `WebhookNotifier` aur `BotNotifier` (httpx client injected, timeout 5 s). `ok: false` pe custom `SlackError`.
- Config sirf env se: `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `SLACK_WEBHOOK_URL`; startup pe missing ho to integration disabled, crash nahi.
- Tests: valid, tampered body, stale timestamp, missing headers, `ok:false` response. Logs mein token ya webhook URL kabhi nahi.

### Common pitfalls
- JSON parse karke `json.dumps` se dobara bytes banana -- key order/whitespace badla, signature hamesha fail; ya worse, check hi hata diya.
- Webhook URL ya `xoxb` token code/README mein -- secrets manager mein rakho, leak ho to turant rotate karo.
- Bot ko workspace-wide scopes de dena "taaki baad mein problem na ho" -- customer ka security team ye approve nahi karega.

### Checklist before moving on
- [ ] Har inbound Slack request ka HMAC aur 5-minute window check hota hai.
- [ ] Webhook vs bot token ka farq aur kab kaunsa use karna hai, bata sakta hoon.
- [ ] Outbound calls pe timeout hai aur `ok` field check hota hai.
- [ ] Teams ke liye current webhook/Workflows docs dekh liye hain.

### Related
- M11-02 Interactive message payloads
- M12-09 API keys vs service accounts
- M13-14 Safe logging (never log PII or prompts)
- M14-01 Idempotency keys for safe tool execution

### Self-quiz
1. Signature valid hai par timestamp 20 minute purana hai. Reject kyun karna chahiye?
2. Incoming webhook aur `chat.postMessage` -- customer ko 5 alag channels mein alerts chahiye. Kaunsa choose karoge aur kyun?
3. HMAC compare ke liye `==` kyun galat hai?
4. Slack ne 200 return kiya par message nahi aaya. Pehle kya check karoge?
