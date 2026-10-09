# Multimodal RAG & Vision AI

## Aligning bounding boxes with text chunks

> Core | Fast CP3 / Slow CP5 | ~1.2 h | Builds on: M08-01, M08-02, M08-10, M06-01

### Kahani
Ek hospital ki compliance team RAG bot use kar rahi hai: "Discharge summary mein allergy kya likhi hai?" Bot jawab deta hai: "Penicillin -- source: discharge_2023.pdf".
Doctor bolti hai: "38 pages hain, kahan likha hai? Main AI pe bina dekhe bharosa nahi karungi." Auditor bhi yahi poochta hai.
Aapke chunks mein sirf `text` aur `filename` tha -- page number tak nahi. Chunking (M06-01) ne text ko kaat diya, aur position ki information wahin kho gayi.
Customer ko chahiye: "page 3, ye wala region" -- click karo aur PDF us jagah highlight ho. Ye feature trust ka feature hai.

### What it is
**Bbox-aligned chunking** = har chunk ke saath `page` + **bounding box** (`x0, y0, x1, y1`) store karna, jo uske saare words ko cover kare. Words -> lines -> blocks -> chunks, har level pe box = children ka **union**.
Phir answer ka citation "page 1, region (43, 102, 171, 126)" ban jaata hai, aur UI wahi rectangle PDF pe highlight kar sakta hai.

### Why it matters for an FDE
Regulated customers (bank, hospital, legal) ke liye "source: file.pdf" citation nahi hai. Page + region ke bina answer verify nahi hota, aur unverifiable answer production mein approve nahi hota.

### Key concepts
- **Coordinate systems** -- PDF origin bottom-left (points, 1/72 inch); images/OCR origin top-left (pixels). Ek convention choose karo (top-left) aur ingest pe hi convert karo.
- **Union box** -- parent box = `(min x0, min y0, max x1, max y1)` of children; containment hamesha true honi chahiye.
- **IoU** (intersection over union) -- do boxes ka overlap 0-1; alag chunks ka IoU ~0, aur extracted box vs ground truth ka IoU high = alignment sahi.
- **Normalized bbox** -- `value / page_size` (0-1) store karo; 72 DPI PDF aur 300 DPI OCR image dono pe same box kaam kare.
- **Chunk splitting keeps words** -- jab M06 chunker block ko todta hai, har piece ke words saath jaayein taaki uska apna union box ban sake.

### Code example
`pip install pypdf fpdf2`

```python
# runnable
import tempfile
from pathlib import Path
from fpdf import FPDF
from pypdf import PdfReader

def make_pdf(path):
    pdf = FPDF(unit="pt", format="A4"); pdf.set_auto_page_break(False); pdf.add_page()
    pdf.set_font("Helvetica", size=10)
    lines = [(40, 100, "Payment terms: invoices are"), (40, 114, "payable within net 45 days."),
             (40, 200, "Termination requires 90"), (40, 214, "days written notice."),
             (320, 100, "Penalty: 2% per month"), (320, 114, "on overdue amounts.")]   # 2nd column
    for x, y, text in lines:
        pdf.set_xy(x, y); pdf.cell(0, 12, text)
    pdf.output(str(path))

def pdf_words(path):
    """Word boxes from the text layer, converted to TOP-LEFT origin. Width is approximated
    (Helvetica ~0.5 em per char); pdfplumber/PyMuPDF give exact glyph boxes."""
    words = []
    for pno, page in enumerate(PdfReader(path).pages, start=1):
        H = float(page.mediabox.height)
        def visit(text, cm, tm, font, size):
            x = tm[4]
            for w in text.split():
                x1 = x + 0.5 * size * len(w)
                words.append({"page": pno, "text": w, "bbox": (x, H - tm[5] - 0.75 * size, x1, H - tm[5] + 0.25 * size)})
                x = x1 + 0.28 * size                                  # one space
        page.extract_text(visitor_text=visit)
    return words, H

def union(boxes):
    return (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))

def iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0])); iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    area = lambda r: (r[2] - r[0]) * (r[3] - r[1])
    return ix * iy / (area(a) + area(b) - ix * iy)

def contains(outer, inner, tol=0.5):
    return outer[0] - tol <= inner[0] and outer[1] - tol <= inner[1] and inner[2] <= outer[2] + tol and inner[3] <= outer[3] + tol

def group(items, same):
    groups = []
    for it in items:
        for g in groups:
            if same(g[-1], it): g.append(it); break
        else: groups.append([it])
    return groups

def to_chunks(words, page_h):
    words = sorted(words, key=lambda w: (w["page"], w["bbox"][1], w["bbox"][0]))
    lines = group(words, lambda a, b: a["page"] == b["page"] and abs(a["bbox"][1] - b["bbox"][1]) < 3
                  and b["bbox"][0] - a["bbox"][2] < 20)                       # same baseline, small x gap
    lines = [{"page": l[0]["page"], "text": " ".join(w["text"] for w in l), "bbox": union([w["bbox"] for w in l]),
              "words": l} for l in lines]
    blocks = group(sorted(lines, key=lambda l: (l["page"], l["bbox"][0] > 300, l["bbox"][1])),   # col split ~mid-page
                   lambda a, b: a["page"] == b["page"] and 0 <= b["bbox"][1] - a["bbox"][3] < 8
                   and abs(a["bbox"][0] - b["bbox"][0]) < 5)                  # next line, same left edge
    return [{"page": b[0]["page"], "text": " ".join(l["text"] for l in b), "bbox": union([l["bbox"] for l in b]),
             "bbox_norm": tuple(round(v / page_h, 4) for v in union([l["bbox"] for l in b])),
             "words": [w for l in b for w in l["words"]]} for b in blocks]

with tempfile.TemporaryDirectory() as tmp:
    make_pdf(Path(tmp) / "contract.pdf")
    words, H = pdf_words(Path(tmp) / "contract.pdf")
chunks = to_chunks(words, H)
for c in chunks:
    print(f"p{c['page']} {tuple(round(v) for v in c['bbox'])}: {c['text']}")

hit = next(c for c in chunks if "net 45 days" in c["text"])
print(f"citation: page {hit['page']}, region {tuple(round(v) for v in hit['bbox'])}")
assert len(chunks) == 3 and hit["text"] == "Payment terms: invoices are payable within net 45 days."
assert all(contains(c["bbox"], w["bbox"]) for c in chunks for w in c["words"])   # chunk box covers its words
assert all(iou(a["bbox"], b["bbox"]) == 0 for i, a in enumerate(chunks) for b in chunks[i + 1:])
truth = (40, 100, 180, 127)                                     # where we drew it (fpdf: top-left, pt)
assert iou(hit["bbox"], truth) > 0.6, iou(hit["bbox"], truth)
print("OK: words -> lines -> blocks -> chunks with page + bbox, IoU", round(iou(hit["bbox"], truth), 2))
```

- `pdf_words` -- pypdf ka `tm` baseline position deta hai (bottom-left origin); `H - y` se top-left mein convert. Width approximation hai (comment dekho) -- isliye IoU check 0.6 pe, 1.0 pe nahi.
- OCR words (M08-02) ka shape bhi `{"page", "text", "bbox"}` hai -- scanned pages ke liye same `to_chunks` chalta hai, bas coords pixels mein (normalize karo).
- `group(..., same)` -- greedy grouping: line = same baseline + chhota x gap (isliye 2nd column alag line rehta hai); block = next line, same left edge, chhota vertical gap.
- Column sort (`x0 > 300`) -- left column pehle, phir right; bina iske "Payment" aur "Penalty" lines interleave ho jaati.
- Asserts -- containment (chunk box apne har word ko cover kare), alag chunks overlap na karein (IoU 0), aur ground-truth region se IoU > 0.6.

```python
# real version -- not run here, needs: pip install pymupdf   (or: pip install pdfplumber)
# Exact glyph boxes instead of the width approximation. Check the docs for your version.
import fitz  # PyMuPDF

doc = fitz.open("contract.pdf")
for pno, page in enumerate(doc, start=1):
    for x0, y0, x1, y1, word, block_no, line_no, word_no in page.get_text("words"):   # top-left origin
        ...  # same {"page", "text", "bbox"} dicts -> to_chunks()
    # highlight a cited region for the UI / audit export
    page.add_highlight_annot(fitz.Rect(43, 102, 171, 126))
doc.save("contract.cited.pdf")

# pdfplumber: page.extract_words() -> [{"text", "x0", "top", "x1", "bottom"}, ...]
```

### Mini-exercise (30-60 min)
`omniguard/ingest/chunks.py` -- OmniGuard CP3 ingestion ka last step: pdf -> pages -> sections -> **chunks with page + bbox**.
- `Chunk` pydantic model: `doc_sha, page, section_path, text, bbox, bbox_norm, chunk_id`. `chunk_id = sha256(doc_sha + page + bbox)` -- re-run pe stable (M08-10 idempotency).
- Bada block M06-01 chunker se split karo, lekin words list saath le jaao; har split ka apna union box.
- Answer ke citation format: `{"file", "page", "bbox_norm"}`; ek chhota script jo PyMuPDF (agar installed) se cited region highlight karke PDF save kare.
- Acceptance (pytest): fixture PDF pe containment + no-overlap + IoU > 0.6 asserts; OCR stub words aur pypdf words dono se chunks bante hain; same input pe chunk_ids identical.

### Common pitfalls
- Coordinate systems mix karna -- pypdf bottom-left, OCR top-left, UI CSS pixels; ek bhi conversion bhoola to highlight ulta (page ke neeche) dikhega. Conversion ek jagah, tests ke saath.
- Rotated pages (M08-10) pe box rotate na karna -- `/Rotate 90` page pe x/y swap hote hain; highlight galat jagah.
- Chunk overlap (M06-02) se ek word do chunks mein -- theek hai, lekin citation box usi chunk ke words se banao, neighbour se nahi.

### Checklist before moving on
- [ ] PDF bottom-left coords ko top-left mein convert kar sakta hoon aur normalize kar sakta hoon.
- [ ] Words -> lines -> blocks merge karke union bbox bana sakta hoon.
- [ ] IoU aur containment khud likh ke test kar sakta hoon.
- [ ] Har chunk ke paas page + bbox hai, aur answer "page N, region" cite karta hai.

### Related
- M06-01 Fixed-size and semantic chunking
- M06-02 Overlap optimization
- M08-02 Optical character recognition pipelines
- M08-10 Ingesting unstructured legacy enterprise PDFs
- M08-12 Managing multi-page visual context

### Self-quiz
1. PDF mein y = 742 aur page height 842 hai. Top-left system mein y kya hoga, aur kyun?
2. Do chunks ka IoU 0.4 aa raha hai. Ye kya bataata hai aapke line/block grouping ke baare mein?
3. Normalized bbox store karna pixels/points store karne se better kyun hai jab OCR 300 DPI pe chala tha?
4. Ek table cell ka answer cite karna hai, lekin poora table ek chunk hai. Region citation kaise precise banaoge?
