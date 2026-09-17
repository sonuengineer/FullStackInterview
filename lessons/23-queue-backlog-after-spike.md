# Traffic Is Normal, But 8 Million Jobs Are Still Stuck in the Queue

> **Similar-question flag**: this connects to [[14-cascading-failure-recovery]] (fixing the trigger doesn't undo the backlog it left behind) and [[17-notification-system-design]] (scale workers on queue depth, not CPU). What's new here is a concrete **decision framework** for what to actually do with an existing backlog, since "scale consumers," "drop stale jobs," and "make users wait" aren't mutually exclusive - they apply to different slices of the backlog.

## 1. Story

Traffic spiked, then returned to normal 20 minutes ago. The API is still slow. Digging in: the queue did its job during the spike - it absorbed 8 million jobs instead of dropping requests or erroring out. But absorbing the work isn't the same as finishing it. The backlog is still there, and consumers are draining it at their normal, pre-spike rate.

## 2. Do the Math First

Before choosing an approach: `backlog size / current consumer throughput = time to drain`. If consumers process 1,000 jobs/sec, 8,000,000 jobs is roughly 2.2 hours at the current rate - far too long. This single number tells you whether "just wait it out" is even remotely viable before you consider it as an option.

## 3. Evaluating the Three Options - They're Not Mutually Exclusive

**Scale consumers** - almost always the first lever, and the direct fix for "drain rate is too slow." But scale carefully: if consumers call a downstream service or database, doubling consumer count means doubling concurrent calls to that dependency. Do this too aggressively and you recreate the exact thundering-herd problem from [[14-cascading-failure-recovery]], just self-inflicted by your own backlog-clearing effort instead of by an outage.

**Drop stale jobs** - only valid for job types where the value of the result **decays with time**. A "user is typing" notification, a real-time price alert, or an abandoned-cart reminder for a cart that's already been checked out are all worthless 20 minutes late - processing them wastes capacity that could clear jobs that still matter. This means giving jobs a TTL/max-age at creation (the same expiry philosophy as [[03-ttl-deletion-at-scale]], applied to queued work instead of stored data) so a consumer can check "is this still relevant?" before doing the expensive part, and skip it if not.

**Make users wait** - acceptable only for genuinely asynchronous, non-blocking work where nobody is staring at a spinner (a background email digest, a nightly report). Unacceptable for anything synchronous or user-facing.

## 4. The Real Answer

Production systems typically do all three, applied to different subsets: scale consumers immediately (matched to what the downstream dependency can actually absorb), drop or deprioritize jobs that have exceeded a staleness threshold, and let the remaining, still-relevant, genuinely-tolerant background work simply take its turn.

## 5. Mental Model

> A full queue after the spike has ended is a math problem (arrival rate vs. drain rate) mixed with a business problem (which jobs still matter). Solve both - don't guess one universal answer for every job in the backlog.

## 6. 🧠 Remember

> The queue absorbing a spike buys you time, not a solution - clearing the backlog needs scaling matched to what downstream can handle, staleness-based dropping for time-decaying work, and patience only where patience is actually free.

## 7. Quick Self-Test

1. Why can scaling consumers too aggressively recreate the exact problem from Lesson 14?
2. What property of a job makes "drop it if stale" the right call, versus a job where that would be unacceptable?
3. Why is "how long will draining take at the current rate" the first calculation to make, before picking a strategy?
