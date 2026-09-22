# JWT Auth in Production: Tokens Get Stolen, Users Log Out, Permissions Change

> **Builds on**: [[09-jwt-logout-invalidation]] (how to invalidate a stateless token) and [[85-authentication-vs-authorization]] (who you are vs what you may do). This is the practical checklist for shipping JWT auth safely.

## 1. Why the Tutorial Version Breaks

`login -> generate token -> verify token` works until production asks four questions:

1. The token was **stolen** - how do you stop it being used?
2. The user pressed **logout** - a signed token is still valid until it expires.
3. The session must **expire**, but users shouldn't be kicked out mid-work.
4. **Permissions changed** (a user was demoted) - the old token still claims the old role.

Every one of these is the same root issue: a JWT is a **signed note the server doesn't remember issuing**.

## 2. The Safe Setup

**1. Two tokens, not one.**
- **Access token**: short life (10-15 minutes), sent on every API call, verified by signature only (fast, no database hit).
- **Refresh token**: long life (days), stored **server-side** so it can be revoked, used only to get a new access token.

**2. Store them properly.**
- Best for browsers: **httpOnly, Secure, SameSite cookies** - JavaScript can't read them, so an XSS bug can't steal them. Add CSRF protection (SameSite=Lax/Strict plus a CSRF token for state-changing routes).
- `localStorage` is convenient but readable by any injected script. For mobile apps use the platform's secure storage.

**3. Rotate refresh tokens, and detect theft.**
Each refresh issues a **new** refresh token and invalidates the old one. If an old one is reused, that means someone has a copy: revoke the whole family and force a re-login.

**4. Logout must kill the refresh token** (delete it server-side), and optionally add the access token's `jti` to a short-lived Redis blocklist ([[09-jwt-logout-invalidation]]).

**5. Handle permission changes** with a `tokenVersion` (or `permissionsUpdatedAt`) claim: bump the stored value when a role changes, and any older token stops being accepted. With 15-minute access tokens, most changes need nothing else.

**6. Verify properly.** This is where real breaches come from:
- Pin the algorithm: `algorithms: ['RS256']`. Never accept `alg` from the token (`none` and HS/RS confusion attacks).
- Check `exp`, `iss` and `aud` - not just the signature.
- Keep a `kid` in the header so you can rotate signing keys without logging everyone out.

**7. Keep the payload boring.** A JWT is signed, **not encrypted** - anyone can read it. No PII, no secrets. Keep it small: user id, role/version, `jti`, `exp`.

## 3. Code

```javascript
const jwt = require('jsonwebtoken');

// Issue: short access token + rotating refresh token stored server-side
function issueAccess(user) {
  return jwt.sign(
    { sub: user.id, ver: user.tokenVersion, jti: crypto.randomUUID() },
    PRIVATE_KEY,
    { algorithm: 'RS256', expiresIn: '15m', issuer: 'api.myapp.com', audience: 'myapp-web', keyid: CURRENT_KID }
  );
}

// Verify: pin the algorithm and check issuer/audience, not just the signature
async function auth(req, res, next) {
  try {
    const token = req.cookies.access;                  // httpOnly cookie
    const payload = jwt.verify(token, publicKeyFor(token), {
      algorithms: ['RS256'], issuer: 'api.myapp.com', audience: 'myapp-web',
    });
    if (await redis.get('blocklist:' + payload.jti)) return res.status(401).json({ error: 'revoked' });
    const user = await users.findById(payload.sub);
    if (!user || user.tokenVersion !== payload.ver) return res.status(401).json({ error: 'stale token' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'invalid token' });  // 401 = who are you; 403 = not allowed
  }
}
```

## 4. Do You Even Need JWT?

For a normal web app with one backend, a **plain server session** (session id in an httpOnly cookie, state in Redis) is simpler and revocable by design. JWTs earn their place when many services must verify a token without calling an auth service, or for mobile/third-party API clients. Choosing the simpler option is a valid, senior answer ([[42-resilience-vs-overengineering]]).

## 5. Checklist

- [ ] Short access token + revocable, rotating refresh token
- [ ] httpOnly + Secure + SameSite cookies (or secure mobile storage), HTTPS everywhere
- [ ] Logout deletes the refresh token (and blocklists the access token if needed)
- [ ] `tokenVersion` claim for role/permission changes and "log out everywhere"
- [ ] Algorithm pinned, `exp`/`iss`/`aud` verified, `kid` for key rotation
- [ ] No PII or secrets in the payload
- [ ] Rate limiting on login and refresh ([[79-blog-rate-limiting]])

## 6. 🧠 Remember

> A JWT is a signed note anyone can read and nobody can recall - so keep access tokens short, keep the revocable state in a rotating refresh token, verify algorithm/issuer/audience (not just the signature), and use a version claim so permission changes take effect.

## 7. Quick Self-Test

1. Why do httpOnly cookies protect a token from XSS when localStorage doesn't, and what new risk do they add?
2. What does refresh-token rotation detect that a long-lived refresh token can't?
3. A user is demoted from admin. What makes their existing token stop working?
