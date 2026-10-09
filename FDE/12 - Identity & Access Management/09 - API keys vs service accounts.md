# Identity & Access Management

## API keys vs service accounts

> Core | Fast CP5 / Slow CP7 | ~1.2 h | Builds on: M12-03, M12-06

### Kahani
Retail customer ke teen systems aapke AI pricing API ko call karte hain: unka ERP (on-prem), ek partner ka Python script, aur aapka khud ka nightly eval job jo Azure pe chalta hai.
Sabko ek hi API key di gayi thi -- `config.py` mein plain text, DB mein bhi plain text. Partner ke laptop se key GitHub pe leak hui. Rotate karne gaye to pata chala ERP, eval job, sab ek saath toot jaayenge, aur logs se ye bhi nahi pata ki leaked key se kisne kya call kiya.
Sahi design: har caller ki alag key (prefix se pehchaan, hash at rest, scopes, rotation), aur jahan aapka code cloud pe chalta hai wahan key hi nahi -- workload identity se short-lived token.

### What it is
**API key** = long-lived shared secret jo caller har request mein bhejta hai. Simple, har client support karta hai, par chori ho to expiry tak kaam karti hai.
**Service account / workload identity** = machine ki apni identity (Entra app registration, AWS IAM role, GCP service account). Best form: koi stored secret nahi -- platform (Azure managed identity, GitHub Actions OIDC, Kubernetes service account token) se **short-lived credential** milta hai, OIDC federation se trust.

### Why it matters for an FDE
Customer ke integrations mein dono milenge. Partner/legacy ke liye API key theek hai agar sahi bani ho; aapke apne cloud workloads ke liye static secrets security review mein red flag hain. Key leak incident mein "kaunsi key, kiski, kya scope, kab rotate" -- in sawaalon ka jawab design se aata hai.

### Key concepts
- **Prefix + secret** -- `ogk_live_3f9a12bc_<secret>`; prefix (id) DB lookup aur logs ke liye, secret kabhi log nahi. Secret scanners (GitHub) bhi prefix se pehchante hain.
- **Hash at rest with a pepper** -- DB mein `HMAC-SHA256(pepper, key)`; pepper secrets manager mein, DB mein nahi. Key random aur lambi hai, isliye bcrypt jaisa slow hash zaroori nahi.
- **Show once** -- key sirf create ke response mein; baad mein sirf prefix + last-used dikhao. Bhool gaye = nayi key.
- **Scopes + owner + expiry** -- har key ka owner (team/partner), scopes (`pricing:read`), `expires_at`. Least privilege, M12-06 ki permissions jaisa.
- **Rotation with overlap** -- nayi key issue, purani grace period (e.g. 7 din) tak valid, phir revoke. Zero-downtime.

### Code example
`stdlib only`

```python
# runnable
import hashlib, hmac, secrets, time
from dataclasses import dataclass, field

PEPPER = secrets.token_bytes(32)        # real: from a secrets manager, never in the DB or the repo

@dataclass
class KeyRecord:
    prefix: str
    digest: str
    owner: str
    scopes: frozenset
    expires_at: float
    revoked: bool = False
    last_used: float | None = None

@dataclass
class KeyStore:
    rows: dict = field(default_factory=dict)          # prefix -> KeyRecord; real: a DB table

    def _digest(self, key: str) -> str:
        return hmac.new(PEPPER, key.encode(), hashlib.sha256).hexdigest()

    def issue(self, owner: str, scopes: set, ttl_days: int = 90) -> str:
        prefix = secrets.token_hex(4)
        key = f"ogk_live_{prefix}_{secrets.token_urlsafe(32)}"
        self.rows[prefix] = KeyRecord(prefix, self._digest(key), owner, frozenset(scopes),
                                      time.time() + ttl_days * 86400)
        return key                                     # show ONCE; only the digest is stored

    def verify(self, key: str, scope: str) -> KeyRecord | None:
        parts = key.split("_", 3)                      # the secret part may itself contain "_"
        if len(parts) != 4 or parts[:2] != ["ogk", "live"]:
            return None
        rec = self.rows.get(parts[2])
        if rec is None or not hmac.compare_digest(rec.digest, self._digest(key)):   # constant-time compare
            return None
        if rec.revoked or rec.expires_at < time.time() or scope not in rec.scopes:
            return None
        rec.last_used = time.time()
        return rec

    def rotate(self, old_key: str, grace_s: float) -> str:
        old = self.rows[old_key.split("_")[2]]
        new_key = self.issue(old.owner, set(old.scopes))
        old.expires_at = min(old.expires_at, time.time() + grace_s)    # overlap window, then dead
        return new_key

    def revoke(self, prefix: str):
        self.rows[prefix].revoked = True

store = KeyStore()
erp = store.issue("erp-team", {"pricing:read"})
partner = store.issue("partner-zeta", {"pricing:read", "pricing:simulate"})

assert erp not in str(store.rows)                              # raw key never stored
assert store.verify(erp, "pricing:read").owner == "erp-team"
assert store.verify(erp, "pricing:simulate") is None           # scope enforced
assert store.verify(erp[:-1] + ("A" if erp[-1] != "A" else "B"), "pricing:read") is None   # tampered
assert store.verify("Bearer nonsense", "pricing:read") is None

# Partner key leaked on GitHub: rotate with a short overlap, then revoke the old one.
new_partner = store.rotate(partner, grace_s=3600)
assert store.verify(partner, "pricing:simulate") and store.verify(new_partner, "pricing:simulate")
store.revoke(partner.split("_")[2])
assert store.verify(partner, "pricing:read") is None and store.verify(new_partner, "pricing:read")

# Expired keys fail.
old = store.issue("eval-job", {"pricing:read"}, ttl_days=0)
store.rows[old.split("_")[2]].expires_at -= 1
assert store.verify(old, "pricing:read") is None

for r in store.rows.values():                                   # what the admin UI may show
    print(f"ogk_live_{r.prefix}_***  owner={r.owner:13} scopes={sorted(r.scopes)} revoked={r.revoked}")
print("OK: prefix lookup, peppered hash, compare_digest, scopes, rotation with overlap, revoke, expiry")
```

- `ogk_live_<prefix>_<secret>` -- prefix se O(1) DB lookup; poori table pe hash compare nahi karna padta. Logs mein sirf prefix.
- `hmac.new(PEPPER, ...)` -- DB dump leak ho to bhi pepper ke bina digests bekaar. Key 32 random bytes hai, isliye fast HMAC kaafi; user passwords ke liye ye galat hoga (wahan argon2/bcrypt).
- `hmac.compare_digest` -- constant-time compare, timing attack se digest guess nahi ho sakta. `==` mat use karo.
- `rotate` -- nayi key turant valid, purani `grace_s` tak; partner deploy kare, phir `revoke`. Leak case mein grace chhota rakho (ya zero).
- Admin listing -- `***` ke saath; key dobara dikhane ka koi code path hi nahi.

```python
# real version -- not run here, needs: pip install azure-identity httpx   (workload identity, no stored secret)
import os
import httpx
from azure.identity import DefaultAzureCredential     # managed identity on Azure, az login locally

cred = DefaultAzureCredential()
token = cred.get_token(os.environ["PRICING_API_SCOPE"])   # e.g. "api://<app-id>/.default", short-lived
r = httpx.get(os.environ["PRICING_API_URL"], headers={"Authorization": f"Bearer {token.token}"}, timeout=5)
```

AWS pe same idea: IAM role + STS `AssumeRoleWithWebIdentity` (GitHub Actions/EKS OIDC); GCP pe Workload Identity Federation. Aapka API in tokens ko M12-02 ki tarah verify karta hai -- `aud`, `iss`, aur `sub` (kaunsa workload) check karke.

### Mini-exercise (30-60 min)
OmniGuard: `omniguard/auth/api_keys.py`.
- SQLite table `api_keys(prefix PK, digest, owner, scopes, expires_at, revoked, last_used)`; `OMNIGUARD_KEY_PEPPER` env se, missing ho to startup fail.
- `X-API-Key` header dependency jo M12-06 ke `Principal` jaisa object return kare (`sub="key:<prefix>"`, scopes as permissions) -- taaki routes ko farak na pade ki caller user hai ya machine.
- Admin endpoints: create (show once), list (prefix only), rotate, revoke -- sab `user:manage` permission + audit event (M12-10).
- Test: logs mein (caplog) raw key kabhi na aaye; tampered/expired/revoked/wrong-scope sab 401/403.
- Bonus: `docs/workload-identity.md` mein ek para -- OmniGuard Azure pe deploy hoga to LLM/DB credentials ke liye managed identity kaise use karega.

### Common pitfalls
- Ek key, saare clients -- leak pe sab rotate, aur audit mein attribution zero. Har caller ki alag key.
- API key URL query mein (`?api_key=...`) -- proxy logs, browser history, Referer header mein leak. Header mein bhejo.
- Apne cloud jobs ke liye bhi long-lived client secrets -- Key Vault mein rakhne se bhi wo static hi rehta hai; workload identity pehli choice.

### Checklist before moving on
- [ ] Meri API keys DB mein sirf peppered hash ke roop mein hain aur sirf ek baar dikhti hain.
- [ ] Verify `hmac.compare_digest` use karta hai aur scope + expiry + revoked check karta hai.
- [ ] Main zero-downtime rotation ka flow bata sakta hoon.
- [ ] API key vs workload identity -- kab kaunsa, ek-ek example se.

### Related
- M12-03 OAuth grant types
- M12-06 Implementing Role-Based Access Control
- M12-10 Audit logging
- M14-03 Centralizing provider API keys via LiteLLM and Portkey

### Self-quiz
1. API key ko bcrypt se hash karna zaroori kyun nahi, par user password ko kyun zaroori hai?
2. Prefix ka kya fayda hai -- lookup, logs aur secret scanning teeno angle se?
3. Partner ki key leak hui, unka deploy 2 din mein hoga. Rotation plan kya hoga?
4. Aapka eval job Azure pe chalta hai. Client secret ki jagah kya use karoge aur kya fayda hai?
