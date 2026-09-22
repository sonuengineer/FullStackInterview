# One of Your Two AZs Goes Down and Users See Errors - What Do You Check First?

> **Same-question flag**: the design answer is [[12-multi-az-availability]] (Multi-AZ ASG + ALB + RDS failover). That lesson is "how do I build it"; this one is the **incident** version - what you check in the first five minutes - plus how each named piece (ALB, Auto Scaling, Multi-AZ RDS, Route 53, health checks) should behave so users barely notice.

## 1. First Question: Why Are Users Seeing Errors At All?

You're already in 2 AZs, so a single AZ failure *should* be invisible. Errors mean one of these assumptions broke:

1. **Health checks aren't failing fast enough.** The ALB keeps sending traffic to dead targets until they fail the threshold. With a 30-second interval and 5 unhealthy checks, that's 2.5 minutes of errors. Check: ALB target group health, `UnHealthyHostCount`, `HTTPCode_ELB_5XX_Count`.
2. **The surviving AZ can't carry 100% of the traffic.** If both AZs ran at 60% capacity, the survivor is now at 120%. Check: instance count per AZ, CPU, and whether Auto Scaling is launching replacements *in the healthy AZ*.
3. **The database primary was in the dead AZ.** Multi-AZ RDS failover is automatic but takes roughly 60-120 seconds, and apps that cache the DNS or don't retry will error through it. Check: RDS events for "failover started/completed", and your app's connection errors.
4. **Something was single-AZ that you forgot.** A NAT gateway, an ElastiCache node, a Kafka broker, a worker that only ran in one AZ, or a subnet with no capacity. This is the most common real cause.

## 2. The Five-Minute Checklist

1. **AWS Health Dashboard** - confirm it's actually an AZ event, not your deploy.
2. **ALB target health per AZ** - are dead targets still receiving traffic? Is cross-zone load balancing on?
3. **Auto Scaling activity** - is it launching in the healthy AZs, or failing with "insufficient capacity" in the dead one?
4. **RDS** - did failover happen, and is the app reconnecting?
5. **Single-AZ dependencies** - NAT, cache, queues, cron hosts.
6. Then: if the survivor is saturated, **raise desired capacity** and shed non-critical load ([[04-handling-traffic-spike-15k-rps]]).

## 3. How Each Piece Should Be Configured So Users Barely Notice

- **Health checks**: short interval (10s), low unhealthy threshold (2-3), and a real `/health` endpoint that checks the app's own dependencies - not a static 200.
- **ALB**: enabled in **all** AZs, with **cross-zone load balancing on**, so the remaining targets share traffic evenly.
- **Auto Scaling**: subnets in 3 AZs, not 2. With 2 AZs you lose 50% of capacity; with 3 you lose 33%. Keep enough headroom that the survivors can absorb the loss, and let the ASG replace lost instances automatically.
- **Multi-AZ RDS**: standby in another AZ, app connects by the **endpoint name** (never a cached IP), with short connection timeouts and retry-on-reconnect so the 60-120s failover is a blip, not an outage.
- **Route 53**: health-checked records matter for *multi-region*; within one region the ALB already handles AZ failure. Keep DNS TTLs low (60s) so a region-level switch is possible later.
- **Stateless app** ([[06-ec2-autoscaling]]): sessions in a shared store, so a user whose instance vanished just continues on another.

## 4. The Honest Trade-off

Surviving an AZ loss invisibly means **paying for capacity you don't use on a normal day** (N+1 across 3 AZs). That's the actual decision, and saying it out loud is the senior answer ([[42-resilience-vs-overengineering]]).

## 5. 🧠 Remember

> In a 2-AZ setup, errors during an AZ failure mean health checks were too slow, the survivor was too small, the database was failing over, or something was quietly single-AZ - check those four, in that order.

## 6. Quick Self-Test

1. Why do 3 AZs need less spare capacity per AZ than 2?
2. Why can an app still error during an RDS Multi-AZ failover, and what makes it a blip instead?
3. Which AZ-failure symptoms does Route 53 *not* solve inside a single region?
