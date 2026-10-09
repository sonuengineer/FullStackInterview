# Advanced & Emerging Tech (Optional)

## AI FinOps (cost governance for LLM systems)

> Extended (slow track only) | Slow CP10 only | ~1.2 h

**AI FinOps** = LLM bill ko "surprise" se "planned number" banana. Pehla kadam **unit economics**: cost per request, per conversation, per tenant, per feature -- input + output + cached tokens x price, plus embeddings, vector DB, reranker. Iske liye har call pe tenant/feature tags ke saath token counts log karne padte hain (M14-11).
Phir **budgets aur alerts**: per-tenant monthly cap, daily spend alert, aur ek runaway agent loop (M14 ke traces) ko max-steps/max-tokens se rokna. Gateway (LiteLLM/Portkey, M14-03) yeh sab ek jagah enforce kar sakta hai.
Cost kam karne ke bade levers: **prompt caching** (M14-15), **model routing** -- easy queries chhote model pe (M14-16), output length limits, retrieval mein kam par better chunks, aur batch APIs jahan latency matter nahi karti.
FDE isse renewal meeting mein milta hai: "Pilot 50 users pe theek tha, 5000 pe bill 100x kaise?" -- aapke paas per-tenant dashboard aur forecast hona chahiye.
Ek baat yaad rakho: cost ko quality ke saath hi measure karo -- sasta model jo eval score gira de, woh savings nahi, support tickets hai.

**Try this (20-40 min):** Ek CSV banao 200 fake requests ka (tenant, feature, model, input_tokens, cached_tokens, output_tokens). Python mein per-tenant aur per-feature cost nikaalo (prices config file se, docs se current rates), ek tenant ke liye budget breach alert print karo, aur "20% traffic chhote model pe route" scenario ka savings estimate karo.

**Read:** https://www.finops.org/wg/finops-for-ai-overview/
