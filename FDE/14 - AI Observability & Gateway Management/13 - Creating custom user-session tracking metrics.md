# AI Observability & Gateway Management

## Creating custom user-session tracking metrics

> Extended (slow track only) | Slow CP10 only | ~1.2 h

Per-request metrics (latency, cost) se ye pata nahi chalta ki user ka kaam hua ya nahi. **Session** = ek user ki poori conversation/task (session_id se spans group). Session-level metrics: turns to resolution, escalation to human rate, thumbs up/down, "rephrased the same question" count, session cost, abandonment.
FDE ko ye tab chahiye jab customer poochta hai "AI se support team ka load kitna kam hua?" -- iska jawab request count nahi, resolved sessions aur human handoff rate hai.
Implementation simple rakho: har span pe `session.id` aur `user.id_hash` attribute (raw email nahi), aur ek nightly job jo sessions aggregate kare.
Metric define karte waqt business owner ke saath "resolved" ka exact matlab likh ke tay karo -- warna har team apna number laayegi.
Yaad rakho: **user ko request nahi, outcome chahiye** -- session metrics outcome naapte hain.

**Try this (20-40 min):** Synthetic spans (session_id, turn, escalated, feedback, cost) ki ek list banao aur ek function likho jo per-session turns, resolution rate, escalation rate aur cost per resolved session nikaale. Ek session jo 6 turns ke baad escalate hua -- wo report mein dikhna chahiye.

**Read:** https://langfuse.com/docs
