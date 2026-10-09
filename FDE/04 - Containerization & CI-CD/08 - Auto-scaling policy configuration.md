# Containerization & CI-CD

## Auto-scaling policy configuration

> Extended (slow track only) | Slow CP6 only | ~1.2 h

ECS service auto scaling **Application Auto Scaling** se hota hai: ek **scalable target** (min/max tasks) aur ek ya zyada **policies**.
Default choice **target tracking** hai: "average CPU 60% ke aas paas rakho" ya `ALBRequestCountPerTarget` = 50 -- AWS khud alarms bana ke tasks add/remove karta hai. **Step scaling** tab jab custom thresholds chahiye; **scheduled scaling** business-hours traffic ke liye (raat ko min 1, subah 9 baje min 3).
AI backends mein twist: OmniGuard ka bottleneck aksar CPU nahi, LLM gateway latency ya concurrency hai -- CPU 15% pe hoga aur users phir bhi wait karenge. Isliye request count per target ya custom metric (in-flight requests) pe scale karna aksar behtar signal hai.
FDE ko ye milta hai jab customer ka bill ya latency spike hota hai. Yaad rakho: **max capacity hamesha set karo** (cost guard, M03-13) aur scale-in cooldown lamba rakho taaki tasks flap na karein.

**Try this (20-40 min):** OmniGuard ke liye `docs/scaling.md` likho: min 1 / max 4 tasks, target tracking on `ALBRequestCountPerTarget` (value apne load test se justify karo), scale-out cooldown 60 s, scale-in 300 s, aur ek scheduled action jo weekdays 09:00 pe min 2 kare. Har number ke saath ek line "kyun".

**Read:** https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-auto-scaling.html
