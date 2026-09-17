# Should We Adopt Kubernetes for Three Containers?

> **Similar-question flag**: this is the same "don't ship the impressive architecture, ship the one your actual scale needs" principle from [[15-simple-vs-scalable-architecture]], now applied to infrastructure orchestration specifically. What's new here is the concrete list of what Kubernetes actually buys you, and the "pets vs. cattle" framing for deciding when that trade is worth it.

## 1. Story

"Let's add Kubernetes, deployments will be easier." "Easier than what?" "Than SSH and a systemd unit." "How many boxes do we run - or are we adopting an operating system to host three containers?"

## 2. The Problem

Kubernetes doesn't run your containers - it runs a **distributed system that runs your containers**: a control plane, a key-value store (etcd) for cluster state, a scheduler, a networking overlay, RBAC, usually an ingress controller. All of that is real, ongoing operational surface area - upgrades, security patches, learning curve, failure modes of its own - adopted before a single line of your actual application changes.

## 3. What Kubernetes Actually Solves

- **Scheduling across many nodes** - deciding which of dozens/hundreds of machines should run which container, and rebalancing automatically as machines come and go.
- **Self-healing at fleet scale** - automatically restarting or rescheduling containers when a node dies, across a fleet large enough that a human can't watch every box.
- **Service discovery and load balancing** across a constantly-changing set of instances.
- **Rolling deployments across many hosts** - safely updating a fleet of dozens/hundreds of instances without a human running the same deploy script over and over.

## 4. Term: Pets vs. Cattle

**Pets** - servers you know individually, name, and nurse back to health when something goes wrong (SSH in, check logs, restart the service). Fine, even correct, at a small scale.

**Cattle** - a fleet large enough that individual machines are disposable and interchangeable; you don't fix a sick one, you replace it. Orchestration exists to manage cattle at scale, automatically.

> Orchestration is for cattle. Don't build a ranch's worth of infrastructure to manage two pets.

## 5. The Actual Decision

For **three containers on a couple of boxes**, SSH plus a systemd unit (or a simple process manager like PM2, plus a basic deploy script) achieves "easier deployments" with a small fraction of the operational surface area. The genuine trigger for Kubernetes isn't "we want easier deploys" in the abstract - it's a specific, measurable pain: dozens-to-hundreds of services/instances that need automatic scheduling, self-healing, and rolling updates that a human genuinely can't keep up with by hand.

## 6. 🔗 Connection to Other Concepts

This is the exact same reasoning taught in [[15-simple-vs-scalable-architecture]] - ask what the actual requirement is before reaching for the architecture that looks most senior on paper.

## 7. 🧠 Remember

> Kubernetes trades a lot of new operational complexity for the ability to manage a large, disposable fleet automatically - if you're managing a handful of pets, not a herd of cattle, that trade isn't worth making yet.

## 8. Quick Self-Test

1. What specifically does Kubernetes cost you operationally, beyond "another thing to learn"?
2. What's the actual, measurable trigger that justifies adopting it, versus just "it sounds more professional"?
3. Why does "pets vs. cattle" matter more than the raw number of containers alone?
