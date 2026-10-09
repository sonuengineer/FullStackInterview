# AI Observability & Gateway Management

## Debugging multi-step agent reasoning and tool inputs

> Extended (slow track only) | Slow CP10 only | ~1.2 h

Multi-step agent ka bug aksar final answer mein nahi, beech ke kisi step mein hota hai: galat tool choose kiya, tool ko galat argument diya (date format, wrong customer id), ya tool error ko ignore karke aage badh gaya.
Debug ka tareeka: M14-10 ka span tree kholo, har LLM span ke baad wala tool span dekho -- **tool input exactly kya tha** (validated args, M05-12) aur **tool output kya wapas gaya** model ko. Zyaadatar bugs input/output ke mismatch mein milte hain.
FDE ko ye customer escalation pe milta hai: "agent ne galat account pe ticket bana diya." Trace replay karo -- same inputs, fixed seed/FakeLLM -- aur failing step ko ek regression test bana do.
Tool args ko trace mein store karna hai to redacted form mein (ids haan, PII nahi -- M13-14), aur debug access role-restricted rakho.
Yaad rakho: **pehle step-level evidence (span + tool I/O), phir hypothesis** -- prompt badalna last option hai, pehla nahi.

**Try this (20-40 min):** M14-10 ke tracer mein tool spans pe `tool.args_hash` aur redacted `tool.args` attribute add karo. Ek fake agent run banao jisme step 2 galat date format bhejta hai; trace print karke bug locate karo aur uska pytest regression likho.

**Read:** https://opentelemetry.io/docs/concepts/signals/traces/
