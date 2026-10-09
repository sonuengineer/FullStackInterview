# Multimodal RAG & Vision AI

## Identifying document structures

> Core | Fast CP3 / Slow CP5 | ~1.2 h | Builds on: M06-01, M06-08

### Kahani
Ek private bank ne 400-page "Retail Lending Policy" PDF diya. Aapne `extract_text()` kiya, 500-char chunks banaye, RAG chala diya.
Credit officer ne poocha: "Car loan ka rate kya hai?" Bot ne jawab diya "ACME Bank -- Internal -- Confidential Page 37 of 400 Car 9.1%" -- header, footer aur table cell ek hi chunk mein ghus gaye.
Doosra sawaal: "Eligibility rules?" -- chunk mein aadhi list "Eligibility" heading se aur aadhi agle section "Documents required" se aayi. Answer galat, citation bhi galat.
Problem retrieval nahi tha -- problem ye tha ki aapne document ko **flat string** samjha, jabki wo heading, list, table, header/footer wala **structure** tha.

### What it is
**Document structure identification** = PDF ke raw text spans (text + position + font) se ye pehchaanna ki kaunsa span heading hai, kaunsa body, list item, table cell, ya repeated header/footer -- aur phir ek **section tree** banana (H1 -> H2 -> content).
Ye tree hi aapke chunker (M06-01) ka input banta hai: chunk boundaries sections pe, aur har chunk ke saath `section_path` metadata.

### Why it matters for an FDE
Customer PDFs ka 80% value headings aur tables mein hota hai. Structure ke bina chunks sections cross karte hain, headers har chunk ko pollute karte hain, aur metadata filter (M06-08) ke liye "section" field hi nahi hota.

### Key concepts
- **Spans with layout** -- sirf text nahi; har span ke saath `page, x, y, font size, bold`. pypdf ka `visitor_text` ye deta hai.
- **Heading heuristics** -- bada font, bold, ALL CAPS, numbering ("2.3 ") -- in signals ka combo; ek akela signal kabhi kaafi nahi.
- **Header/footer by repetition** -- page ke top/bottom band mein jo text (digits normalize karke) 60%+ pages pe repeat ho, wo boilerplate hai.
- **Table detection (cheap)** -- ek hi baseline (same y) pe 3+ alag spans = table row; real tables ke liye M08-08.
- **Section tree** -- stack-based: naya H1 aaya to stack H1 tak pop, H2 aaya to H2 tak; baaki content current node mein.

### Code example
`pip install pypdf fpdf2`

```python
# runnable
import re
import tempfile
from collections import Counter
from pathlib import Path
from fpdf import FPDF
from pypdf import PdfReader

def make_messy_pdf(path):
    pdf = FPDF()
    pdf.set_auto_page_break(False)
    pages = [("1. LENDING POLICY", "Eligibility", ["- Salaried applicants only", "- Age 21 to 60"]),
             ("2. INTEREST RATES", "Rate card", None)]
    for n, (h1, h2, items) in enumerate(pages, start=1):
        pdf.add_page()
        pdf.set_font("Helvetica", size=8)
        pdf.set_xy(10, 8); pdf.cell(0, 5, "ACME Bank -- Internal -- Confidential")  # header
        pdf.set_xy(10, 285); pdf.cell(0, 5, f"Page {n} of 2")                       # footer
        pdf.set_font("Helvetica", "B", 16); pdf.set_xy(10, 20); pdf.cell(0, 8, h1)
        pdf.set_font("Helvetica", "B", 12); pdf.set_xy(10, 34); pdf.cell(0, 6, h2)
        pdf.set_font("Helvetica", size=11); pdf.set_xy(10, 43); pdf.cell(0, 6, "Applies to all branches.")
        y = 51
        for item in items or []:
            pdf.set_xy(14, y); pdf.cell(0, 6, item); y += 7
        if items is None:                                       # a table: 3 cells per baseline
            for row in [("Product", "Rate", "Tenure"), ("Home", "8.5%", "20y"), ("Car", "9.1%", "5y")]:
                pdf.set_xy(10, y); y += 7
                for cell in row:
                    pdf.cell(40, 7, cell, border=1)
    pdf.output(str(path))

def extract_spans(path):
    spans = []
    for pno, page in enumerate(PdfReader(path).pages, start=1):
        def visit(text, cm, tm, font, size):
            if text.strip():
                bold = "Bold" in str((font or {}).get("/BaseFont", ""))
                spans.append({"page": pno, "x": round(tm[4]), "y": round(tm[5]),
                              "size": size, "bold": bold, "text": text.strip()})
        page.extract_text(visitor_text=visit)
    return spans

def drop_headers_footers(spans, n_pages, top=780, bottom=60):
    key = lambda s: re.sub(r"\d+", "#", s["text"])           # "Page 1 of 2" -> "Page # of #"
    edge = [key(s) for s in spans if s["y"] > top or s["y"] < bottom]
    repeated = {k for k, c in Counter(edge).items() if c >= max(2, 0.6 * n_pages)}
    return [s for s in spans if key(s) not in repeated], repeated

def classify(spans):
    rows = Counter((s["page"], s["y"]) for s in spans)        # many spans on one baseline = table row
    for s in spans:
        if s["size"] >= 15: s["kind"] = "h1"
        elif s["bold"] and s["size"] >= 12: s["kind"] = "h2"
        elif rows[(s["page"], s["y"])] >= 3: s["kind"] = "table_cell"
        elif re.match(r"^(-|\*|\d+\))\s", s["text"]): s["kind"] = "list_item"
        else: s["kind"] = "paragraph"
    return spans

def build_tree(spans):
    stack = [{"title": "ROOT", "level": 0, "children": [], "content": []}]
    for s in sorted(spans, key=lambda s: (s["page"], -s["y"], s["x"])):   # reading order
        if s["kind"] in ("h1", "h2"):
            level = int(s["kind"][1])
            while stack[-1]["level"] >= level:
                stack.pop()
            node = {"title": s["text"], "level": level, "page": s["page"], "children": [], "content": []}
            stack[-1]["children"].append(node); stack.append(node)
        else:
            stack[-1]["content"].append((s["kind"], s["text"]))
    return stack[0]

with tempfile.TemporaryDirectory() as tmp:
    make_messy_pdf(Path(tmp) / "policy.pdf")
    spans = extract_spans(Path(tmp) / "policy.pdf")
body, repeated = drop_headers_footers(spans, n_pages=2)
tree = build_tree(classify(body))
for h1 in tree["children"]:
    for h2 in h1["children"]:
        print(f"[p{h1['page']}] {h1['title']} > {h2['title']}: {dict(Counter(k for k, _ in h2['content']))}")
print("removed as header/footer:", sorted(repeated))

assert [h["title"] for h in tree["children"]] == ["1. LENDING POLICY", "2. INTEREST RATES"]
elig, rate = tree["children"][0]["children"][0], tree["children"][1]["children"][0]
assert "Page # of #" in repeated and not any("Confidential" in t for _, t in elig["content"])
assert [t for k, t in elig["content"] if k == "list_item"] == ["- Salaried applicants only", "- Age 21 to 60"]
assert sum(k == "table_cell" for k, _ in rate["content"]) == 9
print("OK: spans -> header/footer removed -> classified -> section tree")
```

- `make_messy_pdf` -- fpdf2 se test PDF: har page pe same header, "Page N of 2" footer, H1 16pt bold, H2 12pt bold, list, aur ek 3x3 table. Real customer PDF ki chhoti copy.
- `visit(text, cm, tm, font, size)` -- pypdf har text draw pe callback deta hai; `tm[4], tm[5]` = x, y (PDF points, **origin bottom-left**, isliye reading order mein `-y` sort).
- `drop_headers_footers` -- digits ko `#` se replace karke compare; warna "Page 1" aur "Page 2" alag dikhte aur repeat detect nahi hota.
- `classify` -- order matters: pehle font-size heading, phir table (same baseline), phir list regex, baaki paragraph.
- `build_tree` -- stack pop logic se H2 sahi H1 ke neeche jaata hai; tree hi chunker ko `section_path = "2. INTEREST RATES > Rate card"` deta hai.

```python
# real version -- not run here, needs: pip install docling   (or: pip install "unstructured[pdf]")
# Layout models detect headings/tables/lists far better than font heuristics. Check the docs for your version.
from docling.document_converter import DocumentConverter

result = DocumentConverter().convert("policy.pdf")
doc = result.document
print(doc.export_to_markdown()[:500])          # headings as #, tables as markdown tables

# unstructured alternative:
# from unstructured.partition.pdf import partition_pdf
# elements = partition_pdf("policy.pdf", strategy="hi_res")   # Title, NarrativeText, ListItem, Table, Header, Footer
# for el in elements: print(el.category, el.metadata.page_number, el.text[:60])
```

Heuristics pehle kyun? Kyunki wo free, fast aur debuggable hain -- aur jab layout model galat ho, aapko pata hona chahiye ki "heading" ka signal kya hota hai.

### Mini-exercise (30-60 min)
`omniguard/ingest/structure.py` banao (CP3 build "OmniGuard: Hybrid RAG v1 over messy PDFs" ka ingestion step).
- `extract_spans(pdf_path) -> list[Span]` (pydantic model: page, x, y, size, bold, text).
- `detect_structure(spans) -> SectionNode` -- header/footer removal + classify + tree. Thresholds (`h1_min_size`, `repeat_ratio`) config se, hardcode nahi.
- `tree_to_sections(tree) -> list[{"section_path", "page_start", "text"}]` -- ye output M06-01 ke chunker ko jaata hai.
- Acceptance (pytest): fpdf2 se 3-page fixture; header/footer kisi section mein nahi; har section ka `section_path` sahi; table cells ek `table` block mein grouped.

### Common pitfalls
- Font size ko absolute maan lena -- ek customer ka body 9pt hai, doosre ka 12pt. Har document ka **median body size** nikaalo aur heading = median se 1.3x+ bada.
- Header/footer detection sirf exact match pe -- page numbers, dates ("Printed 12/03/2024") har page pe alag hote hain; normalize karo.
- Scanned pages pe ye sab chalana -- text layer hi nahi hai, spans empty aayenge. Pehle triage (M08-10), phir OCR (M08-02).

### Checklist before moving on
- [ ] pypdf `visitor_text` se span ka x, y, font size nikaal sakta hoon.
- [ ] Repetition se header/footer hata sakta hoon, page numbers ke saath bhi.
- [ ] Span list se stack-based section tree bana sakta hoon.
- [ ] Bata sakta hoon kab heuristics kaafi hain aur kab docling/unstructured jaisa layout model chahiye.

### Related
- M06-01 Fixed-size and semantic chunking
- M06-08 Metadata filtering
- M08-02 Optical character recognition pipelines
- M08-08 Extracting nested tabular data natively
- M08-10 Ingesting unstructured legacy enterprise PDFs

### Self-quiz
1. PDF coordinates ka origin kahan hota hai, aur reading order sort karte waqt iska kya asar hai?
2. "Page 3 of 40" ko header/footer detect karne ke liye exact-match kyun fail hota hai? Aap kaise fix karoge?
3. Ek document mein headings bold nahi hain, sirf numbered ("4.2 Collateral") hain. Aapka classifier kaise badlega?
4. Section tree bina banaye seedha fixed-size chunking karne se retrieval aur citation dono kaise kharab hote hain?
