# Why Can Autoscaling Make an Outage Worse?

> **Same-question flag**: this is exactly the "common mistake" already named in [[06-ec2-autoscaling]] and [[04-handling-traffic-spike-15k-rps]] - scaling the app tier when the database is the actual bottleneck makes things worse, not better. Kept short; the new piece worth naming is *why* the autoscaler keeps digging the hole deeper in a loop.

## 1. The Feedback Loop

Traffic spikes -> autoscaler adds instances -> more instances mean more concurrent connections hitting the database -> the database, not the app tier, was the real bottleneck, so it gets more overloaded -> requests slow down further -> the autoscaler sees high latency/CPU-wait and interprets it as "need more capacity" -> it adds even more instances -> the database gets hit even harder. The system amplifies its own failure.

## 2. Why This Happens

An autoscaler reacts to a **symptom** (request latency, CPU utilization, queue depth on the app tier) without knowing the **actual cause**. If the true bottleneck is downstream (the database), adding more of the thing that's *waiting* on that bottleneck doesn't relieve pressure - it multiplies the number of things hammering it. This is the identical class of mistake as scaling app servers during the [[04-handling-traffic-spike-15k-rps]] incident: more compute capacity only helps if compute is actually the constrained resource.

## 3. The Fix

- Scale on a metric that reflects the **actual** bottleneck, not just app-tier symptoms - if the database is the constraint, no app-tier metric should be allowed to trigger unbounded scaling.
- Cap the number of concurrent connections each instance (and the fleet as a whole) can open to the database - a connection pool ceiling acts as a natural backpressure valve that prevents the fleet from ever overwhelming the database no matter how many instances exist.
- Fix the actual bottleneck first (caching, read replicas - see [[28-scaling-database-reads]]) before trusting autoscaling to be a safe general-purpose response to any kind of slowdown.

## 4. 🧠 Remember

> Autoscaling amplifies an outage whenever it reacts to a symptom instead of the actual bottleneck - more app instances only help if compute was the real constraint; if the database is drowning, adding instances just means more things drowning it faster.

## 5. Quick Self-Test

1. Why does the autoscaler's own logic ("latency is high, add capacity") make sense in isolation but fail here?
2. What specifically breaks the loop - what would stop instance count from climbing indefinitely?
3. What's the difference between scaling on a symptom versus scaling on the actual bottleneck?
