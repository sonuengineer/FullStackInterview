# Advanced & Emerging Tech (Optional)

## AI red teaming and adversarial testing frameworks

> Extended (slow track only) | Slow CP10 only | ~1.2 h

**AI red teaming** = launch se pehle jaan-boojh ke apne LLM app ko todna: prompt injection (M13-02), jailbreaks, system prompt leak, PII leak, harmful/off-topic output, tool misuse (agent ne galat API call kar di), aur RAG documents ke andar chhupe indirect injection.
Manual testing se shuru karo, phir automate: **promptfoo** (YAML config se red-team test suites, CI mein chalta hai), **garak** (NVIDIA ka LLM vulnerability scanner, probes ka bada set), **PyRIT** (Microsoft ka Python framework, multi-turn attack orchestration). Teeno ke features tezi se badalte hain -- check the docs.
FDE angle: regulated customer (bank, hospital) ka security team launch se pehle evidence maangta hai -- "kaunse attacks try kiye, kitne pass/fail, kya fix kiya". M13-13 ka jailbreak-library testing isi ka chhota version hai; yahan usse repeatable pipeline banate hain jo har prompt/model change pe chale.
Ek baat yaad rakho: red teaming ek baar ka audit nahi, regression test hai -- har naya model, prompt ya tool aane pe suite dobara chalao, aur failures ko permanent test cases bana do.

**Try this (20-40 min):** Apne kisi M13 guardrails project ke liye 25 adversarial prompts ki ek YAML/JSONL list banao (5 categories x 5: injection, jailbreak, PII extraction, off-topic, tool misuse). FakeLLM ya local app ke against chalao, pass/fail table banao, aur promptfoo red-team docs padhke likho ki yahi suite usme kaise express hogi (koi real API key use mat karo).

**Read:** https://www.promptfoo.dev/docs/red-team/
