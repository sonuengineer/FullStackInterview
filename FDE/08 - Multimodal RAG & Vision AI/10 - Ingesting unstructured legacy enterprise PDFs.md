# Multimodal RAG & Vision AI

## Ingesting unstructured legacy enterprise PDFs

> Core | Fast CP3 / Slow CP5 | ~1.2 h | Builds on: M08-01, M08-02

### Kahani
Ek logistics company ka procurement team aapko ek shared drive deta hai: "ye 18 saal ke vendor contracts hain, Monday tak chatbot chahiye". 9,000 PDFs.
Aapka script 40 minute baad file #3,112 pe crash: `FileNotDecryptedError`. Restart kiya -- pehle 3,111 dobara process hue, embeddings ka bill double.
Phir pata chala: kuch files scanned hain, kuch ke pages sideways (90 degree rotate), kuch HR files password-protected, kuch purane font ki wajah se mojibake (garbage characters) text dete hain, aur kuch half-download hi hain.
Demo ke din client ne poocha: "Kitne documents index hue, kitne nahi, aur kyun?" -- aapke paas jawab nahi tha. FDE ka asli kaam yahi hai: **messy reality ko ek controlled, re-runnable pipeline** mein badalna.

### What it is
**Legacy PDF ingestion** = har file aur har page ko pehle **triage** karna (ok / rotated / needs_ocr / garbled / blank; file level pe needs_password / corrupt), result ek **ingestion manifest** mein likhna, aur pipeline ko **idempotent** banana: same file dobara aaye to skip, failed files hi retry.
Manifest hi aapki "source of truth" hai -- client report, retries aur debugging sab usi se.

### Why it matters for an FDE
Real customer data kabhi clean nahi hota. Ek bad file poora batch nahi girani chahiye, re-run paisa double nahi karna chahiye, aur "kya index nahi hua aur kyun" ka jawab ek query mein milna chahiye -- warna trust khatam.

### Key concepts
- **Per-page triage** -- ek hi PDF mein digital + scanned + rotated pages mix hote hain; decision page level pe lo, file level pe nahi.
- **Fail soft, record loudly** -- har exception pakdo, `status` + `error` type manifest mein; crash nahi, silently skip bhi nahi.
- **Content hash as identity** -- `sha256(bytes)` key; file rename ho to bhi duplicate nahi, content badle to naya entry.
- **Idempotent re-run** -- `status == "done"` wale skip; `needs_password` / `corrupt` retry ho sakte hain jab customer password ya fresh copy de.
- **Garbled text detection** -- extractable text bhi galat ho sakta hai (broken font encoding); clean-character ratio low ho to OCR route.

### Code example
`pip install pypdf fpdf2`  (Pillow comes with fpdf2)

```python
# runnable
import hashlib
import io
import logging
import json
import tempfile
from pathlib import Path
from fpdf import FPDF
from PIL import Image
from pypdf import PdfReader, PdfWriter
from pypdf.errors import PdfReadError

logging.getLogger("pypdf").setLevel(logging.ERROR)     # pypdf logs repair warnings for broken files

def build_fixtures(d):
    def pdf_with(pages):                       # pages: list of str (text) or None (image-only "scan")
        pdf = FPDF(); pdf.set_font("Helvetica", size=11)
        for content in pages:
            pdf.add_page()
            if content is None: pdf.image(Image.new("L", (300, 120), 230), x=10, y=10, w=150)
            else: pdf.multi_cell(0, 6, content)
        return bytes(pdf.output())
    digital = pdf_with(["Vendor contract 2011. Payment terms are net 45 days.", "Termination needs 90 days notice."])
    w = PdfWriter(clone_from=PdfReader(io.BytesIO(digital))); w.pages[1].rotate(90)       # sideways page
    (d / "contract_2011.pdf").write_bytes(_write(w))
    (d / "invoice_scan.pdf").write_bytes(pdf_with([None, "Stamped copy -- see scan on page 1."]))
    w = PdfWriter(clone_from=PdfReader(io.BytesIO(digital))); w.encrypt("hr-only", algorithm="RC4-128")
    (d / "salary_locked.pdf").write_bytes(_write(w))
    mojibake = "".join(map(chr, [0xC3, 0xA9, 0xC3, 0xA8, 0xC2, 0xB0, 0xC3, 0xBC])) * 8     # UTF-8 read as Latin-1
    (d / "legacy_font.pdf").write_bytes(pdf_with([mojibake]))
    (d / "truncated.pdf").write_bytes(digital[:300])                                   # broken download

def _write(writer):
    buf = io.BytesIO(); writer.write(buf); return buf.getvalue()

def page_status(page):
    text = (page.extract_text() or "").strip()
    if len(text) < 20:
        return "needs_ocr" if page.images else "blank"
    clean = sum(ch.isascii() and (ch.isalnum() or ch in " .,;:-()%/") for ch in text) / len(text)
    if clean < 0.7: return "garbled"                       # mojibake / broken font encoding -> OCR instead
    return "rotated" if page.rotation % 360 else "ok"

def triage(path):
    try:
        reader = PdfReader(path)
        if reader.is_encrypted and not reader.decrypt(""):     # empty user password opens many "protected" PDFs
            return {"status": "needs_password", "pages": []}
        pages = [page_status(p) for p in reader.pages]
    except (PdfReadError, ValueError, OSError) as e:
        return {"status": "corrupt", "error": type(e).__name__, "pages": []}
    return {"status": "done", "pages": pages}

def ingest(folder, manifest_path):
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    processed = 0
    for pdf in sorted(folder.glob("*.pdf")):
        sha = hashlib.sha256(pdf.read_bytes()).hexdigest()
        if manifest.get(sha, {}).get("status") == "done":
            continue                                          # idempotent: same bytes already ingested
        manifest[sha] = {"file": pdf.name, **triage(pdf)}
        processed += 1
    tmp = manifest_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(manifest, indent=2)); tmp.replace(manifest_path)   # atomic write
    return manifest, processed

with tempfile.TemporaryDirectory() as tmp:
    inbox, mpath = Path(tmp) / "inbox", Path(tmp) / "manifest.json"
    inbox.mkdir(); build_fixtures(inbox)
    m1, n1 = ingest(inbox, mpath)
    m2, n2 = ingest(inbox, mpath)                             # re-run: only non-done docs retried
    by_file = {v["file"]: v for v in m2.values()}

for name, entry in sorted(by_file.items()):
    print(f"{name:22} {entry['status']:15} {entry['pages']}")
print(f"run1 processed={n1}, run2 processed={n2}")
assert by_file["contract_2011.pdf"]["pages"] == ["ok", "rotated"]
assert by_file["invoice_scan.pdf"]["pages"] == ["needs_ocr", "ok"]
assert by_file["salary_locked.pdf"]["status"] == "needs_password"
assert by_file["legacy_font.pdf"]["pages"] == ["garbled"]
assert by_file["truncated.pdf"]["status"] == "corrupt"
assert n1 == 5 and n2 == 2                                     # locked + corrupt retried, done ones skipped
print("OK: per-page triage, manifest, idempotent re-run")
```

- `build_fixtures` -- 5 realistic bad cases: rotated page, image-only scan page, RC4-encrypted file, mojibake text, aur truncated (half-downloaded) file.
- `reader.decrypt("")` -- bahut "protected" PDFs sirf owner password (print/copy restriction) rakhte hain; empty user password se khul jaate hain. Na khule to `needs_password` -- guess mat karo.
- `page_status` -- order: pehle text hai ya nahi, phir quality (garbled), phir rotation. Rotated digital page ka text aksar theek aata hai, lekin OCR/rendering se pehle rotation normalize karni padti hai.
- `ingest` -- sha256 key + `status == "done"` skip = idempotent. Run 2 mein sirf 2 failed files retry hue, 3 skip.
- `tmp.replace(manifest_path)` -- atomic write: beech mein crash ho to aadha-likha JSON manifest corrupt nahi karta.
- `logging.getLogger("pypdf")` -- broken files pe pypdf repair warnings log karta hai; unhe apne structured log mein lo, stdout pe spam nahi.

```python
# real version -- not run here, needs: pip install pikepdf ocrmypdf  (+ Tesseract, Ghostscript for ocrmypdf)
# Check the docs for your version before relying on these flags.
import os, subprocess, pikepdf

# Repair a slightly broken file (qpdf under the hood) and open one the customer gave a password for.
with pikepdf.open("salary_locked.pdf", password=os.environ["HR_PDF_PASSWORD"]) as pdf:   # from a secret store
    pdf.save("salary_unlocked.pdf")                    # keep it in the restricted bucket only

# Scans + sideways pages: add a text layer, auto-rotate and deskew, skip pages that already have text.
subprocess.run(["ocrmypdf", "--skip-text", "--rotate-pages", "--deskew",
                "invoice_scan.pdf", "invoice_scan.ocr.pdf"], check=True, timeout=600)
```

### Mini-exercise (30-60 min)
`omniguard/ingest/manifest.py` + `omniguard/ingest/run.py` -- OmniGuard CP3 ka entry point: `python -m omniguard.ingest.run ./inbox`.
- Manifest SQLite table mein (`sha256 PK, file, status, error, pages_json, updated_at`) -- JSON se better jab 9,000 files hon.
- Pipeline: triage -> `ok/rotated` pages to M08-01 structure, `needs_ocr/garbled` to M08-02 OCR, phir sections -> chunks (M06-01) with `page` metadata.
- `--report` flag: status-wise counts + top errors, ek table jo client ko dikhaya ja sake.
- Acceptance (pytest): fixtures ke saath run twice -> second run mein 0 "done" files reprocess; ek corrupt file poora batch nahi girati; manifest mein har file ka status hai.

### Common pitfalls
- Password guess/brute-force ya password code mein hardcode -- customer se lo, secret store mein rakho, aur decrypted copies ka access same restricted rakho (HR/salary PII).
- File path ko identity banana -- same contract "final.pdf" aur "final (1).pdf" naam se do baar index hota hai; content hash use karo.
- Per-file timeout na hona -- ek 2,000-page corrupt PDF worker ko ghanton atka deta hai; har file pe time/page limit aur `timeout` status rakho.

### Checklist before moving on
- [ ] Ek PDF ke har page ko ok / rotated / needs_ocr / garbled / blank mein classify kar sakta hoon.
- [ ] Encrypted aur corrupt files bina crash ke manifest mein record hoti hain.
- [ ] Re-run pe done files skip hoti hain (content hash se), failed retry hoti hain.
- [ ] Client ko "kitna indexed, kitna nahi, kyun" ka report de sakta hoon.

### Related
- M08-01 Identifying document structures
- M08-02 Optical character recognition pipelines
- M08-11 Aligning bounding boxes with text chunks
- M06-01 Fixed-size and semantic chunking

### Self-quiz
1. Ek PDF ke 200 pages mein 3 scanned hain. File-level "scanned/digital" flag kyun kaafi nahi?
2. `extract_text()` text de raha hai, phir bhi aap page ko OCR route karoge -- kab aur kyun?
3. Re-run idempotent hai, lekin customer ne ek contract ka naya version usi naam se diya. Aapka manifest kya karega, aur purane chunks ka kya hoga?
4. Password-protected HR files ke saath security aur access ke kaunse questions aap customer se poochoge?
