# Production AI Security & Guardrails

## Testing rails against jailbreak libraries

> Extended (slow track only) | Slow CP8 only | ~1.2 h

Apne 15 jailbreak prompts (M13-03) se shuru karna theek hai, par attackers ke paas hazaron variants hain. Open-source red-team tools ye kaam automate karte hain, jaise **garak** (NVIDIA ka LLM vulnerability scanner -- injection, jailbreak, leakage probes) aur **promptfoo** (config-driven evals, ek red-team mode ke saath jo attack prompts generate karta hai).
Flow: tool aapke endpoint (ya local wrapper) ko probes bhejta hai, responses score karta hai, aur report deta hai kaunsi category mein rails fail hue. Fail hue probes ko fixtures bana ke regression suite mein daalo.
FDE angle: CISO ko "humne test kiya" ki jagah report dikhao: kitne probes, kitne blocked, kya fix kiya. Har release pe re-run -- model ya prompt badla to rails ka behaviour bhi badal sakta hai.
Yaad rakho: sirf staging endpoint pe, customer ki permission ke saath chalao, aur API cost budget set karo -- red-team runs hazaron calls kar sakte hain.

**Try this (20-40 min):** promptfoo ya garak ke docs se 20 jailbreak/injection probe ideas lo, `tests/fixtures/redteam.txt` mein daalo, aur M13-03 + M13-10 pipeline ke against block rate measure karo (FakeLLM ke saath, bina API key ke).

**Read:** https://github.com/NVIDIA/garak
