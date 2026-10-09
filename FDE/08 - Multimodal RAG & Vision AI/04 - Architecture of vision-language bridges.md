# Multimodal RAG & Vision AI

## Architecture of vision-language bridges

> Extended (slow track only) | Slow CP5 only | ~1.2 h

**Vision-language model (VLM)** ke andar teen hisse hote hain: ek **vision encoder** (aksar ViT, jaise CLIP ka image tower -- M08-06) jo image ko patch embeddings mein badalta hai, ek **bridge / projector** jo un embeddings ko LLM ke token-embedding space mein map karta hai, aur ek **LLM** jo un "image tokens" ko text tokens ke saath padhta hai.
Bridge simple ho sakta hai (LLaVA: ek chhota MLP projector) ya smart (BLIP-2 ka Q-Former: fixed number of learned queries jo image se zaroori info khinchte hain, taaki tokens kam rahein).
FDE ke liye practical matlab: image bhi **tokens** ban jaati hai -- badi/zyada images = zyada cost aur latency, aur resolution limit hoti hai (chhota text blur ho sakta hai, isliye crop karna kaam aata hai).
VLM "dekhta" nahi, patches ka compressed summary padhta hai -- isliye tiny numbers, dense tables aur exact counting mein galti kar sakta hai; critical numbers ke liye OCR/text cross-check rakho.

**Try this (20-40 min):** Ek A4 page ko 3 resolutions (full, 50%, 25%) pe map karo: provider docs ka image-token formula use karke har resolution ke tokens aur cost estimate karo, aur likho ki kis resolution pe 8pt footnote padhna mushkil hoga.

**Read:** https://arxiv.org/abs/2304.08485
