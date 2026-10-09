# Identity & Access Management

## Understanding JWT tokens

> Core | Fast CP5 / Slow CP7 | ~1.2 h | Builds on: M12-01

### Kahani
Logistics customer ka internal "shipment copilot". Unka Okta har request pe `Authorization: Bearer eyJ...` bhejta hai. Pehle developer ne `jwt.decode(token, options={"verify_signature": False})` likha tha "kyunki local pe key nahi thi" -- aur wahi code production chala gaya.
Pen-tester ne jwt.io pe token kholke `"roles": ["admin"]` kar diya, signature hata diya, aur copilot ne usse saare warehouses ka data de diya.
Lesson: JWT ka payload koi bhi padh aur badal sakta hai. Bharosa sirf signature verify karne ke baad, aur sahi `alg`, `iss`, `aud`, `exp` ke saath.

### What it is
**JWT** = `header.payload.signature`, teeno base64url. Header mein `alg` + `kid`, payload mein claims (`sub`, `iss`, `aud`, `exp`, `iat`, roles). IdP private key se sign karta hai, aap public key se verify.
JWT **signed hai, encrypted nahi** -- payload base64 hai, koi bhi decode kar sakta hai. Secrets, PII, prompts claims mein mat daalo.

### Why it matters for an FDE
Har enterprise IdP aapko JWT dega. Verify mein ek galti (signature skip, `alg` trust kiya, `aud` check nahi) = koi bhi admin ban sakta hai. Ye bug security review mein sabse pehle pakda jaata hai.

### Key concepts
- **RS256 / ES256** -- asymmetric: IdP private key se sign, aap public key se verify. HS256 = shared secret, sirf tab jab issuer aur verifier same service ho.
- **Always pin `algorithms=[...]`** -- token ke header ka `alg` kabhi trust mat karo. `alg: none` aur RS->HS confusion isi se rukte hain.
- **`iss` + `aud`** -- token sahi IdP ne diya aur AAPKE API ke liye diya. Doosre app ka valid token aapke API pe nahi chalna chahiye.
- **`exp` + leeway** -- expiry hamesha check; servers ki clock skew ke liye 30-60 s leeway, zyada nahi.
- **JWKS + `kid`** -- IdP apni public keys `/.well-known/jwks.json` pe publish karta hai; header ka `kid` batata hai kaunsi key. Key rotation isi se bina downtime hota hai.

### Code example
`pip install "pyjwt[crypto]"`   (PyJWT + cryptography)

```python
# runnable
import base64, hashlib, hmac, json, time

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

# The IdP's key pair, generated in memory. Real life: you only ever see the public key (via JWKS).
private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
public_pem = private_key.public_key().public_bytes(
    serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
ISS, AUD = "https://idp.example.com/", "api://shipment-copilot"

def issue(**overrides):
    now = int(time.time())
    claims = {"iss": ISS, "aud": AUD, "sub": "user-17", "roles": ["dispatcher"],
              "iat": now, "exp": now + 300} | overrides
    return jwt.encode(claims, private_key, algorithm="RS256", headers={"kid": "key-2026-10"})

def verify(token: str, leeway: int = 30) -> dict:
    return jwt.decode(token, public_pem, algorithms=["RS256"],      # pinned, never from the header
                      audience=AUD, issuer=ISS, leeway=leeway,
                      options={"require": ["exp", "iat", "iss", "aud", "sub"]})

def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

def rejected(token, **kw) -> str:
    try:
        verify(token, **kw)
    except jwt.InvalidTokenError as e:          # base class of every PyJWT validation error
        return type(e).__name__
    raise AssertionError("token should have been rejected")

good = issue()
claims = verify(good)
assert claims["sub"] == "user-17" and jwt.get_unverified_header(good)["kid"] == "key-2026-10"

# 1. Anyone can READ the payload -- signed, not encrypted.
payload_part = good.split(".")[1]
peek = json.loads(base64.urlsafe_b64decode(payload_part + "=" * (-len(payload_part) % 4)))
assert peek["roles"] == ["dispatcher"]

# 2. Tampering breaks the signature.
head, _, sig = good.split(".")
evil_payload = b64(json.dumps(peek | {"roles": ["admin"]}).encode())
print("tampered     ->", rejected(f"{head}.{evil_payload}.{sig}"))

# 3. Expiry, with and without clock-skew leeway.
expired_10s = issue(iat=int(time.time()) - 400, exp=int(time.time()) - 10)
assert verify(expired_10s, leeway=30)["sub"] == "user-17"        # within skew: accepted
print("expired      ->", rejected(expired_10s, leeway=0))

# 4. Wrong audience / wrong issuer.
print("wrong aud    ->", rejected(issue(aud="api://some-other-app")))
print("wrong iss    ->", rejected(issue(iss="https://evil.example/")))

# 5. alg=none: unsigned token claiming to be admin.
none_tok = jwt.encode(peek | {"roles": ["admin"]}, None, algorithm="none")
print("alg none     ->", rejected(none_tok))

# 6. Algorithm confusion: attacker signs HS256 using the PUBLIC key as the HMAC secret.
h = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
p = b64(json.dumps(peek | {"roles": ["admin"]}).encode())
forged = f"{h}.{p}." + b64(hmac.new(public_pem, f"{h}.{p}".encode(), hashlib.sha256).digest())
print("HS256 confuse->", rejected(forged))

# Even if someone wrongly allowed HS256 too, PyJWT refuses a PEM public key as an HMAC secret.
try:
    jwt.decode(forged, public_pem, algorithms=["RS256", "HS256"], audience=AUD, issuer=ISS)
    raise AssertionError("must not verify")
except jwt.PyJWTError as e:                  # InvalidKeyError here, not an InvalidTokenError
    print("mixed algs   ->", type(e).__name__, "(still rejected, but do not rely on this)")
print("OK: verify signature + pinned alg + iss + aud + exp, every time")
```

- `algorithms=["RS256"]` -- verifier decide karta hai, token nahi. Isi line se case 5 aur 6 fail hote hain.
- `audience` + `issuer` + `options={"require": [...]}` -- claim missing ho to bhi reject; sirf "present ho to check" kaafi nahi.
- `leeway=30` -- 10 s purana token accept hua, `leeway=0` pe `ExpiredSignatureError`. Leeway clock skew ke liye hai, token life badhane ke liye nahi.
- Case 1 -- bina key ke payload padh liya. Isliye claims mein email/phone/secrets nahi; sirf ids aur roles.
- `jwt.get_unverified_header` -- sirf `kid` nikaalne ke liye (kaunsi key use karni hai). Uske claims pe kabhi decision mat lo.

```python
# real version -- not run here, needs: pip install "pyjwt[crypto]" and network access to the IdP
import os
import jwt

jwks = jwt.PyJWKClient(os.environ["IDP_JWKS_URL"], cache_keys=True, lifespan=3600)  # e.g. https://login.example/.well-known/jwks.json

def verify(token: str) -> dict:
    signing_key = jwks.get_signing_key_from_jwt(token)      # picks the key by the header's kid
    return jwt.decode(token, signing_key.key, algorithms=["RS256"],
                      audience=os.environ["API_AUDIENCE"], issuer=os.environ["IDP_ISSUER"], leeway=30)
```

`PyJWKClient` keys cache karta hai; naya `kid` aaya (IdP ne key rotate ki) to JWKS dobara fetch hota hai. JWKS URL hamesha IdP ke OIDC discovery doc (`/.well-known/openid-configuration`) se lo, token ke andar ke URL se kabhi nahi.

### Mini-exercise (30-60 min)
OmniGuard: `omniguard/auth/jwt.py` banao.
- `verify_access_token(token) -> Principal` -- RS256 pinned, `iss`/`aud` env se (`OIDC_ISSUER`, `OIDC_AUDIENCE`), leeway 30 s, required claims.
- Key source pluggable: tests mein in-memory key pair, prod mein `PyJWKClient(OIDC_JWKS_URL)`.
- `omniguard/auth/deps.py` (M12-01) ka fake token map hatao, ab ye function use ho.
- Tests (pytest fixture jo key pair banaye): valid, expired, wrong aud, wrong iss, tampered, `alg=none`, HS256 confusion, missing `exp` -- sab 401, valid 200.

### Common pitfalls
- `verify_signature: False` "sirf debugging ke liye" -- aur wo commit ho gaya. Grep karke CI mein block karo.
- Access token ki jagah `id_token` API pe accept karna -- `aud` client id hota hai, API nahi (M12-03).
- JWKS har request pe fetch karna -- latency + IdP rate limit. Cache karo, unknown `kid` pe hi refresh.

### Checklist before moving on
- [ ] Main JWT ke teen parts aur "signed not encrypted" ka matlab samjha sakta hoon.
- [ ] Mera verify `algorithms`, `audience`, `issuer`, required claims aur chhota leeway set karta hai.
- [ ] `alg: none` aur RS256->HS256 confusion attack samjha sakta hoon.
- [ ] JWKS + `kid` se key rotation kaise hota hai, bata sakta hoon.

### Related
- M12-01 Authentication vs authorization
- M12-03 OAuth grant types
- M12-08 Session and token lifecycle
- M12-05 Mapping Azure AD groups

### Self-quiz
1. JWT "signed hai encrypted nahi" -- iska practical matlab kya hai claims design ke liye?
2. Agar `algorithms` pass na karo aur library header ka `alg` maan le, to kaunse do attack possible hain?
3. Doosri team ke app ka valid Okta token aapke API pe chal gaya. Kaunsa check missing tha?
4. IdP ne aadhi raat key rotate ki. Aapka service bina deploy ke kaise chalta rahega?
