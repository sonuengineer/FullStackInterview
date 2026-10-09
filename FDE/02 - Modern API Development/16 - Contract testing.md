# Modern API Development

## Contract testing

> Extended (slow track only) | Slow CP2 only | ~1.2 h

**Contract test** = check karna ki API provider aur uska consumer ek hi "contract" (request/response shape) maante hain -- bina dono ko saath deploy kiye. Unit tests apna code check karte hain; contract tests do teams/services ke beech ka agreement.
Do styles: **consumer-driven** (Pact -- consumer apni expectations ek pact file mein likhta hai, provider CI mein us file ke against verify karta hai) aur **schema-based** (provider ka OpenAPI schema source of truth; Schemathesis jaise tools schema se bahut saari requests generate karke check karte hain ki responses schema follow karte hain).
FastAPI ka bonus: `/openapi.json` already contract hai -- ise git mein snapshot karo aur CI mein diff karo; field remove/rename hua to test fail = breaking change pakda gaya (M02-10 versioning se connect).
FDE angle: customer ka frontend team, unka integration/ESB team aur aapki API alag-alag release karte hain -- contract tests ke bina "humare side pe to chal raha tha" wali meetings hoti hain.
Yaad rakho: contract test shape aur compatibility check karta hai, business logic nahi -- uske liye unit/integration tests (M02-11, M02-12) chahiye hi.

**Try this (20-40 min):** `omniguard/tests/test_contract.py` likho: `TestClient(app).get("/openapi.json").json()` ko `tests/openapi.snapshot.json` se compare karo (pehli run pe snapshot banao); phir `DocumentOut` se ek field hatao aur test fail hote dekho. Bonus: `jsonschema` se `/documents` response ko OpenAPI ke `DocumentOut` component ke against validate karo.

**Read:** https://docs.pact.io/
