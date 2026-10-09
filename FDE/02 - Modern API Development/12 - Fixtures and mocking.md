# Modern API Development

## Fixtures and mocking

> Core | Fast CP2 / Slow CP2 | ~1.2 h | Builds on: M02-03, M02-11

### Kahani
Ek hospital ke liye aapki `/summarize` API LLM call karti hai, audit file likhti hai, aur "URGENT" summary pe on-call team ko webhook bhejti hai.
Pehle test suite ne har run pe asli LLM hit kiya -- $40 ka bill ek din mein, aur provider slow hua to CI 20 minute atka.
Ek test ne asli webhook fire kar diya -- raat 2 baje on-call doctor ko "URGENT: test test" message gaya.
Tests ek dusre ka env var aur audit file ganda karte the, isliye akele pass, saath mein fail.
Aapko chahiye: har test ka saaf setup/teardown, aur bahar ki duniya (LLM, webhook, filesystem, env) ka controlled fake.

### What it is
**Fixture** = pytest ka reusable setup/teardown function; test parameter mein naam likho, pytest inject karta hai (FastAPI `Depends` jaisa hi idea). `yield` se pehle setup, baad mein teardown -- Jest ke `beforeEach/afterEach` ek function mein.
**Mock** = asli object ka stand-in jo record karta hai kaise call hua aur jo aap bolo wo return karta hai (`unittest.mock`). Jest ke `jest.fn()` / `jest.mock()` ka equivalent.

### Why it matters for an FDE
Customer ke systems (LLM gateway, EHR, SAP, webhooks) test environment mein available nahi hote ya chhune ki permission nahi hoti. Fixtures + mocks se poora behaviour laptop/CI pe test hota hai -- free, fast, aur bina kisi ko 2 baje jagaye.

### Key concepts
- **Fixture scope** -- `function` (default, har test naya), `module`, `session` (poore run mein ek baar -- engine, docker container, heavy model). Wider scope = fast, lekin shared state ka risk.
- **Built-in fixtures** -- `tmp_path` (har test ka apna temp dir), `monkeypatch` (env vars/attributes set karo, test ke baad auto-undo), `capsys`, `caplog`.
- **`conftest.py`** -- yahan ke fixtures us folder ke saare tests ko bina import ke milte hain.
- **`patch("module.name")`** -- jahan naam LOOK UP hota hai wahan patch karo (`app.httpx.post`), jahan define hua wahan nahi. `from httpx import post` kiya ho to `app.post` patch karna padega.
- **`AsyncMock` + `spec=`** -- async methods ke liye awaitable mock; `spec=RealClass` se typo wale method (`complet`) pe `AttributeError`, warna mock chupchaap pass kar deta.

### Code example
`pip install pytest fastapi httpx`

```python
# runnable
import subprocess, sys, tempfile, textwrap
from pathlib import Path

APP = r'''
import json, os
from pathlib import Path
import httpx
from fastapi import Body, Depends, FastAPI, HTTPException

class LLMClient:                                  # real SDK wrapper in production
    async def complete(self, prompt: str) -> str:
        raise RuntimeError("real network call -- must never run in unit tests")

def get_llm() -> LLMClient:
    return LLMClient()
app = FastAPI()

@app.post("/summarize")
async def summarize(text: str = Body(embed=True), llm: LLMClient = Depends(get_llm)):
    try:
        summary = await llm.complete("Summarize: " + text)
    except TimeoutError:
        raise HTTPException(503, "LLM provider timeout")
    with open(Path(os.environ["OMNIGUARD_AUDIT_DIR"]) / "audit.jsonl", "a") as f:
        f.write(json.dumps({"chars": len(text)}) + "\n")   # never log the text itself
    if "URGENT" in summary:
        httpx.post("https://hooks.example.invalid/alert", json={"text": summary}, timeout=5)
    return {"summary": summary}
'''

CONFTEST = r'''
from unittest.mock import AsyncMock
import pytest
from fastapi.testclient import TestClient
from app import LLMClient, app, get_llm

@pytest.fixture(scope="session")
def engine():                                     # expensive: built once per test run
    print("SETUP engine")
    yield "sqlite://"
    print("TEARDOWN engine")

@pytest.fixture
def fake_llm():
    llm = AsyncMock(spec=LLMClient)               # spec: only real methods exist
    llm.complete.return_value = "short summary"
    return llm

@pytest.fixture
def client(engine, fake_llm, tmp_path, monkeypatch):
    monkeypatch.setenv("OMNIGUARD_AUDIT_DIR", str(tmp_path))   # auto-undone after test
    app.dependency_overrides[get_llm] = lambda: fake_llm
    with TestClient(app) as c:
        yield c                                   # test runs here
    app.dependency_overrides.clear()              # teardown
'''

TESTS = r'''
from unittest.mock import Mock, patch
import pytest
from app import LLMClient

def test_summarize_with_fake_llm(client, fake_llm, tmp_path):
    r = client.post("/summarize", json={"text": "patient discharged"})
    assert r.json() == {"summary": "short summary"}
    fake_llm.complete.assert_awaited_once_with("Summarize: patient discharged")
    assert (tmp_path / "audit.jsonl").read_text() == '{"chars": 18}\n'

def test_urgent_summary_sends_alert(client, fake_llm):
    fake_llm.complete.return_value = "URGENT: sepsis risk"
    with patch("app.httpx.post") as post:         # patch where it is LOOKED UP
        client.post("/summarize", json={"text": "vitals"})
    post.assert_called_once()
    assert post.call_args.kwargs["timeout"] == 5

def test_llm_timeout_becomes_503(client, fake_llm):
    fake_llm.complete.side_effect = TimeoutError()
    assert client.post("/summarize", json={"text": "x"}).status_code == 503

def test_spec_catches_typos():
    with pytest.raises(AttributeError):
        Mock(spec=LLMClient).complet("hi")        # typo -> error, not a silent pass
'''

with tempfile.TemporaryDirectory() as tmp:
    d = Path(tmp)
    for name, src in {"pytest.ini": "[pytest]\n", "app.py": APP, "conftest.py": CONFTEST,
                      "test_app.py": TESTS}.items():
        (d / name).write_text(textwrap.dedent(src))
    r = subprocess.run([sys.executable, "-m", "pytest", "-q", "-s", "-p", "no:cacheprovider"],
                       cwd=d, capture_output=True, text=True, timeout=60)
    print(r.stdout.strip().splitlines()[-1])
    assert r.returncode == 0, r.stdout + r.stderr
    assert r.stdout.count("SETUP engine") == 1 and "TEARDOWN engine" in r.stdout
print("OK: session fixture, yield teardown, tmp_path, monkeypatch, AsyncMock, patch, spec")
```

- `client` fixture -- `monkeypatch.setenv` + `dependency_overrides` (M02-03) + `yield` + `clear()`: har test ko fresh, isolated app milta hai aur baad mein sab undo.
- `engine` (`scope="session"`) -- 4 tests ne use kiya lekin "SETUP engine" ek hi baar print hua; runner script yahi count assert karti hai.
- `fake_llm` -- `AsyncMock(spec=LLMClient)`: `complete` awaitable hai, `return_value`/`side_effect` se har test apna scenario (normal, URGENT, timeout) set karta hai; `assert_awaited_once_with` exact prompt check karta hai.
- `patch("app.httpx.post")` -- webhook ka asli network call kabhi nahi hua; `call_args.kwargs["timeout"] == 5` se ye bhi prove kiya ki production call pe timeout laga hai.
- `tmp_path` -- audit file har test ke apne folder mein; test ke beech file sharing khatam. Audit mein sirf `chars` count hai, text nahi (PII safe logging).
- `test_llm_timeout_becomes_503` -- failure path ko mock se simulate karna hi mocking ka asli fayda hai; asli provider ko timeout karwana mushkil hai.

### Mini-exercise (30-60 min)
`omniguard/tests/conftest.py` banao -- CP2 capstone ka test harness.
- Fixtures: `settings` (test values, `get_settings` override), `db_session` (sqlite file in `tmp_path`, `create_all`, yield, drop), `client` (overrides `get_db`, `get_current_user` ko `User(tenant="acme", roles=["admin"])` se; teardown mein `clear()`), `other_tenant_client`.
- `app/llm.py` mein `LLMClient.complete()` banao (abhi `NotImplementedError`), `POST /documents/{id}/summarize` add karo; tests mein `AsyncMock(spec=LLMClient)` se normal + timeout (503) dono path.
- Ek test jo `patch` se `app.notify.httpx.post` pakde aur assert kare ki `timeout=` diya gaya hai.
- Acceptance: `pytest -q` green; har test file akele (`pytest tests/test_auth.py`) bhi green (order-independence); WiFi band karke bhi poora suite chale.

### Common pitfalls
- Galat jagah patch karna (`httpx.post` patch kiya jabki code `from httpx import post` use karta hai) -- mock lagta hi nahi aur asli call chali jaati hai. Safety net: tests mein network block karo (jaise `pytest-socket` plugin).
- Bina `spec` ke `Mock()` -- method rename hua to bhi tests pass, production fail. Hamesha `spec=`/`create_autospec`.
- Over-mocking -- apne hi code ke internals mock kar diye to test sirf implementation copy karta hai. Boundary pe mock karo (LLM, HTTP, clock), apna logic asli chalao.

### Checklist before moving on
- [ ] Fixture scopes aur `yield` teardown ka order bata sakta hoon.
- [ ] `tmp_path` aur `monkeypatch` se env/filesystem isolate karta hoon.
- [ ] "Patch where it is looked up" ek example se samjha sakta hoon.
- [ ] Async dependency ko `AsyncMock(spec=...)` se fake karke success + failure path test karta hoon.

### Related
- M02-03 Dependency injection
- M02-11 Unit testing fundamentals
- M02-13 Test coverage analysis
- M02-16 Contract testing
- M14-02 Exponential backoff strategies

### Self-quiz
1. `client` fixture function-scope hai aur `engine` session-scope. Agar `client` ko session-scope kar do to kaunse tests aur kyun toot sakte hain?
2. `app.py` mein `from httpx import post` likha hai. `patch("httpx.post")` kyun kaam nahi karega, aur sahi target kya hai?
3. `Mock()` (bina spec) pe `llm.complet("x")` call karo -- kya hota hai? Ye production mein kaise bug chhupata hai?
4. Kab mock karna galat hai? Apne code ka ek example do jise mock nahi karna chahiye.
