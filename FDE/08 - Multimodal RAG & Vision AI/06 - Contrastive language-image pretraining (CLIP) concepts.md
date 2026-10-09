# Multimodal RAG & Vision AI

## Contrastive language-image pretraining (CLIP) concepts

> Extended (slow track only) | Slow CP5 only | ~1.2 h

**CLIP** do encoders train karta hai -- ek image ke liye, ek text ke liye -- taaki dono **same vector space** mein aayein. Training: ek batch mein N image-caption pairs; sahi pair ka cosine similarity badhao, baaki (N-1) galat pairs ka ghatao (**contrastive loss**).
Result: "a photo of a damaged parcel" ka text vector aur damaged parcel ki photo ka vector paas aate hain -- isliye **text-to-image search** aur **zero-shot classification** (labels ko text prompts bana ke compare karo) bina extra training ke ho jaata hai.
FDE kahan milega: product catalog search, insurance claim photos tag karna, duplicate image detection (M08-07), aur VLMs ka vision tower (M08-04).
Limits honestly: CLIP dense document text padhne mein weak hai (ye OCR nahi hai), fine-grained domains (X-ray, circuit diagrams) mein bina fine-tune ke weak, aur web captions ke biases saath aate hain. Cosine similarity + vector index wahi hai jo M06-07 mein seekha.

**Try this (20-40 min):** Numpy mein contrastive loss khud likho: random 4x8 image aur text vectors, L2-normalize, `logits = img @ txt.T / temperature`, aur dono directions ka cross-entropy (diagonal = sahi pair). Assert karo ki aligned vectors pe loss random vectors se kam aata hai.

**Read:** https://arxiv.org/abs/2103.00020
