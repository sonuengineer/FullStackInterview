# Production AI Security & Guardrails

## Implementing Microsoft Presidio analyzers and anonymizers

> Core | Fast CP6 / Slow CP8 | ~1.2 h | Builds on: M13-01, M15-02

### Kahani
Ek hospital network ka discharge-summary assistant. Doctors notes paste karte hain, bot patient ke liye simple language summary banata hai -- external LLM provider ke through.
Hospital ka DPO (data protection officer) bola: "Patient ka naam, phone, email, card number provider ke server tak nahi jaayega. Period."
Developer ne 5 regex likhe. Pehle hi din "Dr. Mehta called Ravi Kumar at 98200 12345" mein naam pass ho gaya, aur "Order 4111 1111 1111 1112" (galat number) card samajh ke mask ho gaya.
FDE ka jawab: ek proper PII framework -- **Microsoft Presidio** -- jo detect (analyzer) aur transform (anonymizer) ko alag karta hai, aur jisme NER model + checksum + context sab milte hain.

### What it is
**Presidio** = Microsoft ka open-source PII toolkit. Do parts:
- **AnalyzerEngine** -- text scan karke `RecognizerResult(entity_type, start, end, score)` list deta hai. Andar recognizers: regex + checksum (credit card, SSN), aur spaCy NER model (PERSON, LOCATION), plus **context words** jo score badhate hain.
- **AnonymizerEngine** -- un spans pe **operators** lagata hai: `replace`, `mask`, `hash`, `redact`, `encrypt`, ya custom.

### Why it matters for an FDE
Har regulated customer (health, bank, insurance) LLM call se pehle PII hatana maangega. Presidio standard, auditable answer hai -- aur iska analyzer/anonymizer split aapko per-entity policy dene deta hai ("card mask, email hash, naam replace").

### Key concepts
- **Recognizer** -- ek entity type ka detector. Pattern recognizer (regex + score) ya NER-based. Custom recognizers registry mein add hote hain (M13-06).
- **Score + threshold** -- har result ka confidence; `score_threshold` se kam wale drop. Checksum pass = high score.
- **Context enhancement** -- "card", "ssn", "phone" jaise words paas mein hon to score boost. Bina context ke 9-digit number bas ek number hai.
- **Operator per entity** -- detection policy aur transformation policy alag; compliance team operator choose karti hai.
- **NER vs regex** -- naam, address, organisation regex se nahi pakde jaate. Real Presidio ka spaCy/transformer NER yahan regex se kahin behtar hai.

### Code example
`stdlib only` -- ye ek **stand-in** hai jo Presidio ka shape copy karta hai (regex + checksum + context). Real Presidio NER models aur context words use karta hai aur names/addresses ke liye regex se far better hai.

```python
# runnable
# Stand-in with Presidio's shape: AnalyzerEngine -> RecognizerResult list -> AnonymizerEngine(operators)
import hashlib, re
from dataclasses import dataclass

@dataclass(frozen=True)
class RecognizerResult:
    entity_type: str; start: int; end: int; score: float

def luhn_ok(digits: str) -> bool:
    d = [int(c) for c in digits][::-1]
    return sum(x if i % 2 == 0 else (x * 2 - 9 if x > 4 else x * 2) for i, x in enumerate(d)) % 10 == 0

@dataclass
class PatternRecognizer:
    entity: str; regex: str; score: float; context: tuple = (); validate: object = None
    def analyze(self, text: str) -> list[RecognizerResult]:
        out = []
        for m in re.finditer(self.regex, text):
            s = self.score
            if self.validate:
                if not self.validate(re.sub(r"\D", "", m.group())):
                    continue                                       # checksum failed -> not PII
                s = 1.0
            window = text[max(0, m.start() - 30):m.start()].lower()
            if any(w in window for w in self.context):
                s = min(1.0, s + 0.35)                             # Presidio-style context boost
            out.append(RecognizerResult(self.entity, m.start(), m.end(), s))
        return out

class AnalyzerEngine:
    def __init__(self, recognizers): self.recognizers = list(recognizers)
    def analyze(self, text: str, score_threshold: float = 0.5) -> list[RecognizerResult]:
        res = [r for rec in self.recognizers for r in rec.analyze(text) if r.score >= score_threshold]
        res.sort(key=lambda r: (-r.score, -(r.end - r.start)))
        kept = []                                                  # overlap: keep higher score
        for r in res:
            if all(r.end <= k.start or r.start >= k.end for k in kept):
                kept.append(r)
        return sorted(kept, key=lambda r: r.start)

OPERATORS = {
    "replace": lambda v, p: p.get("new_value", "<{entity}>"),
    "mask": lambda v, p: p.get("masking_char", "*") * (len(v) - p.get("keep_last", 4)) + v[-p.get("keep_last", 4):],
    "hash": lambda v, p: hashlib.sha256((p["salt"] + v).encode()).hexdigest()[:12],
}

class AnonymizerEngine:
    def anonymize(self, text: str, analyzer_results, operators: dict) -> str:
        for r in sorted(analyzer_results, key=lambda r: -r.start):   # right-to-left keeps offsets valid
            name, params = operators.get(r.entity_type, operators["DEFAULT"])
            new = OPERATORS[name](text[r.start:r.end], params).replace("{entity}", r.entity_type)
            text = text[:r.start] + new + text[r.end:]
        return text

analyzer = AnalyzerEngine([
    PatternRecognizer("EMAIL_ADDRESS", r"\b[\w.+-]+@[\w-]+\.[\w.]+\b", 0.85),
    PatternRecognizer("CREDIT_CARD", r"\b(?:\d[ -]?){13,19}\b", 0.3, ("card",), luhn_ok),
    PatternRecognizer("PHONE_NUMBER", r"\b[6-9]\d{4} ?\d{5}\b", 0.4, ("phone", "call", "mobile")),
])
note = "Ravi Kumar, mobile 98200 12345, email ravi.k@example.com, card 4111 1111 1111 1111. Order 4111 1111 1111 1112."
results = analyzer.analyze(note)
print([(r.entity_type, note[r.start:r.end], r.score) for r in results])
safe = AnonymizerEngine().anonymize(note, results, {
    "DEFAULT": ("replace", {}),
    "CREDIT_CARD": ("mask", {"masking_char": "*", "keep_last": 4}),
    "EMAIL_ADDRESS": ("hash", {"salt": "per-tenant-secret"}),
})
print(safe)
assert "98200" not in safe and "ravi.k@" not in safe and "<PHONE_NUMBER>" in safe
assert "1111 1111 1111 1111" not in safe and safe.count("1111") >= 1   # last 4 kept
assert "4111 1111 1111 1112" in safe                                   # Luhn fail -> order id untouched
assert "Ravi Kumar" in safe        # regex cannot find names -> this is exactly why real Presidio uses NER
print("OK: analyze -> results -> per-entity operators")
```

- `RecognizerResult` aur `analyze(text) -> list` -- real Presidio jaisa shape, taaki baad mein swap karna ek import change ho.
- `validate=luhn_ok` -- checksum fail to result hi nahi. "Order 4111...1112" bach gaya; sirf regex hota to false positive.
- Context boost -- phone ka base score 0.4 threshold se neeche; "mobile" paas mein hai to 0.75. Bina context wale 10-digit numbers chhoot jaate.
- Overlap resolution + right-to-left replace -- warna pehla replacement baaki offsets bigaad deta.
- Last assert jaan-bujh ke dikhata hai: "Ravi Kumar" leak hua. Names ke liye NER chahiye -- yahi real Presidio ka main faayda hai.

```python
# real version -- not run here, needs: pip install presidio-analyzer presidio-anonymizer && python -m spacy download en_core_web_lg
from presidio_analyzer import AnalyzerEngine, Pattern, PatternRecognizer
from presidio_anonymizer import AnonymizerEngine
from presidio_anonymizer.entities import OperatorConfig

analyzer = AnalyzerEngine()            # default NLP engine: spaCy en_core_web_lg + built-in recognizers
analyzer.registry.add_recognizer(PatternRecognizer(
    supported_entity="IN_PHONE", context=["mobile", "phone", "call"],
    patterns=[Pattern(name="in_mobile", regex=r"\b[6-9]\d{4} ?\d{5}\b", score=0.4)]))
results = analyzer.analyze(text=note, language="en", score_threshold=0.5)
safe = AnonymizerEngine().anonymize(text=note, analyzer_results=results, operators={
    "DEFAULT": OperatorConfig("replace", {}),          # -> <ENTITY_TYPE>
    "CREDIT_CARD": OperatorConfig("mask", {"masking_char": "*", "chars_to_mask": 12, "from_end": False}),
    "EMAIL_ADDRESS": OperatorConfig("hash", {"hash_type": "sha256"}),   # salt options vary -- check the docs
}).text
```

### Mini-exercise (30-60 min)
OmniGuard CP6: `omniguard/guardrails/pii.py` with a `PIIService` interface: `analyze(text) -> list[RecognizerResult]`, `anonymize(text, results) -> str`.
- Do implementations: `StandInPII` (upar wala, CI ke liye) aur `PresidioPII` (real, optional dependency, `PII_BACKEND=presidio` env var se).
- Per-entity operator policy `config/pii_policy.yaml` mein (M15-02 data classifications se link).
- `/ask` route mein LLM call se pehle `anonymize`; test: 10 sample notes, koi email/phone/card provider tak nahi jaata (FakeLLM ka received prompt assert karo).
- Acceptance: dono backends same interface pass karte hain; real Presidio locally "Ravi Kumar" ko PERSON pakadta hai.

### Common pitfalls
- Default threshold ke saath deploy -- har domain ka score threshold eval set pe tune karo (M13-08), warna ya leak ya over-redaction.
- `hash` bina salt -- phone numbers ka space chhota hai, unsalted SHA-256 brute force se reverse ho jaata hai.
- Sirf English NER model -- Hinglish/Hindi names ya Indian addresses pe recall girta hai; apne data pe measure karo.

### Checklist before moving on
- [ ] Analyzer aur anonymizer ka role alag-alag samjha sakta hoon.
- [ ] `RecognizerResult` ke 4 fields aur score ka matlab pata hai.
- [ ] Context words score kaise badalte hain, ek example de sakta hoon.
- [ ] Per-entity operator policy config mein hai, code mein hardcoded nahi.
- [ ] Mujhe pata hai regex stand-in names/addresses kyun miss karta hai.

### Related
- M13-05 Redacting sensitive entities (SSN, credit cards, emails)
- M13-06 Customizing regex patterns for domain-specific PII
- M13-07 Reversing masks safely post-generation
- M13-08 Evaluating false-positive redaction rates
- M15-02 Defining data classifications
- M15-08 Implementing NeMo & Presidio guardrails

### Self-quiz
1. Presidio detection aur transformation ko alag engines mein kyun rakhta hai? Ek business reason do.
2. Ek 16-digit number Luhn fail karta hai. Analyzer kya karega aur kyun?
3. "Call me at 98200 12345" vs "Invoice 98200 12345" -- context words ka role samjhao.
4. Email ke liye `hash` aur card ke liye `mask` -- dono kab sahi choice hain?
