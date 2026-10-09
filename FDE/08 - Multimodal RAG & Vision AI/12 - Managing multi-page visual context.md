# Multimodal RAG & Vision AI

## Managing multi-page visual context

> Extended (slow track only) | Slow CP5 only | ~1.2 h

60-page scanned contract ko poora VLM context mein daalna tempting hai -- lekin har page image tokens mein badalta hai (M08-04), to cost, latency aur context limit teeno jaldi hit hote hain, aur lambe context mein beech ke pages pe attention kamzor ho sakti hai.
Better pattern: **retrieve, then look** -- pehle text/OCR ya ColPali (M08-03) se relevant 2-5 pages dhundo, sirf unhi pages (ya M08-11 ke bbox se cropped regions) ko image/document blocks mein bhejo, har image ke saath label ("Page 14 of 60").
Cross-page cheezein dhyan se: page break pe split tables (header repeat karo), "see Annex B" references (linked page bhi fetch karo), running totals. Page-level summaries cache karo taaki har question pe poora document re-process na ho.
Production angle: provider docs mein PDF/image per-request limits aur per-page token cost check karo, repeated pages ke liye prompt caching dekho, aur har answer mein page numbers cite karo.

**Try this (20-40 min):** `select_pages(question, page_texts, budget_tokens, tokens_per_page)` likho: rank_bm25 se pages rank karo, budget mein fit hone wale top pages + unke split-table neighbours return karo. Assert karo ki budget kabhi exceed nahi hota aur split table ka doosra page saath aata hai.

**Read:** https://docs.claude.com/en/docs/build-with-claude/pdf-support
