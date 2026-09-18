# Blog: "A Monolith Is a Choice. Microservices Are a Tax."

> **Similar-question flag**: this is the same conversation as [[24-kubernetes-pets-vs-cattle]] ("don't buy a ranch for two pets"), one level up: services instead of infrastructure. The underlying rule is [[15-simple-vs-scalable-architecture]] and [[42-resilience-vs-overengineering]]. What's new here is the itemized bill: what the "tax" actually costs, and what "owing the money" looks like.

---

## The Conversation

> **Me:** "Let's split this into microservices. It'll scale better."
> **Tech Lead:** "Scale better than what?"
> **Me:** "Better than one codebase."
> **Tech Lead:** "Have we measured a single service hitting a limit? Or are we designing a distributed system for a traffic graph that still fits on one laptop?"
> **Tech Lead:** "A monolith is a choice. Microservices are a tax. Don't pay the tax before you owe the money."

## "Scale Better" Is Usually the Wrong Reason

A monolith scales horizontally just fine: run 10 copies behind a load balancer ([[06-ec2-autoscaling]]). What usually hits a limit first is the **database**, and splitting code into services doesn't fix that - often it makes it worse, because now five services share one overloaded database.

Microservices mainly help with **organizational scale**, not traffic scale: many teams stepping on each other in one codebase and one deploy pipeline.

## The Tax Bill (What You Pay From Day One)

A function call becomes a network call. That one change brings:

| In a monolith | With microservices |
|---|---|
| Function call, ~microseconds | Network call, milliseconds, can time out ([[13-hidden-latency-bottleneck]]) |
| One database transaction | Distributed consistency, sagas, outbox ([[65-pagerduty-incident-dedup-paging]]) |
| Call always arrives once | Retries, duplicates, idempotency ([[19-idempotent-consumer-duplicate-events]]) |
| One service fails -> one process down | Cascading failures, circuit breakers ([[14-cascading-failure-recovery]]) |
| One deploy | Many deploys, versioned APIs and event schemas ([[68-schema-change-producer-vs-consumer]]) |
| One log file | Distributed tracing needed just to debug one request |
| Refactor across modules in one PR | Coordinated changes across teams and repos |

Every row is real engineering time, every week, forever.

## When You Actually "Owe the Money"

Split a piece out when you can **point to** one of these:

- **Teams block each other**: many teams, one codebase, deploys queue up behind each other.
- **Different scaling or resource needs**: one component (video transcoding, ML inference) needs very different hardware or scale than the rest.
- **Different reliability or security boundaries**: payments must be isolated, or one flaky feature keeps taking down the core product.
- **Measured bottleneck**: you've profiled it, and one part genuinely can't scale inside the monolith.

If you can't name one of these, the split is a cost with no benefit yet.

## The Better Default: A Modular Monolith

One deployable, but with **strict internal boundaries**: separate modules with clear interfaces, no reaching into each other's tables. You get most of the design cleanliness now, and if a module later truly needs to become a service, the seam is already there.

## A Simple Example

A food-delivery startup with 6 engineers and 200 orders per minute splits into Users, Orders, Restaurants, Payments, and Notifications services. Now:

- Placing an order makes 4 network calls instead of 4 function calls.
- A Notifications outage makes checkout hang (no timeouts yet).
- A bug fix touching Orders and Payments needs two coordinated deploys.

The same team with a modular monolith would ship faster, debug faster, and still handle 200 orders/minute on a couple of servers.

## 🧠 Remember

> Microservices buy team independence and isolation by charging you latency, distributed failure, and operational overhead on every request, forever - start with a well-structured monolith and split only when you can point to the specific limit you've hit.

## Reflect

1. Can you name the specific limit your current system has hit that a service split would fix?
2. Which boundary in your codebase would be the first to split *if* you ever needed to - and is it clean enough today?
