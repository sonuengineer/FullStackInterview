# Blog: 12 LPA to 22 LPA Is Not "More LeetCode"

*What actually moved the people I know. The jump is a packaging problem as much as a skill problem.*

---

## The Six Things That Moved People

**1. One service they could explain under load.**
Not five side projects. One system where you can answer: what breaks at 10x, which component saturates first, how you'd know. That's the whole method in [[53-blog-senior-system-design-without-big-scale]] - and you can practise it on the small system you already work on.

**2. 8-10 DSA patterns, not 400 random Easy problems.**
Sliding window, two pointers, hashing, binary search on answer, BFS/DFS, heap/top-k, intervals, prefix sums, basic DP, graph traversal. Patterns transfer; solved-problem counts don't.

**3. SQL that uses `EXPLAIN`, not just `SELECT`.**
Being able to read a query plan, spot a sequential scan, and add the right composite index is a senior signal that very few candidates show ([[50-slow-query-500m-rows]], [[57-two-indexes-still-slow-composite]], [[95-database-interview-questions]]).

**4. A resume with latency, cost and users - not "worked on APIs".**
Compare:
- *Before:* "Worked on backend APIs using Node.js and MongoDB."
- *After:* "Cut p95 checkout latency 2.4s -> 380ms for 40k daily users by removing sequential calls and adding a Redis cache; cloud bill down 18%."
Same work. The second version tells the interviewer you measure things. If you don't have exact numbers, use honest ranges and say how you measured.

**5. 12 targeted applications + 4 referrals, not 200 blasts.**
A referral plus a short note about why *this* company is worth more than a hundred cold applications. Targeted means: you read what they build and can say which of your projects is closest.

**6. 6 mock interviews where they said the trade-off out loud.**
Not silent practice. The skill being graded is explaining *why this and not that* while someone pushes back ([[30-workload-before-conclusion]], [[42-resilience-vs-overengineering]]).

## Why "Packaging" Is the Right Word

Two engineers with the same three years of experience get very different offers, because one can *show* what they know in the 45 minutes the interviewer has. Packaging means:

- **Evidence over claims:** numbers, not adjectives.
- **Depth over breadth:** one system explained well beats five listed.
- **Reasoning out loud:** the interviewer can only grade what you say.

None of this replaces skill - it makes existing skill legible.

## A Plan That Fits Around a Job

| Weeks | Focus |
|---|---|
| 1-2 | Pick your one system. Write down its load, bottleneck at 10x, and failure modes. |
| 3-4 | 8-10 DSA patterns, 5-8 problems each, revisited, not 200 new ones. |
| 5 | SQL: `EXPLAIN` on your real slow queries; learn indexes and joins properly. |
| 6 | Rewrite the resume around latency, cost, users, scale. |
| 7-8 | 12 targeted applications, ask for 4 referrals, do 6 mocks and record yourself. |

## 🧠 Remember

> The jump usually isn't more problems solved - it's one system you can explain under load, patterns instead of volume, numbers on your resume, and trade-offs spoken out loud in a room.

## Reflect

1. Which single system would you pick as "the one you can explain under load"? Can you name what breaks first at 10x?
2. Rewrite one resume line to include latency, cost, users or scale.
