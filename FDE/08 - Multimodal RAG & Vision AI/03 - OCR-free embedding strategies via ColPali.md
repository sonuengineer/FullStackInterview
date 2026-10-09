# Multimodal RAG & Vision AI

## OCR-free embedding strategies via ColPali

> Extended (slow track only) | Slow CP5 only | ~1.2 h

**ColPali** ek retrieval model hai jo page ko text mein convert hi nahi karta: page ki **image** ko ek vision-language model (PaliGemma base) se patches mein todta hai aur har patch ka ek vector banata hai -- yaani ek page = ~1,000 chhote vectors (multi-vector), ek nahi.
Query ke har token ka vector har patch se compare hota hai aur **late interaction (MaxSim, ColBERT style)** se score banta hai. Fayda: charts, tables, stamps, layout -- jo OCR + text RAG mein kho jaata hai -- seedha retrieve hota hai, aur OCR pipeline (M08-02) ki galtiyan beech mein nahi aati.
FDE ise kab milega: visual-heavy docs (brochures, slide decks, infographics, scanned forms) jahan text RAG ka recall low hai.
Cost honestly samjho: GPU inference chahiye, har page ke ~1,000 vectors = storage aur search heavy (multi-vector index support chahiye), aur answer generate karne ke liye phir bhi page image VLM ko dena padta hai. Clean text-heavy PDFs pe extract/OCR + text RAG usually sasta aur kaafi hai.
Yaad rakho: ColPali **retrieval** step hai, answer engine nahi -- pehle baseline (text RAG) ka recall measure karo, phir decide karo.

**Try this (20-40 min):** 10 pages choose karo (5 text-heavy, 5 chart/table-heavy) aur 10 questions likho. Text RAG (M06-10) ka recall@3 note karo, aur ek table banao: kaunse questions visual layout ki wajah se fail hue -- ye aapka "ColPali worth it?" evidence hai.

**Read:** https://arxiv.org/abs/2407.01449
