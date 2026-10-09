# Modern API Development

## Implementing URL-based vs Header-based API versioning

> Extended (slow track only) | Slow CP2 only | ~1.2 h

Versioning tab chahiye jab breaking change aaye (field rename/remove, type change, naya required field) aur purane clients ko chalte rehna ho.
**URL-based** (`/v1/documents`, `/v2/documents`): FastAPI mein do `APIRouter(prefix="/v1")` aur `prefix="/v2"` -- simple, curl/logs mein dikhta hai, gateway routing aasaan; nuksaan: har version ka route set duplicate hota hai.
**Header-based** (`Accept: application/vnd.omniguard.v2+json` ya custom `API-Version: 2026-10-01`): URL saaf rehta hai, date-based versions (Stripe style) possible; nuksaan: caches/CDN ko `Vary` header chahiye, browser se testing mushkil, aur FastAPI mein ek dependency likhni padti hai jo header padh ke sahi handler/serializer chune.
FDE angle: enterprise integration teams slow upgrade karte hain -- old version ko deprecation date ke saath chalate raho (`Deprecation` / `Sunset` response headers) aur usage logs se dekho kaun abhi bhi v1 pe hai. Zyada tar internal enterprise APIs ke liye URL-based simple aur kaafi hai.
Yaad rakho: additive change (naya optional field) ko naya version nahi chahiye; version sirf breaking change pe.

**Try this (20-40 min):** `omniguard` mein `/v1/documents` (field `title`) aur `/v2/documents` (field `name`) routers banao, ek shared service se; phir `get_api_version` dependency banao jo `API-Version` header padhe (default v1). TestClient se dono styles test karo aur v1 response pe `Deprecation` header assert karo.

**Read:** https://fastapi.tiangolo.com/tutorial/bigger-applications/
