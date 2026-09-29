# IDOR / BOLA - Logged-in User Ne URL Mein ID Badli Aur Dusre Ka Data Dikh Gaya (Hinglish)

> **Similar-question flag**: [[85-authentication-vs-authorization]] mein "kaun ho tum" vs "kya kar sakte ho" ka farak aa chuka hai. Naya yahan ye hai: wo farak **kaise ek real vulnerability ban jaata hai**, aur code mein kahan fix lagta hai.

## 1. Bug Ka Naam

User logged in hai, token valid hai, `/api/users/123/profile` apna data deta hai. Wo `124` kar deta hai -- aur dusre banda ka private data khul jaata hai.

Naam: **IDOR -- Insecure Direct Object Reference**. Server request se aayi ID seedha use kar raha hai, bina check kiye ki *is* user ka *us* object par haq hai ya nahi.

API security ki bhasha mein yahi cheez **OWASP API Security Top 10 ka API1: Broken Object Level Authorization (BOLA)** hai -- list ka **#1 risk**.

**Itna common kyun?** Kyunki ownership check **har endpoint par alag se** lagana padta hai. 300 endpoints hain, 299 par check hai, 1 par bhool gaye -- attacker ke liye wahi ek kaafi hai. Aur bhoolna easy hai: apne data par test karoge to sab sahi lagega.

## 2. Authentication vs Authorization -- Ek Line Mein

| | Sawaal | Fail hone par |
|---|---|---|
| **Authentication** | "Tum kaun ho?" | **401 Unauthorized** -- token nahi/galat/expired |
| **Authorization** | "Tumhe is cheez par haq hai?" | **403 Forbidden** -- pata hai tum kaun ho, par allowed nahi |

Yahan authentication **bilkul theek** tha ([[94-jwt-auth-safely-in-production]] wala poora kaam ho chuka tha). Authorization **gayab** tha. Ye "login bypass" nahi -- ye **missing check** hai. Confidentiality ka direct breach ([[27-cia-triad]]).

## 3. Root Cause

> Server ne **request se aayi ID ko trust kar liya**, ownership derive ya verify karne ki jagah.

Request se aane wali har cheez attacker-controlled hai -- URL param, query string, body field, header. `userId` bhi usi list mein hai.

## 4. Fixes -- Isi Order Mein

**(a) Apna data? URL se ID mat lo -- session/token se lo.** `/api/users/:id/profile` design hi galat hai jab wo sirf "mera profile" deta hai. `/api/me/profile` banao aur `req.user.id` use karo. Jo ID request mein hi nahi hai, usse tamper nahi kar sakte.

**(b) Genuinely shared resource? Ownership query ke andar daalo.** Order, invoice, document -- jinka owner alag ho sakta hai -- wahan ID lena padega. To check **database par** karwao:

```sql
SELECT * FROM orders WHERE id = $1 AND owner_id = $2;
```

Do-step `findById()` phir `if (order.ownerId !== user.id)` bhi chalta hai, par wo line delete ho sakti hai aur koi notice nahi karega. Query wala version **structurally** safe hai -- row hi nahi milti.

**(c) Central authorization layer.** Per-route `if` likhte rahoge to kahin miss hoga. Ek policy helper -- `can(user, 'read', order)` -- aur rule ek jagah.

**(d) Unguessable IDs (UUID/ULID) madad karte hain, authorization NAHI hain.** `124` guess karna trivial hai; UUID nahi -- ye **enumeration** kam karta hai ([[59-uuid-vs-auto-increment]]). Par jo ID leak ho gayi (email, logs, shared link) wo attacker ke paas hai, aur check na ho to data mil jaayega. UUID speed bump hai, lock nahi.

**(e) Jahan existence bhi secret hai, 403 ki jagah 404 do.** 403 ka matlab: "object exist karta hai, par tera nahi" -- attacker isi se valid IDs ki list bana leta hai ([[18-http-status-codes-400-404-409-422]]).

## 5. Code -- Before Aur After

```javascript
// VULNERABLE: requireAuth ne token verify kiya -- authentication OK, authorization ZERO
app.get('/api/users/:id/profile', requireAuth, async (req, res) => {
  const user = await db.users.findById(req.params.id); // attacker-controlled ID
  res.json(user);
});

// FIXED: apna data, ID hi nahi leta
app.get('/api/me/profile', requireAuth, async (req, res) => {
  const user = await db.users.findById(req.user.id); // token se, URL se nahi
  res.json(user);
});
```

**Shared resource -- ownership query mein:**

```javascript
app.get('/api/orders/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM orders WHERE id = $1 AND owner_id = $2',
    [req.params.id, req.user.id]
  );
  if (rows.length === 0) return res.sendStatus(404); // exist karta hai ya nahi, bataya nahi
  res.json(rows[0]);
});
```

**Policy helper -- rule ek jagah, default DENY:**

```javascript
const policies = {
  order: {
    read:  (user, order) => order.ownerId === user.id || user.role === 'support',
    write: (user, order) => order.ownerId === user.id,
  },
};

function can(user, action, type, resource) {
  const rule = policies[type]?.[action];
  if (!rule) return false;            // default DENY -- naya action explicitly allow karna padega
  return rule(user, resource);
}

if (!can(req.user, 'read', 'order', order)) return res.sendStatus(404);
```

Wo `return false` sabse important line hai: naya resource type apne aap allowed nahi ho jaata.

## 6. Isko Dhoondhna Kaise Hai

- **Automated tests**: har object endpoint par ek test jo **user B ke token se user A ka object** maange aur 403/404 expect kare. Sabse sasta safety net -- naye route par test bhool gaye to review mein pakda jaata hai.
- **Code review checklist**: handler mein `req.params`/`req.body` se ID aa rahi hai? Saath ownership condition hai? Query mein hai ya sirf ek `if` mein? List endpoints (`GET /orders`) par `WHERE owner_id` laga hai?
- **Logging + alerting**: ek hi account se repeated 403/404 on object endpoints = enumeration attempt.
- **Scanners ye miss karte hain** kyunki tool ko pata nahi ki `124` kisi *dusre* ka hai -- response 200 hai, error nahi. Detect karne ke liye **do valid accounts** chahiye aur "kya B ne A ka data dekha" wali business-level samajh. Isliye ye bug manual testing aur apne tests se milta hai, generic scanner se nahi.

## 7. Sibling Bug -- Mass Assignment (BOPLA)

IDOR object *level* par hai: "ye object tera hai?" Uska bhai **property** level par: "ye **field** tu change kar sakta hai?" User body mein `role: "admin"` bhejta hai:

```javascript
await db.users.update(req.user.id, req.body);          // galat -- role bhi save ho jaayega
const { name, phone } = req.body;                       // sahi -- allowlist
await db.users.update(req.user.id, { name, phone });
```

**Blocklist nahi, allowlist** -- naya sensitive column add hoga to blocklist update karna bhool jaoge.

## 8. Interview Mein Kya Bolna Hai

> "Ye IDOR hai -- OWASP API Top 10 mein API1, Broken Object Level Authorization. Authentication chal raha tha, authorization missing tha; root cause ye ki server ne request ki ID trust kar li. Fix: 'mera data' endpoints par ID hi mat lo, `req.user.id` use karo; shared resources par ownership query mein daalo taaki DB enforce kare; rules central policy helper mein default-deny ke saath. UUID enumeration kam karta hai par authorization nahi hai. Regression rokne ke liye cross-account tests likhte hain."

## 🧠 Remember

> Authentication proves kaun ho, authorization proves kya tumhara hai -- aur request mein aayi ID kabhi ownership ka proof nahi hoti; ya user session se derive karo, ya `WHERE id = $1 AND owner_id = $2` likhkar database se enforce karwao.

## Quick Self-Test

1. Sab IDs UUID kar diye -- kya bug fix ho gaya? Kyun nahi?
2. `if (order.ownerId !== user.id) throw` aur `WHERE id = $1 AND owner_id = $2` -- dono check karte hain, phir dusra behtar kyun hai?
3. Kis situation mein 403 ki jagah 404 return karna chahiye, aur kyun?
