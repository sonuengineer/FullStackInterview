# Multimodal RAG & Vision AI

## Extracting nested tabular data natively

> Extended (slow track only) | Slow CP5 only | ~1.2 h

Enterprise PDFs ke tables simple grid nahi hote: **merged header cells** ("Q1" ke neeche "Jan Feb Mar"), row groups ("Retail > Home loan > Fixed"), multi-line cells, aur page break pe split table jiska header agle page pe repeat hota hai. Plain text extraction ise kachra bana deta hai, aur M08-01 ka "same baseline = row" heuristic nested headers nahi samajhta.
"Natively" extract karne ka matlab: table ko **structure ke saath** nikaalna -- cells, row/col span, header hierarchy -- aur JSON/HTML/markdown mein store karna. Options: layout/table models (docling ka TableFormer, Azure Document Intelligence layout, AWS Textract tables) ya page image VLM ko de ke JSON schema maangna (M08-05).
RAG ke liye: har row ko **full header path** ke saath flatten karo ("Retail > Home loan > Fixed | Q1 Jan | 8.5%") taaki chunk akela bhi meaningful ho; original table HTML + page/bbox (M08-11) bhi rakho.
Numbers critical hain -- model output ko row totals ya cross-sums se validate karo.

**Try this (20-40 min):** Ek nested table HTML mein haath se likho (`rowspan`/`colspan` ke saath), lxml se parse karo, aur function banao jo har data cell ko `(row_header_path, col_header_path, value)` mein flatten kare. Assert karo ki merged header har child column pe propagate hua.

**Read:** https://docling-project.github.io/docling/
