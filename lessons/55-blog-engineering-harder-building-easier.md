# Blog: Being a Software Engineer Is Getting Harder. Building Software Is Getting Easier.

*An unpopular opinion, and why the gap between those two sentences is going to change who gets into tech.*

---

## Two Things Are True at Once

**Building software is getting easier.** Ten years ago, a login page, a database, hosting, payments, and email took weeks of setup. Today:

- AI writes the first version of most code in seconds.
- Managed services handle auth (Clerk, Auth0), databases (Supabase, RDS), payments (Stripe), and hosting (Vercel, AWS).
- A single person can ship a working product over a weekend.

**Being a software engineer is getting harder.** The job didn't disappear. It moved:

- The easy part (typing code) is now cheap, so the hard parts are what you're paid for: judgment, debugging, design, and owning production.
- Systems are more distributed: more services, more queues, more third-party APIs, more ways to fail.
- The bar for juniors went up. The tasks juniors used to learn on (simple CRUD, boilerplate, small bug fixes) are exactly what AI now does.

## A Simple Example

Ask an AI: "Build me an API that charges a customer."

You'll get working code in 10 seconds. It will probably:

- charge twice if the user double-clicks ([[32-payment-idempotency-double-click]])
- break when two requests read a stale balance ([[60-cache-says-100-db-says-20]])
- hang forever when the payment provider is slow ([[14-cascading-failure-recovery]])

**Building** the endpoint took seconds. **Engineering** it - making it correct under retries, concurrency, and failure - is the part that still needs a person who understands what's happening underneath.

## So What Changes About Who Gets Into Tech?

**1. "I can build an app" is no longer a differentiator.** Almost anyone can. Bootcamp-style "I built a todo app" portfolios stop standing out.

**2. Depth becomes the entry ticket.** People who understand *why* things break - databases, networking, concurrency, failure modes - become more valuable, because they can review and fix what AI produces.

**3. Builders who aren't engineers will multiply.** Designers, founders, domain experts, and analysts will ship real software without calling themselves engineers. That's good. It also means "writing code" is no longer a gate that only engineers pass through.

**4. The junior ladder needs a new first rung.** If AI does the beginner work, beginners must learn from the start by reading, debugging, and questioning code, not only by writing it.

## What To Do About It (If You're Early in Your Career)

- **Use AI to build fast, then ask "how does this break?"** about everything it produces.
- **Go deep on fundamentals** that don't go out of date: how a request travels, how databases execute queries, what happens under concurrency and failure. That's what this whole lesson library is about.
- **Own something in production**, even a small side project with real users. Production teaches what tutorials can't.
- **Practice explaining trade-offs.** "Why this and not that?" is the question AI can't answer for your specific system ([[29-why-hire-you-over-ai]]).

## 🧠 Remember

> Building software is getting cheaper because the code is getting cheaper. Engineering is getting harder because what's left - judgment, correctness, and owning failure - is the part that was always hard.

## Reflect

1. What's one thing you built recently that AI could have written - and one thing about it that AI would likely have gotten wrong?
2. Which fundamental topic would make you better at reviewing AI-generated code?
