# Legacy Systems & Integrations

## Interactive message payloads

> Core | Fast CP5 / Slow CP7 | ~1.2 h | Builds on: M11-01

### Kahani
Hospital ke IT helpdesk mein OmniGuard Slack pe answer deta hai: "VPN reset karna hai? [Approve] [Reject]". Nurse ne Approve dabaya -- Slack ne "This app is not responding" dikhaya.
Kyun? Button click pe aapka handler pehle Active Directory ko call karta tha, phir LLM se summary banwata tha -- 9 second. Slack sirf 3 second wait karta hai.
Nurse ne teen baar click kiya, teen password reset hue. Fix: turant ack karo, kaam background mein karo, result `response_url` pe bhejo -- aur duplicate clicks ko dedupe karo.

### What it is
**Block Kit** = Slack message ka JSON layout (`section`, `actions`, `button` elements with `action_id` aur `value`).
User click kare to Slack aapke **Interactivity Request URL** pe `application/x-www-form-urlencoded` POST bhejta hai jisme ek field `payload=<JSON>` hota hai. Aapko 3 second mein HTTP 200 dena hai; asli jawab baad mein `response_url` pe.

### Why it matters for an FDE
Approval flows (refund approve, access grant, ticket escalate) customer ke liye "AI ne action liya" wala moment hai. Slow ack = timeout errors aur repeat clicks; bina signature check = koi bhi approval forge kar sakta hai.

### Key concepts
- **`payload=` form field** -- body JSON nahi hai; pehle form decode, phir `json.loads(payload)`. Signature raw form body pe verify (M11-01).
- **3-second ack** -- handler sirf verify + validate + enqueue kare, phir `200` empty body.
- **`response_url`** -- payload ke andar; uspe JSON POST karke original message replace/update kar sakte ho (`replace_original`). Ye limited time aur limited uses ke liye valid hota hai -- exact limits docs mein check karo.
- **Dedupe** -- `(message ts, action_id, user)` ya aapka own request id store karo; same action dobara aaye to dobara execute mat karo (M14-01).
- **Authorize the clicker** -- payload mein `user.id` aata hai; check karo ki ye user approve kar sakta hai, sirf button dikhna permission nahi hai.

### Code example
`pip install fastapi httpx`

```python
# runnable
import hashlib, hmac, json, time
from urllib.parse import parse_qs, urlencode
import httpx
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request, Response
from fastapi.testclient import TestClient

SECRET = "test-signing-secret"
APPROVERS = {"U_ADMIN"}                                      # real: RBAC lookup (M12-06)
done_actions: set[tuple] = set()                             # real: Redis/DB with TTL
followups = []

def fake_slack(req: httpx.Request):                          # response_url endpoint, no network
    followups.append(json.loads(req.content))
    return httpx.Response(200, text="ok")
slack_http = httpx.Client(transport=httpx.MockTransport(fake_slack), timeout=5.0)

def approval_message(ticket_id: str) -> dict:
    return {"text": f"Reset VPN for ticket {ticket_id}?", "blocks": [
        {"type": "section", "text": {"type": "mrkdwn", "text": f"*Reset VPN* for ticket `{ticket_id}`?"}},
        {"type": "actions", "elements": [
            {"type": "button", "action_id": "approve_reset", "style": "primary",
             "text": {"type": "plain_text", "text": "Approve"}, "value": ticket_id},
            {"type": "button", "action_id": "reject_reset", "style": "danger",
             "text": {"type": "plain_text", "text": "Reject"}, "value": ticket_id}]}]}

def do_reset_and_reply(ticket_id: str, user: str, response_url: str):    # slow work, after the ack
    time.sleep(0.05)                                         # pretend: AD call + LLM summary
    slack_http.post(response_url, json={"replace_original": True, "text": f"VPN reset done for {ticket_id} by <@{user}>"})

app = FastAPI()

@app.post("/slack/interactions")
async def interactions(request: Request, bg: BackgroundTasks):
    raw = await request.body()
    ts, sig = request.headers.get("X-Slack-Request-Timestamp", "0"), request.headers.get("X-Slack-Signature", "")
    expected = "v0=" + hmac.new(SECRET.encode(), f"v0:{ts}:".encode() + raw, hashlib.sha256).hexdigest()
    if abs(time.time() - int(ts)) > 300 or not hmac.compare_digest(expected, sig):
        raise HTTPException(401, "bad signature")
    payload = json.loads(parse_qs(raw.decode())["payload"][0])           # form field -> JSON
    action = payload["actions"][0]
    user = payload["user"]["id"]
    if user not in APPROVERS:
        return {"response_type": "ephemeral", "replace_original": False, "text": "You are not allowed to approve this."}
    key = (payload["container"]["message_ts"], action["action_id"], action["value"])
    if key in done_actions:
        return Response(status_code=200)                     # duplicate click: ack, do nothing
    done_actions.add(key)
    if action["action_id"] == "approve_reset":
        bg.add_task(do_reset_and_reply, action["value"], user, payload["response_url"])
    return Response(status_code=200)                         # ack within 3 s, empty body

def click(user: str, ts: int | None = None) -> httpx.Response:
    p = {"type": "block_actions", "user": {"id": user}, "response_url": "https://hooks.slack.com/actions/T/1/x",
         "container": {"message_ts": "1700000000.0001"},
         "actions": [{"action_id": "approve_reset", "value": "INC-77", "type": "button"}]}
    body = urlencode({"payload": json.dumps(p)}).encode()
    ts = ts or int(time.time())
    sig = "v0=" + hmac.new(SECRET.encode(), f"v0:{ts}:".encode() + body, hashlib.sha256).hexdigest()
    return client.post("/slack/interactions", content=body, headers={
        "Content-Type": "application/x-www-form-urlencoded", "X-Slack-Request-Timestamp": str(ts), "X-Slack-Signature": sig})

client = TestClient(app)
assert approval_message("INC-77")["blocks"][1]["elements"][0]["action_id"] == "approve_reset"
r1 = click("U_ADMIN"); r2 = click("U_ADMIN")                 # double click
assert r1.status_code == 200 and r1.content == b"" and r2.status_code == 200
assert len(followups) == 1 and followups[0]["replace_original"] is True     # executed once
assert "not allowed" in click("U_NURSE").json()["text"]
assert click("U_ADMIN", ts=int(time.time()) - 900).status_code == 401
print("follow-up:", followups[0]["text"])
print("OK: form payload, ack, background follow-up, dedupe, authz")
```

- `parse_qs(raw)["payload"][0]` -- interactivity body form-encoded hota hai; signature raw bytes pe pehle check, parse baad mein.
- `BackgroundTasks` -- response bhejne ke baad chalta hai. TestClient isko response ke saath hi run kar deta hai, isliye `followups` turant bhara.
- `done_actions` -- double click pe doosri baar sirf ack. Production mein shared store (Redis/DB) chahiye, kyunki multiple workers hain.
- `APPROVERS` check -- button sabko dikhta hai, isliye authorization server pe; unauthorized user ko ephemeral message.
- Real production mein `BackgroundTasks` ki jagah queue (SQS/Celery/RQ) better hai -- process restart pe task lost nahi hoga.

### Mini-exercise (30-60 min)
OmniGuard `omniguard/integrations/slack.py` mein add karo:
- `build_approval_blocks(action_id, label, value)` aur route `/integrations/slack/interactions`.
- Handler: verify (M11-01 wala function reuse), RBAC check (OmniGuard roles), dedupe table `slack_actions(message_ts, action_id, value, created_at)` sqlite mein, ack < 3 s.
- Follow-up `response_url` pe injected httpx client se (timeout 5 s, 1 retry on 5xx).
- Tests: approve, double click, unauthorized user, bad signature, follow-up failure (response_url 500) -- ack phir bhi 200.

### Common pitfalls
- Handler ke andar LLM/DB ka slow kaam -- 3 s cross, Slack error dikhata hai aur user dobara click karta hai.
- `value` field ko trust karna -- attacker signed request nahi bana sakta, par aapke hi users purane messages se actions trigger kar sakte hain; state server pe re-check karo (ticket abhi bhi open hai?).
- `response_url` ko logs mein print karna -- wo bhi ek short-lived secret hai.

### Checklist before moving on
- [ ] Block Kit button JSON bina docs dekhe likh sakta hoon (`action_id`, `value`).
- [ ] Form `payload=` decode aur signature verify ka order sahi hai.
- [ ] Ack 3 s ke andar, kaam background/queue mein, follow-up `response_url` pe.
- [ ] Duplicate clicks aur unauthorized users handle hote hain.

### Related
- M11-01 Webhooks and bot tokens for Slack/Teams
- M14-01 Idempotency keys for safe tool execution
- M12-06 Implementing Role-Based Access Control
- M10-04 Requesting manual state approval

### Self-quiz
1. Handler 5 s leta hai. User ko kya dikhega, aur aap code kaise todoge?
2. Signature verify `json.loads` se pehle kyun, baad mein kyun nahi?
3. Do workers pe app chal raha hai aur dedupe in-memory set mein hai. Kya toot sakta hai?
4. Button user ko dikh raha hai -- kya iska matlab wo approve karne ka haqdaar hai?
