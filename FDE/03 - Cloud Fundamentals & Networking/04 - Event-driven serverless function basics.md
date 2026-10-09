# Cloud Fundamentals & Networking

## Event-driven serverless function basics

> Core | Fast CP4 / Slow CP6 | ~1.2 h | Builds on: M03-02, M03-03

### Kahani
Ek insurance customer roz hazaron claim PDFs S3 mein upload karta hai. OmniGuard ko har PDF pe PII scan chalana hai. Pehla idea tha: ek EC2 pe cron jo har 5 minute bucket list kare -- raat ko idle paise, peak pe backlog.
Phir Lambda lagaya -- aur naya bug: SQS ne ek message do baar deliver kiya, OmniGuard ne ek hi claim pe do alerts bhej diye, aur ek 300-page PDF 3 second ke default timeout pe beech mein kat gaya.
Serverless "server nahi sochna" nahi hai; yeh "retries, timeouts aur duplicates sochna" hai.

### What it is
**AWS Lambda** ek function chalata hai jab koi **event** aata hai (S3 upload, SQS message, API call, schedule). Aap `handler(event, context)` likhte ho; AWS scaling, servers aur billing (per request + duration x memory) sambhalta hai.
Event source decide karta hai ki retry kaise hogi -- isliye handler ko **idempotent** banana padta hai.

### Why it matters for an FDE
Customer ke "file aayi -> process karo" workflows ka sabse sasta glue Lambda hai. Par duplicate processing ya silent timeout customer ko galat alerts/missing data deta hai -- aur woh aapka bug kehlata hai.

### Key concepts
- **Handler shape** -- `def handler(event, context)`; `event` = JSON dict (source-specific shape), `context` = request id, remaining time, memory.
- **At-least-once delivery** -- S3 notifications aur SQS duplicate bhej sakte hain; same message do baar process ho to bhi result ek hi ho (**idempotency key**: SQS `messageId`, S3 key + `sequencer`/ETag).
- **Partial batch response** -- SQS batch mein sirf fail hue messages `batchItemFailures` mein lauta do; baaki dobara nahi aayenge (event source mapping pe `ReportBatchItemFailures` on).
- **Timeout + memory** -- default timeout chhota hai, max 15 minute; memory badhao to CPU bhi proportional badhta hai (check the docs). `context.get_remaining_time_in_millis()` se time dekh ke graceful stop.
- **DLQ / redrive** -- baar-baar fail hone wala "poison" message ko alag queue mein bhejo, warna woh loop mein paise jalata hai.

### Code example
stdlib only

Real Lambda nahi -- `FakeContext` real `context` object ki shape copy karta hai, aur events AWS docs ke sample shape pe bane hain.

```python
# runnable
import json, time, urllib.parse

class FakeContext:  # same attributes/methods the real Lambda context exposes
    def __init__(self, timeout_s=30):
        self.aws_request_id, self.memory_limit_in_mb = "req-123", 512
        self._deadline = time.monotonic() + timeout_s
    def get_remaining_time_in_millis(self):
        return int((self._deadline - time.monotonic()) * 1000)

PROCESSED = set()       # in prod: DynamoDB conditional put (attribute_not_exists) -- not a global
ALERTS = []

def scan_pdf(bucket, key):
    if "corrupt" in key:
        raise ValueError("cannot parse PDF")
    ALERTS.append(f"scanned s3://{bucket}/{key}")

def handle_s3_record(rec):
    bucket = rec["s3"]["bucket"]["name"]
    key = urllib.parse.unquote_plus(rec["s3"]["object"]["key"])   # keys arrive URL-encoded
    idem = f"{bucket}/{key}#{rec['s3']['object']['sequencer']}"
    if idem in PROCESSED:
        return "duplicate-skipped"
    scan_pdf(bucket, key)
    PROCESSED.add(idem)                                             # mark only after success
    return "ok"

def handler(event, context):
    """SQS -> (S3 notification inside body) -> scan. Returns partial batch failures."""
    failures = []
    for msg in event["Records"]:
        if context.get_remaining_time_in_millis() < 10_000:        # leave time to report back
            failures.append({"itemIdentifier": msg["messageId"]})
            continue
        try:
            for rec in json.loads(msg["body"])["Records"]:
                handle_s3_record(rec)
        except Exception as e:
            print(json.dumps({"level": "error", "msg_id": msg["messageId"], "err": str(e)}))
            failures.append({"itemIdentifier": msg["messageId"]})
    return {"batchItemFailures": failures}

def sqs_event(*keys):
    def s3_body(k, seq):
        return json.dumps({"Records": [{"eventName": "ObjectCreated:Put", "s3": {
            "bucket": {"name": "claims-in"}, "object": {"key": k, "sequencer": seq}}}]})
    return {"Records": [{"messageId": f"m{i}", "eventSource": "aws:sqs", "body": s3_body(k, f"0A{i}")}
                        for i, k in enumerate(keys)]}

ev = sqs_event("2026/claim+001.pdf", "2026/corrupt.pdf", "2026/claim+002.pdf")
out = handler(ev, FakeContext())
assert out == {"batchItemFailures": [{"itemIdentifier": "m1"}]}
assert ALERTS == ["scanned s3://claims-in/2026/claim 001.pdf", "scanned s3://claims-in/2026/claim 002.pdf"]

handler(ev, FakeContext())                     # SQS redelivers the same batch
assert len(ALERTS) == 2, "idempotency broken: duplicate alerts"

out = handler(sqs_event("2026/late.pdf"), FakeContext(timeout_s=5))   # nearly out of time
assert out["batchItemFailures"] == [{"itemIdentifier": "m0"}]
print("alerts:", ALERTS)
print("partial failures + idempotency + timeout guard OK")
```

- `unquote_plus` -- S3 event mein `claim 001.pdf` `claim+001.pdf` ban ke aata hai; decode na kiya to `NoSuchKey`.
- `PROCESSED.add` success ke **baad** -- pehle add kiya aur scan crash hua to file kabhi process nahi hogi.
- Global `set` sirf demo hai: Lambda containers reuse hote hain par guarantee nahi, aur parallel instances memory share nahi karte. Prod mein DynamoDB conditional write.
- `batchItemFailures` -- sirf `m1` retry hoga; bina iske poora batch retry hota aur `m0`/`m2` duplicate bante.
- Remaining-time guard -- timeout pe Lambda beech mein mar jaata hai bina cleanup; pehle hi rukna better hai.

Asli deploy (sandbox ya customer account):

```bash
zip -r function.zip handler.py
aws lambda create-function --function-name omniguard-pdf-scan \
  --runtime python3.12 --handler handler.handler --zip-file fileb://function.zip \
  --role arn:aws:iam::111122223333:role/omniguard-pdf-scan-lambda \
  --timeout 120 --memory-size 1024
aws lambda create-event-source-mapping --function-name omniguard-pdf-scan \
  --event-source-arn arn:aws:sqs:eu-west-1:111122223333:claims-in-events \
  --batch-size 5 --function-response-types ReportBatchItemFailures
```

### Mini-exercise (30-60 min)
`omniguard/infra/lambda/pdf_scan/` mein:
1. `handler.py` -- upar jaisa handler; idempotency store ek interface ke peeche (`InMemoryStore` tests ke liye, `DynamoStore` stub prod ke liye).
2. `events/` -- 3 sample JSON events: single upload, URL-encoded key, duplicate redelivery.
3. `test_handler.py` -- duplicate, partial failure, timeout guard, aur SQS queue visibility timeout >= Lambda timeout wala config check.
4. Design doc "Async processing" section: event flow diagram (S3 -> SQS -> Lambda -> DLQ), retry count, DLQ alarm.

Acceptance: `pytest -q` green; duplicate event pe alert count nahi badhta.

### Common pitfalls
- **SQS visibility timeout Lambda timeout se chhota** -- message processing ke beech hi dobara visible, doosra Lambda bhi utha leta hai. AWS ~6x Lambda timeout suggest karta hai (check the docs).
- **Recursive trigger** -- Lambda output usi bucket/prefix mein likhe jahan se trigger hota hai to infinite loop aur bill. Alag prefix/bucket rakho.
- **Logs mein poora event print** -- S3 keys/claim IDs mein PII ho sakti hai; sirf ids log karo.

### Checklist before moving on
- [ ] `handler(event, context)` ka S3 aur SQS event shape yaad hai.
- [ ] Idempotency key kya hai aur mark kab hota hai, bata sakte ho.
- [ ] Partial batch response on hai aur DLQ configured hai.
- [ ] Timeout, memory, visibility timeout ka rishta samjha.

### Related
- M03-02 Object storage lifecycle policies
- M03-03 Managed relational databases setup
- M03-09 Principle of least privilege
- M03-07 Outbound traffic via NAT

### Self-quiz
1. Handler `PROCESSED.add()` scan se pehle karta to kaunsa failure mode aata?
2. Lambda ko VPC ke private subnet mein daala aur ab woh LLM API call nahi kar pa raha. Kyun? (M03-07)
3. Ek poison message har 30 second retry ho raha hai. Kya-kya configure karoge?
4. Kab Lambda ke bajaye ECS/EC2 worker better hai? Do concrete signals do.
