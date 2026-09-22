# You Restart the Backend and Every User Is Logged Out - What Assumption Was Wrong?

## 1. The Story

Users log in and everything works. You deploy a small fix, the server restarts, and suddenly **every single user** is kicked back to the login page. Support tickets flood in. Nothing in the login code changed.

## 2. The Wrong Assumption

> **"The server process will live forever, so it can remember things."**

Login state was stored somewhere that **dies with the process**. When the process restarts, that memory is gone, so every token or session the server issued is now meaningless to it.

## 3. The Three Usual Culprits

**1. Sessions stored in process memory**
`express-session` uses an in-memory store by default (`MemoryStore`). Every session lives in a JavaScript object inside the Node process. Restart = empty object = everyone logged out.
The docs even warn: MemoryStore is not for production - it also leaks memory and doesn't work with more than one server.

**2. The JWT secret is generated at startup**
```javascript
// BAD - a new random secret on every boot
const JWT_SECRET = crypto.randomBytes(32).toString('hex');
```
Every token signed before the restart was signed with the **old** secret. After the restart, verification fails for all of them.

**3. Each server has its own secret or its own memory**
With 3 servers behind a load balancer, even without a restart, a user logged in on server A is "unknown" on server B. A restart just makes the same bug obvious.

## 4. The Fix: Keep Auth State Outside the Process

| What you use | Where state must live |
|---|---|
| Server sessions | A **shared store**: Redis (`connect-redis`), or the database |
| JWT | A **fixed secret from config** (env / Secrets Manager), the same on every server; refresh tokens stored in the DB/Redis |

```javascript
// Sessions in Redis - survive restarts and work across many servers
const session = require('express-session');
const { RedisStore } = require('connect-redis');
const { createClient } = require('redis');

const redisClient = createClient({ url: process.env.REDIS_URL });
await redisClient.connect();

app.use(session({
  store: new RedisStore({ client: redisClient }),
  secret: process.env.SESSION_SECRET,            // fixed, from config - never random at boot
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 },
}));
```

```javascript
// JWT - one stable secret from config, same on every instance
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET missing - refusing to start');   // fail fast
```

## 5. The Principle Behind It

**Term: Stateless server** - a server that keeps no user-specific data in its own memory between requests, so any instance can handle any request and restarts lose nothing.

This is the same rule that makes **horizontal scaling** and **zero-downtime deploys** possible. If a restart logs everyone out, you also can't safely run two servers or do a rolling deploy.

## 6. Related Traps

- **Redis without persistence, or evicting keys:** sessions in Redis also vanish if Redis restarts with no persistence, or if Redis runs out of memory and evicts them. Give session keys their own Redis (or `noeviction`), separate from cache keys.
- **Rotating the secret on purpose:** if you must rotate a JWT secret, support **two keys** for a while (verify with old or new, sign with new) - or everyone is logged out at the rotation.
- **Cookie settings changed in the deploy:** a new cookie name, domain or `SameSite` value also makes old cookies useless.


## 🧠 Remember

> If a restart logs everyone out, your auth state lived inside the process. Move it out: sessions in a shared store, JWT secrets from config - and the same rule gives you safe scaling and zero-downtime deploys.

## Self-Test

1. Why does `express-session` with default settings log everyone out on restart?
2. Why is `crypto.randomBytes()` at startup a bad JWT secret?
3. How would you rotate a JWT secret without logging everyone out?

Related: [[09-jwt-logout-invalidation]]
