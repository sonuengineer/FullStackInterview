# Why Not Store SHA-256(password)? What Should You Use Instead?

> **Connects to**: [[27-cia-triad]] (this protects Confidentiality when - not if - the database leaks).

## 1. Story

Your users table leaks. It happens to big companies every year. The attacker now has every row, including the `password_hash` column. The only question that matters now: **how long until they turn those hashes back into real passwords?**

## 2. The Surprise: SHA-256 Is Too *Fast*

SHA-256 is a great hash for **file integrity and signatures**, where speed is a feature. For passwords, speed is exactly the problem.

- A modern GPU can compute **billions** of SHA-256 hashes per second.
- Passwords like `MyPassword@123` are not random. Attackers try leaked-password lists and common patterns first.
- So the attacker hashes billions of guesses per second and compares against your leaked hashes. Weak and medium passwords fall in minutes or hours.

**Other problems with plain SHA-256:**

- **No salt** means two users with the same password have the **same hash**. One crack reveals both, and attackers can use **precomputed tables** (rainbow tables) of hashes for common passwords.
- **Term: Salt** - a random value, unique per user, mixed into the password before hashing. Same password, different salt, completely different hash. It kills precomputed tables and forces attackers to crack each user separately.

Even with a salt, SHA-256 is still billions-per-second fast. Salt fixes the "crack everyone at once" problem, but not the "guess very fast" problem.

## 3. The Fix: A Slow, Salted Password-Hashing Function

Use an algorithm **designed to be slow and memory-hungry on purpose**:

| Algorithm | Notes |
|---|---|
| **Argon2id** | Modern first choice (winner of the Password Hashing Competition). Tunable CPU + memory cost, which hurts GPU attacks badly. |
| **bcrypt** | Battle-tested, widely available. Tunable cost factor. Only uses the first 72 bytes of the password. |
| **scrypt** | Memory-hard, good choice too. |
| **PBKDF2** | Acceptable (and required in some compliance settings) with a high iteration count, but weaker against GPUs. |

These have **salts built in** and a **cost factor** you tune so one hash takes around 100-500ms on your server. For one login that's unnoticeable. For an attacker trying billions of guesses, it turns minutes into centuries.

## 4. Mental Model

> A password hash should be like a heavy vault door: one legitimate opening a day is fine, but trying a billion keys becomes impossibly slow. SHA-256 is a revolving door - great for traffic, terrible for security.

## 5. Code Example

```javascript
const argon2 = require('argon2');

// Signup: hash with a built-in random salt and tuned cost
const hash = await argon2.hash(password, { type: argon2.argon2id });
// Stored value looks like: $argon2id$v=19$m=65536,t=3,p=4$<salt>$<hash>
// Algorithm, cost settings, and salt are all stored inside the string.

// Login: verify - never compare hashes yourself with ===
const ok = await argon2.verify(storedHash, loginAttemptPassword);
```

## 6. Production Reality

- **Raise the cost factor over time** as hardware gets faster; re-hash a user's password with new settings when they next log in successfully.
- Optionally add a **pepper**: a server-side secret (kept outside the database, e.g. in a secrets manager) mixed in, so a database-only leak isn't enough.
- **Rate-limit login attempts** - slow hashing also makes login a CPU target, so protect the endpoint.
- Never write your own crypto. Use the library's `hash` and `verify`.

## 7. Common Mistakes

- "SHA-256 is secure, so it's fine for passwords." Secure for *integrity*, wrong tool for *passwords*.
- Hashing many times with MD5/SHA in a homemade loop instead of using a proper algorithm.
- Encrypting passwords (reversible) instead of hashing them (one-way). If you can decrypt them, so can an attacker who steals the key.

## 8. 🧠 Remember

> Passwords need a slow, salted, purpose-built hash - Argon2id or bcrypt - because the threat is billions of guesses per second after a leak, and SHA-256's speed is exactly what the attacker wants.

## 9. Quick Self-Test

1. Why is speed good for file hashing but bad for password hashing?
2. What does a salt protect against, and what does it *not* protect against?
3. Why is encrypting passwords worse than hashing them?
