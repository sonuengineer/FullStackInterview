# 100 Users Upload 500 MB Videos at Once and Memory Explodes

> **Same-question flag**: this is [[49-large-file-upload-with-status]] (pre-signed URLs, direct-to-storage multipart upload) plus the "don't hold big payloads in memory" rule from [[48-huge-json-payloads]]. Short recap with the math.

## Why Memory Explodes

The API buffers the **whole file** before processing: `100 users x 500 MB = 50 GB` of memory. No normal server has that, so it swaps, slows down, and gets OOM-killed - taking every other request down with it.

## The Fix, in Order of Preference

**1. Don't let the bytes touch your API at all.** Return a **pre-signed URL**; the client uploads directly to object storage (S3/GCS) using **multipart upload** (e.g. 10 MB chunks, retry per chunk). Your API only stores metadata and status. Memory used by your API: close to zero. Full design: [[49-large-file-upload-with-status]].

**2. If the file must pass through your server, stream it.** Pipe the incoming request straight to storage chunk by chunk, never collecting it in memory. Memory per upload becomes a small fixed buffer (a few MB), not 500 MB.

```javascript
// Streaming pass-through: memory stays at a small buffer per upload
const { Upload } = require('@aws-sdk/lib-storage');
app.post('/videos', async (req, res) => {
  await new Upload({
    client: s3,
    params: { Bucket: 'videos', Key: crypto.randomUUID(), Body: req }, // req is a stream
    partSize: 10 * 1024 * 1024,
    queueSize: 2,
  }).done();
  res.status(202).json({ status: 'processing' });
});
```

**3. Process asynchronously.** Transcoding and thumbnails run in background workers from a queue, never inside the upload request.

**4. Add guardrails.** Max file size at the load balancer, per-user concurrent upload limits, and short-lived upload URLs.

## 🧠 Remember

> Never buffer large uploads in API memory: send clients straight to object storage with pre-signed multipart uploads, or at minimum stream the bytes through, and process the video in background workers.
