# AI Observability & Gateway Management

## Exporting trace data for continuous model improvement

> Extended (slow track only) | Slow CP10 only | ~1.2 h

Production traces sona hain: real user questions, failures, low judge scores, thumbs-down. Inhe export karke aap **eval datasets** (M14-08 ke saath), regression tests aur kabhi-kabhi fine-tuning/prompt-improvement data banate ho.
Flow: filter (errors, low score, negative feedback) -> PII redaction (M13-04..07) -> dedupe -> human review/label -> versioned dataset (JSONL) -> agle deploy ka eval (M14-09).
FDE ke liye sabse bada sawaal consent aur contract hai: customer ka data training/eval ke liye use karne ki permission DPA/contract mein hai ya nahi -- pehle legal, phir code.
Export hamesha redacted, retention ke saath, aur dataset ke saath source trace ids rakho taaki koi bhi example audit ho sake.
Yaad rakho: **trace -> redacted, reviewed, versioned example** -- raw traces ko seedha dataset mat banao.

**Try this (20-40 min):** M14-10 ke `traces/*.jsonl` se ek script likho jo ERROR status ya low score waale LLM spans chune, email/phone regex se redact kare, duplicates hataye aur `evals/from_prod_v1.jsonl` likhe (har line mein `source_trace_id`).

**Read:** https://opentelemetry.io/docs/specs/semconv/gen-ai/
