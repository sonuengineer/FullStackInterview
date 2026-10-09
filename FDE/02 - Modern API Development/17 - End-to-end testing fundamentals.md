# Modern API Development

## End-to-end testing fundamentals

> Extended (slow track only) | Slow CP2 only | ~1.2 h

**E2E test** = poora system asli tarike se chalao (browser ya HTTP client -> API -> DB -> queue) aur user ke nazariye se ek complete flow check karo: "login -> document upload -> summary dikhe". Test pyramid ki sabse upar wali -- sabse kam, sabse slow -- layer.
Python tooling: API-level E2E ke liye pytest + `httpx` asli chal rahe server (`uvicorn` ya `docker compose up`) ke against; UI E2E ke liye **Playwright** (`pytest-playwright`) -- Cypress jaisa, auto-wait ke saath. External cheezein (LLM provider, customer SSO) stub servers ya sandbox accounts se replace karo.
Rules: kam lekin critical flows (happy path + 1-2 critical failures), har test apna data banaye aur saaf kare, fixed `sleep` ki jagah condition pe wait, aur failure pe screenshot/trace/logs save karo.
FDE angle: UAT (M15-05) se pehle customer ke staging pe ek smoke E2E suite chalana sabse sasta confidence hai -- deploy hua, health green, ek document end-to-end process hua. Flaky E2E test ko ignore mat karo; aksar wo race condition ya timeout hai jo production mein bhi aayega.
Yaad rakho: E2E wo bugs pakadta hai jo pieces ke beech chhupe hain (CORS, config, network), lekin debug karna mehenga hai -- logic bugs unit tests mein pakdo.

**Try this (20-40 min):** `omniguard` ko `uvicorn` se port 8000 pe chalao; `tests/e2e/test_flow.py` mein `httpx.Client(base_url="http://localhost:8000")` se create -> list (cursor) -> PUT -> GET flow test likho, `@pytest.mark.e2e` marker ke saath, aur normal run mein `pytest -m "not e2e"` se skip karo.

**Read:** https://playwright.dev/python/docs/intro
