# Production AI Security & Guardrails

## Evaluating false-positive redaction rates

> Extended (slow track only) | Slow CP8 only | ~1.2 h

Redactor ke do failure modes: **false negative** (PII leak -- compliance risk) aur **false positive** (order id, drug dose, date redact ho gaya -- product bekaar, users workaround dhundhte hain). Dono measure karo, sirf "sab redact ho gaya" nahi.
Method: customer ke real (ya synthetic) samples pe ek labelled set banao -- har PII span ka `(start, end, entity)`. Phir per-entity **precision** (redacted mein se kitne sach mein PII) aur **recall** (PII mein se kitne pakde) nikalo (M06-14 jaisa).
Threshold sweep karo (score 0.3 se 0.9): recall vs false-positive curve dekho, aur customer ke saath trade-off sign off karo -- usually PII recall pe strict (jaise >= 0.98), FP pe thoda flexible.
Yaad rakho: span-level matching decide karo (exact vs overlap) aur report mein likho; aur har naya custom recognizer (M13-06) is eval ko CI mein dobara chalaye.

**Try this (20-40 min):** M13-05 ke redactor pe 30 labelled lines (20 PII, 10 hard negatives) banao; per-entity precision/recall aur FP rate print karo; phir Luhn validator hata ke dobara chalao aur FP ka fark note karo.

**Read:** https://github.com/microsoft/presidio-research
