# Production AI Security & Guardrails

## Writing programmable conversational rails using Colang

> Extended (slow track only) | Slow CP8 only | ~1.2 h

**NeMo Guardrails** (NVIDIA, open source) aapke LLM ke aage ek rails layer lagata hai. Config folder mein `config.yml` (model, enabled input/output rails jaise self-check input, jailbreak detection) aur `.co` files hoti hain jo **Colang** mein likhi jaati hain.
Colang mein aap **user intents** (example utterances), **bot messages** (fixed responses) aur **flows** (intent -> response/action) define karte ho. Ye wahi idea hai jo M13-11 mein haath se banaya -- topic classifier + template refusal -- par declarative.
FDE angle: OmniGuard (M15-08) mein NeMo topical + jailbreak rails, Presidio PII ke saath. Colang 1.0 aur 2.x ka syntax kaafi alag hai -- check the docs for your version before copying examples (neeche 1.0 style).

```colang
define user ask about politics
  "who will win the election?"

define bot refuse politics
  "I can only help with policy and claims questions."

define flow politics
  user ask about politics
  bot refuse politics
```

**Try this (20-40 min):** Ek `config/` folder banao (`config.yml` + `rails.co`) jisme upar wala politics flow aur ek "investment advice" flow ho; `pip install nemoguardrails` karke local chalao (LLM key chahiye), ya bina key ke sirf files likh ke docs ke examples se compare karo.

**Read:** https://github.com/NVIDIA/NeMo-Guardrails
