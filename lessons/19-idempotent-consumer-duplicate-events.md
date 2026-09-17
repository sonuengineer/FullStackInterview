# A Consumer Crashes After Processing But Before Acknowledging - Now What?

> **Similar-question flag**: this is the same idempotency principle taught in [[17-notification-system-design]]'s "Idempotency" deep dive, now asked directly as a multiple-choice distributed-systems question. The mechanism doesn't need re-deriving - what's worth walking through is *why the other three options are traps* and why this crash window is unavoidable in any at-least-once queue, not just a payment-specific edge case.

## 1. Story

Your payment service publishes an event. A consumer picks it up, fully processes it (say, marks the payment as captured and emails the receipt) - and then crashes, a split second before it sends the acknowledgment back to the queue.

**A.** Process it again
**B.** Drop the event
**C.** Make the consumer idempotent
**D.** Block the entire queue

## 2. Why the Crash Window Is Unavoidable

A message queue only knows a message is "done" when it receives an acknowledgment. If the consumer crashes after finishing the work but before sending that ack, the queue has no way to know the work already happened - from its point of view, the message was never confirmed, so it **must** redeliver it to be safe. This is exactly why real message queues (Kafka, SQS, RabbitMQ) advertise **at-least-once delivery**, not exactly-once: exactly-once would require the queue and your business logic to commit atomically as a single distributed transaction, which is either impossible or prohibitively expensive at scale. At-least-once plus a crash-at-the-wrong-instant is what guarantees you will eventually see a duplicate delivery, no matter how you configure things.

## 3. Evaluating the Four Options

- **A. Process it again (unconditionally)** - wrong. This is what happens by default if you do nothing, and here it means charging the card or sending the receipt email a second time. Straightforwardly harmful for a payment.
- **B. Drop the event** - wrong, and worse than A. Assuming any redelivery is a duplicate and silently discarding it risks losing a payment that was never actually processed (e.g. the consumer crashed *before* doing the work, not after) - trading a duplicate-processing risk for a silent-data-loss risk.
- **D. Block the entire queue** - wrong as a general strategy. Halting all consumers over one ambiguous event turns a local problem into a system-wide outage - the same cascading, self-inflicted damage pattern from [[14-cascading-failure-recovery]]. (A narrower version of this - routing just the one problematic event to a dead-letter queue for isolated inspection - is reasonable; freezing everything is not.)
- **C. Make the consumer idempotent** - correct. Accept that redelivery *will* happen, and design processing so handling the same event twice produces the exact same end state as handling it once.

## 4. How to Actually Make It Idempotent

- **Track processed event IDs**: before doing the real work, check a dedup store (a `processed_events` table with a unique constraint on `event_id`, or Redis `SETNX`) in the *same transaction* as the business effect. If the ID is already present, skip - this is the identical mechanism used for notification dedup in [[17-notification-system-design]].
- **Prefer naturally idempotent operations**: "set balance to $500" is idempotent no matter how many times you run it; "add $50 to balance" is not - reprocessing the second form doubles the effect. Where possible, design state changes as absolute sets rather than relative deltas.
- **Use the payment provider's own idempotency key** (e.g. Stripe's `Idempotency-Key` header) so even a duplicate *call* to the provider is deduplicated on their side too, not just yours.

## 5. Mental Model

> At-least-once delivery is a promise, not a threat - it guarantees your consumer will eventually see everything, at the cost of sometimes seeing it twice. Idempotency is the other half of that deal: it's what turns "at least once" into "effectively once" from the business's point of view.

## 6. 🧠 Remember

> You cannot prevent duplicate delivery in a distributed queue - you can only make duplicate delivery harmless. Idempotency at the consumer is that fix; reprocessing blindly or dropping events blindly both trade one failure mode for a worse one.

## 7. Quick Self-Test

1. Why can a message queue never fully guarantee exactly-once delivery on its own?
2. Why is "add $50 to balance" more dangerous to reprocess than "set balance to $500"?
3. Why is blocking the entire queue over one ambiguous event a worse trade-off than routing just that event to a dead-letter queue?
