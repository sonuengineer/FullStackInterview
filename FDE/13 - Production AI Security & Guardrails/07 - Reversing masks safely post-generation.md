# Production AI Security & Guardrails

## Reversing masks safely post-generation

> Extended (slow track only) | Slow CP8 only | ~1.2 h

Kabhi user ko answer mein asli value chahiye: "Ravi Kumar ko email draft karo". Pattern: LLM se pehle `Ravi Kumar` -> `<PERSON_1>`, mapping ek **per-request vault** mein (memory ya short-TTL encrypted store), LLM sirf placeholders dekhta hai, aur response aane ke baad placeholders wapas asli values se replace (de-anonymize).
Safety rules: mapping kabhi log ya prompt mein nahi; sirf usi request/user ke liye restore jisne original value di thi (authz check); request khatam = vault delete.
Model placeholders bigaad sakta hai (`<PERSON 1>`, `PERSON_1`, naya `<PERSON_3>` invent) -- strict regex se sirf known placeholders restore karo, unknown ko as-is chhod ke flag karo.
Yaad rakho: de-anonymization output pipeline ka **last** step hai, PII leak check (M13-10) ke baad -- warna leak check apne hi restore kiye hue PII pe fire karega.

**Try this (20-40 min):** `Vault` class likho: `mask(text) -> (masked, mapping)` aur `unmask(text, mapping)`; FakeLLM response mein ek mangled aur ek invented placeholder daalo, aur assert karo ki sirf valid wale restore hue aur mapping log file mein nahi gayi.

**Read:** https://microsoft.github.io/presidio/anonymizer/
