# Blog: AI Coding Agents Are Great Tools - But Not for Every Job

*Being a good engineer now includes knowing when to prompt and when to just write the code.*

---

## The Core Idea

A quote (credited to Petar Dambovaliev) sums it up:

> "The more precise you need to be, the more natural-language text you need to write to describe the same programming concept. So at some point it is actually faster to write the code than to try to explain to an LLM what the code should do. It is a spectrum, and you should at any moment be able to go from one to the other."

Code is a precise language. English is not. When the thing you want is fuzzy, English is efficient. When the thing you want is exact, the code **is** the shortest description.

## A Simple Example

**Easy to prompt:** "Create an Express endpoint that returns a paginated list of orders, with validation and tests."
Twelve words produce 150 lines. Huge win.

**Hard to prompt:** "The balance update must be one atomic conditional statement, reject if the balance would go negative, use the account row as the only source of truth, and never read from the cache."
You've now written a paragraph to describe what is literally one line:

```sql
UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND balance >= $1;
```

At that point, writing the line yourself is faster **and** you know it's exactly right ([[60-cache-says-100-db-says-20]]).

## Where Agents Shine

- **Boilerplate and scaffolding**: CRUD endpoints, DTOs, config, migrations for simple tables.
- **Well-known patterns**: "add rate limiting with this library," "convert this to async/await."
- **Exploration**: reading an unfamiliar codebase, summarizing a module, drafting options.
- **Tests and refactors** with a clear target.
- **Glue code** between well-documented APIs.

## Where Writing It Yourself Is Often Faster (or Safer)

- **Precise invariants**: concurrency, locking, money, idempotency ([[44-distributed-locking-with-redis]], [[65-pagerduty-incident-dedup-paging]]).
- **Tiny, exact changes**: a one-line fix where describing it takes longer than typing it.
- **Deep context**: behavior that depends on history nobody wrote down ("we do it this way because of the 2024 incident").
- **Performance-critical paths** where the exact query plan matters ([[50-slow-query-500m-rows]]).
- **Security-sensitive code**: auth flows, crypto, secret handling ([[56-password-hashing-not-sha256]], [[72-secret-leaked-to-public-git]]).

## The Skill: Moving Along the Spectrum

Good engineers switch modes constantly:

1. Prompt the agent for the scaffold.
2. Hand-write the one tricky function where correctness lives.
3. Ask the agent to write tests for that function.
4. Review everything like it came from a fast but new teammate.

The mistake isn't using AI or refusing to. It's being stuck at one end of the spectrum: prompting for 20 minutes to avoid writing 3 lines, or hand-typing 300 lines of boilerplate out of pride.

## Why This Matters for Your Career

If you can only work through prompts, you can't tell when the output is subtly wrong - and the subtle bugs (races, retries, stale caches) are exactly the expensive ones. If you can read and write precise code, AI becomes a multiplier instead of a crutch. That's the same point as [[29-why-hire-you-over-ai]] and [[55-blog-engineering-harder-building-easier]].

## 🧠 Remember

> Use natural language when the idea is fuzzy and the pattern is common; write code when the idea is precise, because past a certain point the code is the shortest and most accurate description.

## Reflect

1. What was the last task where prompting took longer than writing it would have?
2. Which parts of your current project would you never let an agent change without a line-by-line review?
