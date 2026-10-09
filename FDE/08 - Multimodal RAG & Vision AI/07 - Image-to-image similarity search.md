# Multimodal RAG & Vision AI

## Image-to-image similarity search

> Extended (slow track only) | Slow CP5 only | ~1.2 h

**Image-to-image search** = query ek image hai ("is damaged parcel photo jaisi purani claims dikhao"), text nahi. Pipeline wahi RAG wali: har image ka embedding (CLIP image encoder ya koi vision model) -> vector index (M06-06) -> query image ka embedding -> top-k by cosine (M06-07).
FDE use cases: duplicate/fraud claim photos, product "find similar", aur near-duplicate scanned pages dedupe karna (M08-10 ingestion mein bahut kaam aata hai).
Exact ya near-exact duplicates ke liye embeddings overkill hain -- **perceptual hash** (pHash/dHash) sasta aur fast hai; embeddings "semantically similar" ke liye hain (alag angle, same object).
Production angle: images ko same size/format mein normalize karo, embedding model version metadata mein rakho (model badla = re-index), aur similarity threshold customer ke labelled examples se tune karo -- "0.8" koi magic number nahi.

**Try this (20-40 min):** Pillow + numpy se `dhash(img)` likho (9x8 grayscale resize, adjacent pixels compare, 64-bit hash) aur Hamming distance. 5 test images banao (original, resized, thoda brighter, do bilkul alag) aur assert karo ki near-duplicates ka distance chhota aur alag images ka bada hai.

**Read:** https://github.com/facebookresearch/faiss/wiki
