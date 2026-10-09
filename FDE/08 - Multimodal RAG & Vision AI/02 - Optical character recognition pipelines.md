# Multimodal RAG & Vision AI

## Optical character recognition pipelines

> Core | Fast CP3 / Slow CP5 | ~1.2 h | Builds on: M08-01

### Kahani
Ek insurance company ke 12,000 claim files ingest karne the. Aapka pipeline (M08-01) chala -- aur 40% documents ke liye "0 sections found". Kyun? Wo scanner se aaye the: PDF ke andar sirf ek image, **text layer hi nahi**.
Junior engineer ne "sab pe OCR chala do" kar diya -- ab digital PDFs bhi OCR ho rahe the (5x slow, aur perfect text ki jagah "1O,5OO" jaisi galtiyan).
Ops team ne poocha: "Claim amount galat kyun aa raha hai?" OCR ne 0 ko O padha tha, aur kisi ne confidence check nahi kiya tha.
Aapko chahiye ek **pipeline**, single function call nahi: kab OCR karna hai, kaise image saaf karni hai, aur kab result pe bharosa nahi karna.

### What it is
**OCR pipeline** = scanned page (image) se text + word positions nikaalne ke stages: **route** (text layer hai? to extract, warna OCR) -> **render** (page -> image, ~300 DPI) -> **preprocess** (grayscale, deskew, denoise, threshold) -> **OCR** (words + bbox + confidence) -> **confidence filter** -> **reading order / layout** -> **post-correction**.
Har stage alag function, alag metric -- taaki pata chale quality kahan gir rahi hai.

### Why it matters for an FDE
Enterprise data ka bada hissa scanned hai (fax, stamps, signatures, purane archives). Bina routing ke aap ya to scans miss karte ho ya digital pages ko bigaadte ho; bina confidence ke galat numbers chupchaap RAG answer mein chale jaate hain.

### Key concepts
- **Route first** -- `extract_text()` ka output chhota + page pe image = OCR. Digital page ko kabhi OCR mat karo.
- **Preprocess** -- grayscale -> **deskew** (tilted scan seedha) -> denoise -> **threshold** (Otsu: ink vs paper ka best cut). Accuracy ka bada hissa yahin se aata hai.
- **Confidence** -- har word ka 0-100 score; low-conf words drop/flag, page mean conf low ho to human review queue.
- **Reading order** -- OCR words ko columns/lines mein sort karna; 2-column page ko left-to-right padhoge to sentences mix ho jaayenge.
- **Post-correction** -- domain rules: numeric tokens mein O->0, l->1; dictionary/regex checks (policy ids, dates). LLM se correction possible hai lekin numbers pe dangerous.

### Code example
`pip install pypdf fpdf2 numpy`  (Pillow comes with fpdf2)

```python
# runnable
import re
import tempfile
from pathlib import Path
import numpy as np
from fpdf import FPDF
from PIL import Image          # Pillow ships as an fpdf2 dependency
from pypdf import PdfReader

def make_pdf(path):
    pdf = FPDF()
    pdf.add_page(); pdf.set_font("Helvetica", size=11)
    pdf.cell(0, 8, "Claim form v2 -- digital page with a real text layer.")
    pdf.add_page()                                    # page 2: a "scan" = image only, no text layer
    rng = np.random.default_rng(0)
    scan = np.full((200, 400), 200, np.uint8) + rng.integers(0, 40, (200, 400), dtype=np.uint8)
    scan[60:70, 30:370] = 20                          # dark "ink" strokes
    pdf.image(Image.fromarray(scan), x=10, y=10, w=190)
    pdf.output(str(path))

def needs_ocr(page, min_chars=20):
    return len((page.extract_text() or "").strip()) < min_chars and len(page.images) > 0

def preprocess(gray):
    """Otsu threshold: pick the cut that best separates ink from paper. (Deskew/denoise: see real version.)"""
    hist = np.bincount(gray.ravel(), minlength=256).astype(float)
    best_t, best_var, levels = 0, -1.0, np.arange(256)
    for t in range(1, 256):
        w0, w1 = hist[:t].sum(), hist[t:].sum()
        if w0 == 0 or w1 == 0: continue
        m0 = (hist[:t] * levels[:t]).sum() / w0; m1 = (hist[t:] * levels[t:]).sum() / w1
        if w0 * w1 * (m0 - m1) ** 2 > best_var: best_t, best_var = t, w0 * w1 * (m0 - m1) ** 2
    return (gray >= best_t).astype(np.uint8) * 255, best_t

def fake_ocr(binary):
    """STUB with the shape of pytesseract.image_to_data(..., output_type=DICT): words, boxes (x0,y0,x1,y1), conf."""
    words = [("Claim", 30, 20, 80, 32, 96), ("total:", 85, 20, 130, 32, 93), ("1O,5OO", 135, 20, 190, 32, 71),
             ("Approved", 220, 20, 290, 32, 95), ("by", 295, 20, 312, 32, 97), ("RK", 316, 20, 338, 32, 90),
             ("Policy", 30, 40, 80, 52, 94), ("P-2O19", 85, 40, 140, 52, 88), ("~#@", 150, 40, 170, 52, 21),
             ("Stamp", 220, 40, 270, 52, 92)]
    return [dict(text=t, bbox=(a, b, c, d), conf=k) for t, a, b, c, d, k in words]

def reading_order(words, page_width):
    mid = page_width / 2                              # naive 2-column split; real layout models do better
    col = lambda w: 0 if w["bbox"][0] < mid else 1
    return sorted(words, key=lambda w: (col(w), round(w["bbox"][1] / 10), w["bbox"][0]))

def post_correct(token):
    digits = sum(ch.isdigit() for ch in token)
    if digits >= 2 and digits >= len(token) / 3:      # mostly numeric -> fix classic OCR swaps
        return token.translate(str.maketrans({"O": "0", "o": "0", "l": "1", "I": "1"}))
    return token

def ocr_page(page, min_conf=60):
    gray = np.array(page.images[0].image.convert("L"))
    binary, _ = preprocess(gray)
    raw = fake_ocr(binary)
    words = [w for w in raw if w["conf"] >= min_conf]        # low-confidence junk out
    ordered = reading_order(words, page_width=binary.shape[1])
    text = " ".join(post_correct(w["text"]) for w in ordered)
    mean_conf = sum(w["conf"] for w in words) / len(words)
    return {"text": text, "ink_ratio": round(float((binary == 0).mean()), 3), "dropped": len(raw) - len(words),
            "mean_conf": round(mean_conf, 1), "review": mean_conf < 80}

with tempfile.TemporaryDirectory() as tmp:
    make_pdf(Path(tmp) / "claim.pdf")
    pages = PdfReader(Path(tmp) / "claim.pdf").pages
    routes = ["ocr" if needs_ocr(p) else "extract" for p in pages]
    result = ocr_page(pages[1])

print("routes:", routes)
print("ocr:", result)
assert routes == ["extract", "ocr"]
assert 0.03 < result["ink_ratio"] < 0.06 and result["dropped"] == 1    # ink = 340x10 px of 400x200
assert result["text"] == "Claim total: 10,500 Policy P-2019 Approved by RK Stamp"
assert result["review"] is False
print("OK: route -> preprocess -> OCR -> conf filter -> reading order -> post-correct")
```

- `needs_ocr` -- routing rule: text layer almost empty **aur** page pe image hai. Blank page ko OCR karna paisa waste hai.
- `preprocess` -- Otsu threshold numpy mein: har possible cut `t` ke liye ink/paper groups ka between-class variance; max wala cut. Real life mein OpenCV ek line mein karta hai.
- `fake_ocr` -- **stub**: `pytesseract.image_to_data` jaisa shape (text, box, conf). Isme jaan-boojh ke "1O,5OO" aur ek junk word (conf 21) daala hai.
- `reading_order` -- pehle column, phir line (`y // 10` bucket), phir x. "Approved by RK" right column mein tha, isliye left column ke baad aata hai.
- `post_correct` -- sirf mostly-numeric tokens pe O->0 fix; "Policy" jaise normal word ko nahi chhuta.
- `review` flag -- page mean conf < 80 to human queue; threshold customer ke saath tune karo.

```python
# real version -- not run here, needs: pip install pypdfium2 opencv-python pytesseract  (+ Tesseract binary installed)
# Check the docs for your version; flags/DPI below are common starting points, not rules.
import cv2, numpy as np, pypdfium2 as pdfium, pytesseract

page = pdfium.PdfDocument("claim.pdf")[1]
img = np.array(page.render(scale=300 / 72).to_pil().convert("L"))        # render at ~300 DPI
img = cv2.fastNlMeansDenoising(img, h=15)
_, binary = cv2.threshold(img, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
data = pytesseract.image_to_data(binary, lang="eng", config="--psm 3",
                                 output_type=pytesseract.Output.DICT)
words = [dict(text=t, bbox=(l, tp, l + w, tp + h), conf=float(c))
         for t, l, tp, w, h, c in zip(data["text"], data["left"], data["top"],
                                      data["width"], data["height"], data["conf"]) if t.strip()]

# Cloud OCR (better on handwriting/forms/tables, costs per page, data leaves the network -- check the customer's policy):
# AWS Textract: boto3.client("textract").detect_document_text(Document={"Bytes": png_bytes})   # multi-page PDF: async API via S3
# Azure Document Intelligence: DocumentIntelligenceClient(...).begin_analyze_document("prebuilt-read", ...)
# docling / unstructured(strategy="hi_res") wrap OCR + layout for you.
```

### Mini-exercise (30-60 min)
`omniguard/ingest/ocr.py` -- OmniGuard CP3 ingestion ka OCR branch.
- `route_page(page) -> "extract" | "ocr" | "blank"`; `ocr_page(image) -> OcrResult(words, mean_conf, needs_review)`.
- OCR engine ek interface ke peeche: `FakeOcr` (tests) aur `TesseractOcr` (agar binary installed ho). Engine config se choose.
- Har page ke liye metrics log karo: route, ms taken, word count, mean_conf, dropped words (text nahi -- PII).
- Acceptance (pytest): fpdf2 fixture (1 digital + 1 image page) -> routes `["extract", "ocr"]`; numeric fix test; low-conf page `needs_review=True`.

### Common pitfalls
- Low DPI render (72) -- Tesseract accuracy gir jaati hai; ~300 DPI standard start point hai, lekin memory/time badhta hai -- page-by-page process karo, poori PDF memory mein nahi.
- OCR text ko LLM se "clean" karwana bina guardrail ke -- model numbers aur names "theek" karke galat kar sakta hai. Original OCR text + bbox hamesha store karo.
- Cloud OCR pe bina batching/timeout/retry -- 12,000 pages pe throttling (429) aur bill dono aate hain; per-page cost pehle estimate karo.

### Checklist before moving on
- [ ] Bata sakta hoon kab extract aur kab OCR -- aur ise code mein route kar sakta hoon.
- [ ] Preprocess ke 4 steps aur Otsu threshold ka idea samjha sakta hoon.
- [ ] Confidence filter + human review flag laga sakta hoon.
- [ ] 2-column page ka reading order fix kar sakta hoon.

### Related
- M08-01 Identifying document structures
- M08-03 OCR-free embedding strategies via ColPali
- M08-10 Ingesting unstructured legacy enterprise PDFs
- M08-11 Aligning bounding boxes with text chunks

### Self-quiz
1. Ek page ka `extract_text()` 3 characters deta hai aur page pe 1 image hai. Aap kya karoge, aur blank page se kaise alag karoge?
2. Threshold se pehle deskew kyun? Tilted scan pe OCR ka kya hota hai?
3. "Claim total 1O,5OO" -- post-correction rule kaise likhoge jo "Policy" ya "OK" jaise words ko na bigaade?
4. Mean confidence 72 aaya. Is page ka text RAG index mein jaana chahiye ya nahi? Business ke saath kaunsa trade-off discuss karoge?
