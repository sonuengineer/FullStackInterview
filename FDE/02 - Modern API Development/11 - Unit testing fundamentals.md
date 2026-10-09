# Modern API Development

## Unit testing fundamentals

> Core | Fast CP2 / Slow CP2 | ~1.2 h | Builds on: M01-04, M02-02

### Kahani
Ek hospital customer ke liye aapki API LLM ko bhejne se pehle text se emails mask karti hai aur documents ko chunks mein todti hai.
Friday ko kisi ne regex "thoda improve" kiya. Monday ko customer ka DPO (data protection officer) email karta hai: logs mein `dr.rao@hospital.example!` jaise emails unmasked dikh rahe hain -- regex punctuation ke saath toot gaya.
Usi release mein chunking ka off-by-one: har chunk ka last character gayab, RAG answers mein aadhe sentences.
Dono bugs ek 2-second unit test pakad leta. Ab customer har release se pehle "test evidence" maangta hai.

### What it is
**Unit test** = code ke sabse chhote hisse (ek function/class) ko isolation mein, fast aur deterministic tarike se check karna -- no network, no real DB.
Python mein standard tool **pytest** hai: `test_*.py` files mein `test_*` functions, aur plain `assert`. Jest se mapping: `test()/it()` -> `def test_...`, `expect(x).toBe(y)` -> `assert x == y`, `test.each` -> `@pytest.mark.parametrize`, `expect(fn).toThrow()` -> `pytest.raises`.

### Why it matters for an FDE
Aap customer ke code mein jaldi-jaldi changes karte ho, aksar unke engineers ke saamne. Tests hi proof hain ki PII masking, validation aur business rules toote nahi -- aur CP2 gate pe coverage report (M02-13) inhi tests se banti hai.

### Key concepts
- **Arrange-Act-Assert** -- setup, ek action, phir check. Ek test = ek behaviour; naam se pata chale kya toota (`test_mask_handles_trailing_punctuation`).
- **Plain `assert` + assertion rewriting** -- pytest `assert a == b` ko rewrite karke fail hone pe dono values ka diff dikhata hai; `assertEqual` jaise methods ki zaroorat nahi.
- **`@pytest.mark.parametrize`** -- ek test, kai input/output rows; edge cases (empty, unicode, boundary) table mein add karna sasta ho jaata hai.
- **`pytest.raises(ValueError, match=...)`** -- error path bhi behaviour hai; message regex se check karo.
- **Test pyramid** -- bahut saare fast unit tests, kuch integration (TestClient + sqlite), bahut kam E2E (M02-17).

### Code example
`pip install pytest`

```python
# runnable
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path

CODE = r'''
import re
EMAIL = re.compile(r"[\w.+-]+@[\w-]+(\.[A-Za-z]{2,})+")

def mask_emails(text: str) -> str:
    return EMAIL.sub("[EMAIL]", text)

def chunk(text: str, size: int, overlap: int = 0) -> list[str]:
    if size <= 0 or not 0 <= overlap < size:
        raise ValueError("need size > 0 and 0 <= overlap < size")
    if not text:
        return []
    return [text[i:i + size] for i in range(0, max(len(text) - overlap, 1), size - overlap)]
'''

TESTS = r'''
import pytest
from textproc import chunk, mask_emails

def test_mask_single_email():
    text = "Contact dr.rao@hospital.example for the report"   # arrange
    out = mask_emails(text)                                  # act
    assert out == "Contact [EMAIL] for the report"           # assert

@pytest.mark.parametrize("text, expected", [
    ("no pii here", "no pii here"),
    ("a@b.co and c.d+x@e.org", "[EMAIL] and [EMAIL]"),
    ("mail dr.rao@hospital.example!", "mail [EMAIL]!"),       # the Friday bug
    ("", ""),
])
def test_mask_table(text, expected):
    assert mask_emails(text) == expected

def test_chunk_overlap_keeps_boundaries():
    assert chunk("abcdefghij", size=4, overlap=1) == ["abcd", "defg", "ghij"]

def test_chunk_loses_no_text():
    text = "".join(chr(97 + i % 26) for i in range(1003))
    parts = chunk(text, 100, 10)
    assert "".join(p if i == 0 else p[10:] for i, p in enumerate(parts)) == text

@pytest.mark.parametrize("size, overlap", [(0, 0), (10, 10), (10, -1)])
def test_chunk_rejects_bad_args(size, overlap):
    with pytest.raises(ValueError, match="overlap"):
        chunk("abc", size, overlap)
'''

FAILING = 'from textproc import chunk\ndef test_demo():\n    assert chunk("abcdef", 4) == ["abcd", "ef", ""]\n'

with tempfile.TemporaryDirectory() as tmp:
    d = Path(tmp)
    (d / "pytest.ini").write_text("[pytest]\n")              # makes tmp the rootdir
    (d / "textproc.py").write_text(textwrap.dedent(CODE))
    (d / "test_textproc.py").write_text(textwrap.dedent(TESTS))
    (d / "test_demo_fail.py").write_text(FAILING)
    run = lambda f: subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", f],
                                   cwd=d, capture_output=True, text=True, timeout=60)
    ok = run("test_textproc.py")
    print(ok.stdout.strip().splitlines()[-1])
    assert ok.returncode == 0, ok.stdout + ok.stderr
    bad = run("test_demo_fail.py")                           # see pytest's rewritten assert
    assert bad.returncode == 1 and "Right contains one more item" in bad.stdout, bad.stdout
    print("failing test explained itself:", "Right contains one more item: ''")
print("OK: AAA, parametrize, raises, assertion rewriting")
```

- `CODE` / `TESTS` strings -- real project mein ye `app/textproc.py` aur `tests/test_textproc.py` files hongi; yahan temp dir mein likh ke `sys.executable -m pytest` chalaya taaki example self-contained rahe.
- `test_mask_single_email` -- Arrange / Act / Assert teen lines; fail hone pe naam hi bata deta hai kya toota.
- `parametrize` table mein `"mail dr.rao@hospital.example!"` row -- jo bug production mein mila, wo pehle failing test banta hai, phir fix. Bug kabhi wapas nahi aayega (regression test).
- `test_chunk_loses_no_text` -- exact output ki jagah ek **property** check (overlap hata ke jodo to original text milna chahiye); off-by-one bugs isse pakde jaate hain.
- `test_demo_fail.py` jaan-boojh ke fail -- pytest output mein `Right contains one more item: ''` dikhata hai. Plain `assert` se itna detail milna hi assertion rewriting hai.
- `-p no:cacheprovider` sirf temp dir saaf rakhne ke liye; apne repo mein normal `pytest -q` chalao.

### Mini-exercise (30-60 min)
`omniguard` mein `tests/` folder setup karo (CP2 capstone ka test base).
- `pyproject.toml` mein `[tool.pytest.ini_options]` -> `testpaths = ["tests"]`, `addopts = "-q"`.
- `tests/test_schemas.py`: M02-02 ke `DocumentCreate` ke liye parametrize table -- 4 valid, 6 invalid inputs (extra field, short title, bad classification, wrong date order...), har invalid pe `pytest.raises(ValidationError)` aur `loc` check.
- `tests/test_health.py`: `TestClient(app).get("/health")` -> 200 + `version` field.
- `app/redact.py` mein `mask_emails` + `mask_phone` (Indian 10-digit) likho, pehle tests phir code (ek chhota TDD round).
- Acceptance: `pytest` green, < 2 s, koi test network/env pe depend nahi karta; ek test jaan-boojh ke tod ke failure message padho, phir wapas theek karo.

### Common pitfalls
- Tests jo ek dusre pe depend karte hain (module-level list mein state, order-dependent) -- alag order ya `-k` se chalane pe random fail. Har test apna data khud banaye (fixtures, M02-12).
- Real LLM/HTTP call unit test mein -- slow, paid, flaky, aur CI mein API key leak ka risk. Fake/mock karo; real calls sirf alag marked integration suite mein.
- Sirf happy path test karna -- PII masking jaise security code ke liye edge cases (punctuation, uppercase, unicode, empty) hi asli tests hain.

### Checklist before moving on
- [ ] Jest ke `test`, `expect`, `test.each`, `toThrow` ka pytest equivalent likh sakta hoon.
- [ ] Har test AAA pattern mein hai aur naam behaviour batata hai.
- [ ] `parametrize` aur `pytest.raises(match=...)` comfortably use karta hoon.
- [ ] Production bug ko pehle failing test mein convert karta hoon, phir fix.

### Related
- M02-12 Fixtures and mocking
- M02-13 Test coverage analysis
- M02-16 Contract testing
- M13-05 Redacting sensitive entities (SSN, credit cards, emails)
- M04-09 Creating workflow YAML files

### Self-quiz
1. Unit test aur integration test mein fark kya hai? `TestClient` + in-memory sqlite wala test kis category mein aayega?
2. `assert result == expected` fail hua -- pytest itna detailed diff kaise dikhata hai jabki ye plain Python `assert` hai?
3. Chunking function ke liye exact output check karna behtar hai ya property check (jaise "koi text loss nahi")? Dono kab?
4. Aapke test suite mein ek test kabhi pass kabhi fail hota hai. Teen possible causes batao.
