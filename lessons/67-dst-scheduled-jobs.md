# 2M Users Schedule a Job for 2:30 AM Local Time. On DST Spring-Forward Day, 2:30 AM Doesn't Exist.

## 1. Story

Millions of users set "run my backup / send my report at 2:30 AM." In many regions (US, Europe), on the day clocks spring forward, local time jumps straight from **1:59:59 to 3:00:00**. There is no 2:30 AM that day. And on the fall-back day, **1:00-1:59 happens twice**.

The options:
- **A:** Skip the job.
- **B:** Run it at 3:00 AM.
- **C:** Convert the intended local time to UTC once, before scheduling.

## 2. Why Option C Is a Trap

C sounds the most "correct," because "always store times in UTC" is good general advice. But for a **recurring job defined in local time**, converting to UTC once is wrong:

- In winter, 2:30 AM New York = 07:30 UTC. Store "07:30 UTC" forever.
- After DST starts, 07:30 UTC = **3:30 AM** local. The user's job now runs an hour late every day for months.
- Timezone rules also change by government decision (countries drop or move DST), so a UTC time computed today can be wrong next year.

**UTC is right for moments that already happened** (event timestamps, logs). It's wrong for **future local-time intentions** ("2:30 every night in my city").

## 3. Option A Is Usually Wrong Too

Skipping silently means a user's daily backup or bill payment just doesn't happen that day. Silent data-loss-style behavior is worse than running a bit late.

## 4. The Best Answer: Store the Intention, Resolve It at Run Time, and Apply B as the Policy

**Store what the user actually meant:**
- `local_time = 02:30`
- `timezone = America/New_York` (an IANA timezone name, not a fixed offset like `-05:00`)
- the recurrence rule (daily, weekly, ...)

**Compute each next run time at scheduling time for that occurrence**, using an up-to-date timezone database, with an explicit policy for the two DST edge cases:

| Case | What happens to 2:30 | Common policy |
|---|---|---|
| **Spring forward (gap)** | 2:30 doesn't exist | Run at the next valid time, **3:00** (option B) |
| **Fall back (overlap)** | 1:30 happens twice | Run **once**, at the first occurrence |

That's how cron-like systems and calendar apps (RFC 5545 / iCalendar) generally behave, and it matches what users expect: "run it, even if a little shifted, and never twice."

So the interview answer is: **B as the behavior, but implemented by storing local time + timezone, not by pre-converting to UTC (C).**

## 5. Don't Forget the Scale Problem

2 million jobs mapped to the same wall-clock moment means **2M jobs fire at 3:00 AM at once** on DST day (and every night at 2:30). That's the synchronized-burst problem from [[16-synchronized-connection-pool-expiry]]. Add **jitter** (spread execution across a window, e.g. 2:30-2:45) and push jobs through a queue with bounded workers ([[23-queue-backlog-after-spike]]). Make each job **idempotent** so a retry or the fall-back hour never runs it twice ([[19-idempotent-consumer-duplicate-events]]).

## 6. Code Example

```javascript
const { DateTime } = require('luxon');

function nextRun(localTime, zone, afterUtc) {
  const [h, m] = localTime.split(':').map(Number);
  let day = DateTime.fromJSDate(afterUtc, { zone }).startOf('day');
  for (let i = 0; i < 3; i++) {
    let run = day.set({ hour: h, minute: m });   // Luxon shifts a nonexistent
                                                  // 2:30 forward to 3:30 - normalize
    if (run.hour !== h) run = run.set({ minute: 0 }); // policy: run at 3:00
    if (run.toUTC() > DateTime.fromJSDate(afterUtc)) return run.toUTC();
    day = day.plus({ days: 1 });
  }
}
// Stored: { localTime: '02:30', zone: 'America/New_York' } - never a fixed UTC time
```

## 7. Mental Model

> Store the user's **intention** ("2:30 at night where I live"), not your **translation** of it. Translate fresh each time, because the rules for translating can change.

## 8. 🧠 Remember

> For recurring local-time jobs, store local time + IANA timezone and compute each run at scheduling time: shift nonexistent times forward (3:00), run ambiguous times once, add jitter for the burst, and make the job idempotent - converting to UTC once breaks the moment DST changes.

## 9. Quick Self-Test

1. Why does storing "07:30 UTC" make a 2:30 AM job run at the wrong local time for half the year?
2. What should happen to a 1:30 AM job on the fall-back day, and why?
3. Why is 2M jobs at the same local time a problem even on normal days?
