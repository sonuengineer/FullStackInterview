# OmniGuard - Secure AI Integration

## OAuth 2.0 and RBAC

> Deliverable 03 of 12 | Built in: Fast CP5 / Slow CP7 | Time box: 9 h

### Goal
Every OmniGuard request carries a verified identity, every route checks a named permission, and the same question asked by two roles returns two different allowed answers. Prove it today with a mock IdP, so the real Azure AD tenant only changes config.

### Customer context (Kavach Finserv)
Kavach uses Azure AD (Entra ID) for SSO, but Anil's (CISO) team will only hand over the tenant a few days before UAT. UAT-07 says: "an underwriter must never see claim medical notes". Claims analysts (40) see claim status; underwriters (12) see portfolio figures such as the Q2 loss ratio but not individual claims.

### What to build
- `create_app(jwt_public_key_pem: str) -> FastAPI` factory in `omniguard/main.py`, so tests inject a key; production uses a JWKS URL.
- `omniguard/auth/jwt.py`: `verify_access_token(token) -> Principal`. RS256 pinned, `iss` and `aud` from config, small leeway, required claims `exp`, `iss`, `sub`.
- `Principal`: `sub`, `tenant`, `roles`, `groups`. Map Entra app roles (for example `OmniGuard.Analyst`) to internal roles; ignore unknown values (M12-05).
- `config/rbac.yaml`: roles -> permissions (`ask:use`, `docs:read`, `sql:query`, `audit:read`). Unknown permission name = startup fails.
- `require_permission("...")` dependency on every non-public route; a test iterates `app.routes` and fails on any ungated route not in an explicit public allow-list.
- Status codes: no/invalid token -> 401; valid token, missing permission -> 403.
- Principal flows into retrieval (ACL filter, Deliverable 01) and SQL guard (Deliverable 02).
- `tests/fake_idp.py`: mock IdP issuing RS256 tokens via code + PKCE (M12-03).
- `docs/permission-matrix.md` generated from `rbac.yaml`; `scripts/two_user_demo.sh` calls `/v1/ask` as both users.

Config keys: `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URL`, `JWT_LEEWAY_S`, `RBAC_CONFIG`.
Seed roles used by the harness: `claims_analyst`, `underwriter`, `intern` (no `ask:use`).

### Inputs: lessons to (re)read
- M12-01 Authentication vs authorization
- M12-02 Understanding JWT tokens
- M12-03 OAuth grant types
- M12-05 Mapping Azure AD groups
- M12-06 Implementing Role-Based Access Control
- M12-07 Enforcing data-level permissions in retrieval layers
- M12-10 Audit logging (deny events)
- M02-03 Dependency injection; M02-12 Fixtures and mocking
- M15-06 Executing mock OAuth 2.0 / RBAC flows (the harness)

### Acceptance checks
Automated by the M15-06 harness (`omniguard/tests/acceptance/test_auth.py`, `OMNIGUARD_APP_FACTORY=omniguard.main:create_app`):
1. No token -> 401.
2. Expired token -> 401.
3. Token with wrong `aud` (another app) -> 401.
4. Token signed by a different key -> 401.
5. `alg=none` token -> 401.
6. Valid token, role without `ask:use` (`intern`) -> 403.
7. Two-user test, question "Status of claim C-1001 and the Q2 loss ratio?": `claims_analyst` answer contains `C-1001` and not `loss ratio`; `underwriter` answer contains `loss ratio` and not `C-1001`.
8. Fault injection: a branch that disables `aud` verification -> CI red (screenshot in README).
Also from M12-02: wrong `iss`, tampered payload, HS256 confusion, missing `exp` -> all 401.

### Proof for the gate
CP5 two-user demo recording (`scripts/two_user_demo.sh`): same question, two users, different allowed answers, plus the 401/403 cases. Link the green CI run and `docs/permission-matrix.md`.

### Definition of done
- All harness checks green on your real app, red on the broken-`aud` branch.
- No auth bypass flag exists anywhere (`DISABLE_AUTH` or similar); tests use the mock IdP.
- Test keys are generated at runtime, never committed.
- Every 403 writes an audit event without raw tokens or prompt text.

### Out of scope
Real Azure AD tenant setup, SAML (M12-04), refresh-token rotation and revocation (M12-08), API keys for machine callers (M12-09), a login UI.

### Stretch goals
- Session lifecycle: idle + absolute timeout, refresh rotation with reuse detection (M12-08).
- Group overage handling (`_claim_names`) with a stubbed Graph lookup (M12-05).
- Audit query: "which user saw which chunk, who was denied" answered with one command (M12-10).
