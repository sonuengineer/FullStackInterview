# Production AI Security & Guardrails

## Setting up AWS Bedrock managed guardrail configurations via Boto3

> Extended (slow track only) | Slow CP8 only | ~1.2 h

**Bedrock Guardrails** AWS ka managed rails service hai: **content filters** (hate, violence, prompt attack etc., strength levels ke saath), **denied topics** (natural-language definition + examples), word filters, **sensitive information filters** (PII block/anonymize + custom regex), aur **contextual grounding check** (RAG answer source se grounded hai ya nahi).
Boto3 se `bedrock` client pe `create_guardrail(...)` + `create_guardrail_version(...)`; phir model call ke saath guardrail id/version do, ya **`apply_guardrail`** API se kisi bhi text ko check karo (non-Bedrock model ka output bhi).
FDE angle: AWS-heavy customer ka security team managed service prefer karta hai (IAM, CloudWatch, audit). Par ye M13-10 pipeline ka poora replacement nahi -- tool authz aur injection policy phir bhi aapke code mein. Exact params aur limits ke liye check the docs.

```python
# real version -- not run here, needs: pip install boto3 + an AWS account (check the docs for exact params)
import boto3
rt = boto3.client("bedrock-runtime")
resp = rt.apply_guardrail(guardrailIdentifier=GUARDRAIL_ID, guardrailVersion="1", source="INPUT",
                          content=[{"text": {"text": user_msg}}])
blocked = resp["action"] == "GUARDRAIL_INTERVENED"
```

**Try this (20-40 min):** Bina AWS account ke: docs padh ke ek `create_guardrail` request ka JSON draft likho (1 denied topic "investment advice", EMAIL anonymize, PROMPT_ATTACK filter HIGH) aur usse M13-10 pipeline ke checks se map karo -- kaunsa check managed ho gaya, kaunsa abhi bhi aapka code.

**Read:** https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails.html
