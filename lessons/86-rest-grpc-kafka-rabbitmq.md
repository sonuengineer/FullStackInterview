# REST vs gRPC vs Kafka vs RabbitMQ - Which One for Microservice Communication?

*Don't pick one. Pick by the **problem**. Background on API styles: [[25-api-styles-comparison]].*

## 1. The First Question: Does the Caller Need an Answer Right Now?

- **Yes, now** -> **synchronous request/response**: REST or gRPC. The caller waits.
- **No, just make it happen / tell others** -> **asynchronous messaging**: RabbitMQ or Kafka. The caller moves on.

That one question removes half the options.

## 2. Each Tool and the Problem It Fits

### REST (HTTP + JSON)
- **Choose when:** simple request/response, public or partner APIs, browser/mobile clients, teams that want easy debugging (`curl`, readable JSON).
- **Example:** the mobile app asks the order service "give me order 123".
- **Costs:** text JSON is bigger and slower to parse; no enforced contract unless you add OpenAPI.

### gRPC (HTTP/2 + Protocol Buffers)
- **Choose when:** **internal, service-to-service** calls that are frequent and latency-sensitive; you want a **strict typed contract** and generated clients; you need **streaming**.
- **Example:** the pricing service calls the inventory service thousands of times per second.
- **Costs:** not browser-friendly without a proxy; binary messages are harder to inspect; both sides need the `.proto` files.

### RabbitMQ (message broker / task queue)
- **Choose when:** you need to **hand off work** to be done once by a worker: send an email, resize an image, process a payment callback. Also flexible **routing** (send "order.cancelled.in" to certain queues only), per-message acks, retries, dead-letter queues, delayed messages.
- **Example:** "user signed up" -> a worker sends the welcome email.
- **Costs:** messages are **removed once consumed** - no replay; throughput is lower than Kafka at huge scale.

### Kafka (distributed event log / stream)
- **Choose when:** **many independent consumers** need the same stream of events; you need **replay** (reprocess last week's events, rebuild a read model); **very high throughput** (analytics, clickstream, activity tracking); **ordering per key** (all events for one order, in order).
- **Example:** "order placed" -> billing, inventory, analytics, notifications and the search index each consume it separately, at their own speed.
- **Costs:** the most operational weight (partitions, consumer groups, retention); overkill for a simple job queue.

## 3. Decision Table

| Your problem | Choose |
|---|---|
| Client needs an answer now; simple; public/mobile | **REST** |
| Internal, high-frequency, low-latency calls with a strict contract or streaming | **gRPC** |
| "Do this job once, reliably, in the background" + routing/retries | **RabbitMQ** (or SQS on AWS) |
| "This happened" - many services react; replay; huge volume; per-key order | **Kafka** (or Kinesis / MSK on AWS) |

## 4. Real Systems Use Several

A typical e-commerce order flow:

```
Mobile app --REST--> API gateway --gRPC--> Order service
Order service --publishes "OrderPlaced"--> Kafka
   Kafka --> Billing, Inventory, Analytics, Search indexer (each its own consumer group)
Notification service --puts "send email" job--> RabbitMQ --> Email workers
```

## 5. The Trade-off Nobody Should Skip

- **Sync (REST/gRPC) couples services in time:** if the inventory service is down, the order service fails too. Needs timeouts, retries and circuit breakers ([[14-cascading-failure-recovery]]).
- **Async (queues/streams) decouples them**, but brings **eventual consistency**, **duplicate messages** (make consumers idempotent - [[19-idempotent-consumer-duplicate-events]]), harder debugging, and more infrastructure.
- **For a small team:** start with REST + one simple managed queue (SQS/RabbitMQ). Add gRPC or Kafka only when you have the problem they solve ([[77-blog-microservices-are-a-tax]]).

## 6. In Node.js (tiny examples)

```javascript
// REST call with a timeout (sync)
const res = await fetch(`${INVENTORY_URL}/stock/${sku}`, { signal: AbortSignal.timeout(2000) });

// RabbitMQ: hand off a job (async, done once)
channel.sendToQueue('emails', Buffer.from(JSON.stringify({ userId, template: 'welcome' })), { persistent: true });

// Kafka: publish an event (async, many consumers, keyed for order)
await producer.send({ topic: 'orders', messages: [{ key: orderId, value: JSON.stringify(orderPlaced) }] });
```

## 🧠 Remember

> Ask "does the caller need the answer now?" Sync: REST for simple/public, gRPC for fast internal calls. Async: RabbitMQ to hand off a job once, Kafka when many consumers need a replayable event stream. Most real systems use more than one.

## Self-Test

1. Why would you choose Kafka over RabbitMQ for "OrderPlaced"?
2. When is gRPC a bad choice?
3. What new problems does async messaging bring?

Related: [[25-api-styles-comparison]], [[19-idempotent-consumer-duplicate-events]], [[77-blog-microservices-are-a-tax]]
