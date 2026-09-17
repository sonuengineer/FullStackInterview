# Pay Now, Clicked Twice - Preventing a Double Charge

> **Similar-question flag**: this is the same idempotency principle from [[19-idempotent-consumer-duplicate-events]], now from the client-double-click angle instead of the consumer-crash angle, and it also depends on the check-then-act fix from [[26-duplicate-email-race-condition]]. The mechanism is identical - what's worth walking through is *why each layer alone is insufficient* and how they stack as defense in depth.

## 1. Story

A customer clicks "Pay Now." The network is slow, nothing visibly happens, so they click it again. Two payment requests reach the server. Both succeed. The customer meant to pay once.

## 2. Evaluating the Three Options

**Disable the button after the first click** - helps, but is not sufficient on its own. It only prevents *that specific click* from firing twice; it does nothing about a network-level retry, a second tab, a mobile app auto-retrying a timed-out request, or the user refreshing and resubmitting a form. It's a real UX improvement, not a correctness guarantee.

**Use an idempotency key** - the real mechanism. The client generates a unique key once per payment *intent* (not per HTTP request) and sends it with every attempt, including retries. The server checks: "have I already processed this key?" If yes, it returns the original result instead of charging again. This is exactly the same idempotency-key mechanism from [[19-idempotent-consumer-duplicate-events]] and matches how real payment providers (e.g. Stripe's `Idempotency-Key` header) work.

**Handle it at the database/payment-provider level** - the backstop. Even with an idempotency key, the *check-then-act* gap (check if key exists, then process) is itself a race condition if two requests with the same key arrive at nearly the same instant - the exact TOCTOU pattern from [[26-duplicate-email-race-condition]]. The fix is the same: a unique constraint on the idempotency key column, enforced atomically at insert time, so the second concurrent request fails the constraint instead of slipping through the gap.

## 3. The Real Answer: All Three, Layered

- **UI**: disable the button - cheap, immediate, catches the common case, but not the source of truth.
- **Application**: generate and send an idempotency key with the payment intent.
- **Database**: a unique constraint on that key, checked atomically - this is what actually prevents the double charge, even under true concurrency or client retries.

## 4. Mental Model

> Disabling the button is UX. The idempotency key is the mechanism. The database constraint is what makes it actually true, no matter how many ways a duplicate request could arrive.

## 5. 🧠 Remember

> A double charge isn't prevented by making the client "better behaved" - it's prevented by giving every payment attempt a stable identity (the idempotency key) and enforcing uniqueness on that identity atomically at the database, the same defense used against every other check-then-act race condition in this curriculum.

## 6. Quick Self-Test

1. Why is disabling the button not a sufficient fix on its own?
2. Why must the idempotency key represent the payment *intent*, not the individual HTTP request?
3. Why does the idempotency check itself need a database-level unique constraint rather than just an application-level "if exists" check?
