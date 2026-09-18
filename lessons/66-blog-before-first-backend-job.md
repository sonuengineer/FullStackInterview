# Blog: Things I Wish Someone Told Me Before My First Backend Job

*Ten short lessons that usually take a year of production incidents to learn. Each one comes with a tiny real example and a link to go deeper.*

---

## 1. Logs Are Your Best Friend. Use Them.

When something breaks in production, you can't attach a debugger. Logs are what you have.

**Example:** "Payment failed for some users." With logs that include `requestId`, `userId`, and the error, you find the cause in 5 minutes. With `console.log("error")`, you're guessing for a day.

Log with context, use structured (JSON) logs, and never log passwords or card numbers. -> [[02-debugging-random-500-errors]]

## 2. Every Input Is a Potential Attack. Validate Everything.

Query params, JSON bodies, headers, file uploads, even data from your own mobile app - all of it can be changed by an attacker.

**Example:** A `quantity` field accepts `-5`, and a user gets a refund on an order they never paid for. Validate type, range, and length on the server, and use parameterized queries to prevent SQL injection. -> [[18-http-status-codes-400-404-409-422]]

## 3. "Works in Dev" Means Nothing.

Dev has 50 rows, one user, and a fast laptop. Production has 50 million rows, concurrent users, slow networks, and real failures.

**Example:** A query that takes 5ms locally takes 45 seconds in production because the table is 10,000x bigger and has no index. -> [[50-slow-query-500m-rows]]

## 4. Database Transactions Exist for a Reason.

If two writes must both happen or neither happen, wrap them in a transaction.

**Example:** You deduct money from wallet A, then the server crashes before adding it to wallet B. Without a transaction, the money just disappears. -> [[60-cache-says-100-db-says-20]]

## 5. Never Store Passwords in Plain Text. Ever.

And not as plain SHA-256 or MD5 either. Use Argon2id or bcrypt.

**Example:** Databases leak. With plain text, every user's password (and likely their email password too) is exposed instantly. -> [[56-password-hashing-not-sha256]]

## 6. Cache Invalidation Is Harder Than It Sounds.

Adding a cache takes an hour. Keeping it correct takes forever.

**Example:** A user updates their profile photo, but the old one keeps showing for 10 minutes because the cache wasn't cleared. Annoying for photos; dangerous for balances and permissions. Never make critical decisions from cached data. -> [[60-cache-says-100-db-says-20]]

## 7. Your API Will Be Called in Ways You Never Imagined.

Clients double-click, retry on timeout, send huge payloads, call endpoints out of order, and hammer you from scripts.

**Example:** A mobile app retries every failed request 3 times. A slow payment endpoint now gets triple traffic and charges some users twice. Design for retries with idempotency keys. -> [[32-payment-idempotency-double-click]], [[48-huge-json-payloads]]

## 8. Rate Limiting Is Not Optional.

Without limits, one buggy client, scraper, or attacker can take down the service for everyone.

**Example:** A partner's integration has a bug and sends 5,000 requests per second in a loop. Rate limiting returns `429` to them and keeps everyone else working. -> [[04-handling-traffic-spike-15k-rps]]

## 9. Backups Mean Nothing If You've Never Tested Restoring Them.

A backup you've never restored is a hope, not a backup.

**Example:** A team discovers during a real outage that backups had been silently failing for 3 months, or that a restore takes 14 hours - longer than the business can survive. Practice restores regularly and time them.

## 10. The Bug Is Always in the Last Place You Look.

(Because you stop looking once you find it.) The real lesson: **debug systematically**, not randomly. Check what changed, follow one request end to end, and rule things out with data instead of hunches.

-> [[20-sudden-latency-spike-checklist]]

---

## 🧠 Remember

> Production is where your assumptions go to die: log with context, validate everything, use transactions, hash passwords properly, distrust caches, expect retries, rate limit, test restores, and debug with data.

## Reflect

Which of these ten has already bitten you? Which one do you think will bite you next?
