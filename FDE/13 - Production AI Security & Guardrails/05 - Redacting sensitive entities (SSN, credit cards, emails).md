# Production AI Security & Guardrails

## Redacting sensitive entities (SSN, credit cards, emails)

> Core | Fast CP6 / Slow CP8 | ~1.2 h | Builds on: M13-04

### Kahani
Ek US + India operations wali fintech ka support copilot. Agents ticket history paste karte hain: SSN, card numbers, UPI ids, PAN, sab kuch.
Pehla version: `\d{16}` -> `[CARD]`. Result: har 16-digit shipment tracking number aur order id bhi `[CARD]` ban gaya. Agents ne complain kiya "bot ko order id hi nahi dikh raha".
Doosri taraf, `4111-1111-1111-1111` (dashes ke saath) aur `536 22 8471` jaise formats pass ho gaye.
Lesson: PII redaction = **format + validation + overlap handling**. Regex akela ya to zyada pakadta hai, ya kam.

### What it is
**Entity redaction** = text mein sensitive values dhundh ke typed placeholders (`[CREDIT_CARD]`, `[US_SSN]`) se replace karna, LLM / logs / vendors tak jaane se pehle.
Achha redactor teen kaam karta hai: flexible pattern (spaces/dashes), **validation** (Luhn checksum, SSN format rules), aur **overlapping spans** ka sahi resolution.

### Why it matters for an FDE
Over-redaction = product bekaar (order ids gayab). Under-redaction = compliance incident (PCI DSS card data, SSN). Customer dono numbers dekhna chahega, aur aapka redactor dono pe tested hona chahiye.

### Key concepts
- **Luhn check** -- card number ka last digit checksum hai. Random 16-digit numbers mein se lagbhag 10% hi Luhn pass karte hain, to false positives ~90% kam.
- **US SSN rules** -- `AAA-GG-SSSS`: area `000`, `666`, `9xx` invalid; group `00` invalid; serial `0000` invalid.
- **Indian IDs** -- PAN: `ABCPE1234F` (5 letters, 4 digits, 1 letter; 4th letter holder type, `P` = individual). Aadhaar: 12 digits, first digit 2-9, last digit Verhoeff checksum (validate it in production).
- **Overlapping spans** -- `9820012345@upi.example.com` mein phone bhi hai aur email bhi. Ek hi winner: priority + longer span.
- **Typed placeholders** -- `[EMAIL]` model ko context deta hai ("yahan email tha") bina value ke; blank karne se answer quality girti hai.

### Code example
`stdlib only`

```python
# runnable
import re

def luhn_ok(num: str) -> bool:
    digits = [int(c) for c in re.sub(r"\D", "", num)][::-1]
    total = sum(d if i % 2 == 0 else (d * 2 - 9 if d > 4 else d * 2) for i, d in enumerate(digits))
    return 13 <= len(digits) <= 19 and total % 10 == 0

def ssn_ok(s: str) -> bool:
    area, group, serial = re.split(r"[- ]", s)
    return area not in ("000", "666") and not area.startswith("9") and group != "00" and serial != "0000"

# (entity, regex, validator, priority) -- higher priority wins an overlap
RULES = [
    ("EMAIL", r"\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b", None, 3),
    ("CREDIT_CARD", r"\b(?:\d[ -]?){12,18}\d\b", luhn_ok, 2),
    ("US_SSN", r"\b\d{3}[- ]\d{2}[- ]\d{4}\b", ssn_ok, 2),
    ("IN_PAN", r"\b[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]\b", None, 2),
    ("PHONE", r"(?:\+91[ -]?)?\b[6-9]\d{4} ?\d{5}\b|(?<!\w)\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b", None, 1),
]

def find_spans(text: str) -> list[tuple[int, int, str]]:
    cands = []
    for ent, rx, check, prio in RULES:
        for m in re.finditer(rx, text):
            if check is None or check(m.group()):
                cands.append((m.start(), m.end(), ent, prio))
    cands.sort(key=lambda c: (-c[3], -(c[1] - c[0])))           # priority, then longest
    kept = []
    for s, e, ent, _ in cands:
        if all(e <= ks or s >= ke for ks, ke, _ in kept):
            kept.append((s, e, ent))
    return sorted(kept)

def redact(text: str) -> str:
    for s, e, ent in reversed(find_spans(text)):
        text = text[:s] + f"[{ent}]" + text[e:]
    return text

ticket = ("Cust SSN 536-22-8471, card 4111-1111-1111-1111 and 5555 5555 5555 4444, amex 378282246310005. "
          "Reach at 9820012345@upi.example.com or +91 98200 12345 or (415) 555-0134. PAN ABCPE1234F. "
          "Tracking 4111111111111112, order 1234567812345678, ref 000-12-3456, 912-34-5678, 536-00-8471.")
out = redact(ticket)
print(out)

assert "536-22-8471" not in out and out.count("[CREDIT_CARD]") == 3 and out.count("[US_SSN]") == 1
assert "[EMAIL]" in out and "9820012345" not in out          # overlap: email wins, phone not double-replaced
assert out.count("[PHONE]") == 2 and "([PHONE]" not in out and "[IN_PAN]" in out
# false positives that validation removes:
assert "4111111111111112" in out and "1234567812345678" in out   # Luhn fail -> kept (tracking/order ids)
assert "000-12-3456" in out and "912-34-5678" in out and "536-00-8471" in out  # invalid SSN formats kept
assert luhn_ok("4111 1111 1111 1111") and not luhn_ok("4111 1111 1111 1112")
assert ssn_ok("536-22-8471") and not ssn_ok("666-12-3456") and not ssn_ok("536-22-0000")

# naive baseline: regex only, no validation, no overlap handling
naive = re.sub(r"\b\d{16}\b", "[CARD]", ticket)
assert "[CARD]" in naive and "Tracking [CARD]" in naive        # tracking number wrongly redacted
assert "4111-1111-1111-1111" in naive                          # dashed real card missed
print("OK: Luhn + SSN rules cut false positives, overlap resolved by priority")
```

- `luhn_ok` -- har doosra digit (right se) double, 9 se bada to -9, total % 10 == 0. Length 13-19 bhi check.
- `ssn_ok` -- teen SSN format rules. `000-12-3456`, `912-...`, `536-00-...` SSN jaise dikhte hain par valid nahi, to untouched.
- `RULES` priority -- email (3) > card/SSN/PAN (2) > phone (1). `9820012345@upi...` ek baar `[EMAIL]` bana, `[EMAIL]` ke andar `[PHONE]` nahi.
- Right-to-left replace (`reversed`) -- left se replace karoge to baaki spans ke offsets shift ho jaayenge.
- `naive` asserts -- `\d{16}` ka double failure: tracking number redact, dashed real card leak. Isi ko customer ke saamne before/after dikhao.

### Mini-exercise (30-60 min)
OmniGuard CP6: `omniguard/guardrails/pii.py` mein `StandInPII` ko ye rules do (M13-04 interface ke peeche).
- Aadhaar recognizer add karo with **Verhoeff checksum** (tables Wikipedia/UIDAI se, khud test vectors banao).
- `tests/test_redaction.py`: 20 positive samples (har entity, multiple formats) + 20 hard negatives (tracking ids, invoice numbers, dates `2024-05-0001`, invalid SSNs).
- Metrics print karo: per-entity recall (positives) aur false-positive rate (negatives). Acceptance: recall 100% on positives, FP <= 1/20.
- Same function logs aur LLM prompt dono ke liye (M13-14).

### Common pitfalls
- Sirf output redact karna -- prompt provider tak already PII le gaya. Input pe redact, output pe leak check dono.
- Card number sirf contiguous digits -- real text mein spaces, dashes, line breaks hote hain; pattern flexible, validation strict.
- Redaction ke baad bhi raw text kahin aur (cache, trace, error message) mein pada hai -- M13-14 aur M14-10 dekho.

### Checklist before moving on
- [ ] Luhn algorithm haath se ek number pe chala sakta hoon.
- [ ] SSN ke 3 invalid-format rules yaad hain.
- [ ] PAN aur Aadhaar ka format bata sakta hoon, aur Aadhaar checksum ka naam.
- [ ] Overlap resolution ka rule (priority, phir length) code mein hai aur tested hai.
- [ ] Hard negatives ka test set hai.

### Related
- M13-04 Implementing Microsoft Presidio analyzers and anonymizers
- M13-06 Customizing regex patterns for domain-specific PII
- M13-08 Evaluating false-positive redaction rates
- M13-14 Safe logging (never log PII or prompts)
- M15-02 Defining data classifications

### Self-quiz
1. Luhn check se kitne percent random 16-digit false positives hatt jaate hain, aur kyun?
2. `000-12-3456` ko redact na karna risky lagta hai -- kab aap phir bhi redact karna chahoge?
3. Ek UPI id `9820012345@okaxis` mein phone aur email dono -- aapka system kya output dega aur kyun?
4. `[EMAIL]` placeholder ki jagah empty string kyun nahi?
