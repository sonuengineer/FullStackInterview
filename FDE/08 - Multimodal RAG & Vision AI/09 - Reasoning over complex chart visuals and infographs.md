# Multimodal RAG & Vision AI

## Reasoning over complex chart visuals and infographs

> Extended (slow track only) | Slow CP5 only | ~1.2 h

Annual reports aur investor decks mein asli jawab aksar **charts** mein hota hai: "2022 mein kis region ka revenue gira?" Text extraction se sirf axis labels milte hain, bars/lines nahi -- text RAG yahan andha hai.
Do common approaches: (1) chart image seedha VLM ko do aur sawaal poocho (M08-05); (2) pehle chart ko **data table** mein convert karo (chart-to-table, DePlot jaisa idea) aur phir reasoning us table pe karo -- ye zyada auditable hai.
Limits honestly: VLMs trend aur comparison achha padhte hain, lekin exact values (bar height se 23.7 vs 24.1), log scales, dual axes, stacked charts aur chhote legends mein galti karte hain. Agar chart ka source data (Excel, appendix table) mil sakta hai to wahi best source hai.
FDE rule: chart-based answers mein "approximately" language aur page citation (M08-11) do, aur critical numbers ke liye human check ya source data maango.

**Try this (20-40 min):** Ek bar chart ka ground-truth table likho (5 bars) aur 8 questions banao: 4 trend/compare type, 4 exact-value type. Scoring function likho jo exact-value answers ko +-5% tolerance se grade kare -- ye aapka future VLM chart eval harness hai.

**Read:** https://arxiv.org/abs/2212.10505
