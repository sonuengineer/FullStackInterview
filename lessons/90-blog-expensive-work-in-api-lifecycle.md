# Blog: How to Handle Expensive Work in an API Request

*Some requests trigger work that takes seconds or minutes: generating a report, transcoding a video, calling a slow AI model, importing a big CSV, sending 10,000 emails. You can't keep an HTTP request open for that. Here's the pattern, simply.*

---

## The Problem

A user clicks "Export last year's orders". The server starts building a 200 MB CSV... 90 seconds later:
- The **load balancer times out** at 60 seconds, so the user sees an error - even though the work continues.
- The user clicks again. Now **two** exports are running.
- A deploy restarts the server halfway - the work is **lost**.
- While it runs, the request holds memory and a connection; 50 users doing this take the API down.

**The request/response cycle is for fast work.** Slow work needs a different shape.

## The Pattern: Accept Now, Work Later, Tell Them When It's Done

It's called **asynchronous request-reply**:

```
1. Client:  POST /api/exports            {range: "2025"}
2. Server:  validate, save a job row (status=queued), put it on a queue
            -> 202 Accepted   { jobId: "j_123", statusUrl: "/api/jobs/j_123" }     (in ~50 ms)
3. Worker:  takes the job from the queue, does the heavy work, uploads the file to S3,
            updates the job row: status=done, resultUrl=...
4. Client:  finds out it's done (poll, push, or notification) and downloads the result
```

**Term: 202 Accepted** - the HTTP status that means "I've accepted your request, but the work isn't finished yet."

## Code (Node.js)

```javascript
// API: accept quickly, never do the heavy work here
app.post('/api/exports', authenticate, async (req, res) => {
  const key = req.get('Idempotency-Key');                 // double-click = same job, not two
  const existing = key && await db.jobs.findOne({ userId: req.user.id, idempotencyKey: key });
  if (existing) return res.status(202).json({ jobId: existing.id, statusUrl: `/api/jobs/${existing.id}` });

  const job = await db.jobs.create({ userId: req.user.id, type: 'export', params: req.body,
                                     status: 'queued', idempotencyKey: key });
  await queue.add('export', { jobId: job.id });            // BullMQ / SQS / RabbitMQ
  res.status(202).json({ jobId: job.id, statusUrl: `/api/jobs/${job.id}` });
});

// Status endpoint the client can poll
app.get('/api/jobs/:id', authenticate, async (req, res) => {
  const job = await db.jobs.findOne({ id: req.params.id, userId: req.user.id });   // own jobs only
  if (!job) return res.sendStatus(404);
  res.json({ status: job.status, progress: job.progress, resultUrl: job.resultUrl, error: job.error });
});

// Worker: a separate process that does the slow part
new Worker('export', async ({ data }) => {
  await db.jobs.update(data.jobId, { status: 'running' });
  const fileKey = await buildCsvAndUploadToS3(data.jobId, (p) =>
    db.jobs.update(data.jobId, { progress: p }));           // progress for the UI
  await db.jobs.update(data.jobId, { status: 'done', resultUrl: await presign(fileKey) });
}, { concurrency: 3, connection: redis });                  // cap how many run at once
```

## How the Client Finds Out It's Done

| Option | How | Good for |
|---|---|---|
| **Polling** | `GET /api/jobs/:id` every few seconds (with backoff) | Simplest; works everywhere |
| **Server-Sent Events / WebSocket** | Server pushes progress to the open page | Live progress bars |
| **Webhook** | Server calls the client's URL when done | Server-to-server integrations |
| **Notification / email** | "Your export is ready" with a link | Long jobs the user won't wait for |

Start with polling. Add push only when the UX needs it.

## Details That Make It Production-Grade

- **Idempotency key** so a double-click or retry doesn't start two jobs ([[32-payment-idempotency-double-click]]).
- **Retries with backoff** for transient failures, a **dead-letter queue** for jobs that keep failing, and a clear `failed` status with an error message for the user.
- **Workers are idempotent** - a job may run twice after a crash ([[19-idempotent-consumer-duplicate-events]]).
- **Concurrency limits** on workers so heavy jobs don't overload the database.
- **Results in object storage** (S3) with an expiry, not in the database or server memory.
- **Timeouts per job** and a way to **cancel**.
- **Monitor queue depth and job age** - a growing backlog is your early warning ([[23-queue-backlog-after-spike]]).

## When NOT to Do This

If the work reliably takes **under ~1-2 seconds**, just do it in the request. A queue, a worker and a status endpoint are real complexity - add them when the work is slow, unreliable, or needs retries.

## 🧠 Remember

> Keep the request path short: accept the job, return 202 with a status URL, let a worker do the heavy lifting, and let the client poll or get notified - with idempotency, retries and limits so it stays reliable.

## Self-Test

1. Why is doing a 90-second job inside an HTTP request dangerous even if it "works"?
2. What does the 202 response contain, and why?
3. Why does the job need an idempotency key?

Related: [[23-queue-backlog-after-spike]], [[49-large-file-upload-with-status]], [[19-idempotent-consumer-duplicate-events]], [[32-payment-idempotency-double-click]]
