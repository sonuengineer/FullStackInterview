# Cloud Fundamentals & Networking

## Setting automated budget thresholds

> Core | Fast CP1 / Slow CP1 | ~1.2 h | Builds on: -- (day-1 task, before any AWS resource)

### Kahani
Ek logistics customer ke saath POC chal raha tha. FDE ne Friday shaam ek GPU instance aur NAT gateway test ke liye on kiya, aur weekend pe bhool gaya. Monday ko finance ka email aaya: "Yeh $1,900 ka bill kya hai?" Kisi ne alert set hi nahi kiya tha, kyunki "abhi to account naya hai, kuch chal hi nahi raha".
Isliye yeh lesson aapke **pehle din** ka kaam hai -- pehla EC2, pehla S3 bucket ya pehla Bedrock call banane se bhi pehle. Account khula, aur sabse pehle budget lagao.

### What it is
**AWS Budgets** ek service hai jo aapke actual aur forecasted cost ko ek limit (jaise $10/month) se compare karti hai aur threshold cross hone pe email ya SNS alert bhejti hai.
Yeh ek **alarm** hai, brake nahi -- by default yeh kuch band nahi karta, sirf batata hai.

### Why it matters for an FDE
Customer ka ya aapka sandbox account bina budget ke chhoda to ek bhooli hui resource (NAT gateway, GPU, unbounded LLM loop) chupchaap paise jalati rahegi -- aur trust pehle hafte mein hi toot jaata hai.

### Key concepts
- **ACTUAL vs FORECASTED** -- actual = ab tak ka kharcha; forecasted = AWS ka andaza ki mahine ke end tak kitna hoga (early warning).
- **Threshold ladder** -- 50% / 80% / 100% ACTUAL plus FORECASTED alerts, taaki surprise ke bajaye trend dikhe.
- **Notification limits** -- API docs ke hisaab se ek budget pe up to 5 notifications, har notification pe 1 SNS + up to 10 email subscribers (check the docs for your version).
- **Free Tier alerts** -- Billing preferences mein on karo; free-tier limit ke kareeb aane pe email aata hai, chahe budget ho ya na ho.
- **Cost Anomaly Detection** -- Cost Explorer ka ML feature jo "normal se alag" spike pakadta hai (jaise ek service ka kharcha achanak 10x), fixed threshold ka intezaar kiye bina.

### Code example
`pip install jsonschema`

Yeh block AWS ko call **nahi** karta. Yeh woh do JSON files banata aur validate karta hai jo `aws budgets create-budget` ko chahiye, taaki CLI chalane se pehle hi galti pakdi jaaye.

```python
# runnable
import json, pathlib, shlex, tempfile
from jsonschema import Draft202012Validator, ValidationError

BUDGET_SCHEMA = {
    "type": "object",
    "required": ["BudgetName", "BudgetLimit", "TimeUnit", "BudgetType"],
    "properties": {
        "BudgetName": {"type": "string", "minLength": 1, "maxLength": 100},
        "BudgetLimit": {"type": "object", "required": ["Amount", "Unit"],
                        "properties": {"Amount": {"type": "string", "pattern": r"^\d+(\.\d+)?$"},
                                       "Unit": {"const": "USD"}}},
        "TimeUnit": {"enum": ["DAILY", "MONTHLY", "QUARTERLY", "ANNUALLY"]},
        "BudgetType": {"const": "COST"},
    },
}
NOTIF_SCHEMA = {
    "type": "array", "minItems": 1, "maxItems": 5,          # docs: up to five per budget
    "items": {"type": "object", "required": ["Notification", "Subscribers"], "properties": {
        "Notification": {"type": "object",
            "required": ["NotificationType", "ComparisonOperator", "Threshold", "ThresholdType"],
            "properties": {"NotificationType": {"enum": ["ACTUAL", "FORECASTED"]},
                           "ComparisonOperator": {"const": "GREATER_THAN"},
                           "Threshold": {"type": "number", "exclusiveMinimum": 0},
                           "ThresholdType": {"const": "PERCENTAGE"}}},
        "Subscribers": {"type": "array", "minItems": 1, "maxItems": 11, "items": {
            "type": "object", "required": ["SubscriptionType", "Address"],
            "properties": {"SubscriptionType": {"enum": ["EMAIL", "SNS"]},
                           "Address": {"type": "string", "pattern": r"^[^@\s]+@[^@\s]+\.[^@\s]+$"}}}}}},
}

def build(limit_usd: int, email: str):
    budget = {"BudgetName": f"monthly-guardrail-{limit_usd}usd",
              "BudgetLimit": {"Amount": str(limit_usd), "Unit": "USD"},   # Amount is a STRING
              "TimeUnit": "MONTHLY", "BudgetType": "COST"}
    ladder = [("ACTUAL", 50), ("ACTUAL", 80), ("ACTUAL", 100), ("FORECASTED", 80), ("FORECASTED", 100)]
    notifs = [{"Notification": {"NotificationType": t, "ComparisonOperator": "GREATER_THAN",
                                "Threshold": pct, "ThresholdType": "PERCENTAGE"},
               "Subscribers": [{"SubscriptionType": "EMAIL", "Address": email}]} for t, pct in ladder]
    return budget, notifs

def alerts_firing(notifs, limit, actual, forecast):
    spend = {"ACTUAL": actual, "FORECASTED": forecast}
    return [(n["Notification"]["NotificationType"], n["Notification"]["Threshold"]) for n in notifs
            if spend[n["Notification"]["NotificationType"]] > limit * n["Notification"]["Threshold"] / 100]

budget, notifs = build(10, "me+aws-alerts@example.com")
Draft202012Validator(BUDGET_SCHEMA).validate(budget)
Draft202012Validator(NOTIF_SCHEMA).validate(notifs)
keys = [(n["Notification"]["NotificationType"], n["Notification"]["Threshold"]) for n in notifs]
assert len(keys) == len(set(keys)), "duplicate threshold"

try:                                                         # a classic mistake gets caught
    Draft202012Validator(BUDGET_SCHEMA).validate({**budget, "BudgetLimit": {"Amount": 10, "Unit": "USD"}})
    raise AssertionError("numeric Amount should fail")
except ValidationError:
    pass

assert alerts_firing(notifs, 10, actual=3.0, forecast=9.0) == [("FORECASTED", 80)]   # early warning
assert len(alerts_firing(notifs, 10, actual=10.5, forecast=14.0)) == 5

out = pathlib.Path(tempfile.mkdtemp())
(out / "budget.json").write_text(json.dumps(budget, indent=2))
(out / "notifications.json").write_text(json.dumps(notifs, indent=2))
cmd = ["aws", "budgets", "create-budget", "--account-id", "123456789012",
       "--budget", "file://budget.json", "--notifications-with-subscribers", "file://notifications.json"]
print("files written to", out)
print("run later:", shlex.join(cmd))
```

- `BUDGET_SCHEMA` / `NOTIF_SCHEMA` -- AWS API ka chhota subset; asli API zyada fields leti hai (filters, `TimePeriod`, tags), par guardrail budget ke liye itna kaafi hai.
- `"Amount": str(limit_usd)` -- API `Amount` ko string maangti hai; number bhejna common galti hai, isliye test usse pakadta hai.
- `ladder` -- 3 ACTUAL + 2 FORECASTED = 5, documented limit ke andar. Forecast 50% pe alert noisy hota hai, isliye 80/100 rakha.
- `alerts_firing()` -- AWS ka logic simulate karta hai: $3 actual par $9 forecast pe sirf FORECASTED 80% bajega -- yahi early warning hai.
- `maxItems: 11` subscribers -- 10 email + 1 SNS wali limit ka simple guard.

Asli command (aapke account pe, jab AWS CLI configured ho):

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
aws budgets create-budget \
  --account-id "$ACCOUNT_ID" \
  --budget file://budget.json \
  --notifications-with-subscribers file://notifications.json
aws budgets describe-budgets --account-id "$ACCOUNT_ID" \
  --query 'Budgets[].{name:BudgetName,limit:BudgetLimit.Amount}'
# Optional: a per-service anomaly monitor (alert subscription is easiest in the console)
aws ce create-anomaly-monitor --anomaly-monitor \
  '{"MonitorName":"per-service","MonitorType":"DIMENSIONAL","MonitorDimension":"SERVICE"}'
```

Simple cost budgets (bina Budget Actions ke) free hote hain; Budget Actions ke charges ke liye pricing page check karo.

### Mini-exercise (30-60 min)
Apne `fde-exercises` repo mein `infra/budgets/` folder banao:
1. `make_budget.py` -- CLI args `--limit` (default 10) aur `--email` le, upar jaisa `budget.json` + `notifications.json` likhe.
2. `test_make_budget.py` (pytest) -- check kare: schema valid, `Amount` string hai, 5 se zyada notifications nahi, koi duplicate threshold nahi, `--limit 0` pe error.
3. Account pe (sirf apne personal sandbox mein): Billing preferences -> Free Tier alerts ON, phir CLI command chalao, phir console mein Budgets page pe budget dikhe.
4. Cost Anomaly Detection mein ek monitor + daily email subscription console se banao.

Acceptance: `pytest -q` green, `describe-budgets` aapka budget dikhaye, aur `README.md` mein 3 lines: kaunsa limit, kaunse thresholds, alerts kis inbox mein jaate hain.

### Common pitfalls
- **Budget ko hard cap samajhna** -- alert aane tak resource chalta rehta hai, aur billing data din mein kuch hi baar refresh hota hai, to alert ghanton late ho sakta hai. Auto-stop chahiye to Budget Actions ya alarm -> Lambda alag se socho.
- **Alerts aise inbox mein jo koi nahi padhta** -- team distribution list ya SNS -> Slack use karo, personal inbox nahi; aur email address ko code mein hardcode karke public repo mein push mat karo.
- **Naye account pe FORECASTED pe bharosa** -- forecast ke liye kuch hafton ka usage history chahiye (check the docs), isliye pehle mahine ACTUAL 50% hi asli early warning hai.

### Checklist before moving on
- [ ] Free Tier alerts ON hain.
- [ ] $5-$10 monthly COST budget bana hai, ACTUAL 50/80/100 + FORECASTED alerts ke saath.
- [ ] Alert email ek aisa address hai jo aap roz dekhte ho, aur test email/notification aa chuka hai.
- [ ] Cost Anomaly Detection ka ek monitor + subscription hai.
- [ ] Aap bata sakte ho ki budget kuch "rokta" kyun nahi.

### Related
- M03-12 Navigating the AWS Billing console
- M03-09 Principle of least privilege
- M03-07 Outbound traffic via NAT
- M03-01 Provisioning virtual machines

### Self-quiz
1. $10 budget, din 8 pe actual $3 aur forecast $9 -- kaun se alerts bajenge aur kyun yeh useful signal hai?
2. Budget alert aur Cost Anomaly Detection alag-alag kaun si problem pakadte hain? Ek scenario do jahan sirf anomaly detection kaam aaye.
3. Customer ke shared account mein aap budget lagana chahte ho par aapke IAM role ko Billing access nahi hai. Kya check karoge aur kisse baat karoge?
4. Budget alert aane ke baad bhi NAT gateway raat bhar chalta raha. Process mein kya badloge?
