# Vector Search & Core RAG

## Dimensionality trade-offs

> Extended (slow track only) | Slow CP4 only | ~1.2 h

Embedding dimension (384, 768, 1536, 3072) = har chunk ke kitne floats. Zyada dims usually thodi better quality, lekin storage, RAM aur search latency seedha dim ke proportional badhte hain: 1 crore chunks x 1536 dims x 4 bytes = ~61 GB sirf raw vectors, index overhead alag.
FDE isse customer ke sizing call mein milta hai: "Hamare 50 lakh documents ke liye vector DB ka bill kitna aayega?" -- answer dim, precision (float32 vs int8/binary quantization) aur replicas se nikalta hai.
Kuch models (Matryoshka-style, jaise OpenAI text-embedding-3 ka `dimensions` param) aapko vector chhota karne dete hain with small quality loss -- lekin har model ye support nahi karta, docs check karo.
Ek baat yaad rakho: dim choose karne se pehle apne eval set pe recall@k measure karo; aksar 384-dim local model + reranker, 3072-dim model se sasta aur almost utna hi accha nikalta hai.

**Try this (20-40 min):** numpy mein 100k random unit vectors banao 384, 768, 1536 dims pe; har ke liye memory (`arr.nbytes`) aur ek brute-force `M @ q` ka time measure karo, phir float16 aur int8 pe repeat karo. Ek table banao: dims vs MB vs ms.

**Read:** https://www.sbert.net/examples/sentence_transformer/training/matryoshka/README.html
