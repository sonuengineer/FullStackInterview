# Encoding vs Encryption vs Hashing (and Which One for Passwords)

> **Connects to**: [[56-password-hashing-not-sha256]] (the password answer in depth) and [[43-crypto-shredding-recovery]] (what encryption really promises).

## 1. The Three, in One Line Each

- **Encoding** = changing the *format* so a system can handle the data. **No secret involved. Anyone can reverse it.** Example: Base64 for sending a file in JSON, URL encoding for `%20`.
- **Encryption** = scrambling data so only someone with the **key** can read it. **Two-way on purpose** - you encrypt to decrypt later. Example: TLS for traffic, a database field holding a customer's PAN card number.
- **Hashing** = a one-way fingerprint. **Cannot be reversed**, and the same input always gives the same output. Example: password storage, file integrity checks.

## 2. Mental Model

> Encoding is a **translation** (anyone can translate back). Encryption is a **locked box** (you need the key). Hashing is a **blender** (you can never get the fruit back, but the same fruit always makes the same smoothie).

## 3. The Table

| | Reversible? | Needs a key? | What it's for | Example |
|---|---|---|---|---|
| Encoding | Yes, by anyone | No | Safe transport/storage of a format | Base64, URL encoding, UTF-8 |
| Encryption | Yes, with the key | Yes | Keeping data secret from others | AES-256-GCM, TLS |
| Hashing | No | No (a salt is not a key) | Proving a value matches, without storing it | Argon2id, bcrypt, SHA-256 |

## 4. The Answer for Passwords: Hashing

And not just any hash - a **slow, salted password hash**: **Argon2id** (first choice) or **bcrypt**.

- **Not encoding:** Base64 is not security at all. `cGFzc3dvcmQ=` is decodable by anyone in one second.
- **Not encryption:** if you can decrypt passwords, so can anyone who steals your key. You never *need* the original password - only to check whether the one typed matches.
- **Not plain SHA-256:** it's a hash, but a *fast* one. A GPU tries billions of guesses per second. Password hashes must be deliberately slow ([[56-password-hashing-not-sha256]]).

## 5. Code

```javascript
// ENCODING - no security, just format
Buffer.from('hunter2').toString('base64');            // 'aHVudGVyMg=='
Buffer.from('aHVudGVyMg==', 'base64').toString();     // 'hunter2' - anyone can do this

// ENCRYPTION - two-way, needs a key you must protect
const { createCipheriv, randomBytes } = require('node:crypto');
const iv = randomBytes(12);
const cipher = createCipheriv('aes-256-gcm', key, iv);  // key from a secrets manager
const enc = Buffer.concat([cipher.update('4111 1111 1111 1111', 'utf8'), cipher.final()]);

// HASHING (passwords) - one-way, slow, salted
const argon2 = require('argon2');
const stored = await argon2.hash(password, { type: argon2.argon2id });
const ok = await argon2.verify(stored, attempt);       // compare, never decrypt
```

## 6. Where Each Belongs in a Real App

- **Passwords** -> hash (Argon2id/bcrypt).
- **Card numbers, Aadhaar/PAN, health data you must show again** -> encrypt, with the key in a secrets manager (or, better, don't store it - let a payment provider hold it).
- **Data in transit** -> encryption (HTTPS/TLS), always.
- **Tokens in a URL, binary in JSON, file names** -> encoding.
- **"Did this file change?"** -> hashing (SHA-256 is perfect here, because speed is a feature).

## 7. Common Mistakes

- Saying "the password is encoded/encrypted in the database" - both are wrong answers in an interview, and the second is a real design flaw.
- Using a fast hash (MD5, SHA-1, SHA-256) for passwords.
- Thinking Base64 hides anything. It's a format, not protection.

## 8. 🧠 Remember

> Encoding is for format (anyone can undo it), encryption is for secrecy (the key undoes it), hashing is one-way (nothing undoes it) - and passwords need hashing with a slow, salted algorithm like Argon2id.

## 9. Quick Self-Test

1. Why is "we encrypt passwords" a worse answer than "we hash passwords"?
2. Why is SHA-256 great for file integrity but wrong for passwords?
3. Which of the three would you use for a stored card number that must be shown again, and what extra thing does it need?
