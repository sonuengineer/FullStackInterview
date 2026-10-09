# Cloud Fundamentals & Networking

## Object storage lifecycle policies

> Core | Fast CP4 / Slow CP6 | ~1.2 h | Builds on: M03-13

### Kahani
Ek logistics SaaS customer pe OmniGuard har LLM request/response ka audit log S3 mein likhta hai. Teen mahine baad unke FinOps lead ne pucha: "S3 bill har mahine 20% kyun badh raha hai?"
Dekha to: 2 TB purane logs Standard class mein pade the, versioning ON thi to har overwrite ka purana version bhi charge ho raha tha, aur failed uploads ke **incomplete multipart** parts chupchaap jama the -- jo console listing mein dikhte bhi nahi.
Compliance bolta hai "logs 1 saal rakho", finance bolta hai "sasta karo". Dono ka jawab ek hi config hai.

### What it is
**S3 lifecycle configuration** bucket pe lagne wale rules hain jo age ke basis pe objects ko sasti **storage class** mein move (transition) ya delete (expire) karte hain -- automatically, roz ek baar evaluate hokar.
Rules prefix ya tag se filter hote hain, aur versioned bucket mein purane (noncurrent) versions ke liye alag rules hote hain.

### Why it matters for an FDE
AI apps logs, embeddings dumps, uploaded PDFs bahut banate hain. Bina lifecycle ke storage cost har mahine badhti hai aur "data kab delete hota hai?" wale compliance sawal ka aapke paas jawab nahi hota.

### Key concepts
- **Storage classes** -- STANDARD (hot) -> STANDARD_IA (kam access, retrieval fee) -> GLACIER_IR / GLACIER / DEEP_ARCHIVE (archive, sasta store, mehnga/slow read).
- **Minimum storage duration** -- IA ~30 din, Glacier classes 90-180 din; usse pehle delete/move kiya to bhi poore period ka charge (check the pricing page).
- **Expiration** -- current version ko delete (versioned bucket mein delete marker banta hai); **NoncurrentVersionExpiration** purane versions ko sach mein hatata hai.
- **AbortIncompleteMultipartUpload** -- adhoore multipart uploads ke parts N din baad saaf; inke bina invisible kharcha chalta rehta hai.
- **Small objects** -- bahut chhote objects (default 128 KB se kam) transition nahi hote; per-object transition fee bachat kha jaati hai (check the docs).

### Code example
`pip install jsonschema`

Block AWS ko call nahi karta: lifecycle JSON validate karta hai aur simulate karta hai ki N din purane object ke saath kya hoga.

```python
# runnable
import json
from jsonschema import Draft202012Validator

LIFECYCLE = {"Rules": [
    {"ID": "audit-logs", "Status": "Enabled", "Filter": {"Prefix": "logs/"},
     "Transitions": [{"Days": 30, "StorageClass": "STANDARD_IA"},
                     {"Days": 90, "StorageClass": "GLACIER_IR"}],
     "Expiration": {"Days": 365},
     "NoncurrentVersionExpiration": {"NoncurrentDays": 30}},
    {"ID": "tmp-uploads", "Status": "Enabled", "Filter": {"Prefix": "uploads/tmp/"},
     "Expiration": {"Days": 7}},
    {"ID": "abort-mpu", "Status": "Enabled", "Filter": {"Prefix": ""},
     "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 7}},
]}
SCHEMA = {"type": "object", "required": ["Rules"], "properties": {"Rules": {
    "type": "array", "minItems": 1, "items": {"type": "object",
    "required": ["ID", "Status", "Filter"], "properties": {
        "ID": {"type": "string", "maxLength": 255},
        "Status": {"enum": ["Enabled", "Disabled"]},
        "Transitions": {"type": "array", "items": {"type": "object",
            "required": ["Days", "StorageClass"], "properties": {
                "Days": {"type": "integer", "minimum": 0},
                "StorageClass": {"enum": ["STANDARD_IA", "ONEZONE_IA", "INTELLIGENT_TIERING",
                                          "GLACIER_IR", "GLACIER", "DEEP_ARCHIVE"]}}}}}}}}}
MIN_DAYS = {"STANDARD_IA": 30, "ONEZONE_IA": 30}   # first IA transition must wait 30 days

def semantic_errors(cfg):
    errs = []
    for r in cfg["Rules"]:
        tr = r.get("Transitions", [])
        days = [t["Days"] for t in tr]
        if days != sorted(days):
            errs.append(f"{r['ID']}: transitions not in ascending order")
        for t in tr:
            if t["Days"] < MIN_DAYS.get(t["StorageClass"], 0):
                errs.append(f"{r['ID']}: {t['StorageClass']} before day {MIN_DAYS[t['StorageClass']]}")
        exp = r.get("Expiration", {}).get("Days")
        if exp is not None and days and exp <= max(days):
            errs.append(f"{r['ID']}: expires before last transition")
    return errs

def fate(cfg, key, age_days, size_bytes=1_000_000):
    """What lifecycle would have done to the CURRENT version of `key` by `age_days`."""
    state = "STANDARD"
    for r in cfg["Rules"]:
        if r["Status"] != "Enabled" or not key.startswith(r["Filter"].get("Prefix", "")):
            continue
        if "Expiration" in r and age_days >= r["Expiration"]["Days"]:
            return "EXPIRED"
        if size_bytes >= 128 * 1024:                  # tiny objects are not transitioned
            for t in r.get("Transitions", []):
                if age_days >= t["Days"]:
                    state = t["StorageClass"]
    return state

Draft202012Validator(SCHEMA).validate(LIFECYCLE)
assert semantic_errors(LIFECYCLE) == []
assert fate(LIFECYCLE, "logs/2026/01/a.jsonl", 10) == "STANDARD"
assert fate(LIFECYCLE, "logs/2026/01/a.jsonl", 45) == "STANDARD_IA"
assert fate(LIFECYCLE, "logs/2026/01/a.jsonl", 200) == "GLACIER_IR"
assert fate(LIFECYCLE, "logs/2026/01/a.jsonl", 400) == "EXPIRED"
assert fate(LIFECYCLE, "logs/tiny.json", 200, size_bytes=2_000) == "STANDARD"
assert fate(LIFECYCLE, "uploads/tmp/x.pdf", 8) == "EXPIRED"
assert fate(LIFECYCLE, "embeddings/v1.parquet", 400) == "STANDARD"   # no rule -> forever

broken = {"Rules": [{"ID": "bad", "Status": "Enabled", "Filter": {"Prefix": "logs/"},
          "Transitions": [{"Days": 90, "StorageClass": "GLACIER"},
                          {"Days": 7, "StorageClass": "STANDARD_IA"}],
          "Expiration": {"Days": 30}}]}
errs = semantic_errors(broken)
assert len(errs) == 3, errs
print(json.dumps(LIFECYCLE)[:60] + "...", "valid")
print("caught:", *errs, sep="\n  ")
```

- `Filter: {"Prefix": ""}` -- poore bucket pe lagta hai; multipart cleanup har bucket mein hona chahiye.
- `MIN_DAYS` -- AWS IA class mein 30 din se pehle transition reject karta hai; hum yeh galti CI mein hi pakadte hain.
- `fate()` -- simplified model: asli S3 roz ek baar async evaluate karta hai, to "day 30" pe move thoda baad ho sakta hai.
- `embeddings/` pe koi rule nahi -- yeh conscious decision hona chahiye, bhool nahi. Design doc mein likho.
- `semantic_errors()` -- schema shape check karta hai, yeh function *meaning* check karta hai (order, expire-before-transition).

Asli apply (customer bucket pe, unke role se):

```bash
BUCKET=omniguard-audit-logs-111122223333
aws s3api put-bucket-versioning --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" \
  --lifecycle-configuration file://lifecycle.json
aws s3api get-bucket-lifecycle-configuration --bucket "$BUCKET"
```

### Mini-exercise (30-60 min)
`omniguard/infra/s3/` mein:
1. `lifecycle.json` -- OmniGuard ke 3 prefixes (`logs/`, `uploads/tmp/`, `exports/`) ke liye rules + multipart abort + noncurrent expiry.
2. `check_lifecycle.py` -- upar ka validator + `fate()`; CLI: `python check_lifecycle.py logs/x 120` -> storage class print kare.
3. `test_check_lifecycle.py` -- har prefix ke liye 3 ages, plus ek broken config jo fail ho.
4. Design doc mein "Data retention" table: prefix | kab IA | kab archive | kab delete | kis compliance rule ki wajah se.

Acceptance: `pytest -q` green; retention table customer ke compliance officer ke sawal "audit log kitne din rehta hai?" ka seedha jawab de.

### Common pitfalls
- **Versioning ON, noncurrent rule nahi** -- har overwrite purana copy rakhta hai; bill doguna ho sakta hai aur kisi ko dikhta nahi.
- **Chhote objects ko Glacier bhejna** -- per-request transition fee aur metadata overhead ki wajah se kharcha *badh* sakta hai.
- **Legal hold / retention bhoolna** -- customer ke paas Object Lock ya litigation hold ho sakta hai; expiration lagane se pehle unke compliance se likhit confirm lo.

### Checklist before moving on
- [ ] STANDARD, STANDARD_IA, GLACIER_IR ka trade-off (store cost vs read cost vs latency) bata sakte ho.
- [ ] Har bucket pe AbortIncompleteMultipartUpload rule hai.
- [ ] Versioned bucket pe NoncurrentVersionExpiration hai.
- [ ] `fate()` jaisa test aapke config ke har prefix ko cover karta hai.

### Related
- M03-13 Setting automated budget thresholds
- M03-12 Navigating the AWS Billing console
- M03-10 Creating identity policies
- M03-04 Event-driven serverless function basics

### Self-quiz
1. Ek object day 10 pe GLACIER mein bheja aur day 20 pe delete kiya -- bill pe kya dikhega aur kyun?
2. Versioned bucket mein `Expiration: 365` lagaya; kya data sach mein delete hua? Kya aur chahiye?
3. OmniGuard ke prompt logs mein PII hai. Lifecycle aur compliance team ke "right to be forgotten" request ka conflict kaise handle karoge?
4. S3 Intelligent-Tiering kab lifecycle transitions se behtar choice hai?
