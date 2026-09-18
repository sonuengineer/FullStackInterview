# Authentication vs Authorization - In One Sentence Each

## 1. The One-Liners

> **Authentication (AuthN)** answers **"Who are you?"** - proving your identity.
>
> **Authorization (AuthZ)** answers **"What are you allowed to do?"** - checking your permissions.

**Authentication always comes first** - you can't decide what someone may do until you know who they are.

## 2. The Everyday Picture

At an office building:
- Showing your **ID card at reception** = authentication (they know who you are).
- Your card **opening only the 5th floor, not the server room** = authorization (what you may access).

## 3. In a Real App

| | Authentication | Authorization |
|---|---|---|
| Question | Who is this? | May they do this? |
| Examples | Password, OTP / 2FA, SSO login, JWT or session check | Roles (admin, editor), permissions ("can delete supplier"), ownership ("only your own orders") |
| Failure status | **401 Unauthorized** (really means "unauthenticated") | **403 Forbidden** |
| Happens | Once at login, then verified on each request via the token/session | On every protected action |

## 4. In Code (Express)

```javascript
// AUTHENTICATION - who is calling?
function authenticate(req, res, next) {
  const token = req.get('Authorization')?.replace('Bearer ', '');
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);   // identity proven
    next();
  } catch {
    res.status(401).json({ error: 'Please log in' });         // we don't know who you are
  }
}

// AUTHORIZATION - may they do THIS?
const requirePermission = (perm) => (req, res, next) =>
  req.user.permissions?.includes(perm) ? next()
    : res.status(403).json({ error: 'You do not have access to this' });

app.delete('/api/suppliers/:id',
  authenticate,                          // 1. who are you?
  requirePermission('supplier:delete'),  // 2. may you do this?
  deleteSupplier);
```

## 5. Common Mistakes

- **Returning 401 when it should be 403** (and the reverse). Logged in but not allowed = 403.
- **Authorization only in the frontend** - hiding a button is not security. The server must check every request.
- **Checking the role but not ownership** - a user may edit orders, but only **their own**: `WHERE id = $1 AND user_id = $2`. Missing this is an **IDOR** bug, one of the most common security holes.
- **Trusting the user ID from the request body** instead of the verified token.

## 6. Real Example (ThePipingMart admin panel)

The admin panel has 24 permission keys (supplier access, RFQ access, Jamstack rebuild...). **Authentication** is the login token; **authorization** is the `PermissionRoute` guard in the UI plus a `checkPermission(key)` middleware on the API. The key lesson from that project: the UI check alone is not enough - the API must enforce the same permissions.

## 🧠 Remember

> Authentication proves who you are (401 if it fails); authorization decides what you may do (403 if it fails) - and authorization must always be enforced on the server.

## Self-Test

1. A logged-in user tries to open the admin page and isn't an admin. 401 or 403?
2. Why isn't hiding a button in React a form of authorization?

Related: [[09-jwt-logout-invalidation]], [[27-cia-triad]]
