# Production AI Security & Guardrails

## Customizing regex patterns for domain-specific PII

> Extended (slow track only) | Slow CP8 only | ~1.2 h

Presidio ke built-in recognizers generic hain: email, card, US SSN, phone. Par har customer ka apna PII hota hai -- hospital ka MRN (`MRN-0042817`), bank ka customer id (`CIF 88231190`), insurer ka policy number, employee id, vehicle number (`MH12AB1234`), GSTIN.
Inke liye `PatternRecognizer` banao: regex + base score + **context words** ("mrn", "patient id") + optional validator (checksum, known prefix). Low base score (0.3-0.5) rakho aur context se boost hone do, warna har 7-digit number MRN ban jaayega.
FDE angle: discovery workshop (M15-01) mein customer se poocho "aapke systems mein kaunse identifiers hain?" -- sample documents se 20 real examples aur 20 look-alikes lo.
Yaad rakho: har custom pattern ke saath positive aur hard-negative tests likho; regex jitna loose, false positives utne zyada (M13-08).

**Try this (20-40 min):** M13-05 ke `RULES` mein `IN_VEHICLE` (`[A-Z]{2}\d{2}[A-Z]{1,2}\d{4}`) aur `MRN` (`MRN-\d{7}`, context "patient") add karo; 10 positive + 10 negative strings pe asserts likho, aur dekho kaunsa negative galti se match hota hai.

**Read:** https://microsoft.github.io/presidio/analyzer/adding_recognizers/
