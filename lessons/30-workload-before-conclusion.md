# The Database Name Is the Conclusion. The Workload Is the Reasoning.

> **Connects to**: [[15-simple-vs-scalable-architecture]] (ask before answering), [[17-notification-system-design]] (full requirements-first design), and [[28-scaling-database-reads]] / [[21-database-partitioning]] (write volume drives infrastructure choices).

## 1. Story

Two senior candidates get the same prompt: design a transaction ledger.

**Candidate A**: "I'll use Postgres, because transactions need ACID."

**Candidate B**: "What's the write volume? Are balances computed from entries, or stored separately? Can entries ever be edited? Which reads need to be strongly consistent? What's the audit and reconciliation requirement?"

Candidate A may well land on the same technology Candidate B eventually chooses. But only one of them can defend that choice when challenged, adapt it when a stated assumption turns out to be wrong, or extend it when a new constraint shows up next quarter.

## 2. The Problem

**The database name is a conclusion. The workload, access patterns, invariants, and failure model are the reasoning.** A conclusion without reasoning behind it isn't wrong by default - but it's also not defensible, and it can't tell you what changes if a constraint changes. This is the same asking-before-answering instinct from [[15-simple-vs-scalable-architecture]], but a ledger's specific questions are worth walking through concretely, because each one changes the design in a real way.

## 3. Why Each Question Actually Matters

**"What's the write volume?"** - determines whether a single instance suffices, whether you need read replicas (see [[28-scaling-database-reads]]), or whether write throughput alone forces sharding (see [[21-database-partitioning]]). Skipping this question means potentially over- or under-building the entire system.

**"Are balances computed from entries, or stored separately?"** - this is the core design decision of any ledger. Storing a single mutable `balance` field that gets incremented on every transaction is fast to read, but it destroys the audit trail and reintroduces exactly the lost-update/race-condition risk from [[26-duplicate-email-race-condition]] and [[10-clock-skew-last-write-wins]] - two concurrent updates to the same balance can silently overwrite each other. The standard ledger design instead treats transactions as an **append-only log of immutable entries**, with the balance **derived** (computed on demand, or maintained via a separately-updated materialized total) - correctness comes from the log, not from a single mutable number anyone could race against.

**"Can entries ever be edited?"** - in a real accounting system, the answer is almost always **no**. Once written, an entry is permanent; corrections happen by writing a new reversing or adjusting entry, never by mutating history. This isn't just a technical preference - it's what makes the ledger auditable at all, and it sidesteps an entire category of concurrency bugs by never allowing an in-place update to a financial record.

**"Which reads must be strongly consistent?"** - checking your current balance before approving a withdrawal needs a strongly consistent read (a stale balance could let someone overdraw). A monthly statement or historical report can tolerate eventual consistency. This is the same per-operation consistency reasoning from [[17-notification-system-design]] (delivery status can be eventual; opt-out checks cannot) - consistency requirements attach to *specific operations*, not to "the database" as a whole.

**"What's the audit and reconciliation requirement?"** - financial data usually needs a complete, immutable history that can be reconciled against an external source of truth (a bank statement, a payment processor's records). This shapes the schema (append-only, no `UPDATE`/`DELETE` on transaction rows, ever) more than any specific database engine choice does.

## 4. Mental Model

> Naming a technology first and justifying it after is guessing with hindsight bias. Naming the workload, invariants, and failure model first, then choosing a technology, is engineering - and it's the only version of the answer that survives a follow-up question.

## 5. Flow

```mermaid
flowchart LR
  A[Requirement: "design a ledger"] --> B{Write volume?}
  A --> C{Balances: computed or stored?}
  A --> D{Entries mutable?}
  A --> E{Which reads need strong consistency?}
  A --> F{Audit/reconciliation needs?}
  B --> G[Technology choice]
  C --> G
  D --> G
  E --> G
  F --> G
```

## 6. Production Reality

Interviewers ask "design X" specifically to see whether a candidate reaches for a conclusion or for the reasoning that produces one - because in a real job, requirements shift constantly, and only the reasoning transfers to the next set of constraints. The technology name from six months ago is often wrong the moment write volume grows 10x; the underlying questions asked to get there are still exactly the right ones to ask again.

## 7. 🧠 Remember

> The database name is the conclusion. The workload, access patterns, invariants, and failure model are the reasoning - and only the reasoning is reusable when the constraints change.

## 8. Quick Self-Test

1. Why does storing a single mutable `balance` field reintroduce a race condition already covered elsewhere in this curriculum?
2. Why must ledger entries typically be immutable, and how are corrections handled instead?
3. Why can two different reads in the same system have two different consistency requirements?
